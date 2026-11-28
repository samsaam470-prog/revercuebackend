import { dbFirst, dbQuery, dbRun } from '../utils/db';
import type { Bindings } from '../types';

/**
 * Temporary collaboration chat for Shareable Builder.
 *
 * Messages are intentionally NOT part of the permanent document record. They
 * live in a dedicated table that is emptied when a contribution session ends
 * (either completion route), when the invitation is revoked, and by the hourly
 * retention job for anything older than CHAT_TTL_MINUTES. They are never
 * written to `document_editing_events`, analytics or application logs.
 *
 * Honest limitation: Revercue deletes the rows it controls immediately. D1
 * point-in-time backups held by the infrastructure provider are outside this
 * application's control and follow that provider's own retention window.
 */

export const CHAT_TTL_MINUTES = 120;

export interface ChatMessage {
  id: string;
  session_id: string;
  author: 'owner' | 'contributor';
  body: string;
  created_at: string;
}

export async function postChatMessage(
  env: Bindings,
  sessionId: string,
  author: 'owner' | 'contributor',
  body: string
): Promise<ChatMessage> {
  const id = `ccm_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const text = body.trim().slice(0, 2000);
  await dbRun(
    env,
    `INSERT INTO collaboration_messages (id, session_id, author, body, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, sessionId, author, text, now, new Date(Date.now() + CHAT_TTL_MINUTES * 60_000).toISOString()]
  );
  return { id, session_id: sessionId, author, body: text, created_at: now };
}

export async function listChatMessages(
  env: Bindings,
  sessionId: string,
  afterIso: string | null = null
): Promise<ChatMessage[]> {
  const rows = await dbQuery<ChatMessage>(
    env,
    `SELECT id, session_id, author, body, created_at
       FROM collaboration_messages
      WHERE session_id = ? AND expires_at > ?
        AND (? IS NULL OR created_at > ?)
      ORDER BY created_at ASC
      LIMIT 200`,
    [sessionId, new Date().toISOString(), afterIso, afterIso]
  );
  return rows;
}

/** Deletes every message for a session. Called on completion and revocation. */
export async function clearSessionChat(env: Bindings, sessionId: string): Promise<void> {
  await dbRun(env, `DELETE FROM collaboration_messages WHERE session_id = ?`, [sessionId]);
}

/** Hourly sweep for anything past its TTL, including abandoned sessions. */
export async function purgeExpiredChat(env: Bindings): Promise<void> {
  await dbRun(env, `DELETE FROM collaboration_messages WHERE expires_at <= ?`, [new Date().toISOString()]);
}

export async function sessionChatExists(env: Bindings, sessionId: string): Promise<boolean> {
  const row = await dbFirst<{ id: string }>(
    env,
    `SELECT id FROM collaboration_messages WHERE session_id = ? LIMIT 1`,
    [sessionId]
  );
  return Boolean(row);
}
