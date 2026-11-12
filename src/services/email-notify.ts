import { sendFormSubmitEmail } from './email';
import { tursoQuery } from '../utils/turso';
import { EMAIL_NOTIFICATIONS } from '../config/constants';
import type { Bindings } from '../types';

export interface EmailEventInput {
  userId: string;
  eventType: string;
  clientName?: string | null;
  documentTitle?: string | null;
  extra?: Record<string, string>;
}

const EVENT_SUBJECTS: Record<string, string> = {
  proposal_opened: 'Your proposal was opened',
  proposal_accepted: 'Your proposal was accepted',
  proposal_declined: 'Your proposal was declined',
  contract_approved: 'Your contract was approved',
  contract_declined: 'Your contract was declined',
  form_submitted: 'Your form was submitted',
  invoice_paid: 'Your invoice was paid',
  invoice_proof_submitted: 'A payment proof was uploaded',
  client_replied: 'Your client replied',
  system_summary_ready: 'A client summary is ready',
};

const EVENT_KEYS: Record<string, string> = {
  proposal_opened: 'proposal_opened',
  proposal_accepted: 'proposal_accepted',
  proposal_declined: 'proposal_declined',
  contract_approved: 'contract_approved',
  contract_declined: 'contract_declined',
  form_submitted: 'form_submitted',
  invoice_paid: 'invoice_paid',
  invoice_proof_submitted: 'invoice_paid',
  client_replied: 'client_replied',
  system_summary_ready: 'system',
};

export async function maybeSendEmail(env: Bindings, input: EmailEventInput): Promise<void> {
  try {
    const user = await tursoQuery(env, `SELECT email, name, plan, notifications_enabled, notification_events FROM users WHERE id = ?`, [input.userId]);
    if (user.rows.length === 0) return;
    const u = user.rows[0];

    const plan = u.plan ?? 'free';
    if (!EMAIL_NOTIFICATIONS[plan as keyof typeof EMAIL_NOTIFICATIONS]) return;
    if (!u.notifications_enabled) return;

    const eventKey = EVENT_KEYS[input.eventType];
    if (!eventKey) return;
    const toggles = u.notification_events ? JSON.parse(u.notification_events) : {};
    if (toggles[eventKey] === false) return;

    const subject = EVENT_SUBJECTS[input.eventType] ?? 'Revercue notification';
    const fields: Record<string, string> = {
      'Event': input.eventType,
      'Client': input.clientName ?? '—',
      'Document': input.documentTitle ?? '—',
      'Dashboard': 'https://revercue.pages.dev/dashboard',
      ...(input.extra ?? {}),
    };

    await sendFormSubmitEmail(env, String(u.email), `Revercue — ${subject}`, fields);
  } catch (err) {
    console.error('EMAIL_NOTIFY_ERROR', err);
  }
}
