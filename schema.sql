-- ═══════════════════════════════════════════
-- schema.sql — Run this ONCE in Railway
-- PostgreSQL Query Tab → Paste → Run
-- ═══════════════════════════════════════════

-- USERS TABLE
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  credits       INTEGER NOT NULL DEFAULT 10,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- SUBSCRIPTIONS TABLE
CREATE TABLE IF NOT EXISTS subscriptions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan        VARCHAR(20) NOT NULL DEFAULT 'free',   -- 'free' | 'premium'
  status      VARCHAR(20) NOT NULL DEFAULT 'active', -- 'active' | 'cancelled' | 'expired'
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast email lookups (login)
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Index for fast user_id lookups (subscription check)
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
