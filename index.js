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
// ✅ FIXED — Cook With Ingredients
// ═══════════════════════════════════════════
app.post("/cookWithIngredients", async (req, res) => {

  const { ingredients, country, user_id } = req.body

  if (!ingredients || ingredients.length === 0) {
    return res.status(400).json({ error: 'ingredients list is required' })
  }

  try {
    const ingredientsList = Array.isArray(ingredients) 
      ? ingredients.join(', ') 
      : ingredients

    const prompt = `You are a professional chef who knows global cuisines.

The user has these ingredients: ${ingredientsList}
Their location: ${country || 'International'}

Suggest exactly 3 meals they can cook with these ingredients.
Include both Western and local meals when relevant.

Return ONLY this exact JSON structure with no extra text:
{
  "recipes": [
    {
      "title": "Meal Name Here",
      "description": "One sentence about this meal",
      "cuisine": "Italian or Nigerian etc",
      "cook_time": "30 minutes",
      "difficulty": "Beginner",
      "matchPercentage": 90,
      "usedIngredients": ["egg", "rice"],
      "missedIngredients": ["salt", "oil"],
      "calories": "350 per serving"
    },
    {
      "title": "Second Meal Name",
      "description": "One sentence about this meal",
      "cuisine": "cuisine type",
      "cook_time": "20 minutes",
      "difficulty": "Beginner",
      "matchPercentage": 75,
      "usedIngredients": ["egg"],
      "missedIngredients": ["tomato", "pepper"],
      "calories": "280 per serving"
    },
    {
      "title": "Third Meal Name",
      "description": "One sentence about this meal",
      "cuisine": "cuisine type",
      "cook_time": "45 minutes",
      "difficulty": "Intermediate",
      "matchPercentage": 60,
      "usedIngredients": ["rice"],
      "missedIngredients": ["chicken", "spices"],
      "calories": "420 per serving"
    }
  ]
}`

    console.log('Calling Gemini for cookWithIngredients...')
    console.log('Ingredients:', ingredientsList)

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024,
          topP: 0.8,
          topK: 40
        }
      },
      { 
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    )

    // Log full response for debugging
    console.log('Gemini status:', response.status)

    const candidate = response.data?.candidates?.[0]
    
    if (!candidate) {
      console.error('No candidates in response:', 
        JSON.stringify(response.data, null, 2))
      return res.status(500).json({ 
        error: 'Gemini returned no candidates',
        details: response.data 
      })
    }

    // Check for content filter blocks
    if (candidate.finishReason === 'SAFETY') {
      console.error('Gemini blocked by safety filter')
      return res.status(500).json({ 
        error: 'Content was blocked by AI safety filter' 
      })
    }

    const text = candidate?.content?.parts?.[0]?.text

    if (!text) {
      console.error('No text in candidate:', 
        JSON.stringify(candidate, null, 2))
      return res.status(500).json({ 
        error: 'Gemini returned empty text' 
      })
    }

    console.log('Raw Gemini response:', text)

    // Clean the response
    const cleanJson = text
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .replace(/^\s*[\r\n]/gm, '')
      .trim()

    let parsedData
    try {
      parsedData = JSON.parse(cleanJson)
    } catch (err) {
      console.error('JSON PARSE ERROR')
      console.error('Raw text was:', cleanJson)
      return res.status(500).json({
        error: 'AI returned invalid JSON format',
        raw: cleanJson.substring(0, 500)
      })
    }

    if (!parsedData.recipes || !Array.isArray(parsedData.recipes)) {
      console.error('Missing recipes array:', parsedData)
      return res.status(500).json({
        error: 'AI response missing recipes array'
      })
    }

    res.json({
      success: true,
      recipes: parsedData.recipes,
      count: parsedData.recipes.length
    })

  } catch (error) {
    // Detailed error logging
    if (error.response) {
      // Gemini API returned an error response
      console.error('Gemini API Error Status:', error.response.status)
      console.error('Gemini API Error Data:', 
        JSON.stringify(error.response.data, null, 2))
      
      if (error.response.status === 400) {
        return res.status(500).json({ 
          error: 'Invalid request to AI',
          details: error.response.data?.error?.message 
        })
      }
      if (error.response.status === 429) {
        return res.status(429).json({ 
          error: 'AI rate limit reached. Please try again in a moment.' 
        })
      }
      if (error.response.status === 403) {
        return res.status(500).json({ 
          error: 'Gemini API key is invalid or quota exceeded' 
        })
      }
    } else if (error.code === 'ECONNABORTED') {
      console.error('Gemini request timed out')
      return res.status(500).json({ 
        error: 'AI request timed out. Please try again.' 
      })
    } else {
      console.error('Unexpected error:', error.message)
    }

    res.status(500).json({ 
      error: 'Failed to get meal suggestions',
      message: error.message 
    })
  }
})


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
    Return ONLY a valid JSON object in this exact format, with no markdown formatting or backticks:
    {
      "recipes": [
        { "title": "Recipe Name", "description": "Brief description", "matchPercentage": 90, "missedIngredients": ["salt"] }
      ]
    }`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const text = response.data.candidates[0].content.parts[0].text;
    // Clean up potential markdown formatting from Gemini
    const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsedData = JSON.parse(cleanJson);

    res.json({ success: true, recipes: parsedData.recipes, remainingCredits: users[userId].credits });

  } catch (error) {
    console.error(error.response?.data || error);
    res.status(500).json({ error: 'AI failed' });
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
    Return ONLY a valid JSON object in this exact format, with no markdown formatting or backticks:
    {
      "plan": {
        "Monday": { "breakfast": "Oats", "lunch": "Salad", "dinner": "Chicken" },
        "Tuesday": { "breakfast": "Eggs", "lunch": "Wrap", "dinner": "Fish" }
        // ... (include all 7 days)
      }
    }`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const text = response.data.candidates[0].content.parts[0].text;
    const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsedData = JSON.parse(cleanJson);

    res.json({ success: true, plan: parsedData.plan, remainingCredits: users[userId].credits });

  } catch (error) {
    console.error(error.response?.data || error);
    res.status(500).json({ error: 'AI failed' });
  }
});


// ═══════════════════════════════════════════
// 🚀 START SERVER
// ═══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
app.get("/", (req, res) => {
  res.send("🚀 Nutriverse API is running");
});