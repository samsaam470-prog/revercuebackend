// Every plan limit, retention, and feature gate.
// The routes read from here. No magic numbers in the routes.

export const PLANS = ['free', 'starter', 'growth', 'scale', 'teams'] as const;
export type Plan = typeof PLANS[number];

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
  starter: 0,
  growth: 10,
  scale: 15,
  teams: 15,
};

export const SAVED_FAQ_LIMIT: Record<Plan, number> = {
  free: 0,
  starter: 0,
  growth: 10,
  scale: 30,
  teams: 30,
};

export const SAVED_PACKAGE_LIMIT: Record<Plan, number> = {
  free: 0,
  starter: 0,
  growth: 10,
  scale: 15,
  teams: 15,
};

export const PASSWORD_PROTECTED_LIMIT: Record<Plan, number> = {
  free: 0,
  starter: 0,
  growth: 15,
  scale: 50,
  teams: 50,
};

export const ADAPTIVE_FORM_LIMIT: Record<Plan, number> = {
  free: 0,
  starter: 0,
  growth: 3,
  scale: 15,
  teams: 999999,
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

export const OTP_EXPIRY_MINUTES = 5;
export const OTP_MAX_ATTEMPTS = 3;
export const OTP_RESEND_COOLDOWN_SECONDS = 90;

export const TRACKING_RETENTION_DAYS = 5;
export const NOTIFICATION_RETENTION_DAYS = 90;
export const SAVED_FAQ_RETENTION_MONTHS = 3;
export const SAVED_PACKAGE_RETENTION_MONTHS = 3;

export const DELETION_GRACE_DAYS = 5;
