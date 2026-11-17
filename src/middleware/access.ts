import { dbFirst } from '../utils/db';
import type { Bindings } from '../types';

/**
 * Ownership checks are enforced in SQL (`WHERE user_id = ?`) rather than by
 * trusting an id from the client. Every document route goes through this
 * helper so a caller can never read or mutate another user's record.
 */

export type OwnedTable = 'proposals' | 'contracts' | 'forms' | 'invoices' | 'clients';

const OWNED_TABLES: Record<OwnedTable, string> = {
  proposals: 'proposals',
  contracts: 'contracts',
  forms: 'forms',
  invoices: 'invoices',
  clients: 'clients',
};

export async function getOwnedRow<T = any>(
  env: Bindings,
  table: OwnedTable,
  id: string,
  userId: string
): Promise<T | null> {
  if (!id) return null;
  return dbFirst<T>(env, `SELECT * FROM ${OWNED_TABLES[table]} WHERE id = ? AND user_id = ? LIMIT 1`, [
    id,
    userId,
  ]);
}

export async function userOwnsClient(env: Bindings, clientId: string, userId: string): Promise<boolean> {
  if (!clientId) return false;
  const row = await dbFirst<{ id: string }>(
    env,
    `SELECT id FROM clients WHERE id = ? AND user_id = ? LIMIT 1`,
    [clientId, userId]
  );
  return Boolean(row);
}

export function planAllows(plan: string, map: Record<string, unknown>): boolean {
  const value = map[plan];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  return false;
}

export function planLimit(plan: string, map: Record<string, number>, fallback = 0): number {
  const value = map[plan];
  return typeof value === 'number' ? value : fallback;
}

/** Plan feature gate used by routes that expose paid-only capabilities. */
export function requireFeature(
  plan: string,
  map: Record<string, unknown>
): { allowed: true } | { allowed: false; status: 403; body: Record<string, unknown> } {
  if (planAllows(plan, map)) return { allowed: true };
  return {
    allowed: false,
    status: 403,
    body: { error: 'forbidden', message: 'This feature is not available on your current plan.' },
  };
}
