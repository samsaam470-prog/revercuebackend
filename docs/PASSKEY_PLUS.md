# Passkey Plus readiness

## Current state

Revercue has **no Passkey Plus backend integration**. It verifies AuthAction
OIDC access tokens (see `src/services/authaction.ts`) and does not implement
WebAuthn itself, so standard AuthAction passkeys work through AuthAction's
normal hosted sign-in flow without additions to this Worker.

There are no `AUTHACTION_PASSKEY_PLUS_*`, M2M client, transaction or nonce
endpoints in this repository, and no passkey credential material is stored in
D1 or Turso.

## What is missing before Passkey Plus can be implemented

Passkey Plus requires a separate AuthAction application and machine-to-machine
credentials. None of these are configured in this deployment:

| Configuration | Purpose | Who provides it |
| --- | --- | --- |
| Passkey Plus application ID | Path segment for `/api/v1/passkey-plus/<app-id>/transaction/...` and the frontend SDK `appId` | Created in the AuthAction dashboard |
| M2M client ID | `client_credentials` grant at `/oauth2/m2m/token` | AuthAction dashboard (Passkey Plus application) |
| M2M client secret | Same grant; Worker secret only | AuthAction dashboard |
| M2M audience | Tenant URL, e.g. `https://<tenant>.<region>.authaction.com` | AuthAction tenant |
| Approved RP ID / origins | WebAuthn origin allowlist for Revercue's frontend and preview origins | AuthAction dashboard |
| Frontend SDK integration | `@authaction/passkey-plus-sdk` registration/authentication calls | Frontend repository (not modified here) |
| `externalId` convention | Stable mapping from a passkey identity to a Revercue `users.id` | Backend design decision |
| Verify-transaction policy | Whether passkey auth creates a Revercue session, links an identity, or is step-up only | Backend design decision |

The frontend SPA client ID (`AUTHACTION_CLIENT_ID`) is **not** an M2M
credential and is never accepted as the API audience or as a Passkey Plus
client. Secrets belong in Cloudflare Worker secrets, never in `wrangler.toml`,
source, responses or the frontend bundle.

## Official flow to implement once configured

1. Backend obtains an M2M token from
   `POST https://<tenant>/oauth2/m2m/token` with
   `grant_type=client_credentials`.
2. Backend creates a registration transaction at
   `POST /api/v1/passkey-plus/<app-id>/transaction/register` with
   `{ "externalId", "displayName" }`, or an authentication transaction at
   `POST /api/v1/passkey-plus/<app-id>/transaction/authenticate` with
   `{ "externalId" }`.
3. Frontend completes WebAuthn with the returned `transactionId` through
   `@authaction/passkey-plus-sdk` and returns a `nonce`.
4. Backend verifies the nonce at
   `POST /api/v1/passkey-plus/<app-id>/transaction/verify` with
   `{ "nonce" }`, then maps the verified `externalId` to a Revercue user.

Until the table above is supplied, adding endpoints would require invented
credentials or unverified assertions, so this repository intentionally does not
fake the flow. Normal AuthAction sign-in and direct AuthAction user provisioning
remain unchanged.
