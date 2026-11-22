# Admin Dashboard & AuthAction Management API Integration

## Overview

The admin dashboard (separate repo `revercueadmin`, deployed at
`adminrevercue.pages.dev`) now displays the complete AuthAction identity
directory, including identities that have never registered in Revercue.

## Required Worker secrets

Set these on the `revercue-api` Worker (production and preview) using
`wrangler secret put`. Values are never committed.

```sh
cd revercuebackend
npx wrangler secret put AUTHACTION_M2M_CLIENT_ID
npx wrangler secret put AUTHACTION_M2M_CLIENT_SECRET
# Optional; defaults to AUTHACTION_ISSUER (https://revercue.in.authaction.com)
npx wrangler secret put AUTHACTION_M2M_AUDIENCE
```

Non-secret identifiers are already in `wrangler.toml`:

- `AUTHACTION_ISSUER = "https://revercue.in.authaction.com"`
- `AUTHACTION_AUDIENCE = "revercue-api.samsaam470.workers.dev"`

The M2M audience verified to work is the tenant domain
`https://revercue.in.authaction.com`. The value `6afa556e96e8f0f53e09eacd`
was rejected by the token endpoint.

## AuthAction Management API (verified)

- Token endpoint: `POST https://revercue.in.authaction.com/oauth2/m2m/token`
  (client credentials, `grant_type=client_credentials`).
- Users endpoint: `GET https://revercue.in.authaction.com/api/v1/users`
  (pagination via `page` (0-indexed) and `limit`; response
  `{ data: { meta, items } }`).
- User detail: `GET .../api/v1/users/:id`.
- Fields: id, name, email, tenant, connection, applications, roles,
  emailVerified, isBlocked, createdAt, updatedAt.
- No last-login field is exposed by the API; `last_login_at` is derived from
  Revercue's own `user_identities.last_login_at`.

## New backend endpoints (admin, protected)

- `GET  /api/admin/identities` — paginated directory. Query: `search`, `status`
  (linked|unlinked|onboarding_incomplete|blocked), `plan`, `linked`
  (true|false), `page`, `limit`.
- `GET  /api/admin/identities/:id` — identity + linked Revercue user, payments,
  feedback, notes, documents.
- `POST /api/admin/identities/sync` — trigger a full sync.
- `GET  /api/admin/identities/sync-status` — last sync run + counts.

## Database

Migration `migrations/turso/0003_authaction_directory.sql` adds:

- `authaction_identities` — directory cache keyed by AuthAction user id.
- `authaction_sync_runs` — sync history.
- `announcements` + `announcement_views`.
- `admin_notification_campaigns` + `admin_notification_deliveries`.

## Announcements & notifications

- Admin: `GET/POST /api/admin/announcements`, `PATCH/DELETE /api/admin/announcements/:id`.
- User: `GET /api/announcements`, `POST /api/announcements/:id/seen`,
  `POST /api/announcements/:id/dismiss`.
- Admin notifications: `GET/POST /api/admin/notifications`,
  `GET /api/admin/notifications/:id`, `POST .../:id/send`,
  `POST .../:id/retry`, `POST .../:id/cancel`.

## Automated notifications

Triggered by verified backend events (best-effort, non-blocking):

- Onboarding completed (`onboarding_completed`).
- Plan changed by admin (`subscription_activated`).

Add further triggers as needed in the relevant routes using
`createNotification`.

## Deployment steps

1. Set the Worker secrets listed above.
2. Run `npm run migrate:turso` (or `node scripts/turso-migrate.mjs`) to apply
   migration 0003.
3. Deploy backend: `npm run deploy`.
4. Build & deploy admin: in `revercueadmin`, `npm ci && npm run build`, then
   push to `main` (Pages builds automatically) or use
   `npx wrangler pages deploy dist`.
5. Set `VITE_API_BASE_URL` in the Pages project environment variables.