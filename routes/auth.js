// ═══════════════════════════════════════════
// routes/auth.js — Signup / Login / Me / Webhook
// ═══════════════════════════════════════════
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");

const pool = require("../db");
const verifyToken = require("../middleware/authMiddleware");

const router = express.Router();

// ─────────────────────────────────────────
// Helper: sign a JWT for a user row
// ─────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "30d" }
  );
}

// ═══════════════════════════════════════════
// POST /auth/signup
// Body: { name, email, password }
// ═══════════════════════════════════════════
router.post(
  "/signup",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().normalizeEmail().withMessage("Valid email required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ],
  async (req, res) => {
    // 1. Validate inputs
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: "ValidationError",
        details: errors.array().map((e) => e.msg),
      });
    }

    const { name, email, password } = req.body;

    try {
      // 2. Check if email already in use
      const existing = await pool.query(
        "SELECT id FROM users WHERE email = $1",
        [email]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({
          error: "EmailTaken",
          message: "An account with this email already exists.",
        });
      }

      // 3. Hash password
      const password_hash = await bcrypt.hash(password, 12);

      // 4. Insert user (credits default = 10 from schema)
      const userResult = await pool.query(
        `INSERT INTO users (name, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, name, email, credits, created_at`,
        [name, email, password_hash]
      );
      const newUser = userResult.rows[0];

      // 5. Create a free subscription row for this user
      await pool.query(
        `INSERT INTO subscriptions (user_id, plan, status)
         VALUES ($1, 'free', 'active')`,
        [newUser.id]
      );

      // 6. Issue JWT
      const token = signToken(newUser);

      console.log(`✅ New user signed up: ${email} (ID: ${newUser.id})`);

      res.status(201).json({
        success: true,
        message: "Account created successfully! 🎉 You received 10 free credits.",
        token,
        user: {
          id: newUser.id,
          name: newUser.name,
          email: newUser.email,
          credits: newUser.credits,
          plan: "free",
          created_at: newUser.created_at,
        },
      });
    } catch (err) {
      console.error("Signup error:", err.message);
      res.status(500).json({ error: "ServerError", message: "Signup failed. Please try again." });
    }
  }
);

// ═══════════════════════════════════════════
// POST /auth/login
// Body: { email, password }
// ═══════════════════════════════════════════
router.post(
  "/login",
  [
    body("email").isEmail().normalizeEmail().withMessage("Valid email required"),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: "ValidationError",
        details: errors.array().map((e) => e.msg),
      });
    }

    const { email, password } = req.body;

    try {
      // 1. Fetch user + subscription in one query
      const result = await pool.query(
        `SELECT u.id, u.name, u.email, u.password_hash, u.credits, u.created_at,
                s.plan, s.status AS subscription_status
         FROM users u
         LEFT JOIN subscriptions s ON s.user_id = u.id
         WHERE u.email = $1
         LIMIT 1`,
        [email]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          error: "InvalidCredentials",
          message: "Email or password is incorrect.",
        });
      }

      const user = result.rows[0];

      // 2. Verify password
      const passwordMatch = await bcrypt.compare(password, user.password_hash);
      if (!passwordMatch) {
        return res.status(401).json({
          error: "InvalidCredentials",
          message: "Email or password is incorrect.",
        });
      }

      // 3. Issue JWT
      const token = signToken(user);

      console.log(`🔑 User logged in: ${email} (ID: ${user.id})`);

      res.json({
        success: true,
        message: "Login successful!",
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          credits: user.credits,
          plan: user.plan || "free",
          subscription_status: user.subscription_status || "active",
        },
      });
    } catch (err) {
      console.error("Login error:", err.message);
      res.status(500).json({ error: "ServerError", message: "Login failed. Please try again." });
    }
  }
);

// ═══════════════════════════════════════════
// GET /auth/me  (PROTECTED)
// Header: Authorization: Bearer <token>
// ═══════════════════════════════════════════
router.get("/me", verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.credits, u.created_at,
              s.plan, s.status AS subscription_status
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "UserNotFound", message: "User not found." });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        credits: user.credits,
        plan: user.plan || "free",
        subscription_status: user.subscription_status || "active",
        is_premium: user.plan === "premium",
        created_at: user.created_at,
      },
    });
  } catch (err) {
    console.error("/me error:", err.message);
    res.status(500).json({ error: "ServerError", message: "Could not retrieve user." });
  }
});

// ═══════════════════════════════════════════
// POST /webhook/payment-success
// Called after a successful payment to
// upgrade user to premium.
// Body: { user_id, secret }
// Protect with a shared secret stored in env.
// ═══════════════════════════════════════════
router.post("/webhook/payment-success", async (req, res) => {
  const { user_id, secret } = req.body;

  // Basic secret check — set PAYMENT_WEBHOOK_SECRET in Railway env vars
  if (!secret || secret !== process.env.PAYMENT_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized", message: "Invalid webhook secret." });
  }

  if (!user_id) {
    return res.status(400).json({ error: "user_id is required" });
  }

  try {
    // 1. Make sure user exists
    const userCheck = await pool.query("SELECT id FROM users WHERE id = $1", [user_id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "UserNotFound", message: "No user with that ID." });
    }

    // 2. Update or insert subscription row → premium
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, status, updated_at)
       VALUES ($1, 'premium', 'active', NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET plan = 'premium', status = 'active', updated_at = NOW()`,
      [user_id]
    );

    console.log(`⭐ User ${user_id} upgraded to premium`);

    res.json({
      success: true,
      message: `User ${user_id} is now premium.`,
    });
  } catch (err) {
    console.error("payment-success webhook error:", err.message);
    res.status(500).json({ error: "ServerError", message: "Could not upgrade subscription." });
  }
});

module.exports = router;
