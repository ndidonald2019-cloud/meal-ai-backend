import express from 'express';
import axios from 'axios';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { 
  lemonSqueezySetup, 
  createCheckout,
  getOrder
} from '@lemonsqueezy/lemonsqueezy.js';

dotenv.config();

const app = express();

// ═══════════════════════════════════════
// ⚙️ INITIALIZATION
// ═══════════════════════════════════════

// Initialize Supabase
// Note: Use SERVICE_ROLE_KEY to allow the backend to update user credits
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize Lemon Squeezy
lemonSqueezySetup({
  apiKey: process.env.LEMONSQUEEZY_API_KEY,
  onError: (error) => {
    console.error('LemonSqueezy error:', error);
  }
});

// ═══════════════════════════════════════
// 💰 CONFIGURATION
// ═══════════════════════════════════════

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
};

const CREDIT_COSTS = {
  cookWithIngredients: 8,
  generateWeeklyPlan: 20,
  rescueLeftovers: 8,
  getCookingSteps: 5,
  budgetMeals: 8,
  dietPlan: 15,
  recipeExtraction: 10
};

const SIGNUP_BONUS_CREDITS = 10;

// ═══════════════════════════════════════
// 🛡️ MIDDLEWARE
// ═══════════════════════════════════════

app.use(cors());

// Webhook requires raw body for signature verification
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook/lemonsqueezy') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // Increased slightly for multiple assets
  message: { error: "Too many requests, slow down." }
});

app.use(limiter);

// ═══════════════════════════════════════
// 🧠 CREDIT HELPER
// ═══════════════════════════════════════

async function checkAndDeductCredits(userId, feature) {
  const cost = CREDIT_COSTS[feature];
  if (!cost) throw new Error(`Invalid feature: ${feature}`);

  const { data: user, error: fetchError } = await supabase
    .from('users')
    .select('credits')
    .eq('id', userId)
    .single();

  if (fetchError || !user) return { error: "User not found" };

  if (user.credits < cost) {
    return { 
      error: "insufficient_credits", 
      needed: cost, 
      available: user.credits 
    };
  }

  const newBalance = user.credits - cost;
  await supabase.from('users').update({ credits: newBalance }).eq('id', userId);

  // Log the usage
  await supabase.from('usage_logs').insert({
    user_id: userId,
    feature,
    credits_used: cost,
    created_at: new Date().toISOString()
  });

  return { success: true, remaining: newBalance, cost };
}

// ═══════════════════════════════════════════
// 🔍 MEDIA ENDPOINTS
// ═══════════════════════════════════════════

app.get("/searchVideos", async (req, res) => {
  const meal = req.query.meal;
  if (!meal) return res.status(400).json({ error: "meal required" });

  try {
    const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        part: "snippet",
        q: `how to cook ${meal} recipe`,
        maxResults: 15,
        type: "video",
        videoEmbeddable: true,
        key: process.env.YOUTUBE_API_KEY,
      },
    });

    const videos = response.data.items.map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      thumbnail: item.snippet.thumbnails.medium.url,
      channel: item.snippet.channelTitle,
      embedUrl: `https://www.youtube.com/embed/${item.id.videoId}`
    }));

    res.json({ success: true, videos });
  } catch (error) {
    res.status(500).json({ error: "YouTube API Error" });
  }
});

app.get("/getMealImage", async (req, res) => {
  const meal = req.query.meal;
  if (!meal) return res.status(400).json({ error: "meal required" });

  try {
    const response = await axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: process.env.PEXELS_API_KEY },
      params: { query: meal + " food dish", per_page: 1 }
    });

    const photo = response.data.photos[0];
    res.json({ success: true, image: { url: photo?.src?.large || "", alt: photo?.alt || meal } });
  } catch {
    res.status(500).json({ error: "Pexels API Error" });
  }
});

// ═══════════════════════════════════════════
// 🍳 AI FEATURE ENDPOINTS
// ═══════════════════════════════════════════

const callAI = async (prompt) => {
  const response = await axios.post("https://api.openai.com/v1/chat/completions", {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  }, {
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` }
  });
  return JSON.parse(response.data.choices[0].message.content);
};

app.post("/cookWithIngredients", async (req, res) => {
  const userId = req.headers["userid"];
  const { ingredients, country } = req.body;
  if (!userId) return res.status(401).json({ error: "User ID required" });

  try {
    const deduction = await checkAndDeductCredits(userId, 'cookWithIngredients');
    if (deduction.error) return res.status(403).json(deduction);

    const data = await callAI(`Suggest 3 recipes using: ${ingredients.join(", ")} in ${country || "global"} style. Return JSON: { "recipes": [] }`);
    res.json({ success: true, recipes: data.recipes, remainingCredits: deduction.remaining });
  } catch (error) {
    res.status(500).json({ error: "AI Error" });
  }
});

app.post("/generateWeeklyPlan", async (req, res) => {
  const userId = req.headers["userid"];
  if (!userId) return res.status(401).json({ error: "User ID required" });

  try {
    const deduction = await checkAndDeductCredits(userId, 'generateWeeklyPlan');
    if (deduction.error) return res.status(403).json(deduction);

    const data = await callAI(`Generate a 7-day healthy meal plan. Return JSON: { "plan": [] }`);
    res.json({ success: true, plan: data.plan, remainingCredits: deduction.remaining });
  } catch (error) {
    res.status(500).json({ error: "AI Error" });
  }
});

app.post("/rescueLeftovers", async (req, res) => {
  const userId = req.headers["userid"];
  const { leftovers } = req.body;
  if (!userId) return res.status(401).json({ error: "User ID required" });

  try {
    const deduction = await checkAndDeductCredits(userId, 'rescueLeftovers');
    if (deduction.error) return res.status(403).json(deduction);

    const data = await callAI(`Suggest recipes using these leftovers: ${leftovers.join(", ")}. Return JSON: { "recipes": [] }`);
    res.json({ success: true, recipes: data.recipes, remainingCredits: deduction.remaining });
  } catch (error) {
    res.status(500).json({ error: "AI Error" });
  }
});

// ═══════════════════════════════════════
// 💵 PAYMENT & BILLING
// ═══════════════════════════════════════

app.get('/creditPackages', (req, res) => {
  res.json({
    success: true,
    packages: Object.entries(CREDIT_PACKAGES).map(([id, pkg]) => ({ id, ...pkg })),
    costs: CREDIT_COSTS
  });
});

app.post('/createCheckout', async (req, res) => {
  const { user_id, email, package_id } = req.body;
  const pkg = CREDIT_PACKAGES[package_id];
  if (!pkg) return res.status(400).json({ error: "Invalid package" });

  try {
    const checkout = await createCheckout(process.env.LEMONSQUEEZY_STORE_ID, pkg.variant_id, {
      checkoutData: { email, custom: { user_id, package_id, credits: pkg.credits.toString() } },
      productOptions: { redirectUrl: `${process.env.FRONTEND_URL}/payment-success` }
    });

    await supabase.from('payments').insert({
      user_id, amount: pkg.price_usd, credits_added: pkg.credits, status: 'pending', payment_reference: checkout.data?.data?.id
    });

    res.json({ success: true, checkout_url: checkout.data?.data?.attributes?.url });
  } catch (error) {
    res.status(500).json({ error: "Checkout Error" });
  }
});

app.post('/webhook/lemonsqueezy', async (req, res) => {
  const signature = req.headers['x-signature'];
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  const hmac = crypto.createHmac('sha256', secret);
  const digest = hmac.update(req.body).digest('hex');

  if (signature !== digest) return res.status(401).send('Invalid Signature');

  const payload = JSON.parse(req.body.toString());
  if (payload.meta?.event_name === 'order_created' && payload.data.attributes.status === 'paid') {
    const { user_id, credits } = payload.meta.custom_data;
    const orderId = payload.data.id;

    // Atomic-like credit update
    const { data: user } = await supabase.from('users').select('credits').eq('id', user_id).single();
    const newBalance = (user?.credits || 0) + parseInt(credits);

    await supabase.from('users').update({ credits: newBalance }).eq('id', user_id);
    await supabase.from('payments').upsert({ user_id, payment_reference: orderId, status: 'completed' });
    
    console.log(`✅ Credits added to user ${user_id}`);
  }
  res.json({ received: true });
});

app.get('/creditBalance', async (req, res) => {
  const userId = req.headers['userid'] || req.query.user_id;
  if (!userId) return res.status(401).json({ error: "User ID required" });

  const { data: user } = await supabase.from('users').select('credits').eq('id', userId).single();
  res.json({ success: true, credits: user?.credits || 0 });
});

app.post('/signupBonus', async (req, res) => {
  const { user_id } = req.body;
  const { data: user } = await supabase.from('users').select('signup_bonus_given, credits').eq('id', user_id).single();

  if (user?.signup_bonus_given) return res.status(400).json({ error: "Already claimed" });

  const newBalance = (user?.credits || 0) + SIGNUP_BONUS_CREDITS;
  await supabase.from('users').update({ credits: newBalance, signup_bonus_given: true }).eq('id', user_id);

  res.json({ success: true, credits_added: SIGNUP_BONUS_CREDITS, new_balance: newBalance });
});

// ═══════════════════════════════════════════
// 🚀 START SERVER
// ═══════════════════════════════════════════

app.get("/", (req, res) => res.send("🚀 Nutriverse API is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
