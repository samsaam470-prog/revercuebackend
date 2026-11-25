-- Turso · the 14 days of Scale access included with a Growth purchase.
-- Additive only: this table is new, nothing existing is altered.

CREATE TABLE IF NOT EXISTS subscription_trials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subscription_id TEXT,
  -- The plan the customer bought (growth); access_plan is what they use meanwhile (scale).
  plan_key TEXT NOT NULL,
  access_plan TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  -- active | converted | expired | canceled
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscription_trials_user
  ON subscription_trials (user_id, status);

CREATE INDEX IF NOT EXISTS idx_subscription_trials_expiry
  ON subscription_trials (status, ends_at);
