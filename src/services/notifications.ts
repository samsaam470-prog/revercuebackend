import { tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import type { Bindings } from '../types';

export interface NotificationInput {
  userId: string;
  eventType: string;
  clientId?: string | null;
  documentId?: string | null;
  title: string;
  body?: string | null;
}

export async function createNotification(
  env: Bindings,
  input: NotificationInput
): Promise<string> {
  const id = generateId('notif');
  const now = new Date().toISOString();
  await tursoExecute(
    env,
    `INSERT INTO notifications (id, user_id, event_type, client_id, document_id, title, body, read, dismissed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    [
      id,
      input.userId,
      input.eventType,
      input.clientId ?? null,
      input.documentId ?? null,
      input.title,
      input.body ?? null,
      now,
    ]
  );
  return id;
}
