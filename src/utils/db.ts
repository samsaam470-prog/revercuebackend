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

export async function dbBatch(
  env: Bindings,
  statements: D1PreparedStatement[]
): Promise<void> {
  if (statements.length === 0) return;
  await env.DB.batch(statements);
}
