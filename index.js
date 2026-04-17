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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
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
// ✅ FIXED — Generate Weekly Plan
// ═══════════════════════════════════════════
app.post("/generateWeeklyPlan", async (req, res) => {

  const { 
    goal, 
    country, 
    budget,
    currency,
    skill_level,
    diet_type,
    people_count,
    user_id
  } = req.body

  try {
    const prompt = `You are a professional nutritionist and chef.

Create a healthy 7-day meal plan.
Goal: ${goal || 'healthy eating'}
Country: ${country || 'International'}
Diet: ${diet_type || 'no restrictions'}
Skill level: ${skill_level || 'beginner'}
People: ${people_count || 1}
Budget level: ${budget || 'moderate'}

Mix local meals from ${country || 'around the world'} 
with popular international dishes.
Keep meals simple and realistic.

Return ONLY this exact JSON with no extra text:
{
  "plan": {
    "Monday": {
      "breakfast": "Oatmeal with banana and honey",
      "lunch": "Grilled chicken with rice and salad",
      "dinner": "Vegetable soup with bread",
      "snack": "Apple and peanut butter"
    },
    "Tuesday": {
      "breakfast": "Scrambled eggs with toast",
      "lunch": "Jollof rice with fried fish",
      "dinner": "Pasta with tomato sauce",
      "snack": "Yogurt with granola"
    },
    "Wednesday": {
      "breakfast": "Meal name here",
      "lunch": "Meal name here",
      "dinner": "Meal name here",
      "snack": "Snack name here"
    },
    "Thursday": {
      "breakfast": "Meal name here",
      "lunch": "Meal name here",
      "dinner": "Meal name here",
      "snack": "Snack name here"
    },
    "Friday": {
      "breakfast": "Meal name here",
      "lunch": "Meal name here",
      "dinner": "Meal name here",
      "snack": "Snack name here"
    },
    "Saturday": {
      "breakfast": "Meal name here",
      "lunch": "Meal name here",
      "dinner": "Meal name here",
      "snack": "Snack name here"
    },
    "Sunday": {
      "breakfast": "Meal name here",
      "lunch": "Meal name here",
      "dinner": "Meal name here",
      "snack": "Snack name here"
    }
  },
  "shopping_list": {
    "proteins": ["chicken 1kg", "eggs 6 pieces", "fish 500g"],
    "vegetables": ["tomatoes 500g", "onions 3 pieces", "spinach 1 bunch"],
    "grains": ["rice 2kg", "oats 500g", "bread 1 loaf"],
    "fruits": ["bananas 6 pieces", "apples 4 pieces"],
    "condiments": ["olive oil", "salt", "pepper", "garlic"]
  },
  "nutrition_summary": {
    "daily_calories": "1800-2200",
    "protein": "high",
    "carbs": "moderate",
    "goal_note": "This plan supports your goal of healthy eating"
  },
  "cooking_tips": [
    "Prep vegetables on Sunday to save time",
    "Cook rice in bulk for multiple meals",
    "Keep healthy snacks ready to avoid junk food"
  ]
}`

    console.log('Calling Gemini for generateWeeklyPlan...')
    console.log('Goal:', goal, '| Country:', country)

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
          topP: 0.8,
          topK: 40
        }
      },
      { 
        headers: { 'Content-Type': 'application/json' },
        timeout: 45000
      }
    )

    console.log('Gemini status:', response.status)

    const candidate = response.data?.candidates?.[0]

    if (!candidate) {
      console.error('No candidates:', 
        JSON.stringify(response.data, null, 2))
      return res.status(500).json({ 
        error: 'Gemini returned no response' 
      })
    }

    if (candidate.finishReason === 'SAFETY') {
      return res.status(500).json({ 
        error: 'Content blocked by AI safety filter' 
      })
    }

    // Handle MAX_TOKENS finish reason
    if (candidate.finishReason === 'MAX_TOKENS') {
      console.warn('Response was cut off at max tokens')
    }

    const text = candidate?.content?.parts?.[0]?.text

    if (!text) {
      console.error('No text:', JSON.stringify(candidate, null, 2))
      return res.status(500).json({ 
        error: 'Gemini returned empty text' 
      })
    }

    console.log('Raw response length:', text.length)
    console.log('First 200 chars:', text.substring(0, 200))

    const cleanJson = text
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .replace(/^\s*[\r\n]/gm, '')
      .trim()

    let parsedData
    try {
      parsedData = JSON.parse(cleanJson)
    } catch (err) {
      console.error('JSON PARSE ERROR:', err.message)
      console.error('Attempted to parse:', cleanJson.substring(0, 500))
      return res.status(500).json({
        error: 'AI returned invalid JSON. Please try again.',
        raw: cleanJson.substring(0, 300)
      })
    }

    if (!parsedData.plan) {
      console.error('Missing plan object:', parsedData)
      return res.status(500).json({
        error: 'AI response missing meal plan data'
      })
    }

    const days = ['Monday','Tuesday','Wednesday',
      'Thursday','Friday','Saturday','Sunday']
    
    const missingDays = days.filter(d => !parsedData.plan[d])
    if (missingDays.length > 0) {
      console.warn('Missing days in plan:', missingDays)
    }

    res.json({
      success: true,
      plan: parsedData.plan,
      shopping_list: parsedData.shopping_list || {},
      nutrition_summary: parsedData.nutrition_summary || {},
      cooking_tips: parsedData.cooking_tips || []
    })

  } catch (error) {
    if (error.response) {
      console.error('Gemini API Error:', error.response.status)
      console.error('Details:', 
        JSON.stringify(error.response.data, null, 2))

      if (error.response.status === 429) {
        return res.status(429).json({ 
          error: 'Too many requests. Please wait a moment and try again.' 
        })
      }
      if (error.response.status === 403) {
        return res.status(500).json({ 
          error: 'API key issue. Please contact support.' 
        })
      }
    } else if (error.code === 'ECONNABORTED') {
      return res.status(500).json({ 
        error: 'Request timed out. Please try again.' 
      })
    }

    console.error('generateWeeklyPlan error:', error.message)
    res.status(500).json({ 
      error: 'Failed to generate meal plan',
      message: error.message 
    })
  }
})


// ═══════════════════════════════════════════
// 🚀 START SERVER
// ═══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
app.get("/", (req, res) => {
  res.send("🚀 Nutriverse API is running");
});