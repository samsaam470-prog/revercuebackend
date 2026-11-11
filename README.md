# revercue-api

The Revercue backend. Cloudflare Workers + Hono, Turso (auth + admin), D1 (product), B2 (files).

## Stack
- TypeScript, Hono, Cloudflare Workers
- Turso (auth, admin, suggestions)
- D1 (clients, documents, tracking, communication, expenses)
- B2 (images, templates, proofs)
- FormSubmit (transactional and notification email)
- JWT (user and admin, separate keys)

## Environment variables (Cloudflare Worker Settings)
- ADMIN_USER, ADMIN_PASS, ADMIN_JWT_KEY
- USER_JWT_KEY
- TURSO_URL, TURSO_TOKEN
- B2_KEY_ID, B2_APP_KEY, B2_BUCKET_NAME, B2_S3_ENDPOINT
- FORMSUBMIT_EMAIL
- FRONTEND_ORIGIN

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
- /api/templates — list, get, upload, delete
- /api/admin — login, overview, users, waitlist, beta, contact, website-help, payments, feedback, templates, suggestions, health, notes

## Deploy
Connected to GitHub. Every push to main triggers a deploy.

## Health
GET /api/health → {"ok":true}
