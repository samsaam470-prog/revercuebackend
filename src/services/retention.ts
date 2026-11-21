import { dbFirst, dbQuery, dbRun, dbRunResult } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { generateId } from '../utils/ids';
import { buildDocumentPdf, documentTitleFor, loadDocumentForPdf } from './pdf';
import { createDocumentLink, documentLinkUrl } from './document-links';
import { documentDeliveryEmail, retentionWarningEmail } from './email-templates';
import { sendEmail } from './email';
import { createNotification } from './notifications';
import {
  DEFAULT_AUTO_DELETE_TYPES,
  RETENTION_BATCH_SIZE,
  RETENTION_MAX_DELIVERY_ATTEMPTS,
  RETENTION_POLICY,
  RETENTION_WARNING_DAYS,
  type DocumentType,
} from '../config/constants';
import type { Bindings } from '../types';

/**
 * Document retention lifecycle.
 *
 *   expiry - 10 days  → one warning (in-app + email), idempotent per expiry date
 *   expiry            → generate the PDF, email a private 7-day link, and only
 *                       then apply the deletion policy
 *
 * If delivery fails the document is kept, the failure is recorded and retried
 * with backoff. Fully signed contracts and invoices are never auto-deleted.
 */

export interface RetentionCandidate {
  documentType: DocumentType;
  documentId: string;
  userId: string;
  title: string;
  expiryDate: string;
  status: string;
}

export interface RetentionRunSummary {
  evaluated: number;
  warnings: number;
  deliveries: number;
  deleted: number;
  retained: number;
  failures: number;
  retried: number;
}

// ---------------------------------------------------------------------------
// Pure policy helpers (unit-tested)
// ---------------------------------------------------------------------------

export function warningIdempotencyKey(
  type: DocumentType,
  id: string,
  expiryDate: string,
  warningDays: number
): string {
  return `${type}:${id}:${expiryDate.slice(0, 10)}:${warningDays}`;
}

export function isWithinWarningWindow(expiryDate: string, now: Date, warningDays: number): boolean {
  const expiry = new Date(expiryDate).getTime();
  if (!Number.isFinite(expiry)) return false;
  const diff = expiry - now.getTime();
  return diff > 0 && diff <= warningDays * 86400000;
}

export function isExpired(expiryDate: string, now: Date): boolean {
  const expiry = new Date(expiryDate).getTime();
  return Number.isFinite(expiry) && expiry <= now.getTime();
}

export function computeDraftExpiry(createdAt: unknown, retentionDays: unknown): string | null {
  if (!createdAt) return null;
  const created = new Date(String(createdAt)).getTime();
  const days = Number(retentionDays ?? 0);
  if (!Number.isFinite(created) || !Number.isFinite(days) || days <= 0) return null;
  return new Date(created + days * 86400000).toISOString();
}

/** Which document types may be deleted in this deployment. */
export function autoDeleteTypes(env: Bindings): DocumentType[] {
  const configured = (env.RETENTION_AUTO_DELETE_TYPES ?? '').trim();
  if (!configured) return DEFAULT_AUTO_DELETE_TYPES;
  const allowed = new Set(configured.split(',').map((value) => value.trim().toLowerCase()));
  return (Object.keys(RETENTION_POLICY) as DocumentType[]).filter(
    (type) => allowed.has(type) && RETENTION_POLICY[type].deletable
  );
}

export function shouldDelete(type: DocumentType, types: DocumentType[]): boolean {
  return RETENTION_POLICY[type].deletable && types.includes(type);
}

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

async function draftCandidates(
  env: Bindings,
  type: DocumentType,
  deadline: string
): Promise<RetentionCandidate[]> {
  if (type === 'proposal') {
    const rows = await dbQuery<any>(
      env,
      `SELECT id, user_id, title, status, draft_created_at, draft_retention_days FROM proposals
       WHERE status = 'draft' AND draft_created_at IS NOT NULL AND draft_retention_days IS NOT NULL LIMIT ?`,
      [RETENTION_BATCH_SIZE]
    );
    return rows
      .map((row) => ({
        documentType: 'proposal' as DocumentType,
        documentId: String(row.id),
        userId: String(row.user_id),
        title: String(row.title ?? 'Proposal'),
        expiryDate: computeDraftExpiry(row.draft_created_at, row.draft_retention_days) ?? '',
        status: String(row.status),
      }))
      .filter((row) => row.expiryDate && row.expiryDate <= deadline);
  }

  if (type === 'contract') {
    const rows = await dbQuery<any>(
      env,
      `SELECT c.id, c.user_id, c.title, c.status, c.draft_created_at, c.draft_retention_days
       FROM contracts c
       WHERE c.status IN ('draft','declined')
         AND c.draft_created_at IS NOT NULL AND c.draft_retention_days IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM contract_signatures s WHERE s.contract_id = c.id)
       LIMIT ?`,
      [RETENTION_BATCH_SIZE]
    );
    return rows
      .map((row) => ({
        documentType: 'contract' as DocumentType,
        documentId: String(row.id),
        userId: String(row.user_id),
        title: String(row.title ?? 'Contract'),
        expiryDate: computeDraftExpiry(row.draft_created_at, row.draft_retention_days) ?? '',
        status: String(row.status),
      }))
      .filter((row) => row.expiryDate && row.expiryDate <= deadline);
  }

  if (type === 'form') {
    const rows = await dbQuery<any>(
      env,
      `SELECT id, user_id, title, status, draft_created_at, draft_retention_days FROM forms
       WHERE status = 'draft' AND draft_created_at IS NOT NULL AND draft_retention_days IS NOT NULL LIMIT ?`,
      [RETENTION_BATCH_SIZE]
    );
    return rows
      .map((row) => ({
        documentType: 'form' as DocumentType,
        documentId: String(row.id),
        userId: String(row.user_id),
        title: String(row.title ?? 'Form'),
        expiryDate: computeDraftExpiry(row.draft_created_at, row.draft_retention_days) ?? '',
        status: String(row.status),
      }))
      .filter((row) => row.expiryDate && row.expiryDate <= deadline);
  }

  const rows = await dbQuery<any>(
    env,
    `SELECT id, user_id, invoice_number, status, draft_created_at, draft_retention_days FROM invoices
     WHERE status = 'draft' AND draft_created_at IS NOT NULL AND draft_retention_days IS NOT NULL LIMIT ?`,
    [RETENTION_BATCH_SIZE]
  );
  return rows
    .map((row) => ({
      documentType: 'invoice' as DocumentType,
      documentId: String(row.id),
      userId: String(row.user_id),
      title: String(row.invoice_number ?? 'Invoice'),
      expiryDate: computeDraftExpiry(row.draft_created_at, row.draft_retention_days) ?? '',
      status: String(row.status),
    }))
    .filter((row) => row.expiryDate && row.expiryDate <= deadline);
}

async function archivedCandidates(env: Bindings, deadline: string): Promise<RetentionCandidate[]> {
  const proposals = await dbQuery<any>(
    env,
    `SELECT id, user_id, title, status, archive_deletion_date FROM proposals
     WHERE status = 'archived' AND archive_deletion_date IS NOT NULL AND archive_deletion_date <= ? LIMIT ?`,
    [deadline, RETENTION_BATCH_SIZE]
  );

  const generic = await dbQuery<any>(
    env,
    `SELECT a.document_type, a.document_id, a.user_id, a.archive_deletion_date,
            CASE a.document_type
              WHEN 'contract' THEN (SELECT title FROM contracts WHERE id = a.document_id)
              WHEN 'form' THEN (SELECT title FROM forms WHERE id = a.document_id)
              WHEN 'invoice' THEN (SELECT invoice_number FROM invoices WHERE id = a.document_id)
            END AS title,
            CASE a.document_type
              WHEN 'contract' THEN (SELECT status FROM contracts WHERE id = a.document_id)
              WHEN 'form' THEN (SELECT status FROM forms WHERE id = a.document_id)
              WHEN 'invoice' THEN (SELECT status FROM invoices WHERE id = a.document_id)
            END AS status
     FROM document_archive a
     WHERE a.unarchived_at IS NULL AND a.archive_deletion_date IS NOT NULL AND a.archive_deletion_date <= ?
     LIMIT ?`,
    [deadline, RETENTION_BATCH_SIZE]
  );

  const results: RetentionCandidate[] = proposals.map((row) => ({
    documentType: 'proposal',
    documentId: String(row.id),
    userId: String(row.user_id),
    title: String(row.title ?? 'Proposal'),
    expiryDate: String(row.archive_deletion_date),
    status: 'archived',
  }));

  for (const row of generic) {
    const type = String(row.document_type) as DocumentType;
    if (!RETENTION_POLICY[type]) continue;
    results.push({
      documentType: type,
      documentId: String(row.document_id),
      userId: String(row.user_id),
      title: String(row.title ?? type),
      expiryDate: String(row.archive_deletion_date),
      status: String(row.status ?? 'archived'),
    });
  }
  return results;
}

export async function collectCandidates(env: Bindings, now: Date): Promise<RetentionCandidate[]> {
  const deadline = new Date(now.getTime() + warningWindowDays(env) * 86400000).toISOString();
  const types: DocumentType[] = ['proposal', 'contract', 'form', 'invoice'];
  const collected: RetentionCandidate[] = [];
  for (const type of types) {
    collected.push(...(await draftCandidates(env, type, deadline)));
  }
  collected.push(...(await archivedCandidates(env, deadline)));
  return collected;
}

export function warningWindowDays(env: Bindings): number {
  const raw = Number(env.RETENTION_WARNING_DAYS ?? RETENTION_WARNING_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 60) : RETENTION_WARNING_DAYS;
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

async function sendWarning(env: Bindings, candidate: RetentionCandidate, daysRemaining: number): Promise<boolean> {
  const user = await tursoQuery(env, `SELECT email, name FROM users WHERE id = ? LIMIT 1`, [candidate.userId]);
  const email = user.rows[0]?.email ? String(user.rows[0].email) : null;
  const base = (env.APP_URL || env.FRONTEND_ORIGIN || 'https://revercue.co.uk').replace(/\/$/, '');

  await createNotification(env, {
    userId: candidate.userId,
    eventType: 'retention_warning',
    documentId: candidate.documentId,
    title: `${candidate.title} is deleted in ${daysRemaining} days`,
    body: `Expires ${candidate.expiryDate.slice(0, 10)}. Open Revercue to keep it.`,
    documentTitle: candidate.title,
    // The specific warning email below is the single email for this event.
    sendEmail: false,
  }).catch((error) => console.error('RETENTION_NOTIFICATION_FAILED', error));

  if (!email) return false;
  const rendered = retentionWarningEmail({
    documentTitle: candidate.title,
    documentType: candidate.documentType,
    expiryDate: candidate.expiryDate.slice(0, 10),
    daysRemaining,
    keepUrl: `${base}/dashboard`,
  });
  const result = await sendEmail(env, {
    to: email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    kind: 'retention_warning',
    userId: candidate.userId,
    documentType: candidate.documentType,
    documentId: candidate.documentId,
    idempotencyKey: `retention-warning:${warningIdempotencyKey(candidate.documentType, candidate.documentId, candidate.expiryDate, daysRemaining)}`,
    // The dashboard keep link is permanent; retry provider outages by cron.
    retryable: true,
  });
  return result.ok;
}

// ---------------------------------------------------------------------------
// Delivery + deletion
// ---------------------------------------------------------------------------

async function deliverAndApply(
  env: Bindings,
  candidate: RetentionCandidate,
  deleteTypes: DocumentType[]
): Promise<'deleted' | 'retained' | 'failed'> {
  const existing = await dbFirst<{ status: string; attempts: number }>(
    env,
    `SELECT status, attempts FROM retention_deliveries WHERE document_type = ? AND document_id = ? AND expiry_date = ? LIMIT 1`,
    [candidate.documentType, candidate.documentId, candidate.expiryDate]
  );
  if (existing?.status === 'delivered' || existing?.status === 'retained') {
    return existing.status === 'retained' ? 'retained' : 'deleted';
  }
  if (existing && Number(existing.attempts) >= maxDeliveryAttempts(env)) {
    return 'failed';
  }

  const user = await tursoQuery(env, `SELECT email FROM users WHERE id = ? LIMIT 1`, [candidate.userId]);
  const email = user.rows[0]?.email ? String(user.rows[0].email) : null;
  if (!email) {
    await recordDelivery(env, candidate, 'failed', 'owner_email_missing', false);
    return 'failed';
  }

  const wantsDelete = shouldDelete(candidate.documentType, deleteTypes);
  const pdf = await buildDocumentPdf(env, candidate.documentType, candidate.documentId);
  if (!pdf) {
    await recordDelivery(env, candidate, 'failed', 'pdf_generation_failed', false);
    return 'failed';
  }

  let linkToken: string;
  try {
    const link = await createDocumentLink(env, {
      purpose: 'retention_copy',
      documentType: candidate.documentType,
      documentId: candidate.documentId,
    });
    linkToken = link.token;
  } catch (error) {
    await recordDelivery(env, candidate, 'failed', 'link_generation_failed', false);
    console.error('RETENTION_LINK_FAILED', candidate.documentId, error);
    return 'failed';
  }

  const rendered = documentDeliveryEmail({
    documentTitle: candidate.title,
    documentType: candidate.documentType,
    expiryDate: candidate.expiryDate.slice(0, 10),
    downloadUrl: documentLinkUrl(
      env,
      `/api/public/d/${candidate.documentType}/${candidate.documentId}/download`,
      linkToken
    ),
    deleteAfterDelivery: wantsDelete,
  });

  const sendResult = await sendEmail(env, {
    to: email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    kind: 'document_delivery',
    userId: candidate.userId,
    documentType: candidate.documentType,
    documentId: candidate.documentId,
    retryable: true,
    idempotencyKey: `retention-delivery:${candidate.documentType}:${candidate.documentId}:${candidate.expiryDate.slice(0, 10)}`,
  });

  if (!sendResult.ok) {
    await recordDelivery(env, candidate, 'failed', sendResult.error ?? 'send_failed', false, sendResult.deliveryId);
    return 'failed';
  }

  if (!wantsDelete) {
    await recordDelivery(env, candidate, 'retained', null, true, sendResult.deliveryId);
    await stopRetentionClock(env, candidate);
    return 'retained';
  }

  try {
    await deleteDocument(env, candidate);
    await recordDelivery(env, candidate, 'delivered', null, true, sendResult.deliveryId);
    return 'deleted';
  } catch (error: any) {
    await recordDelivery(env, candidate, 'failed', `delete_failed:${String(error?.message ?? 'unknown').slice(0, 100)}`, false, sendResult.deliveryId);
    return 'failed';
  }
}

function maxDeliveryAttempts(env: Bindings): number {
  const raw = Number(env.RETENTION_MAX_DELIVERY_ATTEMPTS ?? RETENTION_MAX_DELIVERY_ATTEMPTS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 20) : RETENTION_MAX_DELIVERY_ATTEMPTS;
}

async function recordDelivery(
  env: Bindings,
  candidate: RetentionCandidate,
  status: 'delivered' | 'retained' | 'failed',
  error: string | null,
  terminal: boolean,
  emailDeliveryId?: string
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await dbFirst<{ id: string; attempts: number }>(
    env,
    `SELECT id, attempts FROM retention_deliveries WHERE document_type = ? AND document_id = ? AND expiry_date = ? LIMIT 1`,
    [candidate.documentType, candidate.documentId, candidate.expiryDate]
  );
  if (existing) {
    await dbRun(
      env,
      `UPDATE retention_deliveries SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ?, email_delivery_id = COALESCE(?, email_delivery_id), terminal = ? WHERE id = ?`,
      [status, error, now, emailDeliveryId ?? null, terminal ? 1 : 0, existing.id]
    );
    return;
  }
  await dbRun(
    env,
    `INSERT INTO retention_deliveries (id, document_type, document_id, user_id, expiry_date, status, attempts, last_error, email_delivery_id, terminal, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      generateId('rdel'),
      candidate.documentType,
      candidate.documentId,
      candidate.userId,
      candidate.expiryDate,
      status,
      error,
      emailDeliveryId ?? null,
      terminal ? 1 : 0,
      now,
      now,
    ]
  );
}

async function stopRetentionClock(env: Bindings, candidate: RetentionCandidate): Promise<void> {
  if (candidate.documentType === 'proposal') {
    await dbRun(env, `UPDATE proposals SET archive_deletion_date = NULL, retention_paused_at = ? WHERE id = ?`, [
      new Date().toISOString(),
      candidate.documentId,
    ]).catch(() => undefined);
    return;
  }
  await dbRun(
    env,
    `UPDATE document_archive SET archive_deletion_date = NULL WHERE document_type = ? AND document_id = ?`,
    [candidate.documentType, candidate.documentId]
  ).catch(() => undefined);
}

async function deleteDocument(env: Bindings, candidate: RetentionCandidate): Promise<void> {
  switch (candidate.documentType) {
    case 'proposal':
      await dbRun(env, `DELETE FROM proposals WHERE id = ?`, [candidate.documentId]);
      return;
    case 'contract': {
      const contract = await dbFirst<any>(env, `SELECT status FROM contracts WHERE id = ?`, [candidate.documentId]);
      if (contract?.status === 'fully_signed') {
        throw new Error('signed_contract_is_immutable');
      }
      await dbRun(env, `DELETE FROM contract_signatures WHERE contract_id = ?`, [candidate.documentId]);
      await dbRun(env, `DELETE FROM contract_versions WHERE contract_id = ?`, [candidate.documentId]);
      await dbRun(env, `DELETE FROM contract_signing_events WHERE contract_id = ?`, [candidate.documentId]);
      await dbRun(env, `DELETE FROM contracts WHERE id = ?`, [candidate.documentId]);
      return;
    }
    case 'form':
      await dbRun(env, `DELETE FROM form_submissions WHERE form_id = ?`, [candidate.documentId]);
      await dbRun(env, `DELETE FROM form_settings WHERE form_id = ?`, [candidate.documentId]);
      await dbRun(env, `DELETE FROM forms WHERE id = ?`, [candidate.documentId]);
      return;
    case 'invoice': {
      const invoice = await dbFirst<any>(env, `SELECT status FROM invoices WHERE id = ?`, [candidate.documentId]);
      if (invoice?.status === 'confirmed' || invoice?.status === 'paid') {
        throw new Error('invoice_is_an_accounting_record');
      }
      await dbRun(env, `DELETE FROM invoices WHERE id = ?`, [candidate.documentId]);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function processRetention(env: Bindings, now: Date = new Date()): Promise<RetentionRunSummary> {
  const summary: RetentionRunSummary = {
    evaluated: 0,
    warnings: 0,
    deliveries: 0,
    deleted: 0,
    retained: 0,
    failures: 0,
    retried: 0,
  };

  const candidates = await collectCandidates(env, now);
  const days = warningWindowDays(env);
  const deleteTypes = autoDeleteTypes(env);

  // Retry deliveries that previously failed and are still within policy.
  const retryable = await dbQuery<any>(
    env,
    `SELECT document_type, document_id, user_id, expiry_date FROM retention_deliveries
     WHERE status = 'failed' AND terminal = 0 AND attempts < ? AND expiry_date <= ?
     ORDER BY updated_at ASC LIMIT ?`,
    [maxDeliveryAttempts(env), now.toISOString(), RETENTION_BATCH_SIZE]
  );
  for (const row of retryable) {
    const document = await loadDocumentForPdf(env, String(row.document_type) as DocumentType, String(row.document_id));
    if (!document) continue;
    summary.retried += 1;
    const outcome = await deliverAndApply(
      env,
      {
        documentType: String(row.document_type) as DocumentType,
        documentId: String(row.document_id),
        userId: String(row.user_id),
        title: documentTitleFor(String(row.document_type) as DocumentType, document),
        expiryDate: String(row.expiry_date),
        status: String(document.status ?? ''),
      },
      deleteTypes
    );
    if (outcome === 'deleted') summary.deleted += 1;
    else if (outcome === 'retained') summary.retained += 1;
    else summary.failures += 1;
  }

  for (const candidate of candidates) {
    summary.evaluated += 1;

    if (isExpired(candidate.expiryDate, now)) {
      const outcome = await deliverAndApply(env, candidate, deleteTypes);
      if (outcome === 'deleted') summary.deleted += 1;
      else if (outcome === 'retained') summary.retained += 1;
      else summary.failures += 1;
      continue;
    }

    if (!isWithinWarningWindow(candidate.expiryDate, now, days)) continue;

    const key = warningIdempotencyKey(candidate.documentType, candidate.documentId, candidate.expiryDate, days);
    const inserted = await dbRunResult(
      env,
      `INSERT OR IGNORE INTO retention_warnings (id, document_type, document_id, user_id, expiry_date, warning_days, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId('rwarn'),
        candidate.documentType,
        candidate.documentId,
        candidate.userId,
        candidate.expiryDate,
        days,
        key,
        new Date().toISOString(),
      ]
    );
    if (inserted.changes === 0) continue; // already warned for this expiry

    const daysRemaining = Math.max(1, Math.ceil((new Date(candidate.expiryDate).getTime() - now.getTime()) / 86400000));
    const sent = await sendWarning(env, candidate, daysRemaining);
    if (sent) summary.warnings += 1;
    else {
      // Allow the warning to be retried on the next run if no provider was reachable.
      await dbRun(env, `DELETE FROM retention_warnings WHERE idempotency_key = ?`, [key]).catch(() => undefined);
      summary.failures += 1;
    }
  }

  return summary;
}

/** Owner-facing view of what is scheduled, used by the admin dashboard. */
export async function listRetentionFailures(env: Bindings, limit = 50) {
  return dbQuery(
    env,
    `SELECT document_type, document_id, user_id, expiry_date, status, attempts, last_error, updated_at
     FROM retention_deliveries WHERE status = 'failed' ORDER BY updated_at DESC LIMIT ?`,
    [limit]
  );
}
