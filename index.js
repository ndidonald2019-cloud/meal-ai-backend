const express = require("express");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
require('dotenv').config();

const app = express();
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

// ═══════════════════════════════════════════
// ENDPOINT 1 — What Can I Cook With This
// ═══════════════════════════════════════════
app.post("/cookWithIngredients", async (req, res) => {

  const userId = req.headers["userid"];
  if (!userId) return res.status(401).json({ error: "User ID required" });

  const creditCheck = checkAndDeductCredits(userId, CREDIT_COSTS.cookWithIngredients);
  if (creditCheck.error) return res.status(403).json({ error: creditCheck.error });

  const { ingredients, pantryItems, maxMissing, country } = req.body

  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: 'ingredients list is required' })
  }

  try {
    const prompt = `You are a culinary expert. Based on the following ingredients: ${ingredients.join(', ')}, and pantry items: ${pantryItems ? pantryItems.join(', ') : 'none'}, suggest 3-5 meal ideas that can be made with these ingredients, allowing up to ${maxMissing || 3} missing ingredients that can be easily obtained. Consider ${country || 'general'} cuisine preferences. For each meal, provide: name, description, list of ingredients used, missing ingredients, and approximate nutritional information per serving (calories, protein, carbs, fat). Return the response as a valid JSON object with a key "meals" containing an array of meal objects.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 2048 }
      }
    )

    const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text

    let result;
    try {
      const cleanText = rawText?.replace(/```json/g, '').replace(/```/g, '').trim();
      result = JSON.parse(cleanText);
    } catch (err) {
      return res.status(500).json({ error: 'AI returned invalid format. Try again.' });
    }

    res.json({ success: true, ...result, remainingCredits: users[userId].credits })

  } catch (error) {
    res.status(500).json({ error: 'Failed to get meal suggestions' })
  }
})

// ═══════════════════════════════════════════
// ENDPOINT 2 — Generate Weekly Meal Plan
// ═══════════════════════════════════════════
app.post("/generateWeeklyPlan", async (req, res) => {

  const userId = req.headers["userid"];
  if (!userId) return res.status(401).json({ error: "User ID required" });

  const creditCheck = checkAndDeductCredits(userId, CREDIT_COSTS.generateWeeklyPlan);
  if (creditCheck.error) return res.status(403).json({ error: creditCheck.error });

  const { goal } = req.body

  if (!goal) return res.status(400).json({ error: 'goal is required' })

  try {
    const prompt = `You are a nutritionist and meal planner. Create a 7-day meal plan based on the goal: ${goal}. Include breakfast, lunch, dinner, and snacks for each day. Each meal should have a name, brief description, and key ingredients. Make it balanced, healthy, and varied. Return as JSON with key "plan" as an object with days Monday-Sunday, each day having breakfast, lunch, dinner, snacks.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
      }
    )

    const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text

    let plan;
    try {
      const cleanText = rawText?.replace(/```json/g, '').replace(/```/g, '').trim();
      plan = JSON.parse(cleanText);
    } catch (err) {
      return res.status(500).json({ error: 'AI returned invalid format. Try again.' });
    }

    res.json({ success: true, plan, remainingCredits: users[userId].credits })

  } catch (error) {
    res.status(500).json({ error: 'Failed to generate meal plan' })
  }
})

// ═══════════════════════════════════════════
// ENDPOINT 3 — Leftover Rescue
// ═══════════════════════════════════════════
app.post("/rescueLeftovers", async (req, res) => {

  const userId = req.headers["userid"];
  if (!userId) return res.status(401).json({ error: "User ID required" });

  const creditCheck = checkAndDeductCredits(userId, CREDIT_COSTS.rescueLeftovers);
  if (creditCheck.error) return res.status(403).json({ error: creditCheck.error });

  const { leftovers } = req.body

  if (!Array.isArray(leftovers) || leftovers.length === 0) {
    return res.status(400).json({ error: 'leftovers list is required' })
  }

  try {
    const prompt = `You are a creative chef. Given these leftover ingredients: ${leftovers.join(', ')}, suggest 3-5 ways to use them up in new meals or recipes. For each suggestion, provide: name, description, additional ingredients needed (if any), and step-by-step instructions. Focus on reducing waste and making delicious food. Return as JSON with key "ideas" as array of objects.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 2048 }
      }
    )

    const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text

    let result;
    try {
      const cleanText = rawText?.replace(/```json/g, '').replace(/```/g, '').trim();
      result = JSON.parse(cleanText);
    } catch (err) {
      return res.status(500).json({ error: 'AI returned invalid format. Try again.' });
    }

    res.json({ success: true, ...result, remainingCredits: users[userId].credits })

  } catch (error) {
    res.status(500).json({ error: 'Failed to get rescue ideas' })
  }
})

// ═══════════════════════════════════════════
// ENDPOINT 4 — Cooking Steps
// ═══════════════════════════════════════════
app.post("/getCookingSteps", async (req, res) => {

  const userId = req.headers["userid"];
  if (!userId) return res.status(401).json({ error: "User ID required" });

  const creditCheck = checkAndDeductCredits(userId, CREDIT_COSTS.getCookingSteps);
  if (creditCheck.error) return res.status(403).json({ error: creditCheck.error });

  const { mealName } = req.body

  if (!mealName) return res.status(400).json({ error: 'mealName is required' })

  try {
    const prompt = `You are a cooking instructor. Provide detailed step-by-step cooking instructions for making ${mealName}. Include preparation time, cooking time, servings, ingredients list with quantities, and numbered steps. Make it clear and easy to follow. Return as JSON with keys: prepTime, cookTime, servings, ingredients (array), steps (array).`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 2048 }
      }
    )

    const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text

    let result;
    try {
      const cleanText = rawText?.replace(/```json/g, '').replace(/```/g, '').trim();
      result = JSON.parse(cleanText);
    } catch (err) {
      return res.status(500).json({ error: 'AI returned invalid format. Try again.' });
    }

    res.json({ success: true, ...result, remainingCredits: users[userId].credits })

  } catch (error) {
    res.status(500).json({ error: 'Failed to get cooking steps' })
  }
})

// ═══════════════════════════════════════════
// ENDPOINT 5 — Budget Meals
// ═══════════════════════════════════════════
app.post("/budgetMeals", async (req, res) => {

  const userId = req.headers["userid"];
  if (!userId) return res.status(401).json({ error: "User ID required" });

  const creditCheck = checkAndDeductCredits(userId, CREDIT_COSTS.budgetMeals);
  if (creditCheck.error) return res.status(403).json({ error: creditCheck.error });

  const { budget } = req.body

  if (!budget) return res.status(400).json({ error: 'budget is required' })

  try {
    const prompt = `You are a budget cooking expert. Suggest 5 affordable meal ideas that can be made for under $${budget} per serving. Each meal should be nutritious, tasty, and use common ingredients. Provide: name, estimated cost per serving, ingredients with quantities, brief instructions, and nutritional highlights. Return as JSON with key "meals" as array.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
      }
    )

    const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text

    let result;
    try {
      const cleanText = rawText?.replace(/```json/g, '').replace(/```/g, '').trim();
      result = JSON.parse(cleanText);
    } catch (err) {
      return res.status(500).json({ error: 'AI returned invalid format. Try again.' });
    }

    res.json({ success: true, ...result, remainingCredits: users[userId].credits })

  } catch (error) {
    res.status(500).json({ error: 'Failed to get budget meals' })
  }
})

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});