# revercue-api

The Revercue backend. Cloudflare Workers + Hono, Turso (auth + admin), D1 (product), B2 (files).

## Stack
- TypeScript, Hono, Cloudflare Workers
- Turso (auth, admin, suggestions)
- D1 (clients, documents, tracking, communication, expenses)
- B2 (images, templates, proofs)
- Cooper Email (primary) and OpenMail (fallback) for transactional email — FormSubmit is retired
- AuthAction (OIDC/JWKS) for user authentication, with legacy JWT behind `ALLOW_LEGACY_AUTH`
- JWT (admin, separate key)

## Environment variables
See `docs/RELEASE_2.1.md` section E for the complete inventory (variables vs secrets).
Nothing is hardcoded; secrets live in Worker settings, never in the repo.

## Checks
```bash
npm ci
npx tsc --noEmit
npx vitest run
npx wrangler deploy --dry-run --outdir=dist
```

## Migrations
- D1: `npx wrangler d1 migrations apply revercue-db --remote` (`migrations/0003`–`0006`)
- Turso: `TURSO_URL=… TURSO_TOKEN=… node scripts/turso-migrate.mjs` (`migrations/turso`)

Both are additive and idempotent; back up first. Full release notes, API compatibility
report and deployment checklist: `docs/RELEASE_2.1.md`.

## Routes
- /api/auth — signup, login, google, verify, 2fa, password reset, logout, me
- /api/onboarding — step 1, 2, 4, 5, tutorial
- /api/dashboard — summary, suggestions, activity
- /api/proposals — CRUD, draft, publish, duplicate, archive, share, password, autosave
- /api/contracts — same shape
- /api/forms — same shape
- /api/invoices — same shape
- /api/public — the client-facing pages
- /api/files — the B2 proxy and upload
- /api/crm — clients, notes, communication, export, interest
- /api/settings — profile, plan, security, notifications, saved FAQs/packages, revision prices, what-revercue-knows, delete account
- /api/notifications — stream, list, unread, read, dismiss
- /api/templates — list, get, upload, delete, admin publish/unpublish
- /api/newsletter, /api/contact, /api/waitlist, /api/beta — public marketing endpoints
- /api/admin — login, overview, metrics, users, waitlist, beta, contact, website-help, payments, feedback, newsletter (+CSV export), templates, suggestions, health, email/retention failures, audit log, notes

## Deploy
Connected to GitHub. Every push to main triggers a deploy.

## Health
GET /api/health → {"ok":true}
