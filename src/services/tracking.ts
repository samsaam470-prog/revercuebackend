import { dbRun } from '../utils/db';
import { generateId } from '../utils/ids';
import { ADVANCED_TRACKING } from '../config/constants';
import type { Bindings } from '../types';

export interface EventInput {
  userId: string;
  plan: string;
  documentType: string;
  documentId: string;
  visitId?: string | null;
  eventType: string;
  eventData?: any;
}

const FREE_EVENTS = new Set(['opened']);
const STARTER_EVENTS = new Set(['opened', 'opened_at']);
const GROWTH_EVENTS = new Set(['opened', 'opened_at', 'time_spent', 'button_click']);
const SCALE_EVENTS = new Set([
  'opened', 'opened_at', 'time_spent', 'button_click', 'button_deselect',
  'typing_time', 'question_start', 'question_submit', 'per_question_time',
  'not_submitted', 'session_timeline', 'faq_expand', 'package_choice',
]);

function allowedForPlan(plan: string, eventType: string): boolean {
  if (plan === 'free') return FREE_EVENTS.has(eventType);
  if (plan === 'starter') return STARTER_EVENTS.has(eventType);
  if (plan === 'growth') return GROWTH_EVENTS.has(eventType);
  if (plan === 'scale' || plan === 'teams') return SCALE_EVENTS.has(eventType);
  return false;
}

export async function trackEvent(env: Bindings, input: EventInput): Promise<void> {
  if (!allowedForPlan(input.plan, input.eventType)) return;
  if (input.eventType === 'opened' || input.eventType === 'opened_at') {
    await dbRun(
      env,
      `INSERT INTO document_visits (id, user_id, document_type, document_id, opened_at, retention_until) VALUES (?, ?, ?, ?, ?, ?)`,
      [generateId('visit'), input.userId, input.documentType, input.documentId, new Date().toISOString(), new Date(Date.now() + 5 * 86400000).toISOString()]
    );
    return;
  }
  await dbRun(
    env,
    `INSERT INTO document_events (id, visit_id, event_type, event_data, server_timestamp, retention_until) VALUES (?, ?, ?, ?, ?, ?)`,
    [generateId('evt'), input.visitId ?? generateId('visit'), input.eventType, JSON.stringify(input.eventData ?? {}), new Date().toISOString(), new Date(Date.now() + 5 * 86400000).toISOString()]
  );
}
