import { tursoQuery } from './turso';
import type { Bindings } from '../types';

/**
 * The legacy Turso tables (contact_messages, waitlist, beta_testers) were
 * created before this repository had migrations, so their exact column set is
 * not knowable from source. Instead of guessing (and failing the insert), the
 * column list is introspected once per isolate and cached.
 */

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;
const columnsCache = new Map<string, { columns: Set<string>; fetchedAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function getTableColumns(env: Bindings, table: string): Promise<Set<string>> {
  if (!TABLE_NAME.test(table)) throw new Error(`Invalid table name: ${table}`);
  const cached = columnsCache.get(table);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.columns;
  const result = await tursoQuery(env, `PRAGMA table_info(${table})`);
  const columns = new Set<string>(result.rows.map((row: any) => String(row.name)));
  columnsCache.set(table, { columns, fetchedAt: Date.now() });
  return columns;
}

export interface DynamicInsertResult {
  inserted: boolean;
  columns: string[];
  /** True when column introspection failed and every supplied column was used. */
  degraded: boolean;
}

/**
 * Inserts a row using only columns that exist on the target table.
 * Values for unknown columns are dropped (and reported) rather than failing the
 * whole write, which is what protects marketing submissions on legacy schemas.
 */
export async function insertDynamic(
  env: Bindings,
  table: string,
  values: Record<string, unknown>
): Promise<DynamicInsertResult> {
  let available: Set<string> | null = null;
  let degraded = false;
  try {
    available = await getTableColumns(env, table);
  } catch (error) {
    degraded = true;
    console.error('TABLE_INTROSPECTION_FAILED', table, error);
  }

  const keys = Object.keys(values).filter((key) => (available ? available.has(key) : true));
  if (keys.length === 0) throw new Error(`No insertable columns for ${table}`);

  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  try {
    await tursoQuery(
      env,
      sql,
      keys.map((key) => values[key] ?? null)
    );
  } catch (error) {
    // A concurrent introspection race or a stale cache: refresh once and retry.
    if (available && !degraded) {
      columnsCache.delete(table);
      const refreshed = await getTableColumns(env, table);
      const retryKeys = Object.keys(values).filter((key) => refreshed.has(key));
      if (retryKeys.length > 0) {
        await tursoQuery(
          env,
          `INSERT INTO ${table} (${retryKeys.join(', ')}) VALUES (${retryKeys.map(() => '?').join(', ')})`,
          retryKeys.map((key) => values[key] ?? null)
        );
        return { inserted: true, columns: retryKeys, degraded: false };
      }
    }
    throw error;
  }

  return { inserted: true, columns: keys, degraded };
}
