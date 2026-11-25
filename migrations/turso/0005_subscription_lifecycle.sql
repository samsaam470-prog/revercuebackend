-- Turso · subscription lifecycle: plan transitions, temporary combined limits,
-- contextual capacity offers and pauses.
-- Additive only: four new tables and their indexes, nothing existing is altered.

-- A pending plan change. The row is created before the customer is sent to a
-- Whop checkout and is completed only from verified Whop membership data, so a
-- redirect alone can never activate a plan.
CREATE TABLE IF NOT EXISTS subscription_transitions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- upgrade | downgrade | capacity
  kind TEXT NOT NULL,
  from_plan TEXT,
  to_plan TEXT NOT NULL,
  from_subscription_id TEXT,
  from_membership_id TEXT,
  -- Capacity offers only.
  offer_key TEXT,
  addon_id TEXT,
  -- awaiting_payment | completed | canceled | failed | expired
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  whop_checkout_id TEXT,
  whop_checkout_url TEXT,
  whop_membership_id TEXT,
  whop_plan_id TEXT,
  -- Days of Whop trial used to line the new plan up with the old period end.
  trial_days INTEGER NOT NULL DEFAULT 0,
  -- UTC. When the new entitlement starts, and when the combined window ends.
  starts_at TEXT,
  combined_ends_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscription_transitions_user
  ON subscription_transitions (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscription_transitions_checkout
  ON subscription_transitions (whop_checkout_id);
CREATE INDEX IF NOT EXISTS idx_subscription_transitions_membership
  ON subscription_transitions (whop_membership_id);

-- The remaining part of the original Growth period, after a Scale purchase.
-- While this window is open the customer gets Growth + Scale capacity.
CREATE TABLE IF NOT EXISTS combined_limit_windows (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_subscription_id TEXT,
  source_plan TEXT NOT NULL DEFAULT 'growth',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  -- active | expired
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_combined_limit_windows_user
  ON combined_limit_windows (user_id, status);
CREATE INDEX IF NOT EXISTS idx_combined_limit_windows_expiry
  ON combined_limit_windows (status, ends_at);

-- Contextual capacity purchases. Never granted without a verified Whop payment.
CREATE TABLE IF NOT EXISTS capacity_addons (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- protect | protect_plus
  offer_key TEXT NOT NULL,
  -- pending | active | canceled | expired | failed
  status TEXT NOT NULL DEFAULT 'pending',
  whop_checkout_id TEXT,
  whop_membership_id TEXT,
  whop_plan_id TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  -- one_time | month
  billing_interval TEXT NOT NULL DEFAULT 'one_time',
  -- Entitlements granted while active. Protection-only rows keep both at zero
  -- and exist so the customer's over-limit documents are explicitly protected.
  storage_gb INTEGER NOT NULL DEFAULT 0,
  active_documents INTEGER NOT NULL DEFAULT 0,
  protected_documents INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capacity_addons_user
  ON capacity_addons (user_id, status);
CREATE INDEX IF NOT EXISTS idx_capacity_addons_membership
  ON capacity_addons (whop_membership_id);

-- Pausing is not cancelling. The row records the plan to restore and whether
-- the customer asked for an automatic resume date.
CREATE TABLE IF NOT EXISTS subscription_pauses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subscription_id TEXT,
  whop_membership_id TEXT,
  prior_plan TEXT NOT NULL,
  resume_at TEXT,
  -- paused | resumed | failed
  status TEXT NOT NULL DEFAULT 'paused',
  paused_at TEXT NOT NULL,
  resumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscription_pauses_user
  ON subscription_pauses (user_id, status);
