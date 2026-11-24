import { tursoExecute, tursoQuery } from '../utils/turso';
import { dbFirst, dbQuery, dbRun } from '../utils/db';
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
  /**
   * Set false when the caller sends its own richer email for the same event,
   * so the user does not receive two messages for one action.
   */
  sendEmail?: boolean;
}

/** In-app notification + best-effort email. Ownership is always the user id. */
export async function createNotification(env: Bindings, input: NotificationInput): Promise<string> {
  const id = generateId('notif');
  const now = new Date().toISOString();
  if (env.ENVIRONMENT === 'staging') {
    await dbRun(env, `INSERT INTO notifications (id, user_id, event_type, client_id, document_id, title, body, read, dismissed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [id, input.userId, input.eventType, input.clientId ?? null, input.documentId ?? null, input.title.slice(0, 300), input.body ?? null, now]);
    return id;
  }
  await tursoExecute(
    env,
    `INSERT INTO notifications (id, user_id, event_type, client_id, document_id, title, body, read, dismissed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    [id, input.userId, input.eventType, input.clientId ?? null, input.documentId ?? null, input.title.slice(0, 300), input.body ?? null, now]
  );

  if (input.sendEmail !== false) {
    await maybeSendEmail(env, {
      userId: input.userId,
      eventType: input.eventType,
      clientName: input.clientName ?? null,
      documentTitle: input.documentTitle ?? null,
      idempotencyKey: `notification:${id}`,
    });
  }

  return id;
}

export async function getUnreadCount(env: Bindings, userId: string): Promise<number> {
  if (env.ENVIRONMENT === 'staging') {
    const row = await dbFirst<{ c: number }>(env, 'SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0 AND dismissed = 0', [userId]);
    return Number(row?.c ?? 0);
  }
  const result = await tursoQuery(env, `SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0 AND dismissed = 0`, [userId]);
  return Number(result.rows[0]?.c ?? 0);
}

export interface NotificationRow {
  id: string;
  user_id: string;
  event_type: string;
  client_id: string | null;
  document_id: string | null;
  title: string;
  body: string | null;
  read: number;
  dismissed: number;
  created_at: string;
}

/**
 * Notifications created strictly after `since`, for Server-Sent Events.
 * Scoped by user id so a subscriber can never observe another user's rows.
 */
export async function listNotificationsSince(
  env: Bindings,
  userId: string,
  since: string | null,
  limit = 25
): Promise<NotificationRow[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  if (env.ENVIRONMENT === 'staging') {
    const rows = since
      ? await dbQuery<NotificationRow>(env, `SELECT id, user_id, event_type, client_id, document_id, title, body, read, dismissed, created_at FROM notifications WHERE user_id = ? AND dismissed = 0 AND created_at > ? ORDER BY created_at ASC LIMIT ?`, [userId, since, safeLimit])
      : await dbQuery<NotificationRow>(env, `SELECT id, user_id, event_type, client_id, document_id, title, body, read, dismissed, created_at FROM notifications WHERE user_id = ? AND dismissed = 0 ORDER BY created_at DESC LIMIT ?`, [userId, safeLimit]);
    return since ? rows : rows.reverse();
  }
  if (since) {
    const result = await tursoQuery(
      env,
      `SELECT id, user_id, event_type, client_id, document_id, title, body, read, dismissed, created_at
       FROM notifications WHERE user_id = ? AND dismissed = 0 AND created_at > ?
       ORDER BY created_at ASC LIMIT ${safeLimit}`,
      [userId, since]
    );
    return result.rows as NotificationRow[];
  }
  const result = await tursoQuery(
    env,
    `SELECT id, user_id, event_type, client_id, document_id, title, body, read, dismissed, created_at
     FROM notifications WHERE user_id = ? AND dismissed = 0
     ORDER BY created_at DESC LIMIT ${safeLimit}`,
    [userId]
  );
  return (result.rows as NotificationRow[]).reverse();
}
