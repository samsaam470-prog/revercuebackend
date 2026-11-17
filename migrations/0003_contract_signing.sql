-- D1 · contract electronic signature (additive only)
-- A contract version is immutable from the moment it is signed. Any edit after
-- that creates a new version, so old signatures and hashes are never rewritten.

CREATE TABLE IF NOT EXISTS contract_versions (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  locked_at TEXT,
  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_versions_unique
  ON contract_versions (contract_id, version_number);
CREATE INDEX IF NOT EXISTS idx_contract_versions_contract
  ON contract_versions (contract_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_contract_versions_hash
  ON contract_versions (content_hash);

CREATE TABLE IF NOT EXISTS contract_signatures (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  signer_role TEXT NOT NULL CHECK (signer_role IN ('freelancer', 'client')),
  signer_user_id TEXT,
  signer_name TEXT NOT NULL,
  signer_email TEXT,
  signature_key TEXT NOT NULL,
  signature_hash TEXT NOT NULL,
  consent_accepted INTEGER NOT NULL DEFAULT 0,
  consent_version TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  signer_ip TEXT,
  signer_user_agent TEXT,
  content_hash TEXT NOT NULL,
  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES contract_versions(id) ON DELETE CASCADE
);

-- One signature per role per version: the database itself rejects replays.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_signatures_unique
  ON contract_signatures (version_id, signer_role);
CREATE INDEX IF NOT EXISTS idx_contract_signatures_contract
  ON contract_signatures (contract_id, signed_at);

CREATE TABLE IF NOT EXISTS contract_signing_events (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  version_id TEXT,
  signature_id TEXT,
  event_type TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  actor_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contract_signing_events_contract
  ON contract_signing_events (contract_id, created_at);

CREATE TABLE IF NOT EXISTS signed_documents (
  id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  version_id TEXT,
  key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_signed_documents_version
  ON signed_documents (document_type, document_id, version_id);
CREATE INDEX IF NOT EXISTS idx_signed_documents_document
  ON signed_documents (document_type, document_id, created_at DESC);

-- Optional per-document password protection for contracts/invoices/forms,
-- kept in a new table so legacy columns are not altered.
CREATE TABLE IF NOT EXISTS document_access (
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  password_hash TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_type, document_id)
);

-- Small key/value metadata store (e.g. invoice tax label) without ALTER TABLE.
CREATE TABLE IF NOT EXISTS document_meta (
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_type, document_id)
);
