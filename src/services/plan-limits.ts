import { dbFirst, dbQuery } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { ACTIVE_DOCUMENT_LIMIT, ADAPTIVE_FORM_LIMIT } from '../config/constants';
import type { Bindings } from '../types';

/**
 * Plan limits that span every document type.
 *
 * "Active documents" is one allowance shared by proposals, contracts, forms and
 * invoices. Counting only proposals let a free account keep five proposals plus
 * unlimited contracts, forms and invoices, which does not match the published
 * plan table.
 */

const DOCUMENT_TABLES = ['proposals', 'contracts', 'forms', 'invoices'] as const;

export async function countActiveDocuments(env: Bindings, userId: string): Promise<number> {
  const counts = await Promise.all(
    DOCUMENT_TABLES.map((table) =>
      dbFirst<{ c: number }>(
        env,
        `SELECT COUNT(*) as c FROM ${table} WHERE user_id = ? AND status = 'published'`,
        [userId]
      ).catch(() => ({ c: 0 }))
    )
  );
  return counts.reduce((total, row) => total + Number(row?.c ?? 0), 0);
}

export interface ActiveLimitResult {
  allowed: boolean;
  limit: number;
  used: number;
}

/**
 * Checked when a document becomes public. Re-publishing an already published
 * document does not consume another slot, so callers pass `alreadyPublished`.
 */
async function planFor(env: Bindings, userId: string): Promise<string> {
  const row = await tursoQuery(env, `SELECT plan FROM users WHERE id = ? LIMIT 1`, [userId]);
  return String(row.rows[0]?.plan ?? 'free');
}

export async function checkActiveDocumentLimit(
  env: Bindings,
  userId: string,
  alreadyPublished = false
): Promise<ActiveLimitResult> {
  const plan = await planFor(env, userId);
  const limit = ACTIVE_DOCUMENT_LIMIT[plan as keyof typeof ACTIVE_DOCUMENT_LIMIT] ?? 5;
  const used = await countActiveDocuments(env, userId);
  if (alreadyPublished) return { allowed: true, limit, used };
  return { allowed: used < limit, limit, used };
}

export function activeDocumentLimitBody(result: ActiveLimitResult) {
  return {
    error: 'plan_limit_reached',
    message: `Your plan allows ${result.limit} active documents. Archive one to publish another.`,
    details: { limit: result.limit, used: result.used },
  };
}

/** A form with branching rules is an adaptive form. */
export function branchingIsSet(value: unknown): boolean {
  const parsed = typeof value === 'string' ? parseJsonText(value) : value;
  if (!parsed) return false;
  if (Array.isArray(parsed)) return parsed.length > 0;
  if (typeof parsed === 'object') return Object.keys(parsed as Record<string, unknown>).length > 0;
  return false;
}

function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Checked when a form gains its first branching rule. */
export async function checkAdaptiveFormLimit(
  env: Bindings,
  userId: string,
  alreadyAdaptive = false,
  excludeFormId?: string
): Promise<ActiveLimitResult> {
  const plan = await planFor(env, userId);
  const limit = ADAPTIVE_FORM_LIMIT[plan as keyof typeof ADAPTIVE_FORM_LIMIT] ?? 0;
  if (alreadyAdaptive) return { allowed: true, limit, used: 0 };
  const rows = await dbQuery<{ id: string; branching: string }>(
    env,
    `SELECT id, branching FROM forms WHERE user_id = ? AND status != 'archived'`,
    [userId]
  ).catch(() => []);
  const used = rows.filter((row) => row.id !== excludeFormId && branchingIsSet(row.branching)).length;
  return { allowed: used < limit, limit, used };
}
