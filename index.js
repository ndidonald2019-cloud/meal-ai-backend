const express = require("express");
const axios = require("axios");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const {
  lemonSqueezySetup,
  createCheckout,
  getOrder,
} = require("@lemonsqueezy/lemonsqueezy.js");
require("dotenv").config();

const pool = require("./db");

// ═══════════════════════════════════════════
// AUTH SYSTEM (NEW — PostgreSQL)
// ═══════════════════════════════════════════
const authRoutes = require("./routes/auth");

const app = express();

// ═══════════════════════════════════════════
// WEBHOOK MUST COME BEFORE express.json()
// ═══════════════════════════════════════════
app.use(
  "/webhook/lemonsqueezy",
  express.raw({ type: "application/json" })
);

// ═══════════════════════════════════════════
// NORMAL MIDDLEWARE
// ═══════════════════════════════════════════
app.use(cors());
app.set("trust proxy", 1);
app.use(express.json());
app.use("/auth", authRoutes); // ← Auth routes mounted here

// ═══════════════════════════════════════════
// LEMON SQUEEZY SETUP
// ═══════════════════════════════════════════
lemonSqueezySetup({
  apiKey: process.env.LEMONSQUEEZY_API_KEY,
  onError: (error) => {
    console.error("LemonSqueezy error:", error);
  },
});

// ═══════════════════════════════════════════
// POSTGRESQL DATABASE
// Persistent storage — survives redeployments
// ═══════════════════════════════════════════

// Create tables on startup if they don't exist
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                TEXT PRIMARY KEY,
      email             TEXT NOT NULL DEFAULT '',
      credits           INTEGER NOT NULL DEFAULT 0,
      signup_bonus_given BOOLEAN NOT NULL DEFAULT FALSE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id                SERIAL PRIMARY KEY,
      user_id           TEXT NOT NULL,
      amount            NUMERIC(10, 2),
      currency          TEXT,
      credits_added     INTEGER,
      package_id        TEXT,
      payment_gateway   TEXT,
      payment_reference TEXT,
      status            TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id           SERIAL PRIMARY KEY,
      user_id      TEXT NOT NULL,
      feature      TEXT,
      credits_used INTEGER,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log("✅ PostgreSQL tables ready");
}

// Get user from database
async function getUser(user_id) {
  const result = await pool.query(
    "SELECT * FROM users WHERE id = $1",
    [user_id]
  );
  return result.rows[0] || null;
}

// Create new user in database (no-op if already exists)
async function createUser(user_id, email) {
  const result = await pool.query(
    `INSERT INTO users (id, email, credits, signup_bonus_given)
     VALUES ($1, $2, 0, FALSE)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [user_id, email || ""]
  );
  if (result.rows.length > 0) {
    console.log("New user created:", user_id);
    return result.rows[0];
  }
  // Already existed — return current row
  return getUser(user_id);
}

// Update user credits
async function updateUserCredits(user_id, newCredits) {
  const result = await pool.query(
    "UPDATE users SET credits = $1 WHERE id = $2",
    [newCredits, user_id]
  );
  return result.rowCount > 0;
}

// Save payment record
async function savePayment(paymentData) {
  await pool.query(
    `INSERT INTO payments
       (user_id, amount, currency, credits_added, package_id,
        payment_gateway, payment_reference, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      paymentData.user_id,
      paymentData.amount,
      paymentData.currency,
      paymentData.credits_added,
      paymentData.package_id,
      paymentData.payment_gateway,
      paymentData.payment_reference,
      paymentData.status,
    ]
  );
}

// Save usage log
async function saveUsageLog(user_id, feature, credits_used) {
  await pool.query(
    "INSERT INTO usage_logs (user_id, feature, credits_used) VALUES ($1, $2, $3)",
    [user_id, feature, credits_used]
  );
}

// Initialize database on startup
initDatabase().catch((err) => {
  console.error("❌ Failed to initialise database tables:", err.message);
  process.exit(1);
});

// ═══════════════════════════════════════════
// 💰 CREDIT PACKAGES
// ═══════════════════════════════════════════
const CREDIT_PACKAGES = {
  starter: {
    name: "Starter Pack",
    credits: 50,
    price_usd: 2.99,
    variant_id: process.env.LEMONSQUEEZY_STARTER_VARIANT_ID,
  },
  popular: {
    name: "Popular Pack",
    credits: 150,
    price_usd: 6.99,
    variant_id: process.env.LEMONSQUEEZY_POPULAR_VARIANT_ID,
    most_popular: true,
  },
  pro: {
    name: "Pro Pack",
    credits: 400,
    price_usd: 14.99,
    variant_id: process.env.LEMONSQUEEZY_PRO_VARIANT_ID,
    best_value: true,
  },
};

// ═══════════════════════════════════════════
// 💰 CREDIT COSTS PER FEATURE
// ═══════════════════════════════════════════
const CREDIT_COSTS = {
  cookWithIngredients: 5,
  generateWeeklyPlan: 15,
  rescueLeftovers: 3,
  getCookingSteps: 5,
  extractRecipe: 8,
  budgetMeals: 5,
  extractFromVideo: 8,
};

const SIGNUP_BONUS_CREDITS = 10;

// ═══════════════════════════════════════════
// 🧠 CREDIT CHECKER (PostgreSQL)
// ═══════════════════════════════════════════
async function checkAndDeductCredits(userId, cost) {
  // Auto-create user if not exists (for test-user), seed with 100 credits
  let user = await getUser(userId);
  if (!user) {
    await createUser(userId, "");
    await updateUserCredits(userId, 100);
    user = await getUser(userId);
  }

  if (!user) return { error: "User not found" };
  if (user.credits < cost) return { error: "Not enough credits" };

  const newCredits = user.credits - cost;
  await updateUserCredits(userId, newCredits);

  return { success: true, remaining: newCredits };
}

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
// 🔍 YOUTUBE SEARCH (UNCHANGED)
// ═══════════════════════════════════════════
app.get("/searchVideos", async (req, res) => {
  const meal = req.query.meal;
  if (!meal)
    return res
      .status(400)
      .json({ error: "meal parameter is required" });

  try {
    const response = await axios.get(
      "https://www.googleapis.com/youtube/v3/search",
      {
        params: {
          part: "snippet",
          q: `how to cook ${meal} recipe`,
          maxResults: 20,
          type: "video",
          videoEmbeddable: true,
          videoSyndicated: true,
          key: process.env.YOUTUBE_API_KEY,
        },
      }
    );

    const videos = response.data.items
      .filter((item) => item.id?.videoId)
      .slice(0, 15)
      .map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        thumbnail: item.snippet.thumbnails.medium.url,
        channel: item.snippet.channelTitle,
        embedUrl: `https://www.youtube.com/embed/${item.id.videoId}`,
      }));

    res.json({ success: true, videos });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch videos" });
  }
});

// ═══════════════════════════════════════════
// 🖼️ MEAL IMAGE (UNCHANGED)
// ═══════════════════════════════════════════
app.get("/getMealImage", async (req, res) => {
  const meal = req.query.meal;
  if (!meal)
    return res
      .status(400)
      .json({ error: "meal parameter is required" });

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
// 🍳 COOK WITH INGREDIENTS (UNCHANGED)
// ═══════════════════════════════════════════
app.post("/cookWithIngredients", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId)
    return res.status(401).json({ error: "User ID required" });

  const creditCheck = await checkAndDeductCredits(
    userId,
    CREDIT_COSTS.cookWithIngredients
  );
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  const { ingredients, country } = req.body;
  if (!ingredients)
    return res.status(400).json({ error: "ingredients required" });

  try {
    const prompt = `You are a professional chef. Suggest 10 delicious meals using these ingredients: ${ingredients.join(
      ", "
    )}. The style should match ${country || "global"
      } cuisine. Return ONLY valid JSON with this structure: { "recipes": [{"name": "meal name", "description": "short description", "prepTime": "X minutes", "difficulty": "easy/medium/hard"}, ...] }. Make sure to return exactly 10 different recipes.`

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
    if (!jsonMatch) throw new Error("AI did not return JSON format.");
    const parsedData = JSON.parse(jsonMatch[0]);

    const user = await getUser(userId);

    res.json({
      success: true,
      recipes: parsedData.recipes,
      remainingCredits: user ? user.credits : 0,
    });
  } catch (error) {
    res.status(500).json({ error: "Backend Error" });
  }
});

// ═══════════════════════════════════════════
// 🧠 WEEKLY PLAN (UNCHANGED)
// ═══════════════════════════════════════════
app.post("/generateWeeklyPlan", async (req, res) => {
  const userId = req.headers["userid"];
  const creditCheck = await checkAndDeductCredits(
    userId,
    CREDIT_COSTS.generateWeeklyPlan
  );
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  try {
    const prompt = `You are a professional nutritionist and meal planner. Generate a COMPLETE detailed 7-day meal plan with ALL information.

RETURN ONLY VALID JSON with NO other text:
{
  "plan": [
    {
      "day": "Monday",
      "breakfast": "Oatmeal with berries and honey - 400 calories",
      "lunch": "Grilled chicken breast with brown rice and steamed broccoli - 600 calories",
      "dinner": "Baked salmon with roasted vegetables - 650 calories",
      "snack": "Greek yogurt with almonds - 200 calories",
      "tips": "High protein day to support muscle building. Drink plenty of water."
    }
  ],
  "shoppingList": ["chicken breast 1kg", "salmon fillets 500g", "brown rice 1kg", "oats 500g", "honey 200g", "almonds 300g", "greek yogurt 500g", "broccoli 1 head", "bell peppers 2", "carrots 500g"],
  "weeklyTips": "Aim for balanced macros. Drink 8 glasses of water daily. Meal prep on Sunday for the week."
}

RULES:
- Include ALL 7 days (Monday to Sunday)
- EACH day must have: breakfast, lunch, dinner, snack, and tips
- Include estimated calories for each meal
- Include full shopping list with quantities
- Include weekly nutrition tips
- Return VALID JSON ONLY
- NO markdown or extra text`;

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
    
    // Extract JSON - handle markdown code blocks
    let jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (!jsonMatch) {
      jsonMatch = text.match(/\{[\s\S]*\}/);
    }
    if (!jsonMatch) {
      console.error("Failed to extract JSON from:", text.substring(0, 300));
      throw new Error("AI response is not valid JSON format");
    }
    
    // Get the JSON string (handle markdown case)
    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const parsedData = JSON.parse(jsonStr);

    const user = await getUser(userId);

    res.json({
      success: true,
      plan: parsedData.plan || [],
      shoppingList: parsedData.shoppingList || [],
      weeklyTips: parsedData.weeklyTips || "",
      remainingCredits: user ? user.credits : 0,
    });
  } catch (error) {
    console.error("Weekly plan error:", error.message);
    res.status(500).json({ error: "Backend Error" });
  }
});

// ═══════════════════════════════════════════
// ♻️ LEFTOVER RESCUE (UNCHANGED)
// ═══════════════════════════════════════════
app.post("/rescueLeftovers", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId)
    return res.status(401).json({ error: "User ID required" });

  const creditCheck = await checkAndDeductCredits(
    userId,
    CREDIT_COSTS.rescueLeftovers
  );
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  const { leftovers } = req.body;
  if (!leftovers)
    return res.status(400).json({ error: "leftovers required" });

  try {
    const prompt = `You are a professional chef. Suggest 10 creative recipes to rescue these leftovers: ${leftovers.join(
      ", "
    )}. Return ONLY valid JSON with this structure: { "recipes": [{"name": "meal name", "description": "short description", "prepTime": "X minutes", "difficulty": "easy/medium/hard"}, ...] }. Make sure to return exactly 10 different delicious recipes.`

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

    const user = await getUser(userId);

    res.json({
      success: true,
      recipes: JSON.parse(jsonMatch[0]).recipes,
      remainingCredits: user ? user.credits : 0,
    });
  } catch (error) {
    res.status(500).json({ error: "Backend Error" });
  }
});

// ═══════════════════════════════════════════
// 📖 COOKING STEPS (UNCHANGED)
// ═══════════════════════════════════════════
app.post("/getCookingSteps", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId)
    return res.status(401).json({ error: "User ID required" });

  const creditCheck = await checkAndDeductCredits(
    userId,
    CREDIT_COSTS.getCookingSteps
  );
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  const { mealName } = req.body;
  if (!mealName)
    return res.status(400).json({ error: "mealName required" });

  try {
    const prompt = `Steps for ${mealName}. JSON only.`;

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

    const user = await getUser(userId);

    res.json({
      success: true,
      steps: JSON.parse(jsonMatch[0]).steps,
      remainingCredits: user ? user.credits : 0,
    });
  } catch (error) {
    res.status(500).json({ error: "Backend Error" });
  }
});

// ═══════════════════════════════════════════
// 🎬 EXTRACT RECIPE (FROM VIDEO)
// Extracts ingredients and cooking steps from a meal
// ═══════════════════════════════════════════
app.post("/extractRecipe", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId)
    return res.status(401).json({ error: "User ID required" });

  const creditCheck = await checkAndDeductCredits(
    userId,
    CREDIT_COSTS.extractRecipe || 2
  );
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  const { mealName } = req.body;
  if (!mealName)
    return res.status(400).json({ error: "mealName required" });

  try {
    const prompt = `You are a professional chef. Extract a COMPLETE recipe for "${mealName}". 

IMPORTANT: Return ONLY a valid JSON object with NO other text, NO markdown, NO explanations. Use this EXACT structure:
{
  "ingredients": ["1 cup flour", "2 eggs", "1 tablespoon salt"],
  "steps": [
    "Step 1: Preheat oven to 350 degrees fahrenheit. This ensures even cooking throughout the recipe.",
    "Step 2: Mix flour and salt in a large bowl. Stir thoroughly until well combined.",
    "Step 3: Add eggs one at a time and beat until mixture is smooth and creamy."
  ],
  "cookTime": "30 minutes",
  "servings": "4 servings"
}

RULES:
- EVERY step must be detailed and explain exactly what to do
- EVERY step must start with 'Step X:' followed by a complete explanation
- NO numbered lists inside steps
- MINIMUM 3 steps, MAXIMUM 10 steps
- Each ingredient MUST include amount and unit
- Return VALID JSON only`;

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
    
    // Extract JSON - handle markdown code blocks
    let jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (!jsonMatch) {
      jsonMatch = text.match(/\{[\s\S]*\}/);
    }
    if (!jsonMatch) {
      console.error("Failed to extract JSON from:", text.substring(0, 300));
      throw new Error("AI did not return JSON format.");
    }
    
    // Get the JSON string (handle markdown case)
    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const parsedData = JSON.parse(jsonStr);
    
    const user = await getUser(userId);

    res.json({
      success: true,
      mealName,
      ingredients: parsedData.ingredients || [],
      steps: parsedData.steps || [],
      cookTime: parsedData.cookTime || "Unknown",
      servings: parsedData.servings || "Unknown",
      remainingCredits: user ? user.credits : 0,
    });
  } catch (error) {
    console.error("Extract recipe error:", error.message);
    res.status(500).json({ error: "Couldn't extract recipe. Try again." });
  }
});

// ═══════════════════════════════════════════
// 💵 BUDGET MEALS (UNCHANGED)
// ═══════════════════════════════════════════
app.post("/budgetMeals", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId)
    return res.status(401).json({ error: "User ID required" });

  const creditCheck = await checkAndDeductCredits(
    userId,
    CREDIT_COSTS.budgetMeals
  );
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  const { budget } = req.body;
  if (!budget)
    return res.status(400).json({ error: "budget required" });

  try {
    const prompt = `Meals under ${budget}. JSON only.`;

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

    const user = await getUser(userId);

    res.json({
      success: true,
      meals: JSON.parse(jsonMatch[0]).meals,
      remainingCredits: user ? user.credits : 0,
    });
  } catch (error) {
    res.status(500).json({ error: "Backend Error" });
  }
});

// ═══════════════════════════════════════════
// 🎬 EXTRACT RECIPE FROM VIDEO
// ═══════════════════════════════════════════
app.post("/extractFromVideo", async (req, res) => {
  console.log("=== /extractFromVideo endpoint hit ===");
  console.log("Request body:", JSON.stringify(req.body, null, 2));
  console.log("userId from headers:", req.headers["userid"]);
  console.log("videoUrl received:", req.body?.videoUrl);
  console.log("videoId received:", req.body?.videoId);

  const userId = req.headers["userid"];
  if (!userId)
    return res.status(401).json({ error: "User ID required" });

  const { videoUrl, videoId: rawVideoId } = req.body;

  if (!videoUrl && !rawVideoId)
    return res
      .status(400)
      .json({ error: "videoUrl or videoId is required" });

  // Extract video ID from URL if a full URL was provided
  let videoId = rawVideoId;
  if (!videoId && videoUrl) {
    const urlPatterns = [
      /[?&]v=([^&#]+)/,
      /youtu\.be\/([^?&#]+)/,
      /youtube\.com\/embed\/([^?&#]+)/,
      /youtube\.com\/shorts\/([^?&#]+)/,
    ];
    for (const pattern of urlPatterns) {
      const match = videoUrl.match(pattern);
      if (match) {
        videoId = match[1];
        break;
      }
    }
  }

  if (!videoId)
    return res
      .status(400)
      .json({ error: "Could not extract a valid YouTube video ID" });

  const creditCheck = await checkAndDeductCredits(
    userId,
    CREDIT_COSTS.extractFromVideo
  );
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  try {
    // Fetch video details (title + description) from YouTube Data API
    const ytResponse = await axios.get(
      "https://www.googleapis.com/youtube/v3/videos",
      {
        params: {
          part: "snippet",
          id: videoId,
          key: process.env.YOUTUBE_API_KEY,
        },
      }
    );

    const videoItem = ytResponse.data.items?.[0];
    if (!videoItem) {
      return res
        .status(404)
        .json({ error: "Video not found on YouTube" });
    }

    const title = videoItem.snippet.title || "";
    const description = videoItem.snippet.description || "";

    if (!description.trim()) {
      return res.status(422).json({
        error:
          "This video has no description to extract a recipe from",
      });
    }

    const prompt = `You are a professional chef and recipe extractor. \
A user wants to cook a recipe from a YouTube video titled: "${title}". \
Below is the video description which may contain the recipe. \
Extract the ingredients (with quantities) and step-by-step cooking instructions from it. \
If the description does not contain a full recipe, do your best to infer a reasonable recipe based on the video title. \
Return ONLY valid JSON in this exact format, with no extra text:
{
  "ingredients": [
    { "item": "ingredient name", "quantity": "amount and unit" }
  ],
  "steps": [
    "Step 1: ...",
    "Step 2: ..."
  ]
}

Video description:
${description.slice(0, 3000)}`;

    const aiResponse = await axios.post(
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

    const text = aiResponse.data.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch)
      throw new Error("AI did not return JSON format.");

    const parsed = JSON.parse(jsonMatch[0]);
    const user = await getUser(userId);

    await saveUsageLog(userId, "extractFromVideo", CREDIT_COSTS.extractFromVideo);

    res.json({
      success: true,
      videoId,
      title,
      ingredients: parsed.ingredients || [],
      steps: parsed.steps || [],
      remainingCredits: user ? user.credits : 0,
    });
  } catch (error) {
    console.error("extractFromVideo error — message:", error.message);
    console.error("extractFromVideo error — stack:", error.stack);
    console.error("extractFromVideo error — full:", error);
    res
      .status(500)
      .json({ error: "Couldn't extract recipe. Try again." });
  }
});

// ═══════════════════════════════════════════
// ✅ NEW — GET CREDIT PACKAGES
// ═══════════════════════════════════════════
app.get("/creditPackages", (req, res) => {
  const packages = Object.entries(CREDIT_PACKAGES).map(
    ([key, pkg]) => ({
      id: key,
      name: pkg.name,
      credits: pkg.credits,
      price_usd: pkg.price_usd,
      variant_id: pkg.variant_id,
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
  });
});

// ═══════════════════════════════════════════
// ✅ NEW — CREATE CHECKOUT
// ═══════════════════════════════════════════
app.post("/createCheckout", async (req, res) => {
  const { user_id, email, package_id } = req.body;

  if (!user_id || !email || !package_id) {
    return res.status(400).json({
      error: "user_id, email and package_id are required",
    });
  }

  const selectedPackage = CREDIT_PACKAGES[package_id];
  if (!selectedPackage) {
    return res.status(400).json({ error: "Invalid package id" });
  }

  // Create user in database if not exists
  await createUser(user_id, email);

  try {
    const checkout = await createCheckout(
      process.env.LEMONSQUEEZY_STORE_ID,
      selectedPackage.variant_id,
      {
        checkoutOptions: {
          embed: false,
          media: false,
          logo: true,
        },
        checkoutData: {
          email: email,
          custom: {
            user_id: user_id,
            package_id: package_id,
            credits: selectedPackage.credits.toString(),
          },
        },
        productOptions: {
          name: selectedPackage.name,
          description: `${selectedPackage.credits} AI credits for CookAndEatHealthy`,
          redirectUrl: `https://cookandeathealthy.com/payment-success?package=${package_id}&user=${user_id}`,
          receiptButtonText: "Start Cooking",
          receiptThankYouNote: `Your ${selectedPackage.credits} credits have been added!`,
        },
        expiresAt: null,
      }
    );

    // Log full response structure to diagnose SDK shape
    console.log(
      "🔍 Checkout raw response:",
      JSON.stringify(checkout, null, 2)
    );

    // Check if the SDK returned an error (e.g. bad API key, invalid variant ID)
    if (checkout.error) {
      console.error(
        "❌ Lemon Squeezy SDK error:",
        checkout.error,
        "| statusCode:",
        checkout.statusCode
      );
      return res.status(500).json({
        error: "Payment provider returned an error",
        message: checkout.error?.message || String(checkout.error),
        statusCode: checkout.statusCode,
      });
    }

    // Guard: make sure checkout.data exists before drilling into it
    if (!checkout.data) {
      console.error(
        "❌ Lemon Squeezy response has no data field. Full object:",
        JSON.stringify(checkout, null, 2)
      );
      return res.status(500).json({
        error: "Unexpected response from payment provider — no data returned",
      });
    }

    // SDK v4 returns: { data: { data: { id, attributes: { url, ... } } }, error, statusCode }
    // The JSON:API envelope sits at checkout.data; the actual resource is at checkout.data.data
    const checkoutId = checkout.data?.data?.id;
    const checkoutUrl = checkout.data?.data?.attributes?.url;

    console.log("✅ Checkout created — id:", checkoutId, "url:", checkoutUrl);

    if (!checkoutUrl) {
      console.error(
        "❌ No checkout URL in response. Full object:",
        JSON.stringify(checkout, null, 2)
      );
      return res.status(500).json({
        error: "No checkout URL returned from payment provider",
      });
    }

    // Save pending payment to database
    await savePayment({
      user_id,
      amount: selectedPackage.price_usd,
      currency: "USD",
      credits_added: selectedPackage.credits,
      package_id,
      payment_gateway: "lemonsqueezy",
      payment_reference: checkoutId,
      status: "pending",
    });

    res.json({
      success: true,
      checkout_url: checkoutUrl,
      checkout_id: checkoutId,
    });
  } catch (error) {
    console.error("Checkout error:", error.message);
    res.status(500).json({
      error: "Failed to create checkout",
      message: error.message,
    });
  }
});

// ═══════════════════════════════════════════
// ✅ NEW — LEMON SQUEEZY WEBHOOK
// Fires automatically after every payment
// ═══════════════════════════════════════════
app.post("/webhook/lemonsqueezy", async (req, res) => {
  const signature = req.headers["x-signature"];

  if (!signature) {
    console.error("No signature in webhook");
    return res.status(401).json({ error: "No signature" });
  }

  try {
    // Verify webhook is from Lemon Squeezy
    const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    const hmac = crypto.createHmac("sha256", secret);
    const digest = hmac.update(req.body).digest("hex");

    if (signature !== digest) {
      console.error("Invalid webhook signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const payload = JSON.parse(req.body.toString());
    const eventName = payload.meta?.event_name;

    console.log("LemonSqueezy webhook received:", eventName);

    if (eventName === "order_created") {
      const order = payload.data;
      const orderStatus = order.attributes?.status;

      console.log("Order status:", orderStatus);

      if (orderStatus === "paid") {
        const customData = payload.meta?.custom_data;
        const { user_id, package_id, credits } = customData;

        console.log("Processing payment for user:", user_id);

        if (!user_id || !credits) {
          console.error("Missing custom data");
          return res.json({ received: true });
        }

        // Check if already processed
        const orderId = order.id.toString();
        const existingPaymentResult = await pool.query(
          "SELECT id FROM payments WHERE payment_reference = $1 AND status = 'completed'",
          [orderId]
        );

        if (existingPaymentResult.rows.length > 0) {
          console.log("Already processed:", orderId);
          return res.json({ received: true });
        }

        // Get user current credits
        let user = await getUser(user_id);
        if (!user) {
          // Create user if not exists
          await createUser(user_id, "");
          user = await getUser(user_id);
        }

        const creditsToAdd = parseInt(credits);
        const newBalance = (user.credits || 0) + creditsToAdd;

        // Add credits to user
        await updateUserCredits(user_id, newBalance);

        // Save completed payment
        await savePayment({
          user_id,
          amount: order.attributes?.total / 100,
          currency: "USD",
          credits_added: creditsToAdd,
          package_id,
          payment_gateway: "lemonsqueezy",
          payment_reference: orderId,
          status: "completed",
        });

        // Save usage log
        await saveUsageLog(user_id, "credit_purchase", -creditsToAdd);

        console.log("✅ Payment fully processed!");
        console.log(`User: ${user_id}`);
        console.log(`Credits added: ${creditsToAdd}`);
        console.log(`New balance: ${newBalance}`);
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error.message);
    res.status(400).json({ error: "Webhook processing failed" });
  }
});

// ═══════════════════════════════════════════
// ✅ NEW — VERIFY PAYMENT
// ═══════════════════════════════════════════
app.post("/verifyPayment", async (req, res) => {
  const { order_id, user_id, package_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "user_id required" });
  }

  try {
    // Check database for a completed payment for this user
    const completedPaymentResult = await pool.query(
      "SELECT * FROM payments WHERE user_id = $1 AND status = 'completed' LIMIT 1",
      [user_id]
    );
    const completedPayment = completedPaymentResult.rows[0] || null;

    if (completedPayment) {
      const user = await getUser(user_id);
      return res.json({
        success: true,
        verified: true,
        credits_added: completedPayment.credits_added,
        current_balance: user ? user.credits : 0,
      });
    }

    // Check directly with Lemon Squeezy API
    if (order_id) {
      const order = await getOrder(order_id);

      if (order.data?.data?.attributes?.status === "paid") {
        const pkg = CREDIT_PACKAGES[package_id];
        if (!pkg) {
          return res
            .status(400)
            .json({ error: "Package not found" });
        }

        let user = await getUser(user_id);
        if (!user) {
          await createUser(user_id, "");
          user = await getUser(user_id);
        }

        const newBalance = (user.credits || 0) + pkg.credits;
        await updateUserCredits(user_id, newBalance);

        await savePayment({
          user_id,
          amount: pkg.price_usd,
          currency: "USD",
          credits_added: pkg.credits,
          package_id,
          payment_gateway: "lemonsqueezy",
          payment_reference: order_id.toString(),
          status: "completed",
        });

        return res.json({
          success: true,
          verified: true,
          credits_added: pkg.credits,
          new_balance: newBalance,
        });
      }
    }

    res.json({
      success: false,
      verified: false,
      message: "Payment not confirmed yet. Please wait...",
    });
  } catch (error) {
    console.error("verifyPayment error:", error.message);
    res.status(500).json({ error: "Failed to verify payment" });
  }
});

// ═══════════════════════════════════════════
// ✅ NEW — GET CREDIT BALANCE
// ═══════════════════════════════════════════
app.get("/creditBalance", async (req, res) => {
  const user_id =
    req.headers["userid"] || req.query.user_id;

  if (!user_id) {
    return res.status(401).json({ error: "User ID required" });
  }

  const user = await getUser(user_id);

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  res.json({
    success: true,
    credits: user.credits,
    low_balance: user.credits <= 15,
    critical_balance: user.credits <= 8,
    empty: user.credits <= 0,
  });
});

// ═══════════════════════════════════════════
// ✅ NEW — DEDUCT CREDITS
// Call after every successful AI response
// ═══════════════════════════════════════════
app.post("/deductCredits", async (req, res) => {
  const { user_id, feature } = req.body;

  if (!user_id || !feature) {
    return res.status(400).json({
      error: "user_id and feature required",
    });
  }

  const cost = CREDIT_COSTS[feature];
  if (!cost) {
    return res.status(400).json({ error: "Invalid feature name" });
  }

  const user = await getUser(user_id);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  if (user.credits < cost) {
    return res.status(403).json({
      error: "insufficient_credits",
      message: `You need ${cost} credits. You have ${user.credits}.`,
      credits_needed: cost,
      credits_available: user.credits,
      credits_short: cost - user.credits,
      show_paywall: true,
    });
  }

  const newBalance = user.credits - cost;
  await updateUserCredits(user_id, newBalance);
  await saveUsageLog(user_id, feature, cost);

  res.json({
    success: true,
    credits_used: cost,
    credits_remaining: newBalance,
    low_balance: newBalance <= 15,
    critical_balance: newBalance <= 8,
  });
});

// ═══════════════════════════════════════════
// ✅ NEW — SIGNUP BONUS
// Call right after user creates account
// ═══════════════════════════════════════════
app.post("/signupBonus", async (req, res) => {
  const { user_id, email } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "user_id required" });
  }

  // Create user if not exists
  await createUser(user_id, email || "");

  const user = await getUser(user_id);

  if (user.signup_bonus_given) {
    return res.status(400).json({
      error: "Signup bonus already claimed",
    });
  }

  const newBalance = (user.credits || 0) + SIGNUP_BONUS_CREDITS;
  await updateUserCredits(user_id, newBalance);

  // Mark bonus as given
  await pool.query(
    "UPDATE users SET signup_bonus_given = TRUE WHERE id = $1",
    [user_id]
  );

  console.log(`🎁 Signup bonus given to ${user_id}`);

  res.json({
    success: true,
    credits_added: SIGNUP_BONUS_CREDITS,
    new_balance: newBalance,
    message: `🎁 ${SIGNUP_BONUS_CREDITS} free credits added to your account!`,
  });
});

// ═══════════════════════════════════════════
// ✅ NEW — CREATE USER
// Call when user registers in your app
// ═══════════════════════════════════════════
app.post("/createUser", async (req, res) => {
  const { user_id, email } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "user_id required" });
  }

  const existingUser = await getUser(user_id);
  if (existingUser) {
    return res.json({
      success: true,
      message: "User already exists",
      user: {
        id: existingUser.id,
        credits: existingUser.credits,
      },
    });
  }

  await createUser(user_id, email || "");
  const newUser = await getUser(user_id);

  res.json({
    success: true,
    message: "User created successfully",
    user: {
      id: newUser.id,
      credits: newUser.credits,
    },
  });
});

// ═══════════════════════════════════════════
// 🚀 HOME + START SERVER
// ═══════════════════════════════════════════
app.get("/", (req, res) => {
  res.json({
    status: "🚀 Nutriverse API is running",
    version: "2.0 with LemonSqueezy payments",
    endpoints: {
      existing: [
        "GET /searchVideos?meal=",
        "GET /getMealImage?meal=",
        "POST /cookWithIngredients",
        "POST /generateWeeklyPlan",
        "POST /rescueLeftovers",
        "POST /getCookingSteps",
        "POST /extractRecipe",
        "POST /budgetMeals",
        "POST /extractFromVideo",
      ],
      payments: [
        "GET /creditPackages",
        "GET /creditBalance",
        "POST /createCheckout",
        "POST /verifyPayment",
        "POST /deductCredits",
        "POST /signupBonus",
        "POST /createUser",
        "POST /webhook/lemonsqueezy",
      ],
    },
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});