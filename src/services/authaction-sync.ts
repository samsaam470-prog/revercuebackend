import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import {
  listManagementUsers,
  isManagementConfigured,
  type AuthActionManagementUser,
} from './authaction-management';
import type { Bindings } from '../types';

const PAGE_SIZE = 100;

export interface SyncResult {
  runId: string;
  status: 'success' | 'failed';
  totalFetched: number;
  upserted: number;
  error?: string;
}

async function upsertIdentity(env: Bindings, user: AuthActionManagementUser, syncedAt: string): Promise<void> {
  // Derive linked Revercue user from user_identities (stable sub match).
  const linkRows = await tursoQuery(
    env,
    `SELECT user_id FROM user_identities WHERE provider = 'authaction' AND subject = ? LIMIT 1`,
    [user.id]
  );
  const linkedUserId = linkRows.rows.length > 0 ? String(linkRows.rows[0].user_id) : null;

  await tursoExecute(
    env,
    `INSERT INTO authaction_identities
      (id, email, name, email_verified, is_blocked, connection, applications, roles, tenant,
       authaction_created_at, authaction_updated_at, synced_at, linked_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email,
       name = excluded.name,
       email_verified = excluded.email_verified,
       is_blocked = excluded.is_blocked,
       connection = excluded.connection,
       applications = excluded.applications,
       roles = excluded.roles,
       tenant = excluded.tenant,
       authaction_created_at = excluded.authaction_created_at,
       authaction_updated_at = excluded.authaction_updated_at,
       synced_at = excluded.synced_at,
       linked_user_id = excluded.linked_user_id,
       updated_at = excluded.updated_at`,
    [
      user.id,
      user.email || null,
      user.name || null,
      user.emailVerified ? 1 : 0,
      user.isBlocked ? 1 : 0,
      user.connection,
      JSON.stringify(user.applications),
      JSON.stringify(user.roles),
      user.tenant,
      user.createdAt,
      user.updatedAt,
      syncedAt,
      linkedUserId,
      syncedAt,
      syncedAt,
    ]
  );
}

export async function runAuthActionSync(env: Bindings, triggeredBy = 'manual'): Promise<SyncResult> {
  const runId = generateId('sync');
  const startedAt = new Date().toISOString();
  await tursoExecute(
    env,
    `INSERT INTO authaction_sync_runs (id, status, started_at, triggered_by) VALUES (?, 'running', ?, ?)`,
    [runId, startedAt, triggeredBy]
  );

  let totalFetched = 0;
  let upserted = 0;
  try {
    if (!isManagementConfigured(env)) {
      throw new Error('AuthAction Management API is not configured.');
    }
    const syncedAt = new Date().toISOString();
    let page = 0;
    // Safety cap to avoid runaway loops.
    const MAX_PAGES = 1000;
    while (page < MAX_PAGES) {
      const result = await listManagementUsers(env, { page, limit: PAGE_SIZE });
      const items = result.items;
      if (items.length === 0) break;
      totalFetched += items.length;
      for (const user of items) {
        await upsertIdentity(env, user, syncedAt);
        upserted += 1;
      }
      const totalPages = result.meta.totalPages || 1;
      page += 1;
      if (page >= totalPages) break;
    }

    const finishedAt = new Date().toISOString();
    await tursoExecute(
      env,
      `UPDATE authaction_sync_runs SET status = 'success', finished_at = ?, total_fetched = ?, upserted = ? WHERE id = ?`,
      [finishedAt, totalFetched, upserted, runId]
    );
    return { runId, status: 'success', totalFetched, upserted };
  } catch (error: any) {
    const finishedAt = new Date().toISOString();
    const msg = String(error?.message ?? error).slice(0, 1000);
    await tursoExecute(
      env,
      `UPDATE authaction_sync_runs SET status = 'failed', finished_at = ?, total_fetched = ?, upserted = ?, error = ? WHERE id = ?`,
      [finishedAt, totalFetched, upserted, msg, runId]
    ).catch(() => undefined);
    return { runId, status: 'failed', totalFetched, upserted, error: msg };
  }
}

export async function getLastSyncStatus(env: Bindings): Promise<any> {
  const rows = await tursoQuery(
    env,
    `SELECT * FROM authaction_sync_runs ORDER BY started_at DESC LIMIT 1`
  );
  if (rows.rows.length === 0) return null;
  const r = rows.rows[0];
  return {
    id: r.id,
    status: r.status,
    started_at: r.started_at,
    finished_at: r.finished_at,
    total_fetched: Number(r.total_fetched ?? 0),
    upserted: Number(r.upserted ?? 0),
    error: r.error,
    triggered_by: r.triggered_by,
  };
}

export async function getIdentityCounts(env: Bindings): Promise<{
  total: number;
  linked: number;
  unlinked: number;
}> {
  const total = await tursoQuery(env, `SELECT COUNT(*) as c FROM authaction_identities`);
  const linked = await tursoQuery(env, `SELECT COUNT(*) as c FROM authaction_identities WHERE linked_user_id IS NOT NULL`);
  const totalN = Number(total.rows[0]?.c ?? 0);
  const linkedN = Number(linked.rows[0]?.c ?? 0);
  return { total: totalN, linked: linkedN, unlinked: totalN - linkedN };
}