import { dbFirst, dbRun } from '../utils/db';
import { generateId } from '../utils/ids';
import type { Bindings } from '../types';

/**
 * Resolves the client for a document. Revercue never trusts a client id from
 * the browser without checking that it belongs to the caller.
 */
export async function resolveClientId(
  env: Bindings,
  userId: string,
  input: {
    client_id?: string | null;
    client_name?: string | null;
    client_email?: string | null;
    source?: string;
    industry?: string | null;
    client_website?: string | null;
    target_audience?: string | null;
  }
): Promise<string | null> {
  if (input.client_id) {
    const owned = await dbFirst<{ id: string }>(
      env,
      `SELECT id FROM clients WHERE id = ? AND user_id = ? LIMIT 1`,
      [input.client_id, userId]
    );
    if (!owned) return null;
    return owned.id;
  }

  const email = input.client_email?.trim().toLowerCase();
  if (!email) return null;

  const existing = await dbFirst<{ id: string }>(
    env,
    `SELECT id FROM clients WHERE user_id = ? AND lower(email) = ? LIMIT 1`,
    [userId, email]
  );
  if (existing) return existing.id;

  const id = generateId('cli');
  const now = new Date().toISOString();
  await dbRun(
    env,
    `INSERT INTO clients (id, user_id, name, email, industry, target_audience, website_url, source, last_message_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      userId,
      (input.client_name ?? email).slice(0, 200),
      email,
      input.industry ?? null,
      input.target_audience ?? null,
      input.client_website ?? null,
      input.source ?? 'document',
      now,
      now,
      now,
    ]
  );
  return id;
}
