const express = require("express");
const axios = require("axios");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

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
    const prompt = `You are a professional chef. Suggest 3 meals using these ingredients: ${ingredients.join(', ')}. The style should match ${country || 'global'} cuisine. 
    Return ONLY a valid JSON object in this exact format, with NO conversational text:
    {
      "recipes": [
        { "title": "Recipe Name", "description": "Brief description", "matchPercentage": 90, "missedIngredients": ["salt"] }
      ]
    }`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const text = response.data.candidates[0].content.parts[0].text;
    
    // Bulletproof JSON extractor
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI did not return JSON format.");
    
    const parsedData = JSON.parse(jsonMatch[0]);

    res.json({ success: true, recipes: parsedData.recipes, remainingCredits: users[userId].credits });

  } catch (error) {
    console.error("CookWithIngredients Error:", error.response?.data || error.message);
    const errorMsg = error.response?.data?.error?.message || error.message || 'AI failed';
    res.status(500).json({ error: `Backend Error: ${errorMsg}` });
  }
});

// ═══════════════════════════════════════════
// 🧠 WEEKLY PLAN
// ═══════════════════════════════════════════
app.post("/generateWeeklyPlan", async (req, res) => {
  const userId = req.headers["userid"];
  const creditCheck = checkAndDeductCredits(userId, CREDIT_COSTS.generateWeeklyPlan);
  if (creditCheck.error) return res.status(403).json({ error: creditCheck.error });

  try {
    const prompt = `Generate a 7-day healthy meal plan. 
    Return ONLY a valid JSON object in this exact format, with NO conversational text:
    {
      "plan": {
        "Monday": { "breakfast": "Oats", "lunch": "Salad", "dinner": "Chicken" },
        "Tuesday": { "breakfast": "Eggs", "lunch": "Wrap", "dinner": "Fish" }
      }
    }`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const text = response.data.candidates[0].content.parts[0].text;
    
    // Bulletproof JSON extractor
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI did not return JSON format.");

    const parsedData = JSON.parse(jsonMatch[0]);

    res.json({ success: true, plan: parsedData.plan, remainingCredits: users[userId].credits });

  } catch (error) {
    console.error("WeeklyPlan Error:", error.response?.data || error.message);
    const errorMsg = error.response?.data?.error?.message || error.message || 'AI failed';
    res.status(500).json({ error: `Backend Error: ${errorMsg}` });
  }
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
