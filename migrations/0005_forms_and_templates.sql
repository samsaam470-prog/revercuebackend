-- D1 · form submissions, enrichment state, form editor settings, template
-- metadata. Additive only.

CREATE TABLE IF NOT EXISTS form_submissions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT,
  client_submission_id TEXT,
  service_type TEXT,
  answers TEXT NOT NULL,
  generated_prompt TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  research TEXT,
  assets TEXT,
  submitter_ip_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  processed_at TEXT,
  next_attempt_at TEXT
);

-- Replay protection when the client supplies an idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_form_submissions_client_unique
  ON form_submissions (form_id, client_submission_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_form
  ON form_submissions (form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_submissions_processing
  ON form_submissions (status, attempts, next_attempt_at);

CREATE TABLE IF NOT EXISTS form_settings (
  form_id TEXT PRIMARY KEY,
  thank_you_config TEXT,
  page_mode TEXT NOT NULL DEFAULT 'single',
  expiry_date TEXT,
  password_protected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_metadata (
  template_id TEXT PRIMARY KEY,
  description TEXT,
  category TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_template_metadata_category
  ON template_metadata (category);
