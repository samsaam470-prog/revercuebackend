import { tursoExecute, tursoQuery } from '../utils/turso';
import { generateId } from '../utils/ids';
import { maybeSendEmail } from './email-notify';
import type { Bindings } from '../types';

export interface NotificationInput {
  userId: string;
  eventType: string;
  clientId?: string | null;
  documentId?: string | null;
  title: string;
  body?: string | null;
  clientName?: string | null;
  documentTitle?: string | null;
}

export async function createNotification(env: Bindings, input: NotificationInput): Promise<string> {
  const id = generateId('notif');
  const now = new Date().toISOString();
  await tursoExecute(
    env,
    `INSERT INTO notifications (id, user_id, event_type, client_id, document_id, title, body, read, dismissed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    [id, input.userId, input.eventType, input.clientId ?? null, input.documentId ?? null, input.title, input.body ?? null, now]
  );

  await maybeSendEmail(env, {
    userId: input.userId,
    eventType: input.eventType,
    clientName: input.clientName ?? null,
    documentTitle: input.documentTitle ?? null,
  });

  return id;
}

export async function getUnreadCount(env: Bindings, userId: string): Promise<number> {
  const result = await tursoQuery(env, `SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0 AND dismissed = 0`, [userId]);
  return Number(result.rows[0]?.c ?? 0);
}
