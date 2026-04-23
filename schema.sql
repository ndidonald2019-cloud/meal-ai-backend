-- ═══════════════════════════════════════════
-- schema.sql — Run this ONCE in Railway
-- PostgreSQL Query Tab → Paste → Run
-- ═══════════════════════════════════════════

-- USERS TABLE
-- Used by both the auth system (name/password_hash) and the
-- credit system (credits/signup_bonus_given).
CREATE TABLE IF NOT EXISTS users (
  id                 SERIAL PRIMARY KEY,
  name               VARCHAR(100),
  email              VARCHAR(255) UNIQUE NOT NULL,
  password_hash      TEXT,
  credits            INTEGER NOT NULL DEFAULT 10,
  signup_bonus_given BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- SUBSCRIPTIONS TABLE
CREATE TABLE IF NOT EXISTS subscriptions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan        VARCHAR(20) NOT NULL DEFAULT 'free',   -- 'free' | 'premium'
  status      VARCHAR(20) NOT NULL DEFAULT 'active', -- 'active' | 'cancelled' | 'expired'
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PAYMENTS TABLE
-- Records every checkout attempt and completed payment.
CREATE TABLE IF NOT EXISTS payments (
  id                SERIAL PRIMARY KEY,
  user_id           TEXT NOT NULL,
  amount            NUMERIC(10, 2),
  currency          TEXT,
  credits_added     INTEGER,
  package_id        TEXT,
  payment_gateway   TEXT,
  payment_reference TEXT,
  status            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- USAGE LOGS TABLE
-- Tracks credit consumption per feature per user.
CREATE TABLE IF NOT EXISTS usage_logs (
  id           SERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  feature      TEXT,
  credits_used INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast email lookups (login)
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Index for fast user_id lookups (subscription check)
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);

-- Indexes for payment and usage queries
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON usage_logs(user_id);
