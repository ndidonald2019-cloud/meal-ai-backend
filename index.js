const express = require("express");
const axios = require("axios");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

// 💳 PAYMENT SYSTEM (Paddle)
const { Paddle, Environment } = require('@paddle/paddle-node-sdk');

const paddle = new Paddle(process.env.PADDLE_API_KEY, {
  environment: Environment.Sandbox
});

// 📦 CREDIT PACKAGES
const CREDIT_PACKAGES = {
  starter: {
    name: "Starter Pack",
    credits: 50,
    price_usd: 2.99,
    paddle_price_id: process.env.PADDLE_STARTER_PRICE_ID
  },
  popular: {
    name: "Popular Pack",
    credits: 150,
    price_usd: 6.99,
    paddle_price_id: process.env.PADDLE_POPULAR_PRICE_ID
  },
  pro: {
    name: "Pro Pack",
    credits: 400,
    price_usd: 14.99,
    paddle_price_id: process.env.PADDLE_PRO_PRICE_ID
  }
};

// 🎁 SIGNUP BONUS
const SIGNUP_BONUS_CREDITS = 10;

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 Simple in-memory users (MVP)
const users = {
  "test-user": { credits: 100 }
};

// 💰 Credit costs
const CREDIT_COSTS = {
  cookWithIngredients: 5,
  generateWeeklyPlan: 15,
  rescueLeftovers: 3,
  getCookingSteps: 5,
  budgetMeals: 5
};

// 🧠 Credit checker
function checkAndDeductCredits(userId, cost) {
  const user = users[userId];

  if (!user) return { error: "User not found" };
  if (user.credits < cost) return { error: "Not enough credits" };

  user.credits -= cost;
  return { success: true, remaining: user.credits };
}

// 🚫 Rate limiter
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many requests, slow down." }
});

app.use(limiter);

const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════
// 🔍 YOUTUBE SEARCH
// ═══════════════════════════════════════════
app.get("/searchVideos", async (req, res) => {
  const meal = req.query.meal;
  if (!meal) return res.status(400).json({ error: 'meal parameter is required' });

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
      .filter(item => item.id?.videoId)
      .slice(0, 15)
      .map(item => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        thumbnail: item.snippet.thumbnails.medium.url,
        channel: item.snippet.channelTitle,
        embedUrl: `https://www.youtube.com/embed/${item.id.videoId}`
      }));

    res.json({ success: true, videos });

  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
});

// ═══════════════════════════════════════════
// 🖼️ MEAL IMAGE
// ═══════════════════════════════════════════
app.get("/getMealImage", async (req, res) => {
  const meal = req.query.meal;
  if (!meal) return res.status(400).json({ error: 'meal parameter is required' });

  try {
    const response = await axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: process.env.PEXELS_API_KEY },
      params: { query: meal + ' food dish', per_page: 3 }
    });

    const photo = response.data.photos[0];

    res.json({
      success: true,
      image: {
        url: photo?.src?.large || "",
        alt: photo?.alt || meal
      }
    });

  } catch {
    res.status(500).json({ error: 'Failed to fetch image' });
  }
});

// ═══════════════════════════════════════════
// 🍳 COOK WITH INGREDIENTS
// ═══════════════════════════════════════════
app.post("/cookWithIngredients", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId) return res.status(401).json({ error: "User ID required" });

  const creditCheck = checkAndDeductCredits(userId, CREDIT_COSTS.cookWithIngredients);
  if (creditCheck.error) return res.status(403).json({ error: creditCheck.error });

  const { ingredients, country } = req.body;
  if (!ingredients) return res.status(400).json({ error: 'ingredients required' });

  try {
    const prompt = `You are a professional chef. Suggest 3 meals using: ${ingredients.join(', ')}.`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }]
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    const text = response.data.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsedData = JSON.parse(jsonMatch[0]);

    res.json({ success: true, recipes: parsedData.recipes, remainingCredits: users[userId].credits });

  } catch (error) {
    res.status(500).json({ error: 'AI failed' });
  }
});

// ═══════════════════════════════════════════
// 💳 PAYMENT SYSTEM ENDPOINTS (ADDED)
// ═══════════════════════════════════════════

// GET PACKAGES
app.get("/creditPackages", (req, res) => {
  const packages = Object.entries(CREDIT_PACKAGES).map(([key, value]) => ({
    id: key,
    ...value,
    price_per_credit: (value.price_usd / value.credits).toFixed(4)
  }));

  res.json({
    success: true,
    packages,
    signup_bonus: SIGNUP_BONUS_CREDITS
  });
});

// CREATE CHECKOUT
app.post("/createCheckout", async (req, res) => {
  const { user_id, email, package_id } = req.body;

  if (!user_id || !email || !package_id) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const selected = CREDIT_PACKAGES[package_id];
  if (!selected) return res.status(400).json({ error: "Invalid package" });

  try {
    const transaction = await paddle.transactions.create({
      items: [{
        priceId: selected.paddle_price_id,
        quantity: 1
      }],
      customerEmail: email,
      customData: {
        user_id,
        package_id,
        credits: selected.credits
      }
    });

    res.json({
      success: true,
      checkout_url: transaction.checkout.url,
      transaction_id: transaction.id
    });

  } catch (err) {
    res.status(500).json({ error: "Checkout failed" });
  }
});

// SIMPLE TEST BALANCE
app.get("/creditBalance", (req, res) => {
  const user = users["test-user"];
  res.json({ credits: user.credits });
});

// DEDUCT CREDITS TEST
app.post("/deductCredits", (req, res) => {
  const { feature } = req.body;
  const user = users["test-user"];

  const cost = CREDIT_COSTS[feature];

  if (user.credits < cost) {
    return res.status(403).json({ error: "Not enough credits" });
  }

  user.credits -= cost;

  res.json({
    success: true,
    remaining: user.credits
  });
});

// ═══════════════════════════════════════════
// 🚀 START SERVER
// ═══════════════════════════════════════════
app.get("/", (req, res) => {
  res.send("🚀 Nutriverse API is running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
