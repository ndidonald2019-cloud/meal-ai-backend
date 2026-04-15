const express = require("express")
const axios = require("axios")
const cors = require("cors")
const rateLimit = require("express-rate-limit")
require("dotenv").config()

const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://nutriverse-cuisine.lovable.app',
    'https://cookandeathealthy.com',
    'https://www.cookandeathealthy.com',
    'https://cookandeathealthy.netlify.app'
  ]
}))
app.use(express.json())

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests. Try again later." }
})
app.use(limiter)

// Health check (always add this)
app.get("/", (req, res) => {
  res.json({ 
    status: "NutriVerse API is running",
    endpoints: [
      "GET /searchVideos?meal=jollof rice",
      "POST /extractRecipe",
      "POST /getNutrition",
      "GET /getMealImage?meal=jollof rice"
    ]
  })
})

// ✅ ENDPOINT 1 — YouTube Search
app.get("/searchVideos", async (req, res) => {
  const meal = req.query.meal
  if (!meal) {
    return res.status(400).json({ error: 'meal parameter is required' })
  }

  try {
    const response = await axios.get(
      "https://www.googleapis.com/youtube/v3/search",
      {
        params: {
          part: "snippet",
          q: `how to cook ${meal} recipe`,
          maxResults: 20,
          type: "video",
          videoEmbeddable: "true",    // ✅ Fixed: string not boolean
          videoSyndicated: "true",    // ✅ Fixed: string not boolean
          key: process.env.YOUTUBE_API_KEY,
        },
      }
    )

    const videos = response.data.items
      .filter(item => item.id?.videoId)
      .slice(0, 15)
      .map(item => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        thumbnail: item.snippet.thumbnails.medium.url,
        channel: item.snippet.channelTitle,
        embedUrl: `https://www.youtube.com/embed/${item.id.videoId}`
      }))

    res.json({ success: true, count: videos.length, videos })

  } catch (error) {
    console.error('YouTube error:', error.message)
    
    // Handle quota exceeded specifically
    if (error.response?.status === 403) {
      return res.status(403).json({ 
        error: 'YouTube API quota exceeded',
        message: 'Daily limit reached. Try again tomorrow.'
      })
    }
    
    res.status(500).json({ 
      error: 'Failed to fetch videos',
      message: error.message 
    })
  }
})

// ✅ ENDPOINT 2 — AI Recipe Extraction
app.post("/extractRecipe", async (req, res) => {
  const { mealName, videoTitle } = req.body
  if (!mealName) {
    return res.status(400).json({ error: 'mealName is required' })
  }

  try {
    const prompt = `
      You are a culinary expert specializing in global cuisines 
      especially African, Asian and local dishes.
      
      Generate a detailed recipe for: "${mealName}"
      ${videoTitle ? `Related video: "${videoTitle}"` : ''}
      
      Return ONLY valid JSON, no markdown, no extra text:
      {
        "meal_name": "<name>",
        "description": "<2 sentences about this dish>",
        "cooking_time": "<total time>",
        "prep_time": "<preparation time>",
        "servings": <number>,
        "difficulty": "Beginner|Intermediate|Advanced",
        "ingredients": [
          {
            "name": "<English ingredient name>",
            "local_name": "<local language name if African dish>",
            "quantity": "<amount and unit>",
            "notes": "<substitution or tip>"
          }
        ],
        "steps": [
          {
            "number": 1,
            "title": "<short step title>",
            "instruction": "<detailed instruction>",
            "duration": "<time for this step>"
          }
        ],
        "tips": [
          "<practical cooking tip>",
          "<serving or cultural tip>"
        ],
        "nutrition_per_serving": {
          "calories": <number>,
          "protein": "<Xg>",
          "carbs": "<Xg>",
          "fat": "<Xg>",
          "fiber": "<Xg>"
        }
      }
    `

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048  // ✅ Increased for full recipes
        }
      }
    )

    const rawText = response.data
      ?.candidates?.[0]
      ?.content?.parts?.[0]?.text

    if (!rawText) {
      return res.status(500).json({ error: 'Empty response from AI' })
    }

    const cleanText = rawText
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim()

    let recipe
    try {
      recipe = JSON.parse(cleanText)
    } catch (err) {
      console.error("JSON parse error:", cleanText)
      return res.status(500).json({
        error: "AI returned invalid format. Try again.",
      })
    }

    res.json({ success: true, recipe })

  } catch (error) {
    console.error('Gemini recipe error:', error.message)
    res.status(500).json({ error: 'Failed to extract recipe' })
  }
})

// ✅ ENDPOINT 3 — Nutrition Guidance
app.post("/getNutrition", async (req, res) => {
  const { goal } = req.body
  if (!goal) {
    return res.status(400).json({ error: 'goal is required' })
  }

  // Validate goal value
  const validGoals = ['weight gain', 'weight loss', 'maintenance']
  if (!validGoals.some(g => goal.toLowerCase().includes(g))) {
    return res.status(400).json({ 
      error: 'goal must be weight gain, weight loss, or maintenance' 
    })
  }

  try {
    const prompt = `
      You are a professional nutritionist and dietitian.
      User goal: "${goal}"
      
      Give practical, easy to follow nutrition advice.
      Focus on real foods people can find in local markets.
      Include both Western and African food options where relevant.
      
      Return ONLY valid JSON, no extra text:
      {
        "goal": "${goal}",
        "summary": "<one motivational sentence>",
        "daily_calorie_target": "<e.g. 2500 calories for gain>",
        "foods_to_eat_more": [
          {
            "food": "<food name>",
            "reason": "<why it helps this goal>",
            "serving": "<recommended daily amount>",
            "local_alternative": "<African or local equivalent>"
          }
        ],
        "foods_to_reduce": [
          {
            "food": "<food name>",
            "reason": "<why to reduce>",
            "alternative": "<healthier swap>"
          }
        ],
        "meal_timing": {
          "breakfast": "<advice>",
          "lunch": "<advice>",
          "dinner": "<advice>",
          "snacks": "<advice>"
        },
        "cooking_tips": [
          "<tip 1>",
          "<tip 2>",
          "<tip 3>"
        ],
        "simple_meal_ideas": [
          {
            "meal": "<meal name>",
            "why": "<why it fits the goal>",
            "when": "<best time to eat it>"
          }
        ],
        "habits_to_build": [
          "<daily habit 1>",
          "<daily habit 2>",
          "<daily habit 3>"
        ]
      }
    `

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1500
        }
      }
    )

    const rawText = response.data
      ?.candidates?.[0]
      ?.content?.parts?.[0]?.text

    if (!rawText) {
      return res.status(500).json({ error: 'Empty response from AI' })
    }

    const cleanText = rawText
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim()

    let nutrition
    try {
      nutrition = JSON.parse(cleanText)
    } catch (err) {
      return res.status(500).json({
        error: "AI returned invalid format. Try again.",
      })
    }

    res.json({ success: true, nutrition })

  } catch (error) {
    console.error('Nutrition error:', error.message)
    res.status(500).json({ error: 'Failed to get nutrition advice' })
  }
})

// ✅ ENDPOINT 4 — Meal Image
app.get("/getMealImage", async (req, res) => {
  const meal = req.query.meal
  if (!meal) {
    return res.status(400).json({ error: 'meal parameter is required' })
  }

  const FALLBACK_IMAGE = {
    url: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=800&q=80',
    photographer: 'Unsplash',
    alt: meal
  }

  try {
    const response = await axios.get(
      "https://api.pexels.com/v1/search",
      {
        headers: {
          Authorization: process.env.PEXELS_API_KEY
        },
        params: {
          query: meal + ' food dish cooking',
          per_page: 5,
          orientation: 'landscape'
        }
      }
    )

    const photos = response.data.photos.map(p => ({
      url: p.src.large,
      thumbnail: p.src.medium,
      photographer: p.photographer,
      alt: p.alt || meal
    }))

    if (photos.length === 0) {
      return res.json({
        success: true,
        image: FALLBACK_IMAGE
      })
    }

    res.json({ 
      success: true, 
      image: photos[0],
      all: photos
    })

  } catch (error) {
    console.error('Pexels error:', error.message)
    // Return fallback instead of error
    res.json({ 
      success: true, 
      image: FALLBACK_IMAGE,
      note: 'Using fallback image'
    })
  }
})

// Start server
app.listen(PORT, () => {
  console.log(`✅ NutriVerse API running on http://localhost:${PORT}`)
  console.log(`📋 Endpoints ready:`)
  console.log(`   GET  /searchVideos?meal=jollof+rice`)
  console.log(`   POST /extractRecipe`)
  console.log(`   POST /getNutrition`)
  console.log(`   GET  /getMealImage?meal=jollof+rice`)
})