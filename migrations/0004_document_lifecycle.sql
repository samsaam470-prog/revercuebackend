-- D1 · document lifecycle: archive state, retention warnings, delivery log,
-- uploads. Additive only: no existing table or column is modified.

-- Archive state for contracts/forms/invoices (proposals keep their own columns).
CREATE TABLE IF NOT EXISTS document_archive (
  id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status_before TEXT,
  archived_at TEXT NOT NULL,
  archive_retention_days INTEGER,
  archive_deletion_date TEXT,
  unarchived_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_archive_unique
  ON document_archive (document_type, document_id);
CREATE INDEX IF NOT EXISTS idx_document_archive_due
  ON document_archive (unarchived_at, archive_deletion_date);

-- Idempotency for the ten-day warning: one warning per document per expiry date.
CREATE TABLE IF NOT EXISTS retention_warnings (
  id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expiry_date TEXT NOT NULL,
  warning_days INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_warnings_key
  ON retention_warnings (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_retention_warnings_document
  ON retention_warnings (document_type, document_id);

-- Delivery gate: a document is only deleted after its copy was emailed.
CREATE TABLE IF NOT EXISTS retention_deliveries (
  id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expiry_date TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  email_delivery_id TEXT,
  terminal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_deliveries_unique
  ON retention_deliveries (document_type, document_id, expiry_date);
CREATE INDEX IF NOT EXISTS idx_retention_deliveries_retry
  ON retention_deliveries (status, terminal, attempts, expiry_date);

-- Generic private uploads: form answers, invoice proofs, attachments.
CREATE TABLE IF NOT EXISTS document_uploads (
  id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  mime TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  question_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_document_uploads_document
  ON document_uploads (document_type, document_id, created_at);

-- Indexes on pre-existing tables (safe, idempotent).
CREATE INDEX IF NOT EXISTS idx_document_visits_document
  ON document_visits (document_type, document_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_visits_retention
  ON document_visits (retention_until);
CREATE INDEX IF NOT EXISTS idx_document_events_visit
  ON document_events (visit_id, server_timestamp);
CREATE INDEX IF NOT EXISTS idx_document_events_retention
  ON document_events (retention_until);
