/**
 * Single source of truth for notification preference field names.
 *
 * The frontend sends and expects these exact keys (see src/api/settings.ts in
 * revercuefrotend). Historically the API stored `notifications_enabled` and a
 * raw `notification_events` JSON blob with different keys, which is why the
 * settings screen and the email sender disagreed. Both are normalised here.
 */

export interface NotificationPreferences {
  email_enabled: boolean;
  proposal_opened: boolean;
  proposal_answered: boolean;
  contract_action: boolean;
  form_submitted: boolean;
  invoice_paid: boolean;
  proof_uploaded: boolean;
  newsletter_opt_in: boolean;
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  email_enabled: true,
  proposal_opened: true,
  proposal_answered: true,
  contract_action: true,
  form_submitted: true,
  invoice_paid: true,
  proof_uploaded: true,
  newsletter_opt_in: false,
};

/** Maps a legacy stored key to the canonical preference field. */
const LEGACY_KEY_TO_FIELD: Record<string, keyof NotificationPreferences> = {
  proposal_opened: 'proposal_opened',
  proposal_accepted: 'proposal_answered',
  proposal_declined: 'proposal_answered',
  contract_approved: 'contract_action',
  contract_declined: 'contract_action',
  contract_signed: 'contract_action',
  contract_fully_signed: 'contract_action',
  form_submitted: 'form_submitted',
  invoice_paid: 'invoice_paid',
  invoice_proof_submitted: 'proof_uploaded',
  client_replied: 'proposal_answered',
  system: 'email_enabled',
};

/** Maps an emitted notification event type to its preference field. */
const EVENT_TO_FIELD: Record<string, keyof NotificationPreferences> = {
  proposal_opened: 'proposal_opened',
  proposal_accepted: 'proposal_answered',
  proposal_declined: 'proposal_answered',
  client_replied: 'proposal_answered',
  contract_opened: 'contract_action',
  contract_approved: 'contract_action',
  contract_declined: 'contract_action',
  contract_signed: 'contract_action',
  contract_fully_signed: 'contract_action',
  form_submitted: 'form_submitted',
  invoice_opened: 'invoice_paid',
  invoice_paid: 'invoice_paid',
  invoice_proof_submitted: 'proof_uploaded',
  retention_warning: 'email_enabled',
  system_summary_ready: 'email_enabled',
  payment_failed: 'email_enabled',
  feature_release: 'email_enabled',
  maintenance: 'email_enabled',
};

export function parseStoredPreferences(row: {
  notifications_enabled?: unknown;
  notification_events?: unknown;
  newsletter_opt_in?: unknown;
}): NotificationPreferences {
  const prefs: NotificationPreferences = { ...DEFAULT_PREFERENCES };
  prefs.email_enabled = row.notifications_enabled === undefined || row.notifications_enabled === null
    ? true
    : Number(row.notifications_enabled) === 1 || row.notifications_enabled === true;
  prefs.newsletter_opt_in = Number(row.newsletter_opt_in) === 1 || row.newsletter_opt_in === true;

  if (row.notification_events) {
    try {
      const stored = typeof row.notification_events === 'string'
        ? (JSON.parse(row.notification_events) as Record<string, unknown>)
        : (row.notification_events as Record<string, unknown>);
      for (const [key, value] of Object.entries(stored)) {
        const field = LEGACY_KEY_TO_FIELD[key] ?? (key as keyof NotificationPreferences);
        if (field in prefs && typeof value === 'boolean') prefs[field] = value;
      }
    } catch {
      // Corrupt preference JSON must not disable every email silently; keep defaults.
    }
  }
  return prefs;
}

/** Merges a partial PATCH body into stored preferences, ignoring unknown keys. */
export function mergePreferences(
  current: NotificationPreferences,
  patch: Record<string, unknown>
): NotificationPreferences {
  const next: NotificationPreferences = { ...current };
  for (const key of Object.keys(DEFAULT_PREFERENCES) as (keyof NotificationPreferences)[]) {
    const value = patch[key];
    if (typeof value === 'boolean') next[key] = value;
  }
  return next;
}

export function serializePreferences(prefs: NotificationPreferences): {
  notifications_enabled: number;
  notification_events: string;
  newsletter_opt_in: number;
} {
  const events: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(prefs)) {
    if (key === 'email_enabled' || key === 'newsletter_opt_in') continue;
    events[key] = value;
  }
  return {
    notifications_enabled: prefs.email_enabled ? 1 : 0,
    notification_events: JSON.stringify(events),
    newsletter_opt_in: prefs.newsletter_opt_in ? 1 : 0,
  };
}

export function preferenceFieldForEvent(eventType: string): keyof NotificationPreferences {
  return EVENT_TO_FIELD[eventType] ?? 'email_enabled';
}

export function allowsEmailForEvent(
  prefs: NotificationPreferences,
  eventType: string
): boolean {
  if (!prefs.email_enabled) return false;
  return prefs[preferenceFieldForEvent(eventType)] !== false;
}
