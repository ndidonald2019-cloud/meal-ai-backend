const express = require("express");
const axios = require("axios");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Paddle, Environment, EventName } = require("@paddle/paddle-node-sdk");
require("dotenv").config();

const app = express();
app.set("trust proxy", 1);

// ═══════════════════════════════════════════
// PADDLE SETUP
// ═══════════════════════════════════════════
const paddle = new Paddle(process.env.PADDLE_API_KEY, {
  environment: Environment.sandbox,
  // Using Sandbox for testing
});

// ═══════════════════════════════════════════
// WEBHOOK MUST COME BEFORE express.json()
// ═══════════════════════════════════════════
app.use(
  "/webhook/paddle",
  express.raw({ type: "application/json" })
);

// ═══════════════════════════════════════════
// NORMAL MIDDLEWARE
// ═══════════════════════════════════════════
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════
// JSON FILE DATABASE
// ═══════════════════════════════════════════
const DB_FILE = path.join(__dirname, "database.json");

function initDatabase() {
  if (!fs.existsSync(DB_FILE)) {
    const emptyDB = {
      users: {},
      payments: [],
      usage_logs: [],
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(emptyDB, null, 2));
    console.log("✅ Database file created");
  }
}

function readDB() {
  try {
    initDatabase();
    const data = fs.readFileSync(DB_FILE, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Error reading database:", error.message);
    return { users: {}, payments: [], usage_logs: [] };
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error("Error writing database:", error.message);
    return false;
  }
}

function getUser(user_id) {
  const db = readDB();
  return db.users[user_id] || null;
}

function createUser(user_id, email) {
  const db = readDB();
  if (!db.users[user_id]) {
    db.users[user_id] = {
      id: user_id,
      email: email || "",
      credits: 400,
      signup_bonus_given: false,
      created_at: new Date().toISOString(),
    };
    writeDB(db);
    console.log("New user created with 400 test credits:", user_id);
  }
  return db.users[user_id];
}

function updateUserCredits(user_id, newCredits) {
  const db = readDB();
  if (db.users[user_id]) {
    db.users[user_id].credits = newCredits;
    writeDB(db);
    return true;
  }
  return false;
}

function savePayment(paymentData) {
  const db = readDB();
  db.payments.push({
    ...paymentData,
    created_at: new Date().toISOString(),
  });
  writeDB(db);
}

function saveUsageLog(user_id, feature, credits_used) {
  const db = readDB();
  db.usage_logs.push({
    user_id,
    feature,
    credits_used,
    created_at: new Date().toISOString(),
  });
  writeDB(db);
}

initDatabase();

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
  rescueLeftovers: 3,
  getCookingSteps: 5,
  budgetMeals: 5,
};

const SIGNUP_BONUS_CREDITS = 10;

// ═══════════════════════════════════════════
// 🧠 CREDIT CHECKER
// ═══════════════════════════════════════════
function checkAndDeductCredits(userId, cost) {
  let db = readDB();
  if (!db.users[userId]) {
    createUser(userId, "");
    db = readDB();
  }

  const user = db.users[userId];
  if (!user) return { error: "User not found" };
  if (user.credits < cost) return { error: "Not enough credits" };

  const newCredits = user.credits - cost;
  updateUserCredits(userId, newCredits);

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
          // Initialize Paddle for Sandbox
          Paddle.Environment.set('sandbox');
          Paddle.Initialize({
            token: '${process.env.PADDLE_CLIENT_TOKEN}' // Ensure this is set in Railway!
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
          maxResults: 20,
          type: "video",
          videoEmbeddable: "true",
          videoSyndicated: "true",
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

  const creditCheck = checkAndDeductCredits(
    userId,
    CREDIT_COSTS.cookWithIngredients
  );
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  const { ingredients, country } = req.body;
  if (!ingredients)
    return res.status(400).json({ error: "ingredients required" });

  try {
    const prompt = `You are a professional chef. Suggest 3 meals using these ingredients: ${ingredients.join(
      ", "
    )}. The style should match ${
      country || "global"
    } cuisine. Return ONLY valid JSON with this structure: { "recipes": [{ "title": "", "description": "", "matchPercentage": 90, "missedIngredients": [], "usedIngredients": [], "cookTime": "", "difficulty": "" }] }`;

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
    const user = getUser(userId);

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
  const creditCheck = checkAndDeductCredits(
    userId,
    CREDIT_COSTS.generateWeeklyPlan
  );
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  const { goal, country, diet_type, skill_level } = req.body;

  try {
    const prompt = `Generate a 7-day meal plan for someone with goal: ${goal || "healthy eating"}, from ${country || "anywhere"}, diet: ${diet_type || "no restrictions"}, skill level: ${skill_level || "beginner"}. Return ONLY valid JSON: { "plan": { "Monday": { "breakfast": "", "lunch": "", "dinner": "", "snack": "" }, "Tuesday": { "breakfast": "", "lunch": "", "dinner": "", "snack": "" }, "Wednesday": { "breakfast": "", "lunch": "", "dinner": "", "snack": "" }, "Thursday": { "breakfast": "", "lunch": "", "dinner": "", "snack": "" }, "Friday": { "breakfast": "", "lunch": "", "dinner": "", "snack": "" }, "Saturday": { "breakfast": "", "lunch": "", "dinner": "", "snack": "" }, "Sunday": { "breakfast": "", "lunch": "", "dinner": "", "snack": "" } }, "shopping_list": { "proteins": [], "vegetables": [], "grains": [], "fruits": [], "condiments": [] }, "cooking_tips": [] }`;

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
    const user = getUser(userId);

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

  const creditCheck = checkAndDeductCredits(
    userId,
    CREDIT_COSTS.rescueLeftovers
  );
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  const { leftovers, country } = req.body;
  if (!leftovers)
    return res.status(400).json({ error: "leftovers required" });

  try {
    const prompt = `You are a creative chef. Transform these leftovers: ${leftovers.join(", ")} into 3 new exciting meals. Style: ${country || "global"}. Return ONLY valid JSON: { "recipes": [{ "title": "", "description": "", "transformation_steps": [], "extra_ingredients": [], "cook_time": "", "wow_factor": "" }] }`;

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
    const user = getUser(userId);

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
// 📖 COOKING STEPS
// ═══════════════════════════════════════════
app.post("/getCookingSteps", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId)
    return res.status(401).json({ error: "User ID required" });

  const creditCheck = checkAndDeductCredits(
    userId,
    CREDIT_COSTS.getCookingSteps
  );
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
    const user = getUser(userId);
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

  const creditCheck = checkAndDeductCredits(
    userId,
    CREDIT_COSTS.budgetMeals
  );
  if (creditCheck.error)
    return res.status(403).json({ error: creditCheck.error });

  const { budget, currency, country, people_count } = req.body;
  if (!budget)
    return res.status(400).json({ error: "budget required" });

  try {
    const prompt = `You are a budget cooking expert. Find 5 delicious meals under ${budget} ${currency || "USD"} for ${people_count || 1} person in ${country || "anywhere"}. Return ONLY valid JSON: { "budget_summary": { "budget": "", "per_person": "", "verdict": "" }, "meals": [{ "name": "", "cuisine": "", "estimated_cost": "", "servings": 2, "cost_per_person": "", "prep_time": "", "difficulty": "", "why_affordable": "", "money_saving_tip": "" }], "general_tips": [] }`;

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
    const user = getUser(userId);

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
app.post("/createCheckout", async (req, res) => {
  const { user_id, email, package_id } = req.body;

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

  createUser(user_id, email);

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

    savePayment({
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
      error: "Failed to create checkout",
      message: error.message,
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
    console.log("Is body a buffer?", Buffer.isBuffer(req.body));
    console.log("Body typeof:", typeof req.body);
    console.log("Secret length:", process.env.PADDLE_WEBHOOK_SECRET ? process.env.PADDLE_WEBHOOK_SECRET.length : 0);
    
    const eventData = await paddle.webhooks.unmarshal(
      req.body.toString(),
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

      const db = readDB();
      const transactionId = transaction.id;
      const existingPayment = db.payments.find(
        (p) =>
          p.payment_reference === transactionId &&
          p.status === "completed"
      );

      if (existingPayment) {
        console.log("Already processed:", transactionId);
        return res.json({ received: true });
      }

      let user = getUser(user_id);
      if (!user) {
        createUser(user_id, "");
        user = getUser(user_id);
      }

      const creditsToAdd = parseInt(credits);
      const newBalance = (user.credits || 0) + creditsToAdd;

      updateUserCredits(user_id, newBalance);

      savePayment({
        user_id,
        amount: transaction.details?.totals?.total / 100,
        currency: "USD",
        credits_added: creditsToAdd,
        package_id,
        payment_gateway: "paddle",
        payment_reference: transactionId,
        status: "completed",
      });

      saveUsageLog(user_id, "credit_purchase", -creditsToAdd);

      console.log("✅ Payment processed!");
      console.log(`User: ${user_id}`);
      console.log(`Credits added: ${creditsToAdd}`);
      console.log(`New balance: ${newBalance}`);
    }

    if (eventData.eventType === "transaction.payment_failed") {
      const transaction = eventData.data;
      const db = readDB();
      const payment = db.payments.find(
        p => p.payment_reference === transaction.id
      );
      if (payment) {
        payment.status = "failed";
        writeDB(db);
      }
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

  if (!user_id) {
    return res.status(400).json({ error: "user_id required" });
  }

  try {
    const db = readDB();
    const completedPayment = db.payments.find(
      (p) => p.user_id === user_id && p.status === "completed"
    );

    if (completedPayment) {
      const user = getUser(user_id);
      return res.json({
        success: true,
        verified: true,
        credits_added: completedPayment.credits_added,
        current_balance: user ? user.credits : 0,
      });
    }

    if (transaction_id) {
      const transaction = await paddle.transactions.get(
        transaction_id
      );

      if (transaction.status === "completed") {
        const pkg = CREDIT_PACKAGES[package_id];
        if (!pkg) {
          return res.status(400).json({ 
            error: "Package not found" 
          });
        }

        let user = getUser(user_id);
        if (!user) {
          createUser(user_id, "");
          user = getUser(user_id);
        }

        const newBalance = (user.credits || 0) + pkg.credits;
        updateUserCredits(user_id, newBalance);

        savePayment({
          user_id,
          amount: pkg.price_usd,
          currency: "USD",
          credits_added: pkg.credits,
          package_id,
          payment_gateway: "paddle",
          payment_reference: transaction_id,
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
// ✅ GET CREDIT BALANCE
// ═══════════════════════════════════════════
app.get("/creditBalance", async (req, res) => {
  const user_id = req.headers["userid"] || req.query.user_id;

  if (!user_id) {
    return res.status(401).json({ error: "User ID required" });
  }

  let user = getUser(user_id);
  if (!user) {
    createUser(user_id, "");
    user = getUser(user_id);
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
// ✅ DEDUCT CREDITS
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
    return res.status(400).json({ 
      error: "Invalid feature name" 
    });
  }

  let user = getUser(user_id);
  if (!user) {
    createUser(user_id, "");
    user = getUser(user_id);
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
  updateUserCredits(user_id, newBalance);
  saveUsageLog(user_id, feature, cost);

  res.json({
    success: true,
    credits_used: cost,
    credits_remaining: newBalance,
    low_balance: newBalance <= 15,
    critical_balance: newBalance <= 8,
  });
});

// ═══════════════════════════════════════════
// ✅ SIGNUP BONUS
// ═══════════════════════════════════════════
app.post("/signupBonus", async (req, res) => {
  const { user_id, email } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "user_id required" });
  }

  createUser(user_id, email || "");
  const user = getUser(user_id);

  if (user.signup_bonus_given) {
    return res.status(400).json({
      error: "Signup bonus already claimed",
    });
  }

  const newBalance = (user.credits || 0) + SIGNUP_BONUS_CREDITS;
  updateUserCredits(user_id, newBalance);

  const db = readDB();
  db.users[user_id].signup_bonus_given = true;
  writeDB(db);

  console.log(`🎁 Signup bonus given to ${user_id}`);

  res.json({
    success: true,
    credits_added: SIGNUP_BONUS_CREDITS,
    new_balance: newBalance,
    message: `🎁 ${SIGNUP_BONUS_CREDITS} free credits added!`,
  });
});

// ═══════════════════════════════════════════
// ✅ CREATE USER
// ═══════════════════════════════════════════
app.post("/createUser", async (req, res) => {
  const { user_id, email } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "user_id required" });
  }

  const existingUser = getUser(user_id);
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

  createUser(user_id, email || "");
  const newUser = getUser(user_id);

  res.json({
    success: true,
    message: "User created with 400 test credits",
    user: {
      id: newUser.id,
      credits: newUser.credits,
    },
  });
});

// ═══════════════════════════════════════════
// ✅ ADD TEST CREDITS
// ═══════════════════════════════════════════
app.post("/addTestCredits", async (req, res) => {
  const { user_id, amount } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "user_id required" });
  }

  let user = getUser(user_id);
  if (!user) {
    createUser(user_id, "");
    user = getUser(user_id);
  }

  const creditsToAdd = amount || 400;
  const newBalance = (user.credits || 0) + creditsToAdd;
  updateUserCredits(user_id, newBalance);

  res.json({
    success: true,
    credits_added: creditsToAdd,
    new_balance: newBalance,
    message: `${creditsToAdd} test credits added`,
  });
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
  console.log(`📁 Database: ${DB_FILE}`);
  console.log(`💳 Payment: Paddle`);
  console.log(`🧪 Test mode: New users get 400 credits`);
});