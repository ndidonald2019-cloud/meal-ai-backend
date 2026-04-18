const { 
  lemonSqueezySetup, 
  createCheckout,
  getOrder
} = require('@lemonsqueezy/lemonsqueezy.js')
const crypto = require('crypto')

// Initialize Lemon Squeezy
lemonSqueezySetup({
  apiKey: process.env.LEMONSQUEEZY_API_KEY,
  onError: (error) => {
    console.error('LemonSqueezy error:', error)
  }
})

// Credit packages with Lemon Squeezy Variant IDs
const CREDIT_PACKAGES = {
  starter: {
    name: 'Starter Pack',
    credits: 50,
    price_usd: 2.99,
    variant_id: process.env.LEMONSQUEEZY_STARTER_VARIANT_ID
  },
  popular: {
    name: 'Popular Pack',
    credits: 150,
    price_usd: 6.99,
    variant_id: process.env.LEMONSQUEEZY_POPULAR_VARIANT_ID,
    most_popular: true
  },
  pro: {
    name: 'Pro Pack',
    credits: 400,
    price_usd: 14.99,
    variant_id: process.env.LEMONSQUEEZY_PRO_VARIANT_ID,
    best_value: true
  }
}

const CREDIT_COSTS = {
  dietPlan: 15,
  weeklyMealPlan: 20,
  cookWithIngredients: 8,
  leftoverRescue: 8,
  budgetMeals: 8,
  recipeExtraction: 10
}

const SIGNUP_BONUS_CREDITS = 10
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
  if (!meal) return res.status(400).json({ error: "meal parameter is required" });

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
    res.status(500).json({ error: "Failed to fetch videos" });
  }
});

// ═══════════════════════════════════════════
// 🖼️ MEAL IMAGE
// ═══════════════════════════════════════════
app.get("/getMealImage", async (req, res) => {
  const meal = req.query.meal;
  if (!meal) return res.status(400).json({ error: "meal parameter is required" });

  try {
    const response = await axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: process.env.PEXELS_API_KEY },
      params: { query: meal + " food dish", per_page: 3 }
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
    res.status(500).json({ error: "Failed to fetch image" });
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
  if (!ingredients) return res.status(400).json({ error: "ingredients required" });

  try {
    const prompt = `You are a professional chef. Suggest 3 meals using these ingredients: ${ingredients.join(", ")}. The style should match ${country || "global"} cuisine. Return ONLY JSON: { "recipes": [] }`;

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

    if (!jsonMatch) throw new Error("AI did not return JSON format.");

    const parsedData = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      recipes: parsedData.recipes,
      remainingCredits: users[userId].credits
    });

  } catch (error) {
    res.status(500).json({ error: "Backend Error" });
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
    const prompt = `Generate a 7-day meal plan. Return JSON only.`;

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

    if (!jsonMatch) throw new Error("AI did not return JSON format.");

    const parsedData = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      plan: parsedData.plan,
      remainingCredits: users[userId].credits
    });

  } catch (error) {
    res.status(500).json({ error: "Backend Error" });
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
  if (!leftovers) return res.status(400).json({ error: "leftovers required" });

  try {
    const prompt = `Use leftovers: ${leftovers.join(", ")}. Return JSON recipes only.`;

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

    res.json({
      success: true,
      recipes: JSON.parse(jsonMatch[0]).recipes,
      remainingCredits: users[userId].credits
    });

  } catch (error) {
    res.status(500).json({ error: "Backend Error" });
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
  if (!mealName) return res.status(400).json({ error: "mealName required" });

  try {
    const prompt = `Steps for ${mealName}. JSON only.`;

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

    res.json({
      success: true,
      steps: JSON.parse(jsonMatch[0]).steps,
      remainingCredits: users[userId].credits
    });

  } catch (error) {
    res.status(500).json({ error: "Backend Error" });
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
  if (!budget) return res.status(400).json({ error: "budget required" });

  try {
    const prompt = `Meals under ${budget}. JSON only.`;

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

    res.json({
      success: true,
      meals: JSON.parse(jsonMatch[0]).meals,
      remainingCredits: users[userId].credits
    });

  } catch (error) {
    res.status(500).json({ error: "Backend Error" });
  }
});

// ═══════════════════════════════════════
// ENDPOINT — Get Credit Packages
// ═══════════════════════════════════════
app.get('/creditPackages', (req, res) => {
  const packages = Object.entries(CREDIT_PACKAGES)
    .map(([key, pkg]) => ({
      id: key,
      name: pkg.name,
      credits: pkg.credits,
      price_usd: pkg.price_usd,
      variant_id: pkg.variant_id,
      most_popular: pkg.most_popular || false,
      best_value: pkg.best_value || false,
      price_per_credit: (
        pkg.price_usd / pkg.credits
      ).toFixed(3)
    }))

  res.json({
    success: true,
    packages,
    feature_costs: CREDIT_COSTS,
    signup_bonus: SIGNUP_BONUS_CREDITS
  })
})


// ═══════════════════════════════════════
// ENDPOINT — Create Checkout
// ═══════════════════════════════════════
app.post('/createCheckout', async (req, res) => {
  const { user_id, email, package_id } = req.body

  if (!user_id || !email || !package_id) {
    return res.status(400).json({
      error: 'user_id, email and package_id required'
    })
  }

  const selectedPackage = CREDIT_PACKAGES[package_id]
  if (!selectedPackage) {
    return res.status(400).json({
      error: 'Invalid package id'
    })
  }

  try {
    const checkout = await createCheckout(
      process.env.LEMONSQUEEZY_STORE_ID,
      selectedPackage.variant_id,
      {
        checkoutOptions: {
          embed: false,
          media: false,
          logo: true
        },
        checkoutData: {
          email: email,
          custom: {
            user_id: user_id,
            package_id: package_id,
            credits: selectedPackage.credits.toString()
          }
        },
        productOptions: {
          name: selectedPackage.name,
          description: `${selectedPackage.credits} AI credits for CookAndEatHealthy`,
          redirectUrl: `https://cookandeathealthy.com/payment-success?package=${package_id}&user=${user_id}`,
          receiptButtonText: 'Start Cooking',
          receiptThankYouNote: `Your ${selectedPackage.credits} credits have been added!`
        },
        expiresAt: null
      }
    )

    // Save pending payment
    await supabase.from('payments').insert({
      user_id,
      amount: selectedPackage.price_usd,
      currency: 'USD',
      credits_added: selectedPackage.credits,
      package_id,
      payment_gateway: 'lemonsqueezy',
      payment_reference: checkout.data?.data?.id,
      status: 'pending'
    })

    console.log('Checkout created:', checkout.data?.data?.id)

    res.json({
      success: true,
      checkout_url: checkout.data?.data?.attributes?.url,
      checkout_id: checkout.data?.data?.id
    })

  } catch (error) {
    console.error('LemonSqueezy checkout error:', error)
    res.status(500).json({
      error: 'Failed to create checkout',
      message: error.message
    })
  }
})


// ═══════════════════════════════════════
// ENDPOINT — Lemon Squeezy Webhook
// Fires automatically after every payment
// ═══════════════════════════════════════
app.post('/webhook/lemonsqueezy',
  express.raw({ type: 'application/json' }),
  async (req, res) => {

    const signature = req.headers['x-signature']

    if (!signature) {
      console.error('No signature in webhook')
      return res.status(401).json({ 
        error: 'No signature' 
      })
    }

    try {
      // Verify webhook is from Lemon Squeezy
      const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET
      const hmac = crypto.createHmac('sha256', secret)
      const digest = hmac.update(req.body).digest('hex')

      if (signature !== digest) {
        console.error('Invalid webhook signature')
        return res.status(401).json({ 
          error: 'Invalid signature' 
        })
      }

      const payload = JSON.parse(req.body.toString())
      const eventName = payload.meta?.event_name

      console.log('LemonSqueezy webhook:', eventName)

      // Order completed = payment successful
      if (eventName === 'order_created') {
        const order = payload.data
        const orderStatus = order.attributes?.status
        
        console.log('Order status:', orderStatus)

        if (orderStatus === 'paid') {
          const customData = payload.meta?.custom_data
          const { 
            user_id, 
            package_id, 
            credits 
          } = customData

          console.log('Custom data:', customData)

          if (!user_id || !credits) {
            console.error('Missing custom data')
            return res.json({ received: true })
          }

          // Prevent duplicate processing
          const orderId = order.id.toString()
          const { data: existingPayment } = await supabase
            .from('payments')
            .select('status')
            .eq('payment_reference', orderId)
            .single()

          if (existingPayment?.status === 'completed') {
            console.log('Already processed:', orderId)
            return res.json({ received: true })
          }

          // Get user current credits
          const { data: user, error: userError } = await supabase
            .from('users')
            .select('credits')
            .eq('id', user_id)
            .single()

          if (userError || !user) {
            console.error('User not found:', user_id)
            return res.json({ received: true })
          }

          const creditsToAdd = parseInt(credits)
          const newBalance = (user.credits || 0) + creditsToAdd

          // Add credits to user account
          await supabase
            .from('users')
            .update({ credits: newBalance })
            .eq('id', user_id)

          // Save completed payment
          await supabase
            .from('payments')
            .upsert({
              user_id,
              amount: order.attributes?.total / 100,
              currency: 'USD',
              credits_added: creditsToAdd,
              package_id,
              payment_gateway: 'lemonsqueezy',
              payment_reference: orderId,
              status: 'completed'
            })

          // Log purchase in usage_logs
          await supabase
            .from('usage_logs')
            .insert({
              user_id,
              feature: 'credit_purchase',
              credits_used: -creditsToAdd,
              created_at: new Date().toISOString()
            })

          console.log('✅ Payment processed!')
          console.log(`User: ${user_id}`)
          console.log(`Credits added: ${creditsToAdd}`)
          console.log(`New balance: ${newBalance}`)
        }
      }

      res.json({ received: true })

    } catch (error) {
      console.error('Webhook error:', error.message)
      res.status(400).json({
        error: 'Webhook processing failed'
      })
    }
  }
)


// ═══════════════════════════════════════
// ENDPOINT — Verify Payment
// Frontend calls as backup
// ═══════════════════════════════════════
app.post('/verifyPayment', async (req, res) => {
  const { order_id, user_id, package_id } = req.body

  if (!user_id) {
    return res.status(400).json({
      error: 'user_id required'
    })
  }

  try {
    // Check Supabase first
    const { data: payment } = await supabase
      .from('payments')
      .select('*')
      .eq('user_id', user_id)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (payment) {
      const { data: user } = await supabase
        .from('users')
        .select('credits')
        .eq('id', user_id)
        .single()

      return res.json({
        success: true,
        verified: true,
        credits_added: payment.credits_added,
        current_balance: user?.credits || 0
      })
    }

    // If not found check with Lemon Squeezy directly
    if (order_id) {
      const order = await getOrder(order_id)
      
      if (order.data?.data?.attributes?.status === 'paid') {
        const pkg = CREDIT_PACKAGES[package_id]
        if (!pkg) {
          return res.status(400).json({ 
            error: 'Package not found' 
          })
        }

        const { data: user } = await supabase
          .from('users')
          .select('credits')
          .eq('id', user_id)
          .single()

        const newBalance = (user?.credits || 0) + pkg.credits

        await supabase
          .from('users')
          .update({ credits: newBalance })
          .eq('id', user_id)

        await supabase
          .from('payments')
          .insert({
            user_id,
            amount: pkg.price_usd,
            currency: 'USD',
            credits_added: pkg.credits,
            package_id,
            payment_gateway: 'lemonsqueezy',
            payment_reference: order_id.toString(),
            status: 'completed'
          })

        return res.json({
          success: true,
          verified: true,
          credits_added: pkg.credits,
          new_balance: newBalance
        })
      }
    }

    res.json({
      success: false,
      verified: false,
      message: 'Payment not confirmed yet'
    })

  } catch (error) {
    console.error('verifyPayment error:', error.message)
    res.status(500).json({
      error: 'Failed to verify payment'
    })
  }
})


// ═══════════════════════════════════════
// ENDPOINT — Credit Balance
// ═══════════════════════════════════════
app.get('/creditBalance', async (req, res) => {
  const user_id = req.headers['userid']
    || req.query.user_id

  if (!user_id) {
    return res.status(401).json({
      error: 'User ID required'
    })
  }

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('credits')
      .eq('id', user_id)
      .single()

    if (error || !user) {
      return res.status(404).json({
        error: 'User not found'
      })
    }

    res.json({
      success: true,
      credits: user.credits,
      low_balance: user.credits <= 15,
      critical_balance: user.credits <= 8,
      empty: user.credits <= 0
    })

  } catch (error) {
    console.error('creditBalance error:', error.message)
    res.status(500).json({
      error: 'Failed to get balance'
    })
  }
})


// ═══════════════════════════════════════
// ENDPOINT — Deduct Credits
// Call AFTER successful AI response
// ═══════════════════════════════════════
app.post('/deductCredits', async (req, res) => {
  const { user_id, feature } = req.body

  if (!user_id || !feature) {
    return res.status(400).json({
      error: 'user_id and feature required'
    })
  }

  const cost = CREDIT_COSTS[feature]
  if (!cost) {
    return res.status(400).json({
      error: 'Invalid feature name'
    })
  }

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('credits')
      .eq('id', user_id)
      .single()

    if (error || !user) {
      return res.status(404).json({
        error: 'User not found'
      })
    }

    if (user.credits < cost) {
      return res.status(403).json({
        error: 'insufficient_credits',
        message: `Need ${cost} credits. You have ${user.credits}.`,
        credits_needed: cost,
        credits_available: user.credits,
        credits_short: cost - user.credits,
        show_paywall: true
      })
    }

    const newBalance = user.credits - cost

    await supabase
      .from('users')
      .update({ credits: newBalance })
      .eq('id', user_id)

    await supabase
      .from('usage_logs')
      .insert({
        user_id,
        feature,
        credits_used: cost,
        created_at: new Date().toISOString()
      })

    res.json({
      success: true,
      credits_used: cost,
      credits_remaining: newBalance,
      low_balance: newBalance <= 15,
      critical_balance: newBalance <= 8
    })

  } catch (error) {
    console.error('deductCredits error:', error.message)
    res.status(500).json({
      error: 'Failed to deduct credits'
    })
  }
})


// ═══════════════════════════════════════
// ENDPOINT — Signup Bonus
// Call right after user registers
// ═══════════════════════════════════════
app.post('/signupBonus', async (req, res) => {
  const { user_id } = req.body

  if (!user_id) {
    return res.status(400).json({
      error: 'user_id required'
    })
  }

  try {
    const { data: user } = await supabase
      .from('users')
      .select('signup_bonus_given, credits')
      .eq('id', user_id)
      .single()

    if (user?.signup_bonus_given) {
      return res.status(400).json({
        error: 'Signup bonus already claimed'
      })
    }

    const newBalance = (user?.credits || 0)
      + SIGNUP_BONUS_CREDITS

    await supabase
      .from('users')
      .update({
        credits: newBalance,
        signup_bonus_given: true
      })
      .eq('id', user_id)

    console.log(`🎁 Bonus given to ${user_id}`)

    res.json({
      success: true,
      credits_added: SIGNUP_BONUS_CREDITS,
      new_balance: newBalance,
      message: `🎁 ${SIGNUP_BONUS_CREDITS} free credits added!`
    })

  } catch (error) {
    console.error('signupBonus error:', error.message)
    res.status(500).json({
      error: 'Failed to give signup bonus'
    })
  }
}) 

// ═══════════════════════════════════════════
// 🚀 START SERVER
// ═══════════════════════════════════════════
app.get("/", (req, res) => {
  res.send("🚀 Nutriverse API is running (OpenAI)");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});