import { tursoQuery, tursoExecute } from '../utils/turso';
import { dbQuery, dbRun } from '../utils/db';
import type { Bindings } from '../types';

export async function runRetention(env: Bindings): Promise<void> {
  const now = new Date().toISOString();

  // Draft retention
  const drafts = await dbQuery(
    env,
    `SELECT id, user_id FROM proposals WHERE status = 'draft' AND draft_retention_days IS NOT NULL
     AND datetime(draft_created_at, '+' || draft_retention_days || ' days') < datetime(?)`,
    [now]
  );
  for (const d of drafts as any[]) {
    await dbRun(env, `DELETE FROM proposals WHERE id = ?`, [d.id]);
  }

  // Archive retention
  const archived = await dbQuery(
    env,
    `SELECT id FROM proposals WHERE status = 'archived' AND archive_deletion_date IS NOT NULL AND archive_deletion_date < ?`,
    [now]
  );
  for (const a of archived as any[]) {
    await dbRun(env, `DELETE FROM proposals WHERE id = ?`, [a.id]);
  }

  // 5-day tracking aggregation
  const visits = await dbQuery(
    env,
    `SELECT document_type, document_id, SUM(time_spent_seconds) as total FROM document_visits WHERE retention_until < ? GROUP BY document_type, document_id`,
    [now]
  );
  for (const v of visits as any[]) {
    const table = v.document_type === 'proposal' ? 'proposals' : v.document_type === 'contract' ? 'contracts' : v.document_type === 'invoice' ? 'invoices' : 'forms';
    await dbRun(env, `UPDATE ${table} SET total_time_spent_seconds = COALESCE(total_time_spent_seconds, 0) + ? WHERE id = ?`, [v.total ?? 0, v.document_id]);
  }
  await dbRun(env, `DELETE FROM document_visits WHERE retention_until < ?`, [now]);
  await dbRun(env, `DELETE FROM document_events WHERE retention_until < ?`, [now]);

  // 90-day notifications
  await tursoExecute(env, `DELETE FROM notifications WHERE created_at < datetime('now', '-90 days')`);

  // 3-month saved FAQs
  await dbRun(env, `DELETE FROM saved_faqs WHERE last_used_at IS NOT NULL AND last_used_at < datetime('now', '-3 months')`);

  // 3-month saved packages
  await dbRun(env, `DELETE FROM saved_packages WHERE last_used_at IS NOT NULL AND last_used_at < datetime('now', '-3 months')`);

  // 5-day account deletion
  const deleted = await tursoQuery(env, `SELECT id FROM users WHERE deletion_requested_at IS NOT NULL AND deletion_requested_at < datetime('now', '-5 days')`);
  for (const u of deleted.rows as any[]) {
    await tursoExecute(env, `DELETE FROM users WHERE id = ?`, [u.id]);
  }
}
