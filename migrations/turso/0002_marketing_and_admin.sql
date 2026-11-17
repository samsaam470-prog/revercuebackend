-- Turso · newsletter subscribers, brand assets, admin audit trail.
-- Additive only. Legacy tables (waitlist, beta_testers, contact_messages) are
-- reused as-is; this migration does not alter them.

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  consent_source TEXT,
  consent_at TEXT,
  confirmed_at TEXT,
  unsubscribed_at TEXT,
  user_id TEXT,
  ip_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_subscribers_email
  ON newsletter_subscribers (email);
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_status
  ON newsletter_subscribers (status, created_at DESC);

CREATE TABLE IF NOT EXISTS user_branding (
  user_id TEXT PRIMARY KEY,
  logo_key TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  admin_user TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created
  ON admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target
  ON admin_audit_log (target_type, target_id);
