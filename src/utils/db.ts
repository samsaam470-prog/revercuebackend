import type { Bindings } from '../types';

export async function dbQuery<T = any>(
  env: Bindings,
  sql: string,
  args: any[] = []
): Promise<T[]> {
  const stmt = env.DB.prepare(sql);
  const bound = args.length > 0 ? stmt.bind(...args) : stmt;
  const { results } = await bound.all<T>();
  return results ?? [];
}

export async function dbFirst<T = any>(
  env: Bindings,
  sql: string,
  args: any[] = []
): Promise<T | null> {
  const stmt = env.DB.prepare(sql);
  const bound = args.length > 0 ? stmt.bind(...args) : stmt;
  const result = await bound.first<T>();
  return result ?? null;
}

export async function dbRun(
  env: Bindings,
  sql: string,
  args: any[] = []
): Promise<void> {
  const stmt = env.DB.prepare(sql);
  const bound = args.length > 0 ? stmt.bind(...args) : stmt;
  await bound.run();
}

/**
 * Runs a statement and returns mutation metadata. Needed wherever the code
 * must know whether an insert actually happened (idempotency guards such as
 * retention warnings and signature de-duplication).
 */
export async function dbRunResult(
  env: Bindings,
  sql: string,
  args: any[] = []
): Promise<{ changes: number; lastRowId: number | null }> {
  const stmt = env.DB.prepare(sql);
  const bound = args.length > 0 ? stmt.bind(...args) : stmt;
  const result = await bound.run();
  const meta = result.meta as { changes?: number; last_row_id?: number } | undefined;
  return { changes: Number(meta?.changes ?? 0), lastRowId: meta?.last_row_id ?? null };
}

export async function dbBatch(
  env: Bindings,
  statements: D1PreparedStatement[]
): Promise<void> {
  if (statements.length === 0) return;
  await env.DB.batch(statements);
}

/** Counts rows for a `SELECT COUNT(*) as c ...` query. */
export async function dbCount(env: Bindings, sql: string, args: any[] = []): Promise<number> {
  const row = await dbFirst<{ c: number }>(env, sql, args);
  return Number(row?.c ?? 0);
}

/** Builds `?, ?, ?` placeholders for an IN clause with bound values. */
export function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(', ');
}
