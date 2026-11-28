-- D1 · shared document editing authority (Shareable Builder + Offline Builder).
-- Additive only: no existing table or column is modified.

-- One row per document tracks the current editing authority. Only one
-- authority may hold a document at a time (enforced by the application layer
-- and the unique index on (document_type, document_id)).
CREATE TABLE IF NOT EXISTS document_editing_state (
  id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL,
  authority_kind TEXT NOT NULL,
  authority_id TEXT,
  lock_token TEXT,
  cloud_version TEXT,
  offline_session_id TEXT,
  contributor_session_id TEXT,
  last_saved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_editing_state_document
  ON document_editing_state (document_type, document_id);
CREATE INDEX IF NOT EXISTS idx_document_editing_state_user
  ON document_editing_state (user_id, state);

-- Contributor invitations for Shareable Builder.
CREATE TABLE IF NOT EXISTS document_contributor_invitations (
  id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  contributor_email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  completed_at TEXT,
  last_saved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_contributor_invitations_document
  ON document_contributor_invitations (document_type, document_id, status);
CREATE INDEX IF NOT EXISTS idx_contributor_invitations_token
  ON document_contributor_invitations (token);

-- Auditable state transitions. Temporary chat message content is never stored here.
CREATE TABLE IF NOT EXISTS document_editing_events (
  id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  authority_kind TEXT,
  authority_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_document_editing_events_document
  ON document_editing_events (document_type, document_id, created_at);

-- Offline sessions for Offline Builder.
CREATE TABLE IF NOT EXISTS document_offline_sessions (
  id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL,
  prepared_version TEXT,
  completed_at TEXT,
  synced_at TEXT,
  sync_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_document_offline_sessions_document
  ON document_offline_sessions (document_type, document_id, status);
CREATE INDEX IF NOT EXISTS idx_document_offline_sessions_user
  ON document_offline_sessions (user_id, status);
-- Temporary collaboration chat. Rows exist only while a contribution session
-- is live: they are deleted on either completion route, on revocation, and by
-- the hourly retention sweep once `expires_at` passes. Message bodies are never
-- copied into document_editing_events, analytics or application logs.
CREATE TABLE IF NOT EXISTS collaboration_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collaboration_messages_session
  ON collaboration_messages (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_collaboration_messages_expiry
  ON collaboration_messages (expires_at);
