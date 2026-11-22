-- Turso · AuthAction identity directory + admin notifications/announcements.
-- Additive only. Does not alter existing user/identity tables.

CREATE TABLE IF NOT EXISTS authaction_identities (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  connection TEXT,
  applications TEXT,
  roles TEXT,
  tenant TEXT,
  authaction_created_at TEXT,
  authaction_updated_at TEXT,
  last_login_at TEXT,
  synced_at TEXT NOT NULL,
  linked_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_authaction_identities_email
  ON authaction_identities (email);
CREATE INDEX IF NOT EXISTS idx_authaction_identities_linked
  ON authaction_identities (linked_user_id);
CREATE INDEX IF NOT EXISTS idx_authaction_identities_synced
  ON authaction_identities (synced_at DESC);

CREATE TABLE IF NOT EXISTS authaction_sync_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  total_fetched INTEGER NOT NULL DEFAULT 0,
  upserted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  triggered_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_authaction_sync_runs_started
  ON authaction_sync_runs (started_at DESC);

-- Announcements shown to users on dashboard entry after publication.
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'general',
  image_url TEXT,
  link_url TEXT,
  target_audience TEXT NOT NULL DEFAULT 'all',
  target_plans TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  starts_at TEXT,
  expires_at TEXT,
  created_by TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_announcements_status_starts
  ON announcements (status, starts_at);

CREATE TABLE IF NOT EXISTS announcement_views (
  user_id TEXT NOT NULL,
  announcement_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, announcement_id)
);

-- Admin notification campaigns (sent to user bell + optional email).
CREATE TABLE IF NOT EXISTS admin_notification_campaigns (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  target_audience TEXT NOT NULL DEFAULT 'all',
  target_plans TEXT,
  target_user_ids TEXT,
  scheduled_at TEXT,
  published_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  delivery_total INTEGER NOT NULL DEFAULT 0,
  delivery_sent INTEGER NOT NULL DEFAULT 0,
  delivery_failed INTEGER NOT NULL DEFAULT 0,
  delivery_read INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_notif_campaigns_status
  ON admin_notification_campaigns (status, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_notification_deliveries (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  notification_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  delivered_at TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_notif_deliveries_campaign
  ON admin_notification_deliveries (campaign_id);
CREATE INDEX IF NOT EXISTS idx_admin_notif_deliveries_user
  ON admin_notification_deliveries (user_id);