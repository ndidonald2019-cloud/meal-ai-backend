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
// RESEND EMAIL SETUP
// ═══════════════════════════════════════════
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY || 're_dummykey1234567890');

// ═══════════════════════════════════════════
// EMAIL HELPER FUNCTIONS
// ═══════════════════════════════════════════

async function sendWelcomeEmail(email, name) {
  try {
    // Fire and forget (no await if we want to run in background, but the user requested try/catch around the call, so we await the call to resend but we don't await the helper function in the endpoints)
    await resend.emails.send({
      from: 'CookAndEatHealthy <noreply@cookandeathealthy.com>',
      to: email,
      subject: '🍳 Welcome to CookAndEatHealthy!',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { 
              font-family: Inter, sans-serif; 
              background: #1A0A0A; 
              color: #F5ECD7;
              margin: 0;
              padding: 0;
            }
            .container {
              max-width: 600px;
              margin: 0 auto;
              padding: 40px 20px;
            }
            .header {
              text-align: center;
              padding: 40px 0;
              border-bottom: 1px solid rgba(255,255,255,0.1);
            }
            .logo {
              font-size: 28px;
              font-weight: 800;
              color: #E8A020;
            }
            .content { padding: 40px 0; }
            .greeting {
              font-size: 24px;
              font-weight: 700;
              color: #F5ECD7;
              margin-bottom: 16px;
            }
            .text {
              font-size: 16px;
              color: #D4B8A0;
              line-height: 1.7;
              margin-bottom: 16px;
            }
            .credits-box {
              background: rgba(232,160,32,0.15);
              border: 1px solid rgba(232,160,32,0.30);
              border-radius: 12px;
              padding: 24px;
              text-align: center;
              margin: 24px 0;
            }
            .credits-number {
              font-size: 48px;
              font-weight: 800;
              color: #E8A020;
            }
            .credits-label {
              font-size: 16px;
              color: #D4B8A0;
            }
            .button {
              display: inline-block;
              background: #E8A020;
              color: #1A0A0A;
              font-weight: 700;
              font-size: 16px;
              padding: 16px 32px;
              border-radius: 12px;
              text-decoration: none;
              margin: 24px 0;
            }
            .feature-item {
              padding: 12px 0;
              border-bottom: 1px solid rgba(255,255,255,0.06);
              font-size: 15px;
              color: #D4B8A0;
            }
            .footer {
              text-align: center;
              padding: 24px 0;
              border-top: 1px solid rgba(255,255,255,0.1);
              font-size: 13px;
              color: #9A7A6A;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div class="logo">🍳 CookAndEatHealthy</div>
            </div>
            <div class="content">
              <div class="greeting">
                Welcome ${name || 'Chef'}! 👋
              </div>
              <p class="text">
                You have successfully joined CookAndEatHealthy.
                Your personal AI cooking assistant is ready.
                We are excited to help you discover amazing 
                meals from around the world.
              </p>
              <div class="credits-box">
                <div class="credits-number">10 🪙</div>
                <div class="credits-label">
                  Free credits added to your account
                </div>
              </div>
              <p class="text">
                Use your free credits to explore:
              </p>
              <div class="feature-item">
                🥘 Cook With Ingredients — 5 credits
              </div>
              <div class="feature-item">
                🍱 Leftover Rescue — 3 credits
              </div>
              <div class="feature-item">
                💰 Budget Meals — 5 credits
              </div>
              <div class="feature-item">
                📖 Recipe Extraction — 5 credits
              </div>
              <div class="feature-item">
                🤖 Weekly Meal Plan — 15 credits
              </div>
              <div style="text-align:center;">
                <a href="https://cookandeathealthy.com" 
                   class="button">
                  Start Cooking Now →
                </a>
              </div>
              <p class="text">
                Need help? Contact us at
                support@cookandeathealthy.com
              </p>
            </div>
            <div class="footer">
              © 2026 CookAndEatHealthy. All rights reserved.
              <br>cookandeathealthy.com
            </div>
          </div>
        </body>
        </html>
      `
    });
    console.log('✅ Welcome email sent to:', email);
    return true;
  } catch (error) {
    console.error('Welcome email error:', error.message);
    return false;
  }
}

async function sendCreditPurchaseEmail(email, name, credits, amount, newBalance) {
  try {
    await resend.emails.send({
      from: 'CookAndEatHealthy <noreply@cookandeathealthy.com>',
      to: email,
      subject: `✅ ${credits} Credits Added to Your Account`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { 
              font-family: Inter, sans-serif;
              background: #1A0A0A;
              color: #F5ECD7;
              margin: 0;
              padding: 0;
            }
            .container {
              max-width: 600px;
              margin: 0 auto;
              padding: 40px 20px;
            }
            .logo {
              font-size: 28px;
              font-weight: 800;
              color: #E8A020;
              text-align: center;
              padding: 30px 0;
              border-bottom: 1px solid rgba(255,255,255,0.1);
            }
            .success-box {
              background: rgba(232,160,32,0.15);
              border: 1px solid rgba(232,160,32,0.30);
              border-radius: 12px;
              padding: 32px;
              text-align: center;
              margin: 32px 0;
            }
            .checkmark { font-size: 48px; }
            .success-title {
              font-size: 24px;
              font-weight: 700;
              color: #F5ECD7;
              margin: 16px 0 8px;
            }
            .credits-added {
              font-size: 36px;
              font-weight: 800;
              color: #E8A020;
            }
            .details-box {
              background: rgba(255,255,255,0.04);
              border: 1px solid rgba(255,255,255,0.08);
              border-radius: 12px;
              padding: 24px;
              margin: 24px 0;
            }
            .detail-row {
              display: flex;
              justify-content: space-between;
              padding: 12px 0;
              border-bottom: 1px solid rgba(255,255,255,0.06);
              font-size: 15px;
              color: #D4B8A0;
            }
            .detail-value {
              color: #F5ECD7;
              font-weight: 600;
            }
            .button {
              display: block;
              background: #E8A020;
              color: #1A0A0A;
              font-weight: 700;
              font-size: 16px;
              padding: 16px 32px;
              border-radius: 12px;
              text-decoration: none;
              text-align: center;
              margin: 24px 0;
            }
            .footer {
              text-align: center;
              padding: 24px 0;
              border-top: 1px solid rgba(255,255,255,0.1);
              font-size: 13px;
              color: #9A7A6A;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="logo">🍳 CookAndEatHealthy</div>
            <div class="success-box">
              <div class="checkmark">✅</div>
              <div class="success-title">
                Payment Successful!
              </div>
              <div class="credits-added">
                +${credits} Credits Added
              </div>
            </div>
            <div class="details-box">
              <div class="detail-row">
                <span>Credits purchased</span>
                <span class="detail-value">${credits} 🪙</span>
              </div>
              <div class="detail-row">
                <span>Amount paid</span>
                <span class="detail-value">$${amount}</span>
              </div>
              <div class="detail-row">
                <span>New balance</span>
                <span class="detail-value">${newBalance} 🪙</span>
              </div>
              <div class="detail-row">
                <span>Date</span>
                <span class="detail-value">
                  ${new Date().toLocaleDateString()}
                </span>
              </div>
            </div>
            <a href="https://cookandeathealthy.com" 
               class="button">
              Start Using Your Credits →
            </a>
            <div class="footer">
              © 2026 CookAndEatHealthy
              <br>Questions? support@cookandeathealthy.com
            </div>
          </div>
        </body>
        </html>
      `
    });
    console.log('✅ Purchase email sent to:', email);
    return true;
  } catch (error) {
    console.error('Purchase email error:', error.message);
    return false;
  }
}

async function sendLowBalanceEmail(email, name, credits) {
  try {
    await resend.emails.send({
      from: 'CookAndEatHealthy <noreply@cookandeathealthy.com>',
      to: email,
      subject: '⚠️ You are running low on credits',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body {
              font-family: Inter, sans-serif;
              background: #1A0A0A;
              color: #F5ECD7;
              margin: 0;
              padding: 0;
            }
            .container {
              max-width: 600px;
              margin: 0 auto;
              padding: 40px 20px;
            }
            .logo {
              font-size: 28px;
              font-weight: 800;
              color: #E8A020;
              text-align: center;
              padding: 30px 0;
              border-bottom: 1px solid rgba(255,255,255,0.1);
            }
            .warning-box {
              background: rgba(224,120,32,0.15);
              border: 1px solid rgba(224,120,32,0.40);
              border-radius: 12px;
              padding: 32px;
              text-align: center;
              margin: 24px 0;
            }
            .warning-icon { font-size: 48px; }
            .warning-title {
              font-size: 22px;
              font-weight: 700;
              color: #F5ECD7;
              margin: 16px 0 8px;
            }
            .credits-left {
              font-size: 36px;
              font-weight: 800;
              color: #E07820;
            }
            .text {
              font-size: 16px;
              color: #D4B8A0;
              line-height: 1.7;
              margin: 16px 0;
            }
            .package-card {
              background: rgba(255,255,255,0.04);
              border: 1px solid rgba(255,255,255,0.08);
              border-radius: 12px;
              padding: 20px 24px;
              margin: 12px 0;
              display: flex;
              justify-content: space-between;
              align-items: center;
            }
            .package-name {
              font-weight: 600;
              color: #F5ECD7;
              font-size: 16px;
            }
            .package-price {
              color: #9A7A6A;
              font-size: 14px;
              margin-top: 4px;
            }
            .package-credits {
              color: #E8A020;
              font-weight: 700;
              font-size: 18px;
            }
            .button {
              display: block;
              background: #E8A020;
              color: #1A0A0A;
              font-weight: 700;
              font-size: 16px;
              padding: 16px 32px;
              border-radius: 12px;
              text-decoration: none;
              text-align: center;
              margin: 24px 0;
            }
            .footer {
              text-align: center;
              padding: 24px 0;
              border-top: 1px solid rgba(255,255,255,0.1);
              font-size: 13px;
              color: #9A7A6A;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="logo">🍳 CookAndEatHealthy</div>
            <div class="warning-box">
              <div class="warning-icon">⚠️</div>
              <div class="warning-title">
                Running Low on Credits
              </div>
              <div class="credits-left">
                ${credits} credits left
              </div>
            </div>
            <p class="text">
              Hey ${name || 'Chef'}, you are almost out 
              of credits. Top up now to keep enjoying 
              AI-powered cooking features.
            </p>
            <div class="package-card">
              <div>
                <div class="package-name">Starter Pack</div>
                <div class="package-price">$2.99</div>
              </div>
              <div class="package-credits">50 🪙</div>
            </div>
            <div class="package-card">
              <div>
                <div class="package-name">Popular Pack</div>
                <div class="package-price">$6.99</div>
              </div>
              <div class="package-credits">150 🪙</div>
            </div>
            <div class="package-card">
              <div>
                <div class="package-name">Pro Pack</div>
                <div class="package-price">$14.99</div>
              </div>
              <div class="package-credits">400 🪙</div>
            </div>
            <a href="https://cookandeathealthy.com/pricing" 
               class="button">
              Top Up Credits Now →
            </a>
            <div class="footer">
              © 2026 CookAndEatHealthy
              <br>cookandeathealthy.com
            </div>
          </div>
        </body>
        </html>
      `
    });
    console.log('✅ Low balance email sent to:', email);
    return true;
  } catch (error) {
    console.error('Low balance email error:', error.message);
    return false;
  }
}


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
// 🔍 PADDLE DIAGNOSTIC TEST (TEMPORARY)
// ═══════════════════════════════════════════
app.get("/paddleTest", async (req, res) => {
  const results = {};

  // 1. Check env vars are set
  results.env = {
    PADDLE_API_KEY: process.env.PADDLE_API_KEY
      ? `SET (starts with: ${process.env.PADDLE_API_KEY.substring(0, 8)}...)`
      : "MISSING",
    PADDLE_CLIENT_TOKEN: process.env.PADDLE_CLIENT_TOKEN
      ? `SET (starts with: ${process.env.PADDLE_CLIENT_TOKEN.substring(0, 8)}...)`
      : "MISSING",
    PADDLE_STARTER_PRICE_ID: process.env.PADDLE_STARTER_PRICE_ID || "MISSING",
    PADDLE_POPULAR_PRICE_ID: process.env.PADDLE_POPULAR_PRICE_ID || "MISSING",
    PADDLE_PRO_PRICE_ID: process.env.PADDLE_PRO_PRICE_ID || "MISSING",
  };

  // 2. Test Paddle API — try listing customers
  try {
    const customers = await paddle.customers.list({ perPage: 1 });
    results.paddle_api = {
      status: "OK",
      message: "Paddle API key is valid and working",
      environment: "production",
    };
  } catch (err) {
    results.paddle_api = {
      status: "FAILED",
      error: err.message,
      detail: err?.error || err?.errors || null,
      hint: err.message?.includes("401") || err.message?.includes("unauthorized")
        ? "API key is wrong or still a sandbox key"
        : err.message?.includes("sandbox")
        ? "You are using a sandbox API key in production mode"
        : "Check Railway env vars",
    };
  }

  res.json(results);
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
    // ── Step 1: Find or create a Paddle Customer to get a real customerId ──
    // Live mode does NOT accept customerEmail — it requires a proper customerId.
    let customerId = null;
    try {
      const customerList = await paddle.customers.list({ search: email });
      const match = (customerList.data || []).find(
        (c) => c.email === email && c.status === "active"
      );
      if (match) {
        customerId = match.id;
        console.log("Found existing Paddle customer:", customerId);
      } else {
        const newCustomer = await paddle.customers.create({ email });
        customerId = newCustomer.id;
        console.log("Created new Paddle customer:", customerId);
      }
    } catch (customerErr) {
      // If create() failed because email already exists, extract existing ctm_ ID from error
      const conflictIdMatch = customerErr.message?.match(/ctm_[a-z0-9]+/);
      if (conflictIdMatch) {
        customerId = conflictIdMatch[0];
        console.log("Using existing Paddle customer from conflict:", customerId);
      } else {
        console.warn("Customer lookup failed:", customerErr.message);
      }
    }

    // ── Step 2: Build transaction payload ──
    const transactionPayload = {
      items: [{ priceId: selectedPackage.paddle_price_id, quantity: 1 }],
      customData: {
        user_id: user_id,
        package_id: package_id,
        credits: selectedPackage.credits.toString(),
      },
      successUrl: `https://cookandeathealthy.com/payment-success?package=${package_id}&user=${user_id}`,
    };

    if (customerId) {
      transactionPayload.customerId = customerId;
    } else {
      transactionPayload.customer = { email };
    }

    // ── Step 3: Create the transaction ──
    const transaction = await paddle.transactions.create(transactionPayload);
    console.log("Paddle transaction created:", transaction.id);

    const checkoutUrl = transaction.checkout?.url;
    if (!checkoutUrl) {
      console.error("No checkout URL from Paddle:", JSON.stringify(transaction, null, 2));
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

    console.log("Checkout created:", transaction.id);
    res.json({
      success: true,
      checkout_url: checkoutUrl,
      transaction_id: transaction.id,
    });
  } catch (error) {
    // Expose the real Paddle error so it is visible in the app (not just logs)
    const paddleDetail =
      error?.error?.detail ||
      error?.error?.code ||
      error?.errors ||
      error?.detail ||
      error.message;
    console.error("Paddle checkout error:", error.message);
    console.error("Paddle error detail:", JSON.stringify(error?.error || error, null, 2));
    res.status(500).json({
      error: "Payment setup failed",
      paddle_error: paddleDetail,
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

      // SEND PURCHASE EMAIL (Fire and forget)
      const userForEmail = await db.getUser(user_id);
      if (userForEmail && userForEmail.email) {
        sendCreditPurchaseEmail(
          userForEmail.email,
          userForEmail.name || 'Chef',
          creditsToAdd,
          (transaction.details?.totals?.total / 100) || 0,
          newBalance
        );
      }
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

    // SEND LOW BALANCE EMAIL (Fire and forget)
    if (newBalance <= 10 && newBalance > 0) {
      const userForEmail = await db.getUser(user_id);
      if (userForEmail && userForEmail.email) {
        sendLowBalanceEmail(
          userForEmail.email,
          userForEmail.name || 'Chef',
          newBalance
        );
      }
    }

    res.json({ success: true, credits_used: cost, credits_remaining: newBalance, low_balance: newBalance <= 15, critical_balance: newBalance <= 8 });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ═══════════════════════════════════════════
// ✅ SIGNUP BONUS
// ═══════════════════════════════════════════
app.post("/signupBonus", async (req, res) => {
  const { user_id, email, name } = req.body;
  if (!user_id) return res.status(400).json({ error: "user_id required" });
  
  if (email) {
    sendWelcomeEmail(email, name || 'Chef');
  }
  
  res.json({ success: true, message: "Credits already granted on signup" });
});

app.post("/createUser", async (req, res) => {
  const { user_id, email, name } = req.body;
  if (!user_id) return res.status(400).json({ error: "user_id required" });
  
  try {
    const existingUser = await db.getUser(user_id);
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

    const user = await db.createUser(user_id, email || "", { name: name || "" });
    res.json({
      success: true,
      message: "User created successfully",
      user: {
        id: user.id,
        credits: user.credits,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ═══════════════════════════════════════════
// 📧 TEST EMAIL ENDPOINT
// ═══════════════════════════════════════════
app.post("/testEmail", async (req, res) => {
  const { email, type } = req.body;

  if (!email) {
    return res.status(400).json({ 
      error: "email required" 
    });
  }

  try {
    let result = false;

    if (type === 'welcome') {
      result = await sendWelcomeEmail(email, 'Test User');
    } else if (type === 'purchase') {
      result = await sendCreditPurchaseEmail(
        email, 'Test User', 150, 6.99, 550
      );
    } else if (type === 'lowbalance') {
      result = await sendLowBalanceEmail(
        email, 'Test User', 8
      );
    } else {
      result = await sendWelcomeEmail(email, 'Test User');
    }

    res.json({
      success: result,
      message: result 
        ? 'Email sent successfully' 
        : 'Email failed to send'
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to send test email',
      message: error.message
    });
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