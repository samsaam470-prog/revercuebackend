CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'whop',
  whop_membership_id TEXT,
  whop_plan_id TEXT,
  plan_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  current_period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  canceled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (whop_membership_id)
);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subscription_id TEXT,
  whop_payment_id TEXT,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending',
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (whop_payment_id)
);

CREATE TABLE IF NOT EXISTS whop_webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  provider_object_id TEXT,
  processing_status TEXT NOT NULL DEFAULT 'received',
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS subscription_change_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subscription_id TEXT,
  from_plan TEXT NOT NULL,
  to_plan TEXT NOT NULL,
  change_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_for TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_sub_payments_user ON subscription_payments (user_id);
CREATE INDEX IF NOT EXISTS idx_sub_payments_sub ON subscription_payments (subscription_id);
