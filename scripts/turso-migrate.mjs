#!/usr/bin/env node
/**
 * Applies the additive Turso migrations in migrations/turso in filename order.
 *
 * The repository talks to Turso through the libSQL HTTP pipeline (no driver),
 * so this script uses exactly the same mechanism. It never drops or alters a
 * table: migrations only contain CREATE ... IF NOT EXISTS statements.
 *
 * Usage:
 *   TURSO_URL=libsql://... TURSO_TOKEN=... node scripts/turso-migrate.mjs --dry-run
 *   TURSO_URL=libsql://... TURSO_TOKEN=... node scripts/turso-migrate.mjs
 *
 * The token is read from the environment only. Never commit it.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations', 'turso');

const url = process.env.TURSO_URL;
const token = process.env.TURSO_TOKEN;
const dryRun = process.argv.includes('--dry-run');

if (!url || !token) {
  console.error('TURSO_URL and TURSO_TOKEN must be set in the environment.');
  process.exit(1);
}

const httpUrl = url.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '');

async function pipeline(requests) {
  const response = await fetch(`${httpUrl}/v2/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [...requests.map((stmt) => ({ type: 'execute', stmt })), { type: 'close' }],
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Turso HTTP ${response.status}: ${text.slice(0, 500)}`);
  const data = JSON.parse(text);
  const results = data.results ?? [];
  for (const [index, result] of results.entries()) {
    if (result.type === 'error') {
      throw new Error(`Statement ${index} failed: ${JSON.stringify(result.error ?? result)}`);
    }
  }
  return results;
}

async function executeStatement(sql, args = []) {
  return pipeline([{ sql, args: args.map((value) => ({ type: typeof value === 'number' ? 'integer' : 'text', value: String(value) })) }]);
}

function splitStatements(file) {
  const withoutComments = file
    .split('\n')
    .map((line) => (line.trim().startsWith('--') ? '' : line))
    .join('\n');
  return withoutComments
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function main() {
  await executeStatement(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`
  );
  const appliedResult = await pipeline([{ sql: 'SELECT version FROM schema_migrations', args: [] }]);
  const rows = appliedResult[0]?.response?.result?.rows ?? [];
  const cols = appliedResult[0]?.response?.result?.cols ?? [];
  const versionIndex = cols.findIndex((col) => col.name === 'version');
  const applied = new Set(rows.map((row) => String(row[versionIndex]?.value ?? '')));

  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
  let failures = 0;

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) {
      console.log(`skip   ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = splitStatements(sql);
    console.log(`${dryRun ? 'plan  ' : 'apply '} ${file} (${statements.length} statements)`);
    if (dryRun) continue;

    try {
      for (const statement of statements) {
        await executeStatement(statement);
      }
      await executeStatement(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`, [
        version,
        new Date().toISOString(),
      ]);
      console.log(`done   ${file}`);
    } catch (error) {
      failures += 1;
      console.error(`FAILED ${file}: ${error.message}`);
      console.error('Migrations are additive; fix the statement and re-run. Applied versions are recorded, so nothing is repeated.');
      break;
    }
  }

  if (failures > 0) process.exit(1);
  console.log(dryRun ? 'Dry run complete. Nothing was written.' : 'Turso migrations complete.');
}

main().catch((error) => {
  console.error('MIGRATION_FAILED', error.message);
  process.exit(1);
});
