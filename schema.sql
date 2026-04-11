-- ============================================================
-- Task Shredder AI — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- ── Users table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                    TEXT        PRIMARY KEY,
  telegram_id           TEXT,
  credits               INTEGER     NOT NULL DEFAULT 10,
  streak                INTEGER     NOT NULL DEFAULT 0,
  last_streak           INTEGER     NOT NULL DEFAULT 0,
  today_sessions        INTEGER     NOT NULL DEFAULT 0,
  last_active_day       TEXT,
  total_completed       INTEGER     NOT NULL DEFAULT 0,
  is_premium            BOOLEAN     NOT NULL DEFAULT FALSE,
  plan                  TEXT        NOT NULL DEFAULT 'free',
  premium_expiry        TIMESTAMPTZ,
  daily_breakdowns      INTEGER     NOT NULL DEFAULT 0,
  task_count_today      INTEGER     NOT NULL DEFAULT 0,
  daily_breakdown_date  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Sessions / history table ────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT        NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_completed_at_idx ON sessions(completed_at DESC);

-- ── Telegram payment ledger (idempotency + audit) ─────────
CREATE TABLE IF NOT EXISTS payments (
  id                          BIGSERIAL   PRIMARY KEY,
  telegram_payment_charge_id  TEXT        NOT NULL UNIQUE,
  provider_payment_charge_id  TEXT        UNIQUE,
  user_id                     TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload                     TEXT        NOT NULL,
  product                     TEXT        NOT NULL,
  plan                        TEXT,
  amount                      INTEGER     NOT NULL,
  currency                    TEXT        NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payments_user_id_idx ON payments(user_id);
CREATE INDEX IF NOT EXISTS payments_created_at_idx ON payments(created_at DESC);

-- Backfill columns for existing deployments
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS task_count_today INTEGER NOT NULL DEFAULT 0;

-- ── Disable RLS (all access goes through the backend API) ───
-- If you later want per-user RLS, enable it and add policies.
ALTER TABLE users      DISABLE ROW LEVEL SECURITY;
ALTER TABLE sessions   DISABLE ROW LEVEL SECURITY;
ALTER TABLE payments   DISABLE ROW LEVEL SECURITY;
