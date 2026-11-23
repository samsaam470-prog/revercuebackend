-- Contracts carry two facts: the storage status the old lifecycle check allows
-- ('draft','published','approved','declined','inactive','archived') and the
-- electronic-signature lifecycle ('awaiting_client_signature','fully_signed',
-- …). Writing the signing state into `contracts.status` failed the table CHECK,
-- so publishing and client signing returned 500. Keep the signing lifecycle in
-- its own column instead of rebuilding the table (and its child rows).
--
-- `signed_at` is written and read by the signing flow and the contract list but
-- was never created, so it is added here too.

ALTER TABLE contracts ADD COLUMN signing_status TEXT NOT NULL DEFAULT 'draft';

ALTER TABLE contracts ADD COLUMN signed_at TEXT;

UPDATE contracts
SET signing_status = CASE
  WHEN approved_at IS NOT NULL THEN 'fully_signed'
  WHEN published_at IS NOT NULL THEN 'awaiting_client_signature'
  ELSE 'draft'
END;

CREATE INDEX IF NOT EXISTS idx_contracts_signing_status ON contracts (signing_status);
