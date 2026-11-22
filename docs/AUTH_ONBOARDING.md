# AuthAction → Revercue provisioning and onboarding contract

This document supersedes the account-linking sections of `docs/RELEASE_2.1.md`.
There is **no account-linking page and no account-linking email OTP** in the
current architecture.

## Authentication lifecycle

AuthAction owns the whole authentication lifecycle: sign-up, sign-in (password,
passkeys, WhatsApp, Google), **email verification**, **second factors** and
**forgot password**. Revercue does not duplicate any of it.

| Concern | Owner |
| --- | --- |
| Sign-up | AuthAction |
| Sign-in | AuthAction (legacy `/api/auth/login` only for pre-existing Revercue passwords) |
| Email verification / OTP | AuthAction only. Revercue issues no codes and sends no verification email. |
| Second factors | AuthAction only. There is no Revercue 2FA code. |
| Forgot password / reset | AuthAction only. Revercue has no password-reset endpoint. |
| Email address storage | Revercue stores `users.email` as contact data. It is never verified by Revercue. |

Removed from Revercue (all now `404`): `POST /api/auth/signup`,
`POST /api/auth/verify-email`, `POST /api/auth/resend-verification`,
`POST /api/auth/2fa/verify`, `POST /api/auth/2fa/resend`,
`POST /api/auth/password-reset/request`, `POST /api/auth/password-reset/verify`,
and `POST /api/settings/security/2fa`.

`POST /api/auth/login` remains only so existing Revercue password accounts can
finish the transition. It never sends or checks an email code and never blocks
an unverified email.

## Flow

1. The visitor chooses Login or Start Free on the frontend.
2. The frontend redirects to AuthAction's hosted authentication page.
3. AuthAction authenticates the user and redirects to the frontend callback.
4. The frontend obtains an AuthAction **access token** (not an ID token).
5. The frontend calls `GET /api/auth/me` with
   `Authorization: Bearer <access token>`.
6. The backend verifies the token (signature, issuer, audience, expiry,
   subject) and resolves the stable AuthAction `sub`.
7. If the `sub` has no Revercue mapping, the backend provisions the application
   user in the same request.
8. The response states whether onboarding is required and where to go next.

No legacy Revercue session is needed for an AuthAction user.

## Provisioning rules

- `user_identities (provider, subject)` is unique. `provider` is always
  `authaction`.
- A valid AuthAction token is sufficient to create the Revercue user and
  start onboarding. `email_verified: false` is not a login or onboarding
  blocker, and the backend never returns `403 email_verification_required`.
- Repeated and concurrent requests for the same subject return one user.
  New users receive a deterministic id derived from the subject, so two
  simultaneous first requests cannot create two `users` rows.
- Identity is resolved from the verified AuthAction `sub`, not from email.
- `users.email_verified` records the real claim: new unverified users store
  `0`, new verified users store `1`. A later AuthAction token with
  `email_verified: true` upgrades the stored value to `1`; a false or missing
  claim never downgrades it.
- An existing Revercue user may be adopted only when AuthAction asserts
  `email_verified: true` and exactly one Revercue user has that email. This is
  a migration fallback for accounts created before identity mapping. A
  client-supplied email is never used, and an unverified email never claims an
  existing account; that user gets a separate Revercue account instead.
- AuthAction does not always release an email address. A valid token with no
  email still provisions a user, with `users.email` empty. `GET /api/auth/me`
  then returns `email_missing: true` and the user is asked to add an address in
  onboarding step 1. That address is stored exactly as typed, with
  `email_verified = 0`: Revercue sends no code and performs no verification.
  Onboarding never overwrites an email AuthAction already provided, and refuses
  (`409 email_in_use`) an address another Revercue account already holds.
- If two Revercue users share a verified email, provisioning returns
  `409 account_conflict` rather than guessing.
- If an existing identity points at a missing user, provisioning returns
  `409 identity_orphaned` rather than silently creating a replacement.
- `users.onboarding_step` remains the onboarding source of truth. Step `6`
  means complete; legacy `0`/empty is also treated as complete. New users start
  at step `1`.

No database migration is required for onboarding state.

## API contract

All endpoints below require `Authorization: Bearer <AuthAction access token>`.
The backend re-reads plan and onboarding state from the database on every
request; token claims are not trusted for authorization.

### `GET /api/auth/me`

Establishes or retrieves the application user and returns onboarding state.

Success `200`:

```json
{
  "authenticated": true,
  "user": {
    "id": "usr_...",
    "email": "user@example.com",
    "email_missing": false,
    "name": "Sam",
    "plan": "free",
    "plan_expires_at": null,
    "onboarding_step": 1,
    "onboarding_required": true,
    "onboarding_complete": false,
    "tutorial_completed": null,
    "tutorial_skipped": null,
    "email_verified": 0,
    "two_factor_enabled": null,
    "account_type": null,
    "business_name": null,
    "deletion_requested_at": null,
    "auth": { "provider": "authaction" }
  },
  "onboarding": {
    "step": 1,
    "required": true,
    "complete": false,
    "next_step": 1,
    "destination": "/onboarding/step-1"
  }
}
```

The frontend should use `onboarding.destination` when present. It must not infer
onboarding state from an error message.

Returning users with completed onboarding receive:

```json
"onboarding": {
  "step": 6,
  "required": false,
  "complete": true,
  "next_step": null,
  "destination": "/dashboard"
}
```

### Authentication and provisioning errors

| Status | `error` | Meaning |
| --- | --- | --- |
| `401` | `unauthorized` | Missing, malformed, expired, wrongly signed, wrong issuer or wrong audience token. |
| `409` | `account_conflict` | Multiple Revercue users share the verified email; support must resolve it. |
| `409` | `identity_orphaned` | The identity mapping points at a missing Revercue user. |
| `503` | `identity_store_unavailable` | Turso identity lookup/write failed (including a missing table). Nothing was guessed or recreated. |
| `500` | `internal_server_error` | Unexpected server failure with a reference code. |

There is no `account_link_required` response, and an unverified email does not
produce a 403. Unverified users still see `email_verified: 0` in the profile and
must not be treated as having proved ownership of that address.

### Onboarding endpoints

All endpoints scope updates to the authenticated user id; a caller cannot update
another user's onboarding data.

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| `PATCH` | `/api/onboarding/step-1` | `{ "account_type": "freelancer" \| "agency", "email"?: "user@example.com" }` | `{ success: true, onboarding_step: 2 }` |
| `PATCH` | `/api/onboarding/step-2` | `{ "name": "...", "business_name"?, "services"?: [], "volume_per_month"?, "website"?, "fiverr_profile"?, "agency_name"?, "agency_size"?, "brand_primary"?, "brand_secondary"? }` | `{ success: true, onboarding_step: 3 }` |
| `POST` | `/api/onboarding/website-help` | `{ "website_type": "...", "timeline": "...", ... }` | `201 { success: true }` |
| `PATCH` | `/api/onboarding/step-4` | `{ "tos_accepted": true, "newsletter_opt_in": false }` | `{ success: true, onboarding_step: 5 }` |
| `PATCH` | `/api/onboarding/step-5` | `{ "plan": "free" }` or `{ "plan": "waitlist", "plan_requested": "starter" }` | `{ success: true, onboarding_step: 6 }` |
| `PATCH` | `/api/onboarding/tutorial` | `{ "completed": true }` or `{ "skipped": true }` | `{ success: true }` |

Invalid payloads return `400 invalid_payload` with a message and do not mutate
the user. Step 4 requires `tos_accepted: true`. Step 5 waitlist entries use the
authenticated user's email, not a client-supplied address, and return
`400 email_required` when the account still has no email.

`email` on step 1 is only used when `email_missing` is true. It never changes an
email that AuthAction already supplied, and it returns `409 email_in_use` when
another account holds that address.

The old `POST /api/auth/link/start` and `POST /api/auth/link/confirm` routes no
longer exist and return `404`.

## Hostname and CORS

- Canonical API base URL: `https://api.revercue.co.uk`
- AuthAction issuer: `https://revercue.in.authaction.com` (unchanged)
- AuthAction audience: `revercue-api.samsaam470.workers.dev` (unchanged)
- The API hostname is **not** the JWT audience. Do not change
  `AUTHACTION_AUDIENCE` for the custom domain.
- Allowed frontend origins include `https://revercue.co.uk` and
  `https://revercue.pages.dev` (plus the configured `www`/`.com` compatibility
  origins). Unknown origins receive no CORS permission; authenticated endpoints
  never use wildcard CORS.
- Authorization headers and `GET/POST/PATCH/PUT/DELETE/OPTIONS` are permitted.

## Turso identity lookup correction

The previous production error was:

```text
SQLite error: no such table: user_identities
```

The repository already contains the additive migration at
`migrations/turso/0001_identity_and_email.sql`, so the first thing to verify is
that the deployed Worker is connected to the intended database, not a different
Turso database.

Required production-side checks (not performed by this repository change; they
need credentials/approval):

1. Confirm the deployed Worker's `TURSO_URL` is
   `libsql://revercue-auth-revercue.aws-ap-south-1.turso.io` (or the actual
   intended database) and that no dashboard override points somewhere else.
2. On that exact database, run:

   ```sql
   SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_identities';
   SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'user_identities';
   ```

3. If the table or unique index is missing, back up the database and apply the
   additive migration:

   ```bash
   TURSO_URL=... TURSO_TOKEN=... node scripts/turso-migrate.mjs --dry-run
   TURSO_URL=... TURSO_TOKEN=... node scripts/turso-migrate.mjs
   ```

4. Re-run the schema query and confirm
   `idx_user_identities_subject` is unique on `(provider, subject)`.

`auth_link_codes` is a legacy table. It is intentionally not dropped so existing
production data is preserved; no current code reads or writes it.

## Frontend handoff

- Send the AuthAction **access token** in the `Authorization` header.
- Treat `GET /api/auth/me` as the session-establishment call after callback.
- Route to `onboarding.destination`; do not route to `/link-account`.
- Handle the error codes above explicitly. Do not block onboarding on
  `email_verified`; route an unverified user with `onboarding.destination` just
  like a verified user.
- Do not use the SPA client id as the API audience or send an ID token.
- Send users to AuthAction for forgot password. There is no Revercue reset form,
  reset code or verification code to build.
- When `user.email_missing` is true, ask for an email address on onboarding step
  1 and submit it with `PATCH /api/onboarding/step-1`. Show it as contact data;
  do not add a verification-code step.
