export interface Bindings {
  /** Cloudflare D1 — product data (documents, clients, signing, tracking, retention). */
  DB: D1Database;

  // ---------------------------------------------------------------------------
  // Legacy Revercue authentication (transition only — see docs/AUTH_MIGRATION.md)
  // ---------------------------------------------------------------------------
  ADMIN_USER: string;
  ADMIN_PASS: string;
  ADMIN_JWT_KEY: string;
  /** Legacy HS256 key for app-issued user tokens. Required for the transition. */
  USER_JWT_KEY: string;
  OTP_HASH_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  /** "false" disables legacy password/OTP token acceptance (AuthAction only). */
  ALLOW_LEGACY_AUTH?: string;

  // ---------------------------------------------------------------------------
  // AuthAction (OIDC / JWT access tokens)
  // ---------------------------------------------------------------------------
  /** Exact issuer from AuthAction's OIDC discovery document. */
  AUTHACTION_ISSUER?: string;
  /**
   * Exact API audience/identifier configured in AuthAction. This is not the
   * public API hostname and must not be changed just because the Worker is also
   * served from a custom domain.
   */
  AUTHACTION_AUDIENCE?: string;
  /** Optional explicit JWKS URL; otherwise derived from OIDC discovery. */
  AUTHACTION_JWKS_URL?: string;
  /** Optional explicit discovery URL; otherwise `${issuer}/.well-known/openid-configuration`. */
  AUTHACTION_DISCOVERY_URL?: string;
  /** AuthAction frontend client id, used only to reject ID tokens. */
  AUTHACTION_CLIENT_ID?: string;

  // ---------------------------------------------------------------------------
  // AuthAction Management API (M2M) — server-side only. Never exposed to the
  // browser. Used by the admin identity directory synchronization.
  // ---------------------------------------------------------------------------
  AUTHACTION_M2M_CLIENT_ID?: string;
  AUTHACTION_M2M_CLIENT_SECRET?: string;
  /** Defaults to AUTHACTION_ISSUER when unset. */
  AUTHACTION_M2M_AUDIENCE?: string;
  /** Comma separated allowlist of accepted JWT algorithms. Default: RS256. */
  AUTHACTION_REQUIRED_ALGS?: string;
  /** Claim holding the email address. Default: email. */
  AUTHACTION_EMAIL_CLAIM?: string;
  /** Claim holding the verified-email flag. Default: email_verified. */
  AUTHACTION_VERIFIED_CLAIM?: string;

  // ---------------------------------------------------------------------------
  // Turso (auth, users, notifications, admin, marketing)
  // ---------------------------------------------------------------------------
  TURSO_URL: string;
  TURSO_TOKEN: string;

  // ---------------------------------------------------------------------------
  // Backblaze B2 (files, signatures, PDFs)
  // ---------------------------------------------------------------------------
  B2_KEY_ID: string;
  B2_APP_KEY: string;
  B2_BUCKET_NAME: string;
  B2_S3_ENDPOINT: string;

  // ---------------------------------------------------------------------------
  // Email providers (primary Cooper, fallback OpenMail). FormSubmit is retired.
  // ---------------------------------------------------------------------------
  COOPER_API_KEY?: string;
  COOPER_INBOX_ID?: string;
  OPENMAIL_API_KEY?: string;
  OPENMAIL_INBOX_ID?: string;
  /** From address shown to recipients, e.g. "Revercue <revercue@cooperemail.com>". */
  EMAIL_FROM?: string;
  /** Administrator inbox for contact/beta/operational alerts. */
  ADMIN_NOTIFICATION_EMAIL?: string;

  // ---------------------------------------------------------------------------
  // Application configuration
  // ---------------------------------------------------------------------------
  FRONTEND_ORIGIN: string;
  /** Canonical public API base URL (https://api.revercue.co.uk). */
  API_BASE_URL?: string;
  /** Public app origin used for links in emails. Falls back to FRONTEND_ORIGIN. */
  APP_URL?: string;
  /** Comma separated additional allowed CORS origins (optional). */
  ALLOWED_ORIGINS?: string;
  /**
   * Secret used to sign short-lived document download links (HMAC-SHA256).
   * Falls back to USER_JWT_KEY during the transition, which is logged as a
   * configuration warning.
   */
  SIGNING_LINK_SECRET?: string;
  /** Comma separated document types eligible for automatic deletion. */
  RETENTION_AUTO_DELETE_TYPES?: string;
  /** Days before expiry that the warning is sent. Default: 10. */
  RETENTION_WARNING_DAYS?: string;
  /** Max delivery attempts before a retention job is parked for review. Default: 5. */
  RETENTION_MAX_DELIVERY_ATTEMPTS?: string;
  /** Max lifetime of an SSE connection in seconds. Default: 300. */
  SSE_MAX_SECONDS?: string;
  /** SSE polling interval in milliseconds. Default: 5000. */
  SSE_POLL_MS?: string;
  /** Seconds between SSE keepalive comments. Default: 15. */
  SSE_KEEPALIVE_SECONDS?: string;
  /** Hard cap for uploaded files in bytes. Default: 10 MiB. */
  MAX_UPLOAD_BYTES?: string;
  /** "production" enables stricter behaviour (legacy auth off by default). */
  ENVIRONMENT?: string;\n  /** Temporary isolated test harness; staging only, never production. */\n  TEST_HARNESS_ENABLED?: string;\n  test_account_name?: string;\n  test_account_pass?: string;\n  test_harness_key?: string;
}

/** Authenticated request context set by the shared auth middleware. */
export interface AuthContext {
  userId: string;
  email: string;
  plan: string;
  role: 'user' | 'admin';
  /** Which credential proved the identity. */
  via: 'authaction' | 'legacy';
  subject?: string;
  sessionId?: string;
}

export type AppEnvironment = { Bindings: Bindings; Variables: { auth: AuthContext } };
