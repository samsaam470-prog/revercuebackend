import { dbFirst, dbQuery, dbRun, dbRunResult } from '../utils/db';
import { generateId } from '../utils/ids';
import type { Bindings } from '../types';

/**
 * Document tracking.
 *
 * Fixes in this version:
 *  - events are attached to a *real* visit id (the old code generated a new
 *    random visit id for every event, orphaning them);
 *  - visits are de-duplicated per visitor so a refresh does not inflate opens;
 *  - the document is re-validated before anything is written, so events cannot
 *    be attributed to another user's document;
 *  - plan gating and retention are enforced server-side.
 */

export type TrackedDocumentType = 'proposal' | 'contract' | 'invoice' | 'form';

const TRACKED_TYPES: TrackedDocumentType[] = ['proposal', 'contract', 'invoice', 'form'];

const FREE_EVENTS = new Set(['opened']);
const STARTER_EVENTS = new Set(['opened']);
const GROWTH_EVENTS = new Set(['opened', 'time_spent', 'button_click', 'not_submitted', 'faq_expand']);
const SCALE_EVENTS = new Set([
  'opened',
  'time_spent',
  'button_click',
  'button_deselect',
  'typing_time',
  'question_start',
  'question_submit',
  'per_question_time',
  'not_submitted',
  'session_timeline',
  'faq_expand',
  'package_choice',
  'scroll_depth',
]);

const MAX_EVENTS_PER_VISIT = 200;
const VISIT_RETENTION_DAYS = 5;
const VISIT_DEDUPE_MINUTES = 30;
const MAX_TIME_SPENT_SECONDS = 3600;

export function isTrackedType(value: string): value is TrackedDocumentType {
  return (TRACKED_TYPES as string[]).includes(value);
}

export function allowedForPlan(plan: string, eventType: string): boolean {
  if (plan === 'scale' || plan === 'teams') return SCALE_EVENTS.has(eventType);
  if (plan === 'growth') return GROWTH_EVENTS.has(eventType);
  if (plan === 'starter') return STARTER_EVENTS.has(eventType);
  if (plan === 'free') return FREE_EVENTS.has(eventType);
  return false;
}

/** Only these events may be reported without an existing visit. */
const IMPLICIT_OPEN_EVENTS = new Set(['opened']);

const DOCUMENT_TABLES: Record<TrackedDocumentType, { table: string; statusColumn: string }> = {
  proposal: { table: 'proposals', statusColumn: 'status' },
  contract: { table: 'contracts', statusColumn: 'status' },
  invoice: { table: 'invoices', statusColumn: 'status' },
  form: { table: 'forms', statusColumn: 'status' },
};

export interface DocumentLookup {
  id: string;
  user_id: string;
  status: string;
}

export async function findTrackableDocument(
  env: Bindings,
  documentType: TrackedDocumentType,
  documentId: string
): Promise<DocumentLookup | null> {
  const { table, statusColumn } = DOCUMENT_TABLES[documentType];
  return dbFirst<DocumentLookup>(
    env,
    `SELECT id, user_id, ${statusColumn} AS status FROM ${table} WHERE id = ? LIMIT 1`,
    [documentId]
  );
}

function retentionUntil(): string {
  return new Date(Date.now() + VISIT_RETENTION_DAYS * 86400000).toISOString();
}

export interface StartVisitInput {
  userId: string;
  plan: string;
  documentType: TrackedDocumentType;
  documentId: string;
  visitorHash: string | null;
  userAgent: string | null;
}

/**
 * Starts (or reuses) a visit for a document open. Returns null when the plan
 * does not include tracking, in which case nothing is written.
 */
export async function startVisit(
  env: Bindings,
  input: StartVisitInput
): Promise<{ visitId: string | null; reused: boolean }> {
  if (!allowedForPlan(input.plan, 'opened')) return { visitId: null, reused: false };

  const now = new Date();
  const dedupeAfter = new Date(now.getTime() - VISIT_DEDUPE_MINUTES * 60000).toISOString();

  if (input.visitorHash) {
    const existing = await dbFirst<{ visit_id: string }>(
      env,
      `SELECT m.visit_id FROM document_visit_meta m
       JOIN document_visits v ON v.id = m.visit_id
       WHERE m.visitor_hash = ? AND v.document_type = ? AND v.document_id = ?
         AND v.opened_at > ? AND v.closed_at IS NULL
       ORDER BY v.opened_at DESC LIMIT 1`,
      [input.visitorHash, input.documentType, input.documentId, dedupeAfter]
    );
    if (existing?.visit_id) return { visitId: existing.visit_id, reused: true };
  }

  const visitId = generateId('visit');
  await dbRun(
    env,
    `INSERT INTO document_visits (id, user_id, document_type, document_id, opened_at, retention_until) VALUES (?, ?, ?, ?, ?, ?)`,
    [visitId, input.userId, input.documentType, input.documentId, now.toISOString(), retentionUntil()]
  );
  await dbRun(
    env,
    `INSERT INTO document_visit_meta (visit_id, visitor_hash, plan, user_agent, created_at) VALUES (?, ?, ?, ?, ?)`,
    [visitId, input.visitorHash, input.plan, input.userAgent, now.toISOString()]
  ).catch((error) => console.error('VISIT_META_WRITE_FAILED', error));

  return { visitId, reused: false };
}

export interface EventInput {
  userId: string;
  plan: string;
  documentType: TrackedDocumentType;
  documentId: string;
  visitId?: string | null;
  eventType: string;
  eventData?: unknown;
}

export type EventOutcome =
  | { ok: true; visitId: string | null; recorded: boolean; reason?: 'plan' | 'invalid_event' }
  | { ok: false; reason: 'document_not_found' | 'visit_not_found' | 'rate_limited' };

/**
 * Records a tracking event against a validated visit for the same document.
 * A client-supplied visit id must already belong to that document and owner.
 */
export async function trackEvent(env: Bindings, input: EventInput): Promise<EventOutcome> {
  const document = await findTrackableDocument(env, input.documentType, input.documentId);
  if (!document) return { ok: false, reason: 'document_not_found' };
  if (document.user_id !== input.userId) return { ok: false, reason: 'document_not_found' };

  const normalizedEvent = String(input.eventType || '').slice(0, 60);
  if (!allowedForPlan(input.plan, normalizedEvent)) {
    return { ok: true, visitId: null, recorded: false, reason: 'plan' };
  }

  let visitId: string | null = null;
  if (input.visitId) {
    const visit = await dbFirst<{ id: string }>(
      env,
      `SELECT id FROM document_visits WHERE id = ? AND document_id = ? AND user_id = ? LIMIT 1`,
      [input.visitId, input.documentId, input.userId]
    );
    if (!visit) return { ok: false, reason: 'visit_not_found' };
    visitId = visit.id;
  } else if (IMPLICIT_OPEN_EVENTS.has(normalizedEvent)) {
    const started = await startVisit(env, {
      userId: input.userId,
      plan: input.plan,
      documentType: input.documentType,
      documentId: input.documentId,
      visitorHash: null,
      userAgent: null,
    });
    visitId = started.visitId;
  } else {
    const open = await dbFirst<{ id: string }>(
      env,
      `SELECT id FROM document_visits WHERE document_id = ? AND user_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`,
      [input.documentId, input.userId]
    );
    visitId = open?.id ?? null;
  }

  if (!visitId) return { ok: true, visitId: null, recorded: false, reason: 'plan' };

  const count = await dbFirst<{ c: number }>(env, `SELECT COUNT(*) as c FROM document_events WHERE visit_id = ?`, [
    visitId,
  ]);
  if (Number(count?.c ?? 0) >= MAX_EVENTS_PER_VISIT) {
    return { ok: false, reason: 'rate_limited' };
  }

  const payload = JSON.stringify(input.eventData ?? {}).slice(0, 4000);

  if (normalizedEvent === 'time_spent') {
    const raw = Number((input.eventData as any)?.seconds ?? 0);
    const seconds = Number.isFinite(raw) ? Math.max(0, Math.min(Math.round(raw), MAX_TIME_SPENT_SECONDS)) : 0;
    await dbRun(
      env,
      `UPDATE document_visits SET time_spent_seconds = MAX(COALESCE(time_spent_seconds, 0), ?) WHERE id = ?`,
      [seconds, visitId]
    );
  }

  await dbRun(
    env,
    `INSERT INTO document_events (id, visit_id, event_type, event_data, server_timestamp, retention_until) VALUES (?, ?, ?, ?, ?, ?)`,
    [generateId('evt'), visitId, normalizedEvent, payload, new Date().toISOString(), retentionUntil()]
  );

  return { ok: true, visitId, recorded: true };
}

export async function closeVisit(
  env: Bindings,
  input: {
    userId: string;
    documentType: TrackedDocumentType;
    documentId: string;
    visitId?: string | null;
    seconds: number;
  }
): Promise<boolean> {
  const seconds = Math.max(0, Math.min(Math.round(input.seconds || 0), MAX_TIME_SPENT_SECONDS));
  const now = new Date().toISOString();
  if (input.visitId) {
    const result = await dbRunResult(
      env,
      `UPDATE document_visits SET closed_at = ?, time_spent_seconds = MAX(COALESCE(time_spent_seconds, 0), ?)
       WHERE id = ? AND document_id = ? AND user_id = ? AND closed_at IS NULL`,
      [now, seconds, input.visitId, input.documentId, input.userId]
    );
    return result.changes > 0;
  }
  const latest = await dbFirst<{ id: string }>(
    env,
    `SELECT id FROM document_visits WHERE document_id = ? AND user_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`,
    [input.documentId, input.userId]
  );
  if (!latest) return false;
  const result = await dbRunResult(
    env,
    `UPDATE document_visits SET closed_at = ?, time_spent_seconds = MAX(COALESCE(time_spent_seconds, 0), ?)
     WHERE id = ? AND closed_at IS NULL`,
    [now, seconds, latest.id]
  );
  return result.changes > 0;
}

export interface DocumentTrackingSummary {
  first_opened_at: string | null;
  last_opened_at: string | null;
  total_visits: number;
  total_time_spent_seconds: number;
}

/** Aggregate used by the owner-facing document views. Never exposes visitor data. */
export async function getTrackingSummary(
  env: Bindings,
  documentType: TrackedDocumentType,
  documentId: string
): Promise<DocumentTrackingSummary> {
  const row = await dbFirst<{
    first_opened_at: string | null;
    last_opened_at: string | null;
    total_visits: number;
    total_time: number;
  }>(
    env,
    `SELECT MIN(opened_at) AS first_opened_at, MAX(opened_at) AS last_opened_at,
            COUNT(*) AS total_visits, COALESCE(SUM(time_spent_seconds), 0) AS total_time
     FROM document_visits WHERE document_type = ? AND document_id = ?`,
    [documentType, documentId]
  );
  return {
    first_opened_at: row?.first_opened_at ?? null,
    last_opened_at: row?.last_opened_at ?? null,
    total_visits: Number(row?.total_visits ?? 0),
    total_time_spent_seconds: Number(row?.total_time ?? 0),
  };
}

/** Session timeline for the owner (scale/teams). No IPs or user agents. */
export async function getVisitTimeline(
  env: Bindings,
  documentType: TrackedDocumentType,
  documentId: string,
  limit = 20
) {
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  return dbQuery(
    env,
    `SELECT id, opened_at, closed_at, time_spent_seconds FROM document_visits
     WHERE document_type = ? AND document_id = ? ORDER BY opened_at DESC LIMIT ${safeLimit}`,
    [documentType, documentId]
  );
}
