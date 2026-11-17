import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import { EMAIL_BATCH_SIZE, EMAIL_MAX_ATTEMPTS } from '../config/constants';
import { isTerminalStatus, nextAttemptAt, shouldRetry } from './email-retry';
import type { Bindings } from '../types';

/**
 * Central email service.
 *
 * Providers: Cooper Email (primary) then OpenMail (fallback). FormSubmit is
 * retired — it is not called, and its environment variable is gone.
 *
 * Every attempt is logged in Turso (`email_deliveries`) with an idempotency
 * key. Nothing in this file reports success unless a provider returned a
 * successful status; callers must treat `{ ok: false }` as "not delivered".
 */

export type EmailKind =
  | 'transactional'
  | 'auth_link_code'
  | 'contract_signed'
  | 'contract_awaiting_signature'
  | 'form_submission'
  | 'document_delivery'
  | 'retention_warning'
  | 'admin_lead'
  | 'newsletter_confirm'
  | 'notification';

export interface EmailAttachment {
  filename: string;
  contentType: string;
  /** base64 (no data URL prefix). */
  contentBase64: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  kind?: EmailKind;
  userId?: string | null;
  /** Stable key (e.g. `retention-warning:contract:con_x:2027-01-01`). */
  idempotencyKey?: string;
  /** Stored payload so a failed send can be retried by the cron. */
  retryable?: boolean;
  documentType?: string | null;
  documentId?: string | null;
  attachments?: EmailAttachment[];
}

export interface EmailResult {
  ok: boolean;
  status: 'sent' | 'failed' | 'skipped' | 'deduped' | 'config_error';
  provider?: string;
  deliveryId?: string;
  error?: string;
}

interface ProviderOutcome {
  ok: boolean;
  provider: string;
  messageId?: string;
  error?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(raw: string): boolean {
  return raw.length <= 320 && EMAIL_PATTERN.test(normalizeEmail(raw));
}

function fromAddress(env: Bindings): string {
  return env.EMAIL_FROM?.trim() || 'Revercue <revercue@cooperemail.com>';
}

async function sendViaCooper(env: Bindings, message: EmailMessage): Promise<ProviderOutcome> {
  if (!env.COOPER_API_KEY || !env.COOPER_INBOX_ID) {
    return { ok: false, provider: 'cooper', error: 'not_configured' };
  }
  try {
    const response = await fetch(
      `https://cooperemail.com/api/v1/inboxes/${encodeURIComponent(env.COOPER_INBOX_ID)}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.COOPER_API_KEY}`,
          'Content-Type': 'application/json',
          ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: fromAddress(env),
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html ?? `<p>${message.text.replace(/\n/g, '<br>')}</p>`,
          ...(message.attachments ? { attachments: message.attachments } : {}),
        }),
      }
    );
    const body = await response.text();
    if (!response.ok) {
      console.error('COOPER_SEND_FAILED', response.status, body.slice(0, 500));
      return { ok: false, provider: 'cooper', error: `http_${response.status}` };
    }
    let messageId: string | undefined;
    try {
      const parsed = JSON.parse(body);
      messageId = parsed?.id ?? parsed?.message_id;
    } catch {
      // A 2xx without a JSON body is still an accepted message.
    }
    return { ok: true, provider: 'cooper', messageId };
  } catch (error: any) {
    console.error('COOPER_SEND_THROW', error?.message ?? error);
    return { ok: false, provider: 'cooper', error: 'network_error' };
  }
}

async function sendViaOpenMail(env: Bindings, message: EmailMessage): Promise<ProviderOutcome> {
  if (!env.OPENMAIL_API_KEY || !env.OPENMAIL_INBOX_ID) {
    return { ok: false, provider: 'openmail', error: 'not_configured' };
  }
  try {
    const response = await fetch(
      `https://api.openmail.sh/v1/inboxes/${encodeURIComponent(env.OPENMAIL_INBOX_ID)}/send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENMAIL_API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey ?? crypto.randomUUID(),
        },
        body: JSON.stringify({
          from: fromAddress(env),
          to: message.to,
          subject: message.subject,
          body: message.text,
          ...(message.html ? { html: message.html } : {}),
          ...(message.attachments ? { attachments: message.attachments } : {}),
        }),
      }
    );
    const body = await response.text();
    if (!response.ok) {
      console.error('OPENMAIL_SEND_FAILED', response.status, body.slice(0, 500));
      return { ok: false, provider: 'openmail', error: `http_${response.status}` };
    }
    let messageId: string | undefined;
    try {
      const parsed = JSON.parse(body);
      messageId = parsed?.id ?? parsed?.message_id;
    } catch {
      // ignore
    }
    return { ok: true, provider: 'openmail', messageId };
  } catch (error: any) {
    console.error('OPENMAIL_SEND_THROW', error?.message ?? error);
    return { ok: false, provider: 'openmail', error: 'network_error' };
  }
}

async function findDeliveryByKey(env: Bindings, key: string) {
  const result = await tursoQuery(
    env,
    `SELECT id, status, attempts FROM email_deliveries WHERE idempotency_key = ? LIMIT 1`,
    [key]
  );
  return result.rows[0] ?? null;
}

export async function sendEmail(env: Bindings, message: EmailMessage): Promise<EmailResult> {
  const to = normalizeEmail(message.to);
  if (!isValidEmail(to)) {
    return { ok: false, status: 'failed', error: 'invalid_recipient' };
  }

  const kind: EmailKind = message.kind ?? 'transactional';
  const key = message.idempotencyKey ?? null;

  if (key) {
    const existing = await findDeliveryByKey(env, key);
    if (existing && existing.status === 'sent') {
      return { ok: true, status: 'deduped', deliveryId: String(existing.id) };
    }
  }

  const now = new Date().toISOString();
  let deliveryId: string;
  let attempts = 1;

  const existing = key ? await findDeliveryByKey(env, key) : null;
  if (existing) {
    deliveryId = String(existing.id);
    attempts = Number(existing.attempts ?? 0) + 1;
    await tursoExecute(
      env,
      `UPDATE email_deliveries SET status = 'sending', attempts = ?, updated_at = ? WHERE id = ?`,
      [attempts, now, deliveryId]
    );
  } else {
    deliveryId = generateId('eml');
    await tursoExecute(
      env,
      `INSERT INTO email_deliveries (id, user_id, to_email, kind, subject, provider, status, attempts, last_error, provider_message_id, idempotency_key, retryable, payload, document_type, document_id, created_at, updated_at, sent_at, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'sending', 1, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      [
        deliveryId,
        message.userId ?? null,
        to,
        kind,
        message.subject.slice(0, 300),
        key,
        message.retryable ? 1 : 0,
        message.retryable ? JSON.stringify(message) : null,
        message.documentType ?? null,
        message.documentId ?? null,
        now,
        now,
      ]
    );
  }

  const attemptsList = [sendViaCooper, sendViaOpenMail];
  let lastError = 'no_provider';
  for (const provider of attemptsList) {
    const outcome = await provider(env, message);
    if (outcome.ok) {
      await tursoExecute(
        env,
        `UPDATE email_deliveries SET status = 'sent', provider = ?, provider_message_id = ?, last_error = NULL, sent_at = ?, updated_at = ?, next_attempt_at = NULL WHERE id = ?`,
        [outcome.provider, outcome.messageId ?? null, new Date().toISOString(), new Date().toISOString(), deliveryId]
      );
      return { ok: true, status: 'sent', provider: outcome.provider, deliveryId };
    }
    lastError = outcome.error ?? lastError;
  }

  const retry = shouldRetry(attempts, EMAIL_MAX_ATTEMPTS) && Boolean(message.retryable);
  const scheduled = retry ? nextAttemptAt(attempts).toISOString() : null;
  await tursoExecute(
    env,
    `UPDATE email_deliveries SET status = ?, last_error = ?, updated_at = ?, next_attempt_at = ? WHERE id = ?`,
    [retry ? 'failed' : attempts >= EMAIL_MAX_ATTEMPTS ? 'abandoned' : 'failed', lastError, new Date().toISOString(), scheduled, deliveryId]
  );
  console.error('EMAIL_DELIVERY_FAILED', kind, lastError);
  return {
    ok: false,
    status: lastError === 'not_configured' ? 'config_error' : 'failed',
    deliveryId,
    error: lastError,
  };
}

/**
 * Compatibility wrapper for existing call sites. Returns true only when a
 * provider accepted the message.
 */
export async function sendTransactionalEmail(
  env: Bindings,
  toEmail: string,
  subject: string,
  text: string,
  html?: string,
  _fields?: Record<string, string>
): Promise<boolean> {
  const result = await sendEmail(env, { to: toEmail, subject, text, html, kind: 'transactional' });
  return result.ok;
}

/** Retried by the hourly cron. Only retryable deliveries carry a stored payload. */
export async function retryFailedDeliveries(
  env: Bindings
): Promise<{ retried: number; sent: number; failed: number; abandoned: number }> {
  const due = await tursoQuery(
    env,
    `SELECT * FROM email_deliveries
     WHERE status = 'failed' AND retryable = 1 AND payload IS NOT NULL
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY updated_at ASC LIMIT ${EMAIL_BATCH_SIZE}`,
    [new Date().toISOString()]
  );

  let retried = 0;
  let sent = 0;
  let failed = 0;
  let abandoned = 0;

  for (const row of due.rows) {
    retried += 1;
    let message: EmailMessage;
    try {
      message = JSON.parse(String(row.payload)) as EmailMessage;
    } catch {
      await tursoExecute(
        env,
        `UPDATE email_deliveries SET status = 'abandoned', last_error = 'corrupt_payload', updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), row.id]
      );
      abandoned += 1;
      continue;
    }

    const attempts = Number(row.attempts ?? 0);
    const outcome = (await sendViaCooper(env, message)).ok
      ? { ok: true as const, provider: 'cooper' }
      : await sendViaOpenMail(env, message);

    if (outcome.ok) {
      await tursoExecute(
        env,
        `UPDATE email_deliveries SET status = 'sent', provider = ?, attempts = ?, sent_at = ?, updated_at = ?, next_attempt_at = NULL, last_error = NULL WHERE id = ?`,
        [outcome.provider, attempts + 1, new Date().toISOString(), new Date().toISOString(), row.id]
      );
      sent += 1;
      continue;
    }

    const nextAttempts = attempts + 1;
    const canRetry = shouldRetry(nextAttempts, EMAIL_MAX_ATTEMPTS);
    await tursoExecute(
      env,
      `UPDATE email_deliveries SET status = ?, attempts = ?, last_error = ?, updated_at = ?, next_attempt_at = ? WHERE id = ?`,
      [
        canRetry ? 'failed' : 'abandoned',
        nextAttempts,
        outcome.error ?? 'send_failed',
        new Date().toISOString(),
        canRetry ? nextAttemptAt(nextAttempts).toISOString() : null,
        row.id,
      ]
    );
    if (canRetry) failed += 1;
    else abandoned += 1;
  }

  return { retried, sent, failed, abandoned };
}

/** Retries one delivery from the admin dashboard. */
export async function retryDeliveryById(
  env: Bindings,
  deliveryId: string
): Promise<{ ok: boolean; status: string; error?: string }> {
  const row = await tursoQuery(env, `SELECT * FROM email_deliveries WHERE id = ? LIMIT 1`, [deliveryId]);
  if (row.rows.length === 0) return { ok: false, status: 'not_found', error: 'not_found' };
  const delivery = row.rows[0];
  if (delivery.status === 'sent') return { ok: true, status: 'sent' };
  if (!delivery.payload) return { ok: false, status: 'not_retryable', error: 'payload_not_stored' };

  let message: EmailMessage;
  try {
    message = JSON.parse(String(delivery.payload)) as EmailMessage;
  } catch {
    return { ok: false, status: 'not_retryable', error: 'corrupt_payload' };
  }

  const outcome = (await sendViaCooper(env, message)).ok
    ? { ok: true as const, provider: 'cooper' }
    : await sendViaOpenMail(env, message);
  const attempts = Number(delivery.attempts ?? 0) + 1;

  if (outcome.ok) {
    await tursoExecute(
      env,
      `UPDATE email_deliveries SET status = 'sent', provider = ?, attempts = ?, sent_at = ?, updated_at = ?, next_attempt_at = NULL, last_error = NULL WHERE id = ?`,
      [outcome.provider, attempts, new Date().toISOString(), new Date().toISOString(), deliveryId]
    );
    return { ok: true, status: 'sent' };
  }

  const canRetry = shouldRetry(attempts, EMAIL_MAX_ATTEMPTS);
  await tursoExecute(
    env,
    `UPDATE email_deliveries SET status = ?, attempts = ?, last_error = ?, updated_at = ?, next_attempt_at = ? WHERE id = ?`,
    [
      canRetry ? 'failed' : 'abandoned',
      attempts,
      outcome.error ?? 'send_failed',
      new Date().toISOString(),
      canRetry ? nextAttemptAt(attempts).toISOString() : null,
      deliveryId,
    ]
  );
  return { ok: false, status: canRetry ? 'failed' : 'abandoned', error: outcome.error };
}

/** Removes delivered/failed payloads once they are no longer needed. */
export async function pruneEmailDeliveries(env: Bindings, olderThanDays = 30): Promise<void> {
  const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
  await tursoExecute(
    env,
    `DELETE FROM email_deliveries WHERE created_at < ? AND status IN ('sent','abandoned','skipped')`,
    [cutoff]
  ).catch((error) => console.error('EMAIL_PRUNE_FAILED', error));
}

export function isDelivered(status: string): boolean {
  return status === 'sent';
}

export { isTerminalStatus };
