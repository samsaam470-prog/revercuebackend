import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Loaded through require so Vite does not try to resolve a Node built-in.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * Minimal D1-shaped adapter over node:sqlite so the collaboration services can
 * be tested against real SQL and real migrations instead of mocks. Only the
 * methods the application uses are implemented.
 */
export function createTestDb() {
  const db = new DatabaseSync(':memory:');

  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...bindArgs: unknown[]) => statement(sql, bindArgs),
    first: async <T = any>() => (db.prepare(sql).get(...(args as any[])) as T) ?? null,
    all: async <T = any>() => ({ results: db.prepare(sql).all(...(args as any[])) as T[], success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...(args as any[]));
      return { success: true, meta: {} };
    },
  });

  const D1 = {
    prepare: (sql: string) => statement(sql, []),
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };

  return { db, D1 };
}

export function applyMigration(db: DatabaseSync, file: string) {
  const sql = readFileSync(resolve(process.cwd(), 'migrations', file), 'utf8');
  db.exec(sql);
}

/** Minimal document tables so the adapter has something real to read and write. */
export function applyDocumentTables(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT, status TEXT NOT NULL DEFAULT 'draft', public_id TEXT, updated_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT, status TEXT NOT NULL DEFAULT 'draft', public_id TEXT, updated_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL, invoice_number TEXT,
      line_items TEXT, notes TEXT, currency TEXT, tax INTEGER, total INTEGER, due_date TEXT,
      payment_arrangement TEXT, status TEXT NOT NULL DEFAULT 'draft', updated_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS forms (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT, title TEXT NOT NULL, description TEXT,
      questions TEXT, branching TEXT, thank_you_config TEXT, status TEXT NOT NULL DEFAULT 'draft',
      updated_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
}
