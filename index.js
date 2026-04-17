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
// 🍳 COOK WITH INGREDIENTS (OpenAI Version)
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
// 🧠 WEEKLY PLAN (OpenAI Version)
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
// ♻️ LEFTOVER RESCUE
// ═══════════════════════════════════════════
app.post("/rescueLeftovers", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId) return res.status(401).json({ error: "User ID required" });

  const creditCheck = checkAndDeductCredits(userId, CREDIT_COSTS.rescueLeftovers);
  if (creditCheck.error) return res.status(403).json({ error: creditCheck.error });

  const { leftovers } = req.body;
  if (!leftovers || leftovers.length === 0) return res.status(400).json({ error: 'leftovers required' });

  try {
    const prompt = `I have these leftovers: ${leftovers.join(', ')}. Suggest 3 creative recipes I can make with them.
    Return ONLY a valid JSON object in this exact format, with NO conversational text:
    {
      "recipes": [
        { "title": "Recipe Name", "description": "Brief description", "matchPercentage": 95, "missedIngredients": ["salt"] }
      ]
    }`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }] },
      { headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    const text = response.data.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI did not return JSON format.");

    res.json({ success: true, recipes: JSON.parse(jsonMatch[0]).recipes, remainingCredits: users[userId].credits });
  } catch (error) {
    console.error("RescueLeftovers Error:", error.response?.data || error.message);
    res.status(500).json({ error: `Backend Error: ${error.message}` });
  }
});

// ═══════════════════════════════════════════
// 📖 COOKING STEPS
// ═══════════════════════════════════════════
app.post("/getCookingSteps", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId) return res.status(401).json({ error: "User ID required" });

  const creditCheck = checkAndDeductCredits(userId, CREDIT_COSTS.getCookingSteps);
  if (creditCheck.error) return res.status(403).json({ error: creditCheck.error });

  const { mealName } = req.body;
  if (!mealName) return res.status(400).json({ error: 'mealName required' });

  try {
    const prompt = `Provide step-by-step cooking instructions for making ${mealName}.
    Return ONLY a valid JSON object in this exact format, with NO conversational text:
    {
      "steps": [
        "Step 1: prep...",
        "Step 2: cook..."
      ]
    }`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }] },
      { headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    const text = response.data.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI did not return JSON format.");

    res.json({ success: true, steps: JSON.parse(jsonMatch[0]).steps, remainingCredits: users[userId].credits });
  } catch (error) {
    console.error("CookingSteps Error:", error.response?.data || error.message);
    res.status(500).json({ error: `Backend Error: ${error.message}` });
  }
});

// ═══════════════════════════════════════════
// 💵 BUDGET MEALS
// ═══════════════════════════════════════════
app.post("/budgetMeals", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId) return res.status(401).json({ error: "User ID required" });

  const creditCheck = checkAndDeductCredits(userId, CREDIT_COSTS.budgetMeals);
  if (creditCheck.error) return res.status(403).json({ error: creditCheck.error });

  const { budget } = req.body;
  if (!budget) return res.status(400).json({ error: 'budget required' });

  try {
    const prompt = `Suggest 3 highly nutritious meals that can be made for under $${budget} total.
    Return ONLY a valid JSON object in this exact format, with NO conversational text:
    {
      "meals": [
        { "title": "Meal Name", "cost": "$5", "description": "Brief description" }
      ]
    }`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }] },
      { headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    const text = response.data.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI did not return JSON format.");

    res.json({ success: true, meals: JSON.parse(jsonMatch[0]).meals, remainingCredits: users[userId].credits });
  } catch (error) {
    console.error("BudgetMeals Error:", error.response?.data || error.message);
    res.status(500).json({ error: `Backend Error: ${error.message}` });
  }
});

// ═══════════════════════════════════════════
// 🥗 NUTRITION & DIET PLAN
// ═══════════════════════════════════════════
app.post("/getNutrition", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId) return res.status(401).json({ error: "User ID required" });

  const { goal } = req.body;
  if (!goal) return res.status(400).json({ error: 'goal required' });

  try {
    const prompt = `Provide nutritional advice and diet planning for someone with the goal to: "${goal}".
    Return ONLY a valid JSON object in this exact format, with NO conversational text:
    {
      "foodsToEatMore": ["food 1", "food 2"],
      "foodsToReduce": ["food 1", "food 2"],
      "mealIdeas": ["meal idea 1", "meal idea 2"]
    }`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }] },
      { headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    const text = response.data.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI did not return JSON format.");

    // Spread the parsed JSON object directly into the response
    res.json({ success: true, ...JSON.parse(jsonMatch[0]), remainingCredits: users[userId].credits });
  } catch (error) {
    console.error("GetNutrition Error:", error.response?.data || error.message);
    res.status(500).json({ error: `Backend Error: ${error.message}` });
  }
});

// ═══════════════════════════════════════════
// 📝 EXTRACT RECIPE
// ═══════════════════════════════════════════
app.post("/extractRecipe", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId) return res.status(401).json({ error: "User ID required" });

  const { mealName, videoTitle } = req.body;
  if (!mealName) return res.status(400).json({ error: 'mealName required' });

  try {
    const prompt = `Write a highly detailed recipe for ${mealName}. (Context to help: ${videoTitle || ''}).
    Return ONLY a valid JSON object in this exact format, with NO conversational text:
    {
      "ingredients": ["1 cup rice", "2 tomatoes"],
      "steps": ["Step 1...", "Step 2..."],
      "cookingTime": "30 mins",
      "tips": ["Tip 1", "Tip 2"]
    }`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }] },
      { headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    const text = response.data.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI did not return JSON format.");

    res.json({ success: true, ...JSON.parse(jsonMatch[0]), remainingCredits: users[userId].credits });
  } catch (error) {
    console.error("ExtractRecipe Error:", error.response?.data || error.message);
    res.status(500).json({ error: `Backend Error: ${error.message}` });
  }
});


// ═══════════════════════════════════════════
// 🚀 START SERVER
// ═══════════════════════════════════════════
app.get("/", (req, res) => {
  res.send("🚀 Nutriverse API is running (OpenAI)");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
