-- D1 · visit identity for de-duplication, suggestion dismissals, revision
-- prices. Additive only.

CREATE TABLE IF NOT EXISTS document_visit_meta (
  visit_id TEXT PRIMARY KEY,
  visitor_hash TEXT,
  plan TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (visit_id) REFERENCES document_visits(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_document_visit_meta_visitor
  ON document_visit_meta (visitor_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS suggestion_dismissals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  suggestion_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestion_dismissals_unique
  ON suggestion_dismissals (user_id, suggestion_id);

CREATE TABLE IF NOT EXISTS revision_prices (
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  price REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, category)
);

CREATE INDEX IF NOT EXISTS idx_file_uploads_user
  ON file_uploads (user_id, created_at DESC);
