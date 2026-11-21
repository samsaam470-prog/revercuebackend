# Revercue backend — release 2.1 implementation report

> **Post-release update (2026-11-21):** the account-linking OTP flow described
> in this historical report has been removed. AuthAction users are now
> provisioned directly and idempotently on their first authenticated request.
> The current contract is `docs/AUTH_ONBOARDING.md`; where the two documents
> disagree, that document wins. The canonical API base URL is
> `https://api.revercue.co.uk`, while `AUTHACTION_AUDIENCE` intentionally remains
> the existing API resource identifier.

Prepared against `samsaam470-prog/revercuebackend` (branch `main`, commit `9c60423`).
All schema requirements were derived from the source code, not from migration files; the
repository only contained `migrations/0002_wiki_cache.sql`, so the base schema was created
outside migrations and is treated as pre-existing production state.

---

## A. Implementation summary

### Authentication (AuthAction)
- **New** `src/services/authaction.ts`: RS256 access-token verification with AuthAction's
  JWKS, `iss` verification after signature verification (normalises the trailing slash that
  AuthAction's discovery document publishes), exact `aud` verification, `exp`/`nbf`,
  allowed-algorithm allowlist (`RS256` by default), JWKS caching via `createRemoteJWKSet`
  (rotation + cooldown handled by `jose`), 30 s clock tolerance, and rejection of malformed,
  unsigned (`alg: none`), HS256 (algorithm-confusion), wrongly-issued and expired tokens.
  ID tokens are rejected: through the audience check in normal configuration, and through
  explicit ID-token markers (`nonce`, `at_hash`, `c_hash`, `token_use`, `typ`) when an
  operator has misconfigured the audience to the client id.
- `src/services/identity.ts`: `user_identities` mapping of AuthAction `sub` → Revercue
  user with **direct, idempotent provisioning**. There is no linking code flow. An existing
  Revercue user is adopted only when AuthAction asserts that the email is verified and the
  email matches exactly one user; concurrent first requests share a deterministic user id
  and the unique `(provider, subject)` index decides any race. Legacy `auth_link_codes`
  remains only as historical production data.
- **Rewritten** `src/middleware/user-auth.ts`: one middleware for AuthAction bearer tokens and
  (behind `ALLOW_LEGACY_AUTH`, default on) the legacy HS256 app JWT. It always exposes the
  authenticated user (id, email, plan) and never trusts a client-supplied user id. Legacy
  sessions are still checked and `last_active_at` is touched.
- **New** `src/middleware/access.ts`: `requirePlan`, `requireRole`, ownership assertions.
- Auth routes: `GET /api/auth/me` uses the shared middleware, provisions or retrieves the
  Revercue user, and returns `authenticated`, the user and an `onboarding` object
  (`required`, `complete`, `step`, `next_step`, `destination`). The old signup/login/OTP
  endpoints remain for compatibility until the frontend migrates. Revercue remains the
  source of truth for plan, payment status, roles and feature access.
- Removed: `POST /api/auth/link/start`, `POST /api/auth/link/confirm`, the account-link OTP
  email template and the `account_link_required` response. Those routes now return `404`.

### Contracts: electronic signature
- **New** `contract-state.ts` (pure rules), `contract-signing.ts` (persistence),
  `pdf-signed.ts` (countersigned PDF), `document-links.ts` (short-lived HMAC links).
- New tables: `contract_versions`, `contract_signatures`, `contract_signing_events`,
  `signed_documents`, `document_access`, `document_meta`.
- The business rule is enforced **server-side**: `publish` returns
  `409 freelancer_signature_required` unless the current version carries a freelancer
  signature. Signing requires explicit consent, a drawn-signature data URL (PNG/JPEG, size
  and magic-byte checked), records name/email/IP/user-agent/consent version/content hash, and
  is rejected for duplicates, replays, superseded versions and hash mismatches (the unique
  index on `(version_id, signer_role)` is the final guard).
- After the first signature the version is locked (`locked_at`); `PATCH /api/contracts/:id`
  returns `409 version_locked` with `details.requires_new_version`, and
  `POST /api/contracts/:id/versions` creates a new immutable draft version.
- When both signatures exist, a real PDF is generated with both signature images and the
  signing evidence, stored under a private B2 key (`signed_documents`), and served only by
  `GET /api/public/contracts/:id/signed-pdf?token=…` or
  `GET /api/contracts/:id/signed-pdf-link` (owner). The contract link alone cannot fetch it.
- Legacy public `POST /api/public/c/:publicId/action` with `approve` no longer signs: it
  returns `409 signature_required` and points at `POST /api/public/c/:publicId/sign`.

### Notifications and SSE
- `GET /api/notifications/stream` is an authenticated SSE endpoint scoped to the caller's own
  notifications, supports `Last-Event-ID`/`since`, sends keepalive comments, caps connection
  lifetime (`SSE_MAX_SECONDS`, default 300 s) and polling interval (1–15 s), and ends the
  stream with a `reconnect` event so the client re-subscribes with a fresh token. Existing
  list/unread/mark-read/mark-all/delete endpoints are preserved with pagination and filters.
- Emitted events now include proposal opened/accepted/declined, contract opened/signed/fully
  signed, invoice paid, form submitted, proof uploaded, client replies, retention warnings and
  summary-ready events, each gated by the user's notification preferences.
- **SSE has not been verified against a deployed Worker or a real browser EventSource.**

### Document tracking
- Tracking accepts proposals, contracts, invoices and forms; plan gating is enforced
  (`allowedForPlan`), visits are de-duplicated per visitor hash within 30 minutes, events are
  attached to a real visit id (the previous code created a random visit id per event), event
  counts are bounded (200/visit), `time_spent` is capped, ownership is re-validated before any
  write, and IPs are stored only as hashes. Retention: tracking rows are purged after 5 days.

### Retention lifecycle
- Ten-day warning is idempotent via `retention_warnings.idempotency_key`
  (`type:id:YYYY-MM-DD:days`), sending in-app + email once per document per expiry date.
- At expiry the document PDF is generated, emailed, recorded in `retention_deliveries`, and
  only a `sent` delivery allows the configured deletion. Failures are retried with backoff,
  parked as `abandoned` at the attempt limit, surfaced via
  `GET /api/admin/retention-failures`, and never delete the only copy.
- Default auto-delete set is `proposal,contract`; `invoice` and `form` are configured
  `deletable: false` in `RETENTION_POLICY` and are dropped from the configuration even if an
  operator lists them. Fully signed contracts/invoices therefore need an explicit product
  decision before any deletion policy applies (see H).
- The hourly cron runs retention, email retries, form enrichment, proof cleanup and rate-limit
  cleanup in isolation, so one failure cannot stop the others.

### Forms, Extract and Visual Assets
- Submissions are persisted **before** any external call (`form_submissions`), with a
  client-supplied idempotency key for replay protection, validation (answer count/size,
  required questions), retryable status machine (`received → processing → enriched|failed`),
  attempt caps and backoff. Research/assets are stored as JSON with attribution/licence
  metadata and never replace the original answers. Public uploads are size/type limited,
  stored privately under `document_uploads`, and ownership-checked on read.

### Templates, marketing, admin, email
- Templates: `user_id` is now written on upload; custom templates are always filtered by
  owner; built-in templates are admin-managed and cannot be edited/deleted by users; tags are
  parsed from JSON or CSV; `template_metadata` holds description/category; URL imports go
  through the SSRF guard.
- Marketing: `POST /api/newsletter` (single opt-in, normalised email, no duplicates, consent
  timestamp, HMAC unsubscribe links; legacy confirm links still honoured), `POST /api/contact`, `POST /api/waitlist`,
  `POST /api/beta`, all rate limited and spam-guarded, storing submissions even if the
  notification email fails. Admin-only listing/export endpoints were added.
- Admin: user list/detail/plan/delete, payments, waitlist, beta, contact, website-help,
  feedback, notes, newsletter list + CSV export, built-in template management
  (edit/publish/unpublish/delete), retention failures, email delivery list/retry, system
  errors, metrics, audit log. Every mutation is written to `admin_audit_log`. Admin auth is a
  separate JWT; no user route can grant admin rights.
- Email: `services/email.ts` sends through Cooper then OpenMail only, with delivery logging
  (`email_deliveries`), idempotency keys, payload storage for retry, backoff and provider
  acceptance recorded as the only success signal. FormSubmit is fully removed server-side.

### Security hardening
- SSRF-safe outbound fetching (`utils/url-safety.ts`: https only, private/loopback/metadata
  address blocking, redirect re-validation, size/time limits) used by templates and pipeline.
- Error responses no longer leak internal messages: `app.onError` logs details with a
  reference code and returns a generic message.
- Security headers, strict CORS allowlist (`FRONTEND_ORIGIN` + `ALLOWED_ORIGINS`, no
  credentials), no public SQL endpoint, parameterised SQL everywhere, private B2 objects only
  through authorized routes or short-lived signed tokens, upload type/size/plan limits,
  rate limits on public and write endpoints, and audit logging for privileged actions.

---

## B. Files changed

### Added — services
| File | Purpose |
| --- | --- |
| `src/services/authaction.ts` | AuthAction OIDC discovery, JWKS cache, access-token verification, ID-token rejection |
| `src/services/identity.ts` | `user_identities` mapping + direct idempotent provisioning |
| `src/services/contract-state.ts` | Pure contract state machine and signing rules |
| `src/services/contract-signing.ts` | Version/signature persistence, publish, client sign, signed PDF orchestration |
| `src/services/pdf-signed.ts` | Countersigned contract PDF with embedded signatures and evidence |
| `src/services/document-links.ts` | Short-lived HMAC download/signing links |
| `src/services/retention.ts` | Warning/expiry policy, PDF delivery gate, retry, deletion |
| `src/services/form-submissions.ts` | Persist-then-enrich submissions, validation, processing states |
| `src/services/newsletter.ts` | Subscriber state machine + signed unsubscribe/legacy-confirm tokens |
| `src/services/notification-preferences.ts` | Canonical preference keys, legacy mapping |
| `src/services/email-templates.ts` | Revercue-native email bodies |
| `src/services/email-retry.ts` | Backoff/terminal-state helpers |
| `src/services/admin-audit.ts` | Admin audit log writes |
| `src/services/archive.ts` | Archive/unarchive state for contracts/forms/invoices |
| `src/services/clients.ts` | Client resolution for public submissions |

### Added — routes, middleware, utils, tests, migrations, scripts
| File | Purpose |
| --- | --- |
| `src/routes/marketing.ts` | Newsletter/contact/waitlist/beta |
| `src/middleware/access.ts` | Plan/role/ownership guards |
| `src/utils/crypto.ts` | HMAC tokens, sha256, constant-time compare, password hashing helpers |
| `src/utils/http.ts` | IP/UA extraction, hashing, reference codes |
| `src/utils/pagination.ts` | Shared `Paginated<T>` shape (`{data, pagination}`) |
| `src/utils/url-safety.ts` | SSRF guard |
| `src/utils/dynamic-insert.ts` | Introspection-based inserts for legacy marketing tables |
| `src/utils/pdf-text.ts` | PDF text sanitising (WinAnsi safety) |
| `src/utils/api-errors.ts` | Uniform `{error,message,details}` responses |
| `migrations/0003_contract_signing.sql` | Contract versions/signatures/events, signed docs, access, meta |
| `migrations/0004_document_lifecycle.sql` | Archive, retention warnings/deliveries, uploads, indexes |
| `migrations/0005_forms_and_templates.sql` | Form submissions/settings, template metadata |
| `migrations/0006_tracking_and_settings.sql` | Visit meta, suggestion dismissals, revision prices |
| `migrations/turso/0001_identity_and_email.sql` | Identities, legacy link-code table, email deliveries, indexes |
| `migrations/turso/0002_marketing_and_admin.sql` | Newsletter subscribers, branding, admin audit |
| `scripts/turso-migrate.mjs` | Idempotent Turso migration runner (libSQL HTTP pipeline) |
| `test/*.test.ts` | Unit and route tests; 99 passing after the post-release auth update (see I) |
| `vitest.config.ts` | Test configuration |

### Modified
| File | Change |
| --- | --- |
| `src/index.ts` | CORS allowlist, security headers, marketing mount, generic error handler + `error_logs`, cron wiring |
| `src/types.ts` | Full `Bindings` inventory, `AuthContext` |
| `src/config/constants.ts` | Contract/consent, retention policy, SSE, email, upload, tracking constants |
| `src/middleware/user-auth.ts` | AuthAction + legacy auth, unified context |
| `src/utils/db.ts` | `dbRunResult`, `dbCount`, `placeholders` helpers |
| `src/routes/contracts.ts` | Sign/publish/versions/duplicate/archive/share/pdf/signed-pdf/events/tracking |
| `src/routes/public.ts` | Tracking for all types, password tokens, proposal action, client sign, real PDFs, signed-PDF and retention downloads, form upload, proof upload |
| `src/routes/forms.ts`, `invoices.ts`, `proposals.ts` | Pagination shape, duplicate/archive/share, uploads, real PDFs |
| `src/routes/files.ts` | Private object authorization (owner or signed token), upload validation |
| `src/routes/notifications.ts` | SSE + pagination/filters, ownership |
| `src/routes/settings.ts` | Plan/receipt shape, sessions `{data}`, per-session logout, prefs, saved FAQ/package PATCH, revision prices, logo upload, `formsubmit-activate` → 410 |
| `src/routes/templates.ts` | Ownership fix, tag parsing, metadata, SSRF-safe import |
| `src/routes/crm.ts` | CSV export before `/:id`, pagination, `keep_documents` delete guard |
| `src/routes/dashboard.ts` | Suggestion dismissal persistence, activity feed |
| `src/routes/admin.ts`, `admin-actions.ts` | New operational endpoints, built-in-only template management, audit logging, email retry |
| `src/routes/auth.ts` | `/me` via shared middleware, link endpoints, FormSubmit insert removed |
| `src/services/email.ts`, `email-notify.ts`, `notifications.ts` | Provider abstraction, delivery log, retries, preference gating |
| `src/services/storage.ts` | Private/public handling, delete, safe filenames |
| `src/services/tracking.ts` | Real visit ids, dedupe, plan gates, retention |
| `src/services/pdf.ts`, `pdf-binary.ts` | Real PDF bytes for all document types |
| `src/services/pipeline.ts` | SSRF-safe Extract/Visuals, attribution metadata |
| `src/cron/retention.ts`, `pdf-cleanup.ts`, `summary.ts` | Isolated hourly jobs |
| `package.json`, `wrangler.toml` | Scripts, vitest, vars (no secrets) |

---

## C. Migration files

**D1** (relative to `wrangler.toml`, `migrations_dir` default `migrations`):
1. `migrations/0003_contract_signing.sql`
2. `migrations/0004_document_lifecycle.sql`
3. `migrations/0005_forms_and_templates.sql`
4. `migrations/0006_tracking_and_settings.sql`

**Turso**:
1. `migrations/turso/0001_identity_and_email.sql`
2. `migrations/turso/0002_marketing_and_admin.sql`

Runner: `scripts/turso-migrate.mjs` (records versions in `schema_migrations`).

All migrations are **additive**: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
no `ALTER TABLE`, no `DROP`, no data statements.

---

## D. Database inventory

### D1 (`DB` binding, `revercue-db`)
Existing, used by code: `proposals`, `contracts`, `invoices`, `forms`, `clients`,
`client_notes`, `communication_log`, `document_visits`, `document_events`, `templates`,
`file_uploads`, `wiki_cache`.

New in this release: `contract_versions`, `contract_signatures`, `contract_signing_events`,
`signed_documents`, `document_access`, `document_meta`, `document_archive`,
`retention_warnings`, `retention_deliveries`, `document_uploads`, `form_submissions`,
`form_settings`, `template_metadata`, `document_visit_meta`, `suggestion_dismissals`,
`revision_prices`.

### Turso (`TURSO_URL`)
Existing, used by code: `users`, `sessions`, `notifications`, `payments`, `payment_requests`,
`upgrade_requests`, `waitlist`, `beta_testers`, `contact_messages`, `website_help_requests`,
`feedback`, `admin_notes`, `instructions`, `patterns`, `pairings`, `error_logs`,
`formsubmit_activations` (now unused).

New: `user_identities`, `email_deliveries`, `newsletter_subscribers`,
`user_branding`, `admin_audit_log`, `schema_migrations` (created by the runner).

`formsubmit_activations` is **not dropped** (production data is preserved); it is simply no
longer written or read.

---

## E. Cloudflare Worker environment variables

### A. Required non-secret variables (`[vars]`, already in `wrangler.toml`)
| Name | Purpose |
| --- | --- |
| `FRONTEND_ORIGIN` | Primary CORS origin (`https://revercue.co.uk`) |
| `ALLOWED_ORIGINS` | Additional CORS origins, including `https://revercue.pages.dev` |
| `API_BASE_URL` | Canonical public API origin (`https://api.revercue.co.uk`) |
| `TURSO_URL` | Turso database URL |
| `B2_BUCKET_NAME`, `B2_KEY_ID`, `B2_S3_ENDPOINT` | Backblaze B2 storage identifiers |
| `B2_S3_REGION` (optional) | Region for SigV4 signing, defaults from endpoint |
| `COOPER_INBOX_ID`, `OPENMAIL_INBOX_ID` | Sending inboxes |
| `AUTHACTION_ISSUER` | `https://revercue.in.authaction.com` (discovery publishes it with a trailing slash; both forms are accepted) |
| `AUTHACTION_AUDIENCE` | `revercue-api.samsaam470.workers.dev` (intentionally unchanged by the custom API hostname) |
| `AUTHACTION_CLIENT_ID` (public, optional) | `OXJC1YmE3BwYU03xKfrMblC2F8hr9AC4`; enables the client-id/ID-token guard (never used as the API audience) |
| `ADMIN_USER` | Admin dashboard username (existing) |
| `ALLOW_LEGACY_AUTH` | `true` during migration, `false` to retire legacy auth |
| `RETENTION_WARNING_DAYS` | Warning window, default `10` |
| `RETENTION_AUTO_DELETE_TYPES` | `proposal,contract` |
| `RETENTION_MAX_DELIVERY_ATTEMPTS` | Optional, default `5` |
| `EMAIL_MAX_ATTEMPTS` | Optional, default `5` |
| `MAX_UPLOAD_BYTES` | Optional, default 10 MiB |
| `SSE_MAX_SECONDS` | Optional, default `300` |
| `SSE_POLL_MS` | Optional, default `5000` |
| `SSE_KEEPALIVE_SECONDS` | Optional, default `15` |
| `APP_URL` | Optional public app URL used in emails (defaults to `FRONTEND_ORIGIN`) |

### B. Required secrets (`wrangler secret put …` / dashboard)
| Name | Used by |
| --- | --- |
| `USER_JWT_KEY` | Legacy app JWT signing (still required while legacy auth is on and as link-token fallback) |
| `ADMIN_PASS` | Admin login |
| `ADMIN_JWT_KEY` | Admin JWT signing |
| `TURSO_TOKEN` | Turso |
| `B2_APP_KEY` | B2 S3 secret |
| `COOPER_API_KEY` | Cooper Email |
| `OPENMAIL_API_KEY` | OpenMail fallback |
| `SIGNING_LINK_SECRET` | Signed-download/signing/newsletter/file tokens (falls back to `USER_JWT_KEY` with a logged warning) |
| `OTP_HASH_KEY` | Legacy OTP hashing (only while legacy auth is retained) |
| `AUTHACTION_MANAGEMENT_TOKEN` | Not used by the Worker; only for operator tooling if you provision clients programmatically |

### C. Optional
`AUTHACTION_JWKS_URL`, `AUTHACTION_DISCOVERY_URL`, `AUTHACTION_REQUIRED_ALGS`,
`AUTHACTION_EMAIL_CLAIM`, `AUTHACTION_VERIFIED_CLAIM`, `ADMIN_NOTIFICATION_EMAIL`,
`EMAIL_FROM`, `ENVIRONMENT`.

### D. Removable after migration
`OTP_HASH_KEY` (once legacy OTP is retired), `ALLOW_LEGACY_AUTH` → can be set to `false`
(keep the variable), `formsubmit_activations` related rows, and the legacy `/auth/signup`,
`/auth/login`, `/auth/otp/*` endpoints once the frontend cutover is complete.

No AuthAction credential is stored in source, migrations or `wrangler.toml`.

---

## F. Deployment commands

```bash
# 1. Install (lockfile is committed for the first time by this release)
npm ci                     # or: npm install

# 2. Checks
npx tsc --noEmit
npx vitest run
npx wrangler deploy --dry-run --outdir=dist

# 3. Backups (do these first, outside the Worker)
npx wrangler d1 export revercue-db --remote --output=backup-d1-$(date +%F).sql
# Turso: turso db shell <db> ".dump" > backup-turso-$(date +%F).sql   (or the dashboard export)

# 4. D1 migrations — staging/preview first
npx wrangler d1 migrations list revercue-db --remote
npx wrangler d1 migrations apply revercue-db --remote --preview   # if you have a preview DB
npx wrangler d1 migrations apply revercue-db --remote             # production, after review

# 5. Turso migrations — dry run, then apply
TURSO_URL=... TURSO_TOKEN=... node scripts/turso-migrate.mjs --dry-run
TURSO_URL=... TURSO_TOKEN=... node scripts/turso-migrate.mjs

# 6. Verify
npx wrangler d1 execute revercue-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
TURSO_URL=... TURSO_TOKEN=... node -e "fetch(process.env.TURSO_URL.replace('libsql://','https://')+'/v2/pipeline',{method:'POST',headers:{Authorization:'Bearer '+process.env.TURSO_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({requests:[{type:'execute',stmt:{sql:\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\",args:[]}},{type:'close'}]})}).then(r=>r.text()).then(console.log)"

# 7. Secrets (only the ones that are not set yet)
npx wrangler secret put SIGNING_LINK_SECRET
npx wrangler secret put ADMIN_JWT_KEY
npx wrangler secret put TURSO_TOKEN
npx wrangler secret put COOPER_API_KEY
npx wrangler secret put OPENMAIL_API_KEY
# … B2_APP_KEY, USER_JWT_KEY, ADMIN_PASS, OTP_HASH_KEY

# 8. Deploy
npx wrangler deploy
```

Rollback: D1/Turso migrations are additive-only, so a code rollback is safe and does not
require reverting schema. If a migration itself must be undone, restore the export taken in
step 3 — never drop tables that contain production rows. Restoring a backup overwrites new
rows, so take it immediately before applying.

---

## G. API compatibility report

Status legend: **matched** (unchanged), **fixed** (was broken/mismatched, now matches the
frontend), **new** (frontend call previously had no backend), **retired** (intentionally gone),
**frontend work** (backend ready, consumer change needed).

| Frontend call | Backend | Status |
| --- | --- | --- |
| `GET /api/auth/me` | same, AuthAction-aware | fixed |
| `POST /api/settings/formsubmit-activate` | `410 retired` | retired |
| `GET /api/proposals?page&limit` | `{data,pagination}` | fixed |
| `GET /api/contracts`, `/forms`, `/invoices` lists | `{data,pagination}` | fixed |
| `POST /api/contracts/:id/duplicate` / `archive` / `unarchive` / `share` | implemented | new |
| `POST /api/forms/:id/duplicate` / `archive` / `unarchive` / `share` | implemented | new |
| `POST /api/invoices/:id/duplicate` / `archive` / `unarchive` / `share` | implemented | new |
| `GET /api/dashboard/suggestions`, `POST /suggestions/:id/dismiss` | implemented with persistence | fixed/new |
| `GET /api/crm/clients/export` | CSV before `/:id` | fixed |
| `DELETE /api/crm/clients/:id?keep_documents=` | implemented | fixed |
| `PATCH /api/settings` notification prefs | canonical keys | fixed |
| `GET/DELETE /api/settings/sessions` | `{data}` + per-session logout | fixed |
| `GET /api/settings/plan` | plan + receipt | fixed |
| `PUT /api/settings/saved-faqs`, `saved-packages` (+ keep) | implemented | new |
| `PUT /api/settings/revision-prices` | `revision_prices` table | new |
| `POST /api/settings/logo` | multipart `logo`, returns signed URL | fixed |
| `GET /api/notifications`, unread, read, read-all, delete | preserved, paginated | matched |
| `GET /api/notifications/stream` | SSE, auth-scoped | new (frontend work) |
| Public unlock `POST /api/public/{p,c,i,f}/:id/unlock` | contract/invoice/form added | fixed |
| `POST /api/public/forms/:id/upload` | implemented | new |
| `POST /api/public/c/:publicId/action` `approve` | `409 signature_required` | retired |
| `POST /api/public/c/:publicId/sign` | client signature | new (frontend work) |
| `GET /api/public/c/:publicId/pdf` | real PDF (inline) | fixed |
| `GET /api/public/contracts/:id/signed-pdf?token` | private signed PDF | new |
| `POST /api/newsletter`, `/contact`, `/waitlist`, `/beta` | implemented | new |
| `POST /api/extract`, `POST /api/organize/visuals` | SSRF-safe, attribution metadata | fixed |
| Templates list/create/upload/delete | ownership + tags fixed | fixed |
| Admin: users, plans, waitlist, beta, contact, payments, feedback, notes | preserved + paginated | fixed |
| Admin: newsletter, email failures/retry, retention failures, errors, metrics, audit | implemented | new |
| Admin: built-in template publish/unpublish/delete | implemented | new |

Missing routes from the earlier audit that are now implemented: CRM export, dashboard
suggestion dismissal, contract/form/invoice duplicate/archive/unarchive/share, settings logo,
receipts, session logout, saved FAQs/packages, revision prices, public unlock for
contract/invoice/form, public form upload, marketing endpoints.

Intentionally retired: FormSubmit activation (HTTP 410) and the legacy public "approve =
signature" action.

---

## H. Remaining work

1. **Frontend (required before release).**
   - Replace the account-linking screen with direct AuthAction login; use
     `GET /api/auth/me` to establish the session and route to
     `onboarding.destination`. Handle `email_verification_required`,
     `account_conflict`, `identity_orphaned` and `identity_store_unavailable`.
     The full contract is `docs/AUTH_ONBOARDING.md`.
   - Drawn-signature UI + explicit consent checkbox for freelancer and client signing.
   - Stop treating "approve" as a signature; call `/sign` and handle `409 signature_required`.
   - Pass a stable `visit_id` (and `client_submission_id`) on tracking events.
   - Consume `/api/notifications/stream` with `EventSource` + `Last-Event-ID` (polling
     fallback already works).
   - Remove FormSubmit copy, banner and `activateFormSubmit`; update the privacy policy text
     (`src/pages/public/LegalPages.tsx`, `DashboardOverviewPage`, `SettingsPage`,
     `SignupTransitionPage`, `src/types/index.ts`).
   - Send `keep_documents` on client delete and handle `409 client_has_documents`.
2. **AuthAction dashboard.** Confirm the API resource audience
   `revercue-api.samsaam470.workers.dev`, the callback URLs for `revercue.co.uk`,
   `revercue.pages.dev` and local development, and that passkeys/WhatsApp/Google are enabled
   for the `revercue` application. The backend performs OIDC discovery; no client secret is
   used by the Worker. Do not replace the audience with `api.revercue.co.uk`.
3. **Credentials/configuration.** `B2_APP_KEY`, `TURSO_TOKEN`, `COOPER_API_KEY`,
   `OPENMAIL_API_KEY`, `ADMIN_JWT_KEY`, `ADMIN_PASS`, `SIGNING_LINK_SECRET`, `USER_JWT_KEY`
   must exist in the Worker; none were available here, so email/B2/Turso were not exercised.
4. **Legal/accounting review** of the `contract` auto-delete default and of any deletion of
   fully signed contracts or invoices. The code is conservative (invoices/forms never
   auto-delete), but the signed-contract window is a business decision.
5. **Admin dashboard UI** does not exist; only the APIs are implemented.
6. **Operational verification** that could not be run here: applying the migrations to real
   D1/Turso, provider email sends, B2 signed PDF storage, SSE behind Cloudflare, and end-to-end
   signing.

---

## I. Test results (actual)

> Post-release auth update: `npx tsc --noEmit` passed and `npx vitest run` passed
> 99 tests across 13 files. The historical results below describe release 2.1
> before the account-linking removal.

```
$ npx tsc --noEmit
(no output)                                  exit 0

$ npx vitest run
 ✓ test/authaction.test.ts        (10 tests)
 ✓ test/contract-signing.test.ts  (12 tests)
 ✓ test/newsletter-and-forms.test.ts (11 tests)
 ✓ test/email-and-preferences.test.ts (9 tests)
 ✓ test/pdf-and-tracking.test.ts  (5 tests)
 ✓ test/retention.test.ts         (7 tests)
 ✓ test/auth-middleware.test.ts   (5 tests)
 Test Files  7 passed (7)
      Tests  59 passed (59)

$ npx wrangler deploy --dry-run --outdir=dist
--dry-run: exiting now.                        exit 0
```

Covered: valid/invalid-signature/wrong-audience/wrong-issuer/expired/HS256/ID-token/
malformed/missing-subject AuthAction cases; contract signing gates, duplicate signatures,
version locking, state derivation, consent, canonical hashing; retention warning window,
expiry, idempotency key, safe auto-delete policy; email backoff/terminal states; preference
mapping/serialisation; newsletter state machine and token forgery; form answer validation;
template tag parsing; real PDF signatures; tracking plan gating; missing/invalid token
rejection for user and admin middleware.

**Not tested:** anything requiring credentials or a live database — D1/Turso queries,
migration application, B2 upload/download, Cooper/OpenMail delivery, SSE through Cloudflare,
route-level integration tests, and the deployed Worker. No integration or end-to-end test
suite was added, and no production command was executed.

---

## J. Deployment checklist

1. Back up D1 and Turso (F step 3); store the files outside the repo.
2. Apply D1 migrations to a staging/preview database; verify tables and indexes.
3. Apply Turso migrations with `--dry-run`, then for real; confirm `schema_migrations`.
4. Set every secret in E/B; confirm `AUTHACTION_ISSUER`/`AUDIENCE` match AuthAction discovery.
5. Deploy the Worker (`npx wrangler deploy`).
6. Smoke test: `/api/health`, `GET /api/auth/me` with an AuthAction token, one legacy token
   (still allowed), a public proposal page, and `/api/newsletter` single opt-in.
7. Sign a test contract end-to-end: freelancer sign → publish → client sign → signed PDF
   download as both parties; confirm a second signature returns `409`.
8. Trigger the cron manually (`wrangler dev --test-scheduled` or a temporary crontab entry)
   and check `retention_warnings`, `email_deliveries` and logs.
9. Monitor `GET /api/admin/health` for `error_logs`, retention and email failures.
10. After the frontend cutover: set `ALLOW_LEGACY_AUTH=false`, remove FormSubmit copy from the
    frontend, then retire the legacy auth endpoints in a later release.
