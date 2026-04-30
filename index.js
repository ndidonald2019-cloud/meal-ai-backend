const express = require("express");
const axios = require("axios");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Paddle, Environment, EventName } = require("@paddle/paddle-node-sdk");
const { WebhooksValidator } = require("@paddle/paddle-node-sdk/dist/cjs/notifications/helpers/webhooks-validator");
const db = require("./db");
require("dotenv").config();

// Increase Paddle's extremely strict 5-second webhook tolerance to 5 minutes
if (WebhooksValidator) {
  WebhooksValidator.MAX_VALID_TIME_DIFFERENCE = 300;
}

const app = express();
app.set("trust proxy", 1);

// ═══════════════════════════════════════════
// PADDLE SETUP
// ═══════════════════════════════════════════
const paddle = new Paddle(process.env.PADDLE_API_KEY, {
  environment: Environment.production,
  // Live production mode
});

// ═══════════════════════════════════════════
// WEBHOOK MUST COME BEFORE express.json()
// ═══════════════════════════════════════════
// (Webhook raw parsing is now handled by express.json's verify function)

// ═══════════════════════════════════════════
// NORMAL MIDDLEWARE
// ═══════════════════════════════════════════
app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// PostgreSQL DB helpers are imported from ./db.js
db.initSchema().catch(err => console.error("Schema init error:", err.message));

// ═══════════════════════════════════════════
// 💰 CREDIT PACKAGES WITH PADDLE PRICE IDS
// ═══════════════════════════════════════════
const CREDIT_PACKAGES = {
  starter: {
    name: "Starter Pack",
    credits: 50,
    price_usd: 2.99,
    paddle_price_id: process.env.PADDLE_STARTER_PRICE_ID,
  },
  popular: {
    name: "Popular Pack",
    credits: 150,
    price_usd: 6.99,
    paddle_price_id: process.env.PADDLE_POPULAR_PRICE_ID,
    most_popular: true,
  },
  pro: {
    name: "Pro Pack",
    credits: 400,
    price_usd: 14.99,
    paddle_price_id: process.env.PADDLE_PRO_PRICE_ID,
    best_value: true,
  },
};

// ═══════════════════════════════════════════
// 💰 CREDIT COSTS PER FEATURE
// ═══════════════════════════════════════════
const CREDIT_COSTS = {
  cookWithIngredients: 5,
  generateWeeklyPlan: 15,
  rescueLeftovers: 5,
  getCookingSteps: 5,
  budgetMeals: 7,
  extractRecipe: 12,
};

const SIGNUP_BONUS_CREDITS = 12;

// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
// 🔒 AUTHENTICATION MIDDLEWARE
// ═══════════════════════════════════════════
const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sign up to buy credit" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Sign up to buy credit" });
  }
};

// ═══════════════════════════════════════════
// 🔐 AUTHENTICATION ENDPOINTS
// ═══════════════════════════════════════════

// SIGNUP
app.post("/auth/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password are required" });

  try {
    const existing = await db.getUserByEmail(email);
    if (existing) return res.status(400).json({ error: "Email already registered" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = crypto.randomUUID();
    const user = await db.createUser(userId, email, { name, password: hashedPassword, credits: SIGNUP_BONUS_CREDITS });

    const token = jwt.sign({ id: userId, email }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.status(201).json({
      success: true, token,
      user: { id: userId, name: name || "", email, credits: SIGNUP_BONUS_CREDITS }
    });
  } catch (error) {
    console.error("Signup error:", error.message);
    res.status(500).json({ error: "Server error during signup", detail: error.message });
  }
});

// LOGIN
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password are required" });

  try {
    const user = await db.getUserByEmail(email);
    if (!user || !user.password)
      return res.status(401).json({ error: "Invalid email or password" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(401).json({ error: "Invalid email or password" });

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({
      success: true, token,
      user: { id: user.id, name: user.name || "", email: user.email, credits: user.credits }
    });
  } catch (error) {
    console.error("Login error:", error.message);
    res.status(500).json({ error: "Server error during login", detail: error.message });
  }
});

// GET ME
app.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await db.getUser(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user: { id: user.id, name: user.name || "", email: user.email, credits: user.credits } });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// ═══════════════════════════════════════════
// 🚫 RATE LIMITER
// ═══════════════════════════════════════════
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many requests, slow down." },
});

app.use(limiter);

const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════
// 🛒 HOSTED CHECKOUT PAGE
// ═══════════════════════════════════════════
app.get("/checkout", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Secure Checkout</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
        <style>
          body { 
            margin: 0; padding: 0; 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background: #f4f4f5; 
            display: flex; flex-direction: column; align-items: center; justify-content: center; 
            height: 100vh; text-align: center;
          }
          .loader {
            border: 4px solid #e4e4e7;
            border-top: 4px solid #3b82f6;
            border-radius: 50%;
            width: 40px; height: 40px;
            animation: spin 1s linear infinite;
            margin-bottom: 20px;
          }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          h2 { color: #18181b; margin: 0 0 8px 0; }
          p { color: #71717a; margin: 0; }
        </style>
      </head>
      <body>
        <div class="loader"></div>
        <h2>Loading Checkout</h2>
        <p>Please wait while we secure your session...</p>
        
        <script>
          // Initialize Paddle for Live Production
          Paddle.Initialize({
            token: '${process.env.PADDLE_CLIENT_TOKEN}'
          });
          // Paddle.js will automatically detect the ?_ptxn parameter in the URL
          // and open the checkout overlay instantly!
        </script>
      </body>
    </html>
  `);
});

// ═══════════════════════════════════════════
// 🔍 YOUTUBE SEARCH
// ═══════════════════════════════════════════
app.get("/searchVideos", async (req, res) => {
  const meal = req.query.meal;
  if (!meal)
    return res.status(400).json({
      error: "meal parameter is required"
    });

  try {
    const response = await axios.get(
      "https://www.googleapis.com/youtube/v3/search",
      {
        params: {
          part: "snippet",
          q: `how to cook ${meal} recipe`,
          maxResults: 50,
          type: "video",
          videoEmbeddable: "true",
          videoSyndicated: "true",
          key: process.env.YOUTUBE_API_KEY,
        },
      }
    );

    const videos = response.data.items
      .filter((item) => item.id?.videoId)
      .slice(0, 30)
      .map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        thumbnail: item.snippet.thumbnails.medium.url,
        channel: item.snippet.channelTitle,
        embedUrl: `https://www.youtube.com/embed/${item.id.videoId}`,
      }));

    res.json({ success: true, videos });
  } catch (error) {
    console.error("YouTube error:", error.message);
    res.status(500).json({ error: "Failed to fetch videos" });
  }
});

// ═══════════════════════════════════════════
// 🖼️ MEAL IMAGE
// ═══════════════════════════════════════════
app.get("/getMealImage", async (req, res) => {
  const meal = req.query.meal;
  if (!meal)
    return res.status(400).json({
      error: "meal parameter is required"
    });

  try {
    const response = await axios.get(
      "https://api.pexels.com/v1/search",
      {
        headers: { Authorization: process.env.PEXELS_API_KEY },
        params: { query: meal + " food dish", per_page: 3 },
      }
    );

    const photo = response.data.photos[0];

    res.json({
      success: true,
      image: {
        url: photo?.src?.large || "",
        alt: photo?.alt || meal,
      },
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch image" });
  }
});

// ═══════════════════════════════════════════
// 🍳 COOK WITH INGREDIENTS
// ═══════════════════════════════════════════
app.post("/cookWithIngredients", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId)
    return res.status(401).json({ error: "User ID required" });

  const creditCheck = await db.checkAndDeductCredits(userId, CREDIT_COSTS.cookWithIngredients);
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  const { ingredients, country } = req.body;
  if (!ingredients)
    return res.status(400).json({ error: "ingredients required" });

  try {
    const prompt = `You are a culinary expert 
specializing in ${country || "global"} cuisine.

The user is from: ${country || "anywhere in the world"}

They have these ingredients available:
${ingredients.join(", ")}

STRICT RULE: You MUST suggest ONLY meals that are 
traditionally prepared and commonly eaten in 
${country || "their country"}.
Do NOT suggest meals from other countries.
${country ? `Every suggested meal must be an authentic ${country} dish.` : ""}

Think about what local home cooks in 
${country || "this region"} would actually 
make with these ingredients.

Return ONLY valid JSON with no extra text:
{
  "recipes": [
    {
      "title": "Local meal name from ${country || "their country"}",
      "description": "One sentence about this local dish",
      "matchPercentage": 85,
      "usedIngredients": ["ingredient1", "ingredient2"],
      "missedIngredients": ["missing ingredient"],
      "cookTime": "30 minutes",
      "difficulty": "Easy",
      "country": "${country || "International"}",
      "why_local": "Why this is a traditional dish here"
    }
  ]
}

Suggest exactly 10 meals.
ALL 10 meals must be authentic traditional dishes 
from ${country || "the user's country"}.
Never suggest meals from other countries.`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    const text = response.data.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI did not return JSON.");
    const parsedData = JSON.parse(jsonMatch[0]);
    const user = await db.getUser(userId);

    res.json({
      success: true,
      recipes: parsedData.recipes,
      remainingCredits: user ? user.credits : 0,
    });
  } catch (error) {
    console.error("cookWithIngredients error:", error.message);
    res.status(500).json({ error: "Backend Error" });
  }
});

// ═══════════════════════════════════════════
// 🧠 WEEKLY PLAN
// ═══════════════════════════════════════════
app.post("/generateWeeklyPlan", async (req, res) => {
  const userId = req.headers["userid"];
  const creditCheck = await db.checkAndDeductCredits(userId, CREDIT_COSTS.generateWeeklyPlan);
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  const { goal, country, diet_type, skill_level } = req.body;

  try {
    const prompt = `You are a professional nutritionist 
and culinary expert specializing in 
${country || "global"} cuisine.

Create a 7-day meal plan for someone:
From: ${country || "anywhere"}
Goal: ${goal || "healthy eating"}
Diet: ${diet_type || "no restrictions"}
Skill level: ${skill_level || "beginner"}
Cooking for: ${req.body.people_count || 1} person(s)

STRICT RULE: ALL meals in this plan MUST be 
traditional dishes from ${country || "their country"}.
Use locally available ingredients from 
${country || "their region"}.
Every meal name must be recognizable to someone 
living in ${country || "their country"}.
${country ? `Every single meal must be an authentic ${country} dish.` : ""}

Return ONLY valid JSON with no extra text:
{
  "plan": {
    "Monday": {
      "breakfast": "Local breakfast dish from ${country || "their country"}",
      "lunch": "Local lunch dish from ${country || "their country"}",
      "dinner": "Local dinner dish from ${country || "their country"}",
      "snack": "Local snack from ${country || "their country"}"
    },
    "Tuesday": {
      "breakfast": "Local breakfast dish",
      "lunch": "Local lunch dish",
      "dinner": "Local dinner dish",
      "snack": "Local snack"
    },
    "Wednesday": {
      "breakfast": "Local breakfast dish",
      "lunch": "Local lunch dish",
      "dinner": "Local dinner dish",
      "snack": "Local snack"
    },
    "Thursday": {
      "breakfast": "Local breakfast dish",
      "lunch": "Local lunch dish",
      "dinner": "Local dinner dish",
      "snack": "Local snack"
    },
    "Friday": {
      "breakfast": "Local breakfast dish",
      "lunch": "Local lunch dish",
      "dinner": "Local dinner dish",
      "snack": "Local snack"
    },
    "Saturday": {
      "breakfast": "Local breakfast dish",
      "lunch": "Local lunch dish",
      "dinner": "Local dinner dish",
      "snack": "Local snack"
    },
    "Sunday": {
      "breakfast": "Local breakfast dish",
      "lunch": "Local lunch dish",
      "dinner": "Local dinner dish",
      "snack": "Local snack"
    }
  },
  "shopping_list": {
    "proteins": ["local protein 1", "local protein 2"],
    "vegetables": ["local vegetable 1", "local vegetable 2"],
    "grains": ["local grain 1", "local grain 2"],
    "fruits": ["local fruit 1", "local fruit 2"],
    "condiments": ["local spice 1", "local spice 2"]
  },
  "cooking_tips": [
    "Practical cooking tip for ${country || "this region"}",
    "Another useful local cooking tip"
  ]
}

ALL 28 meals in the plan must be authentic 
traditional dishes from ${country || "the user's country"}.
Never include meals from other countries.`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    const text = response.data.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI did not return JSON.");
    const parsedData = JSON.parse(jsonMatch[0]);
    const user = await db.getUser(userId);

    res.json({
      success: true,
      plan: parsedData.plan,
      shopping_list: parsedData.shopping_list || {},
      cooking_tips: parsedData.cooking_tips || [],
      remainingCredits: user ? user.credits : 0,
    });
  } catch (error) {
    console.error("generateWeeklyPlan error:", error.message);
    res.status(500).json({ error: "Backend Error" });
  }
});

// ═══════════════════════════════════════════
// ♻️ LEFTOVER RESCUE
// ═══════════════════════════════════════════
app.post("/rescueLeftovers", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId)
    return res.status(401).json({ error: "User ID required" });

  const creditCheck = await db.checkAndDeductCredits(userId, CREDIT_COSTS.rescueLeftovers);
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  const { leftovers, country } = req.body;
  if (!leftovers)
    return res.status(400).json({ error: "leftovers required" });

  try {
    const prompt = `You are a culinary expert 
specializing in ${country || "global"} cuisine.

The user is from: ${country || "anywhere in the world"}

They have these leftover ingredients: 
${leftovers.join(", ")}

STRICT RULE: You MUST suggest ONLY meals that are 
traditionally prepared and eaten in ${country || "their country"}.
Do NOT suggest meals from other countries.
${country ? `Only suggest authentic ${country} dishes.` : ""}

For example:
- If country is Cameroon suggest Ndole, Eru, Mbanga soup, Poulet DG
- If country is Nigeria suggest Egusi, Jollof Rice, Pepper soup, Afang
- If country is Ghana suggest Fufu, Waakye, Banku, Kelewele
- If country is Italy suggest Pasta, Risotto, Pizza, Gnocchi
- If country is Japan suggest Ramen, Sushi, Miso soup, Onigiri
- If country is India suggest Biryani, Dal, Curry, Chapati
- If country is France suggest Ratatouille, Crepes, Quiche, Cassoulet
- If country is Mexico suggest Tacos, Enchiladas, Tamales, Pozole

Return ONLY valid JSON with no extra text:
{
  "recipes": [
    {
      "title": "Authentic meal name from ${country || "their country"}",
      "description": "Brief description of this local dish",
      "transformation_steps": [
        "Step 1 instruction",
        "Step 2 instruction",
        "Step 3 instruction"
      ],
      "extra_ingredients": [
        "additional ingredient needed"
      ],
      "cook_time": "30 minutes",
      "wow_factor": "Why this local dish is special",
      "country": "${country || "International"}",
      "is_local_dish": true
    }
  ]
}

Suggest exactly 10 meals.
ALL 10 meals must be traditional dishes 
from ${country || "the user's country"}.
Never suggest meals from other countries.`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    const text = response.data.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const user = await db.getUser(userId);

    res.json({
      success: true,
      recipes: JSON.parse(jsonMatch[0]).recipes,
      remainingCredits: user ? user.credits : 0,
    });
  } catch (error) {
    console.error("rescueLeftovers error:", error.message);
    res.status(500).json({ error: "Backend Error" });
  }
});

// ═══════════════════════════════════════════
// 🎥 EXTRACT RECIPE
// ═══════════════════════════════════════════
app.post("/extractRecipe", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId)
    return res.status(401).json({ error: "User ID required" });

  const creditCheck = await db.checkAndDeductCredits(userId, CREDIT_COSTS.extractRecipe);
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  const { mealName, url } = req.body;
  if (!mealName)
    return res.status(400).json({ error: "mealName required" });

  try {
    const prompt = `You are a professional chef. Provide a complete, detailed recipe based on this cooking video title: "${mealName}". ${url ? `Video URL context: ${url}.` : ""} Return ONLY valid JSON: { "meal_name": "", "description": "", "cooking_time": "", "servings": 4, "difficulty": "", "ingredients": [{ "name": "", "local_name": "", "quantity": "", "notes": "" }], "steps": [{ "number": 1, "title": "", "instruction": "", "duration": "" }], "tips": [] }`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    const text = response.data.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const user = await db.getUser(userId);
    const parsed = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      meal_name: parsed.meal_name,
      description: parsed.description,
      cooking_time: parsed.cooking_time,
      servings: parsed.servings,
      difficulty: parsed.difficulty,
      ingredients: parsed.ingredients,
      steps: parsed.steps,
      tips: parsed.tips,
      remainingCredits: user ? user.credits : 0,
    });
  } catch (error) {
    console.error("extractRecipe error:", error.message);
    res.status(500).json({ error: "Backend Error" });
  }
});

// ═══════════════════════════════════════════
// 📖 COOKING STEPS
// ═══════════════════════════════════════════
app.post("/getCookingSteps", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId)
    return res.status(401).json({ error: "User ID required" });

  const creditCheck = await db.checkAndDeductCredits(userId, CREDIT_COSTS.getCookingSteps);
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  const { mealName } = req.body;
  if (!mealName)
    return res.status(400).json({ error: "mealName required" });

  try {
    const prompt = `You are a professional chef. Provide a complete recipe for: ${mealName}. Return ONLY valid JSON: { "meal_name": "", "description": "", "cooking_time": "", "servings": 4, "difficulty": "", "ingredients": [{ "name": "", "local_name": "", "quantity": "", "notes": "" }], "steps": [{ "number": 1, "title": "", "instruction": "", "duration": "" }], "tips": [] }`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    const text = response.data.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const user = await db.getUser(userId);
    const parsed = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      meal_name: parsed.meal_name,
      description: parsed.description,
      cooking_time: parsed.cooking_time,
      servings: parsed.servings,
      difficulty: parsed.difficulty,
      ingredients: parsed.ingredients,
      steps: parsed.steps,
      tips: parsed.tips,
      remainingCredits: user ? user.credits : 0,
    });
  } catch (error) {
    console.error("getCookingSteps error:", error.message);
    res.status(500).json({ error: "Backend Error" });
  }
});

// ═══════════════════════════════════════════
// 💵 BUDGET MEALS
// ═══════════════════════════════════════════
app.post("/budgetMeals", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId)
    return res.status(401).json({ error: "User ID required" });

  const creditCheck = await db.checkAndDeductCredits(userId, CREDIT_COSTS.budgetMeals);
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  const { budget, currency, country, people_count } = req.body;
  if (!budget)
    return res.status(400).json({ error: "budget required" });

  try {
    const prompt = `You are a budget cooking expert 
who knows local food prices and markets in 
${country || "countries around the world"}.

The user is from: ${country || "anywhere"}
Their budget: ${budget} ${currency || "USD"}
Number of people: ${people_count || 1}

STRICT RULE: Suggest ONLY meals that are 
traditionally eaten in ${country || "their country"}.
Consider actual local market prices in 
${country || "their region"}.
Use ingredients that are easily found in 
local markets in ${country || "their area"}.
${country ? `Every single meal must be an authentic ${country} dish.` : ""}

Return ONLY valid JSON with no extra text:
{
  "budget_summary": {
    "budget": "${budget} ${currency || "USD"}",
    "per_person": "calculated cost per person",
    "verdict": "good budget or tight budget assessment"
  },
  "meals": [
    {
      "name": "Local meal name",
      "cuisine": "${country || "International"}",
      "estimated_cost": "cost in ${currency || "USD"}",
      "servings": 2,
      "cost_per_person": "cost per person",
      "prep_time": "30 minutes",
      "difficulty": "Easy",
      "why_affordable": "Why this is cheap in ${country || "this region"}",
      "money_saving_tip": "Local tip to save money on this dish",
      "local_market_tip": "Where to find ingredients in ${country || "local markets"}"
    }
  ],
  "general_tips": [
    "Local money saving cooking tip for ${country || "this region"}"
  ]
}

Suggest exactly 8 meals.
ALL 8 meals must be local traditional dishes 
from ${country || "the user's country"}.
Never suggest meals from other countries.`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    const text = response.data.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const user = await db.getUser(userId);

    res.json({
      success: true,
      ...JSON.parse(jsonMatch[0]),
      remainingCredits: user ? user.credits : 0,
    });
  } catch (error) {
    console.error("budgetMeals error:", error.message);
    res.status(500).json({ error: "Backend Error" });
  }
});

// ═══════════════════════════════════════════
// ✅ GET CREDIT PACKAGES
// ═══════════════════════════════════════════
app.get("/creditPackages", (req, res) => {
  const packages = Object.entries(CREDIT_PACKAGES).map(
    ([key, pkg]) => ({
      id: key,
      name: pkg.name,
      credits: pkg.credits,
      price_usd: pkg.price_usd,
      paddle_price_id: pkg.paddle_price_id,
      most_popular: pkg.most_popular || false,
      best_value: pkg.best_value || false,
      price_per_credit: (pkg.price_usd / pkg.credits).toFixed(3),
    })
  );

  res.json({
    success: true,
    packages,
    feature_costs: CREDIT_COSTS,
    signup_bonus: SIGNUP_BONUS_CREDITS,
    paddle_client_token: process.env.PADDLE_CLIENT_TOKEN,
  });
});

// ═══════════════════════════════════════════
// ✅ CREATE PADDLE CHECKOUT
// ═══════════════════════════════════════════
app.post("/createCheckout", requireAuth, async (req, res) => {
  const { email, package_id } = req.body;
  const user_id = req.user.id || req.user.userId || req.body.user_id;

  console.log("createCheckout called:", { user_id, email, package_id });

  if (!user_id || !email || !package_id) {
    return res.status(400).json({
      error: "user_id, email and package_id are required",
    });
  }

  const selectedPackage = CREDIT_PACKAGES[package_id];
  if (!selectedPackage) {
    return res.status(400).json({
      error: `Invalid package: ${package_id}`
    });
  }

  if (!selectedPackage.paddle_price_id) {
    return res.status(500).json({
      error: `Price ID missing for ${package_id}`,
      fix: `Add PADDLE_${package_id.toUpperCase()}_PRICE_ID to Railway variables`,
    });
  }

  await db.createUser(user_id, email);

  try {
    const transaction = await paddle.transactions.create({
      items: [
        {
          priceId: selectedPackage.paddle_price_id,
          quantity: 1,
        },
      ],
      customData: {
        user_id: user_id,
        package_id: package_id,
        credits: selectedPackage.credits.toString(),
      },
      customerEmail: email,
      successUrl: `https://cookandeathealthy.com/payment-success?package=${package_id}&user=${user_id}`,
    });

    console.log("Paddle transaction created:", transaction.id);

    const checkoutUrl = transaction.checkout?.url;

    if (!checkoutUrl) {
      console.error("No checkout URL from Paddle:", transaction);
      return res.status(500).json({
        error: "Paddle did not return a checkout URL",
        transaction_id: transaction.id,
      });
    }

    await db.savePayment({
      user_id,
      amount: selectedPackage.price_usd,
      currency: "USD",
      credits_added: selectedPackage.credits,
      package_id,
      payment_gateway: "paddle",
      payment_reference: transaction.id,
      status: "pending",
    });

    console.log("✅ Checkout created:", transaction.id);

    res.json({
      success: true,
      checkout_url: checkoutUrl,
      transaction_id: transaction.id,
    });
  } catch (error) {
    console.error("Paddle checkout error:", error.message);
    console.error("Full error:", JSON.stringify(error, null, 2));
    res.status(500).json({
      error: "Server error"
    });
  }
});

// ═══════════════════════════════════════════
// ✅ PADDLE WEBHOOK
// Fires automatically after every payment
// ═══════════════════════════════════════════
app.post("/webhook/paddle", async (req, res) => {
  const signature = req.headers["paddle-signature"];

  if (!signature) {
    console.error("No Paddle signature in webhook");
    return res.status(401).json({ error: "No signature" });
  }

  try {
    console.log("--- WEBHOOK DEBUG ---");
    console.log("Has rawBody?", !!req.rawBody);
    console.log("Secret length:", process.env.PADDLE_WEBHOOK_SECRET ? process.env.PADDLE_WEBHOOK_SECRET.length : 0);

    try {
      const parts = signature.split(';');
      let ts = '', h1 = '';
      for (const part of parts) {
        const [k, v] = part.split('=');
        if (k === 'ts') ts = v;
        if (k === 'h1') h1 = v;
      }
      const hmac = crypto.createHmac('sha256', process.env.PADDLE_WEBHOOK_SECRET);
      hmac.update(`${ts}:${req.rawBody}`);
      const computed = hmac.digest('hex');
      console.log("Computed Hash:", computed.substring(0, 8) + "...");
      console.log("Expected Hash:", h1.substring(0, 8) + "...");
      console.log("Does Hash Match?", computed === h1);
      console.log("Time Difference (sec):", (new Date().getTime() / 1000) - parseInt(ts));
    } catch (e) { }

    if (!req.rawBody) {
      console.error("rawBody is missing! Make sure express.json({ verify: ... }) is working.");
      return res.status(400).json({ error: "No raw body" });
    }

    const eventData = await paddle.webhooks.unmarshal(
      req.rawBody,
      process.env.PADDLE_WEBHOOK_SECRET,
      signature
    );

    console.log("Paddle webhook received:", eventData.eventType);

    if (eventData.eventType === "transaction.completed") {
      const transaction = eventData.data;
      const { user_id, package_id, credits } =
        transaction.customData || {};

      console.log("Transaction completed for user:", user_id);
      console.log("Credits to add:", credits);

      if (!user_id || !credits) {
        console.error("Missing custom data in webhook");
        return res.json({ received: true });
      }

      const transactionId = transaction.id;
      const existingPayment = await db.getCompletedPayment(transactionId);

      if (existingPayment) {
        console.log("Already processed:", transactionId);
        return res.json({ received: true });
      }

      let user = await db.getUser(user_id);
      if (!user) {
        await db.createUser(user_id, "");
        user = await db.getUser(user_id);
      }

      const creditsToAdd = parseInt(credits);
      const newBalance = (user.credits || 0) + creditsToAdd;

      await db.updateUserCredits(user_id, newBalance);

      await db.savePayment({
        user_id,
        amount: transaction.details?.totals?.total / 100,
        currency: "USD",
        credits_added: creditsToAdd,
        package_id,
        payment_gateway: "paddle",
        payment_reference: transactionId,
        status: "completed",
      });

      await db.saveUsageLog(user_id, "credit_purchase", creditsToAdd);

      console.log("\u2705 Payment processed!");
      console.log(`User: ${user_id}`);
      console.log(`Credits added: ${creditsToAdd}`);
      console.log(`New balance: ${newBalance}`);
    }

    if (eventData.eventType === "transaction.payment_failed") {
      const transaction = eventData.data;
      await db.savePayment({ payment_reference: transaction.id, status: "failed", user_id: transaction.customData?.user_id || "", amount: 0, credits_added: 0, package_id: "" });
      console.log("Payment failed:", transaction.id);
    }

    res.json({ received: true });
  } catch (error) {
    console.error("Paddle webhook error:", error.message);
    res.status(400).json({ error: "Webhook processing failed" });
  }
});

// ═══════════════════════════════════════════
// ✅ VERIFY PAYMENT
// ═══════════════════════════════════════════
app.post("/verifyPayment", async (req, res) => {
  const { transaction_id, user_id, package_id } = req.body;
  if (!user_id) return res.status(400).json({ error: "user_id required" });

  try {
    const completedPayment = await db.getLatestCompletedPayment(user_id);
    if (completedPayment) {
      const user = await db.getUser(user_id);
      return res.json({ success: true, verified: true, credits_added: completedPayment.credits_added, current_balance: user ? user.credits : 0 });
    }
    res.json({ success: false, verified: false, message: "Payment not confirmed yet. Please wait..." });
  } catch (error) {
    console.error("verifyPayment error:", error.message);
    res.status(500).json({ error: "Failed to verify payment" });
  }
});

// ═══════════════════════════════════════════
// ✅ GET CREDIT BALANCE
// ═══════════════════════════════════════════
app.get("/creditBalance", async (req, res) => {
  const user_id = req.headers["userid"] || req.query.user_id;
  if (!user_id) return res.status(401).json({ error: "User ID required" });

  try {
    let user = await db.getUser(user_id);
    if (!user) {
      await db.createUser(user_id, "");
      user = await db.getUser(user_id);
    }
    res.json({
      success: true,
      credits: user.credits,
      low_balance: user.credits <= 15,
      critical_balance: user.credits <= 8,
      empty: user.credits <= 0,
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ═══════════════════════════════════════════
// ✅ DEDUCT CREDITS
// ═══════════════════════════════════════════
app.post("/deductCredits", async (req, res) => {
  const { user_id, feature } = req.body;
  if (!user_id || !feature) return res.status(400).json({ error: "user_id and feature required" });

  const cost = CREDIT_COSTS[feature];
  if (!cost) return res.status(400).json({ error: "Invalid feature name" });

  try {
    let user = await db.getUser(user_id);
    if (!user) {
      await db.createUser(user_id, "");
      user = await db.getUser(user_id);
    }
    if (user.credits < cost) {
      return res.status(403).json({
        error: "insufficient_credits",
        message: `You need ${cost} credits. You have ${user.credits}.`,
        credits_needed: cost, credits_available: user.credits,
        credits_short: cost - user.credits, show_paywall: true,
      });
    }
    const newBalance = user.credits - cost;
    await db.updateUserCredits(user_id, newBalance);
    await db.saveUsageLog(user_id, feature, cost);
    res.json({ success: true, credits_used: cost, credits_remaining: newBalance, low_balance: newBalance <= 15, critical_balance: newBalance <= 8 });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ═══════════════════════════════════════════
// ✅ SIGNUP BONUS
// ═══════════════════════════════════════════
app.post("/signupBonus", async (req, res) => {
  const { user_id, email } = req.body;
  if (!user_id) return res.status(400).json({ error: "user_id required" });
  res.json({ success: true, message: "Credits already granted on signup" });
});

app.post("/createUser", async (req, res) => {
  const { user_id, email } = req.body;
  if (!user_id) return res.status(400).json({ error: "user_id required" });
  try {
    const user = await db.createUser(user_id, email || "");
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ═══════════════════════════════════════════
// 🚀 HOME + START SERVER
// ═══════════════════════════════════════════
app.get("/", (req, res) => {
  res.json({
    status: "🚀 Nutriverse API is running with Paddle",
    version: "3.0",
    payment_provider: "Paddle",
    test_mode: "✅ New users get 400 credits",
    endpoints: {
      features: [
        "GET /searchVideos?meal=",
        "GET /getMealImage?meal=",
        "POST /cookWithIngredients",
        "POST /generateWeeklyPlan",
        "POST /rescueLeftovers",
        "POST /getCookingSteps",
        "POST /budgetMeals",
      ],
      payments: [
        "GET /creditPackages",
        "GET /creditBalance",
        "POST /createCheckout",
        "POST /verifyPayment",
        "POST /deductCredits",
        "POST /signupBonus",
        "POST /createUser",
        "POST /webhook/paddle",
        "POST /addTestCredits",
      ],
    },
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🐘 Database: PostgreSQL`);
  console.log(`💳 Payment: Paddle`);
  console.log(`🎁 New users get ${SIGNUP_BONUS_CREDITS} credits on signup`);
});