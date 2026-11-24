# Test account (review environment)

A fixed account for automated product review. It does not use AuthAction, so an
agent can enter the product with a password, switch plans and inspect seeded
data. It is meant for review environments only.

## Credentials

| Field | Value |
| --- | --- |
| Email | `agent@revercue.test` |
| Password | `ReviewAgent2026!` |

The page is `/testaccountforyou` on the frontend. It shows these credentials,
has an email sign-up area and a plan switcher.

Both values can be overridden with the Worker variables `TEST_ACCOUNT_EMAIL` and
`TEST_ACCOUNT_PASSWORD`. If the page is used to sign up with a different email,
the account email changes but the password stays the same; sign-in accepts both
the configured email and the account's current email.

## How it signs in

The account uses the legacy Revercue app token (HS256, 12 hours) issued by
`POST /api/test-account/login`. It therefore requires `ALLOW_LEGACY_AUTH` to be
`true`; when legacy auth is retired the endpoint answers `503
legacy_auth_disabled`.

`TEST_ACCOUNT_ENABLED=false` removes every `/api/test-account` route and reports
`test_account: false` in `/api/health`. Disable it before a real launch.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/test-account` | Enabled state, current credentials and plan. |
| `POST` | `/api/test-account/signup` | Create/update the account (`email`, `plan`) and seed the sample environment. |
| `POST` | `/api/test-account/login` | Sign in (`email`, `password`). Returns the bearer token. |
| `POST` | `/api/test-account/plan` | Switch plan (`free`, `starter`, `growth`, `scale`, `teams`). Requires the bearer token. |
| `POST` | `/api/test-account/reset` | Recreate the sample data. Requires the bearer token. |
| `DELETE` | `/api/test-account` | Delete the account and **all** of its data. Requires the bearer token. |

All requests use `Authorization: Bearer <token>` after login.

## What the sample environment contains

Clients (4), proposals (2 published, 1 draft), contracts (1 awaiting client
signature, 1 draft, with versions), forms (2 published with settings), invoices
(1 published, 1 with proof submitted), communication log entries, notifications,
saved FAQs, a saved package, revision prices and an active subscription matching
the current plan. Seeding is skipped when proposals already exist; `reset` forces
it.

## Deleting the account

`DELETE /api/test-account` deletes the test user and every row keyed to it in
both databases: product documents and their child rows (versions, signatures,
events, signed PDFs, access/meta, visits, events, uploads, form submissions and
settings), clients, communication log, saved items, revision prices, retention
rows, subscriptions and change requests, sessions, notifications, payments and
identity rows. Each statement is isolated so a missing legacy table cannot block
the rest; remaining problems are returned in `warnings`.
