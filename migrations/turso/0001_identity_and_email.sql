-- Turso · AuthAction identity mapping and email delivery log. Additive only.

CREATE TABLE IF NOT EXISTS user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email_at_link TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

-- A subject maps to exactly one Revercue user; a user may hold several.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_subject
  ON user_identities (provider, subject);
CREATE INDEX IF NOT EXISTS idx_user_identities_user
  ON user_identities (user_id);

CREATE TABLE IF NOT EXISTS auth_link_codes (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_link_codes_lookup
  ON auth_link_codes (subject, email, created_at DESC);

CREATE TABLE IF NOT EXISTS email_deliveries (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  to_email TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  provider TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  provider_message_id TEXT,
  idempotency_key TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  document_type TEXT,
  document_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  next_attempt_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_deliveries_idempotency
  ON email_deliveries (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_retry
  ON email_deliveries (status, retryable, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_user
  ON email_deliveries (user_id, created_at DESC);

-- Hot-path indexes on pre-existing tables (idempotent, non-destructive).
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, read, dismissed);
CREATE INDEX IF NOT EXISTS idx_sessions_jwt_id
  ON sessions (jwt_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_active
  ON sessions (user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_users_email
  ON users (email);
CREATE INDEX IF NOT EXISTS idx_payments_user
  ON payments (user_id, created_at DESC);
