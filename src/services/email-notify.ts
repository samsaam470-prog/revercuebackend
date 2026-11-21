import { tursoQuery } from '../utils/turso';
import { EMAIL_NOTIFICATIONS } from '../config/constants';
import { allowsEmailForEvent, parseStoredPreferences } from './notification-preferences';
import { sendEmail } from './email';
import type { Bindings } from '../types';

export interface EmailEventInput {
  userId: string;
  eventType: string;
  clientName?: string | null;
  documentTitle?: string | null;
  extra?: Record<string, string>;
  /** Stable per-notification key so cron retries cannot duplicate the email. */
  idempotencyKey?: string;
}

const EVENT_SUBJECTS: Record<string, string> = {
  proposal_opened: 'Your proposal was opened',
  proposal_accepted: 'Your proposal was accepted',
  proposal_declined: 'Your proposal was declined',
  contract_opened: 'Your contract was opened',
  contract_approved: 'Your contract was approved',
  contract_declined: 'Your contract was declined',
  contract_signed: 'Your client signed the contract',
  contract_fully_signed: 'Your contract is fully signed',
  form_submitted: 'You received a form submission',
  invoice_opened: 'Your invoice was opened',
  invoice_paid: 'Your invoice was paid',
  invoice_proof_submitted: 'A payment proof was uploaded',
  client_replied: 'Your client replied',
  retention_warning: 'A document is about to expire',
  system_summary_ready: 'A client summary is ready',
};

function appUrl(env: Bindings): string {
  return (env.APP_URL || env.FRONTEND_ORIGIN || 'https://revercue.co.uk').replace(/\/$/, '');
}

/**
 * Sends an application email for an in-app notification, respecting the user's
 * plan and their saved preferences. Returns whether a provider accepted it.
 */
export async function maybeSendEmail(env: Bindings, input: EmailEventInput): Promise<boolean> {
  try {
    const user = await tursoQuery(
      env,
      `SELECT email, name, plan, notifications_enabled, notification_events, newsletter_opt_in FROM users WHERE id = ? LIMIT 1`,
      [input.userId]
    );
    if (user.rows.length === 0) return false;
    const u = user.rows[0];
    if (!u.email) return false;

    const plan = String(u.plan ?? 'free');
    if (!EMAIL_NOTIFICATIONS[plan as keyof typeof EMAIL_NOTIFICATIONS]) return false;

    const prefs = parseStoredPreferences({
      notifications_enabled: u.notifications_enabled,
      notification_events: u.notification_events,
      newsletter_opt_in: u.newsletter_opt_in,
    });
    if (!allowsEmailForEvent(prefs, input.eventType)) return false;

    const subject = EVENT_SUBJECTS[input.eventType];
    if (!subject) return false;

    const lines = [
      input.clientName ? `Client: ${input.clientName}` : null,
      input.documentTitle ? `Document: ${input.documentTitle}` : null,
      ...Object.entries(input.extra ?? {}).map(([key, value]) => `${key}: ${value}`),
      '',
      `Open Revercue: ${appUrl(env)}/dashboard`,
      '',
      'You can change these alerts in Settings → Notifications.',
    ].filter((line) => line !== null) as string[];

    const result = await sendEmail(env, {
      to: String(u.email),
      subject: `Revercue — ${subject}`,
      text: lines.join('\n'),
      kind: 'notification',
      userId: input.userId,
      idempotencyKey: input.idempotencyKey ?? `notification:${input.userId}:${input.eventType}:${Date.now()}`,
      retryable: true,
    });
    return result.ok;
  } catch (error) {
    console.error('EMAIL_NOTIFY_ERROR', error);
    return false;
  }
}
