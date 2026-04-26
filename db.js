// ═══════════════════════════════════════════
// 🐘 POSTGRESQL DATABASE MODULE
// ═══════════════════════════════════════════
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

// Test connection on startup
pool.query("SELECT NOW()").then(() => {
  console.log("✅ PostgreSQL connected");
}).catch((err) => {
  console.error("❌ PostgreSQL connection failed:", err.message);
});

// Run DB schema if tables don't exist
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT DEFAULT '',
      email TEXT UNIQUE NOT NULL,
      password TEXT,
      credits INTEGER DEFAULT 400,
      signup_bonus_given BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      amount NUMERIC,
      currency TEXT DEFAULT 'USD',
      credits_added INTEGER,
      package_id TEXT,
      payment_gateway TEXT DEFAULT 'paddle',
      payment_reference TEXT UNIQUE,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      feature TEXT,
      credits_used INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("✅ Database schema ready");
}

// ── USER HELPERS ──────────────────────────────
async function getUser(userId) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
  return rows[0] || null;
}

async function getUserByEmail(email) {
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  return rows[0] || null;
}

async function createUser(userId, email, extras = {}) {
  const { name = "", password = null, credits = 400 } = extras;
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (id, name, email, password, credits, signup_bonus_given)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [userId, name, email || "", password, credits]
    );
    return rows[0] || await getUser(userId);
  } catch (err) {
    console.error("createUser error:", err.message);
    return await getUser(userId);
  }
}

async function updateUserCredits(userId, newCredits) {
  await pool.query("UPDATE users SET credits = $1 WHERE id = $2", [newCredits, userId]);
}

// ── PAYMENT HELPERS ───────────────────────────
async function savePayment(data) {
  try {
    await pool.query(
      `INSERT INTO payments (user_id, amount, currency, credits_added, package_id, payment_gateway, payment_reference, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (payment_reference) DO UPDATE SET status = EXCLUDED.status`,
      [
        data.user_id, data.amount, data.currency || "USD",
        data.credits_added, data.package_id, data.payment_gateway || "paddle",
        data.payment_reference, data.status || "pending",
      ]
    );
  } catch (err) {
    console.error("savePayment error:", err.message);
  }
}

async function getCompletedPayment(transactionId) {
  const { rows } = await pool.query(
    "SELECT * FROM payments WHERE payment_reference = $1 AND status = 'completed'",
    [transactionId]
  );
  return rows[0] || null;
}

async function getLatestCompletedPayment(userId) {
  const { rows } = await pool.query(
    "SELECT * FROM payments WHERE user_id = $1 AND status = 'completed' ORDER BY created_at DESC LIMIT 1",
    [userId]
  );
  return rows[0] || null;
}

// ── USAGE LOG HELPERS ─────────────────────────
async function saveUsageLog(userId, feature, creditsUsed) {
  try {
    await pool.query(
      "INSERT INTO usage_logs (user_id, feature, credits_used) VALUES ($1, $2, $3)",
      [userId, feature, creditsUsed]
    );
  } catch (err) {
    console.error("saveUsageLog error:", err.message);
  }
}

// ── CREDIT CHECKER ────────────────────────────
async function checkAndDeductCredits(userId, cost) {
  let user = await getUser(userId);
  if (!user) {
    await createUser(userId, "");
    user = await getUser(userId);
  }
  if (!user) return { error: "User not found" };
  if (user.credits < cost) return { error: "Not enough credits" };

  const newCredits = user.credits - cost;
  await updateUserCredits(userId, newCredits);
  return { success: true, newCredits };
}

module.exports = {
  pool,
  initSchema,
  getUser,
  getUserByEmail,
  createUser,
  updateUserCredits,
  savePayment,
  getCompletedPayment,
  getLatestCompletedPayment,
  saveUsageLog,
  checkAndDeductCredits,
};
