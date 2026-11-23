-- The template routes scope custom templates by `templates.user_id`, and the
-- upload path already inserts it, but the column was never created. Reads of
-- /api/templates therefore failed with "no such column: t.user_id" and the
-- builder showed "Your uploaded templates could not be loaded."
--
-- Additive only: existing built-in rows keep a NULL owner, which the queries
-- already ignore because they select `source = 'built_in'` without a user.

ALTER TABLE templates ADD COLUMN user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_templates_owner
  ON templates (user_id, source, status);
