// Every plan limit, retention, and feature gate.
// The routes read from here. No magic numbers in the routes.

export const PLANS = ['free', 'starter', 'growth', 'scale', 'teams'] as const;
export type Plan = typeof PLANS[number];

// Canonical prices, in USD per month, matching the public pricing page.
// Teams is priced per team from $99; the others are flat monthly prices.
export const PLAN_PRICES: Record<Plan, number> = {
  free: 0,
  starter: 12,
  growth: 29,
  scale: 49,
  teams: 99,
};
export const PLAN_CURRENCY = 'USD';

export const ACTIVE_DOCUMENT_LIMIT: Record<Plan, number> = {
  free: 5,
  starter: 20,
  growth: 100,
  scale: 300,
  teams: 500,
};

export const DOCUMENT_RETENTION_MONTHS: Record<Plan, number> = {
  free: 1,
  starter: 3,
  growth: 12,
  scale: 24,
  teams: 36,
};

export const STORAGE_MB: Record<Plan, number> = {
  free: 50,
  starter: 100,
  growth: 1024,
  scale: 5120,
  teams: 10240,
};

export const DRAFT_RETENTION_DAYS: Record<Plan, number> = {
  free: 10,
  starter: 30,
  growth: 50,
  scale: 80,
  teams: 80,
};

export const ARCHIVE_COUNT_LIMIT: Record<Plan, number> = {
  free: 5,
  starter: 15,
  growth: 30,
  scale: 30,
  teams: 30,
};

export const ARCHIVE_RETENTION_DAYS: Record<Plan, number> = {
  free: 15,
  starter: 30,
  growth: 30,
  scale: 30,
  teams: 30,
};

export const NOTES_PER_CLIENT: Record<Plan, number> = {
  free: 3,
  starter: 10,
  growth: 999999,
  scale: 999999,
  teams: 999999,
};

export const CUSTOM_TEMPLATE_LIMIT: Record<Plan, number> = {
  free: 0,
  starter: 3,
  growth: 10,
  scale: 15,
  teams: 999,
};

export const SAVED_FAQ_LIMIT: Record<Plan, number> = {
  free: 0,
  starter: 0,
  growth: 10,
  scale: 30,
  teams: 999,
};

export const SAVED_PACKAGE_LIMIT: Record<Plan, number> = {
  free: 0,
  starter: 0,
  growth: 10,
  scale: 15,
  teams: 999,
};

export const PASSWORD_PROTECTED_LIMIT: Record<Plan, number> = {
  free: 0,
  starter: 0,
  growth: 15,
  scale: 50,
  teams: 999,
};

export const ADAPTIVE_FORM_LIMIT: Record<Plan, number> = {
  free: 0,
  starter: 0,
  growth: 3,
  scale: 15,
  teams: 999,
};

export const EMAIL_NOTIFICATIONS: Record<Plan, boolean> = {
  free: false,
  starter: false,
  growth: true,
  scale: true,
  teams: true,
};

export const ADVANCED_TRACKING: Record<Plan, boolean> = {
  free: false,
  starter: false,
  growth: false,
  scale: true,
  teams: true,
};

export const CUSTOM_THANK_YOU: Record<Plan, boolean> = {
  free: false,
  starter: false,
  growth: false,
  scale: true,
  teams: true,
};

export const WHAT_REVERCUE_KNOWS: Record<Plan, boolean> = {
  free: false,
  starter: false,
  growth: false,
  scale: true,
  teams: true,
};

export const REVENUE_TRACKER: Record<Plan, boolean> = {
  free: false,
  starter: false,
  growth: false,
  scale: true,
  teams: true,
};

export const EXPENSE_ENTRY: Record<Plan, boolean> = {
  free: false,
  starter: false,
  growth: false,
  scale: true,
  teams: true,
};

export const PATTERN_LEARNING: Record<Plan, boolean> = {
  free: false,
  starter: false,
  growth: false,
  scale: true,
  teams: true,
};

export const PRICE_SUGGESTION: Record<Plan, boolean> = {
  free: false,
  starter: false,
  growth: false,
  scale: true,
  teams: true,
};

export const TEAM_FEATURES: Record<Plan, boolean> = {
  free: false,
  starter: false,
  growth: false,
  scale: false,
  teams: true,
};

export const DEFAULT_MARGIN_PERCENT = 30;


export const TRACKING_RETENTION_DAYS = 5;
export const NOTIFICATION_RETENTION_DAYS = 90;
export const SAVED_FAQ_RETENTION_MONTHS = 3;
export const SAVED_PACKAGE_RETENTION_MONTHS = 3;

export const DELETION_GRACE_DAYS = 5;

// ===========================================================================
// Contract electronic signature
// ===========================================================================

/** Canonical contract lifecycle states. Stored lowercase in D1. */
export const CONTRACT_STATUS = {
  DRAFT: 'draft',
  AWAITING_FREELANCER_SIGNATURE: 'awaiting_freelancer_signature',
  AWAITING_CLIENT_SIGNATURE: 'awaiting_client_signature',
  FULLY_SIGNED: 'fully_signed',
  DECLINED: 'declined',
  VOIDED: 'voided',
} as const;

export type ContractStatus = typeof CONTRACT_STATUS[keyof typeof CONTRACT_STATUS];

/** Version-level states. A version is immutable once `locked_at` is set. */
export const CONTRACT_VERSION_STATUS = {
  DRAFT: 'draft',
  AWAITING_CLIENT: 'awaiting_client',
  SIGNED: 'signed',
  SUPERSEDED: 'superseded',
  VOIDED: 'voided',
} as const;

/** Bump when the consent wording changes; it is stored with every signature. */
export const SIGNING_CONSENT_VERSION = '2026-11-21';

export const SIGNING_CONSENT_TEXT =
  'I agree that typing or drawing my name constitutes my electronic signature on this contract ' +
  'version, and that I have read and accept its terms.';

/** Max decoded size of a drawn signature image. */
export const SIGNATURE_MAX_BYTES = 512 * 1024;

/** Lifetime of an authorized signed-PDF download link. */
export const SIGNED_PDF_LINK_TTL_SECONDS = 15 * 60;

/** Lifetime of a retention delivery link emailed to the owner. */
export const RETENTION_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

// ===========================================================================
// Document retention lifecycle
// ===========================================================================

export type DocumentType = 'proposal' | 'contract' | 'form' | 'invoice';

/**
 * Which document types may be deleted automatically once the owner has been
 * emailed a copy. Invoices and countersigned agreements are records with
 * legal/accounting value, so they are archived, never deleted, by default.
 * Operators can override with RETENTION_AUTO_DELETE_TYPES.
 */
export const DEFAULT_AUTO_DELETE_TYPES: DocumentType[] = ['proposal', 'contract'];

/** Per-type retention policy. `deletable` is the compiled-in safety default. */
export const RETENTION_POLICY: Record<
  DocumentType,
  { deletable: boolean; reason: string; requiresDelivery: boolean }
> = {
  proposal: {
    deletable: true,
    reason: 'Proposals are working documents whose PDF is sufficient after expiry.',
    requiresDelivery: true,
  },
  form: {
    deletable: false,
    reason:
      'A form owns client submissions, which are business records. Forms are archived with their ' +
      'submissions and kept; an operator can opt in to deletion with RETENTION_AUTO_DELETE_TYPES.',
    requiresDelivery: true,
  },
  contract: {
    deletable: true,
    reason:
      'Only unsigned or declined contract drafts are deleted. Fully signed contracts are never ' +
      'deleted automatically and are retained indefinitely unless an operator changes policy.',
    requiresDelivery: true,
  },
  invoice: {
    deletable: false,
    reason:
      'Invoices are accounting records. They are never auto-deleted; they are archived and kept.',
    requiresDelivery: true,
  },
};

export const RETENTION_WARNING_DAYS = 10;
export const RETENTION_MAX_DELIVERY_ATTEMPTS = 5;
/** Documents reviewed per hourly run, per type. Keeps a cron run bounded. */
export const RETENTION_BATCH_SIZE = 50;

// ===========================================================================
// Email delivery
// ===========================================================================

export const EMAIL_MAX_ATTEMPTS = 5;
/** Backoff schedule in minutes for failed deliveries. */
export const EMAIL_BACKOFF_MINUTES = [1, 5, 30, 120, 360];
export const EMAIL_BATCH_SIZE = 25;

// ===========================================================================
// Notifications / SSE
// ===========================================================================

export const SSE_DEFAULT_MAX_SECONDS = 300;
export const SSE_DEFAULT_POLL_MS = 5000;
export const SSE_KEEPALIVE_MS = 15000;
export const SSE_MAX_POLL_MS = 15000;
export const SSE_MIN_POLL_MS = 1000;

// ===========================================================================
// Uploads and validation
// ===========================================================================

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const IMAGE_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const PROOF_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
export const TEMPLATE_UPLOAD_TYPES = ['text/html', 'text/plain'];

/** Hosts allowed to serve public assets through the B2 proxy. */
export const PUBLIC_FILE_PREFIXES = ['public/'];

// ===========================================================================
// Forms enrichment pipeline
// ===========================================================================

export const FORM_PROCESSING_MAX_ATTEMPTS = 5;
export const FORM_PROCESSING_TIMEOUT_MS = 15000;
export const FORM_PROCESSING_BATCH_SIZE = 10;
export const MAX_SUBMISSION_ANSWERS_BYTES = 100 * 1024;

// ===========================================================================
// Marketing / admin
// ===========================================================================

export const NEWSLETTER_EXPORT_LIMIT = 5000;
export const ADMIN_LIST_LIMIT = 100;
export const MARKETING_MESSAGE_MAX = 5000;
