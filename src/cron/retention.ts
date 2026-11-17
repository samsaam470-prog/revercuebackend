import { tursoQuery, tursoExecute } from '../utils/turso';
import { dbQuery, dbRun } from '../utils/db';
import { processRetention } from '../services/retention';
import { pruneEmailDeliveries } from '../services/email';
import { DELETION_GRACE_DAYS, NOTIFICATION_RETENTION_DAYS, TRACKING_RETENTION_DAYS } from '../config/constants';
import type { Bindings } from '../types';

/**
 * Hourly retention run.
 *
 * Order matters: the retention lifecycle (warn → deliver → delete) runs first,
 * then housekeeping. Every step is isolated so one failure cannot stop the rest.
 */
export async function runRetention(env: Bindings): Promise<void> {
  const now = new Date();

  try {
    const summary = await processRetention(env, now);
    if (summary.evaluated > 0 || summary.failures > 0) {
      console.log('RETENTION_RUN', JSON.stringify(summary));
    }
  } catch (error) {
    console.error('RETENTION_LIFECYCLE_ERROR', error);
  }

  // --- Tracking aggregation and prune ---------------------------------------
  try {
    const cutoff = new Date(now.getTime() - TRACKING_RETENTION_DAYS * 86400000).toISOString();
    const visits = await dbQuery<any>(
      env,
      `SELECT document_type, document_id, SUM(time_spent_seconds) as total
       FROM document_visits WHERE retention_until < ? GROUP BY document_type, document_id`,
      [cutoff]
    );
    const tableFor: Record<string, string> = {
      proposal: 'proposals',
      contract: 'contracts',
      invoice: 'invoices',
      form: 'forms',
    };
    for (const visit of visits) {
      const table = tableFor[String(visit.document_type)];
      if (!table) continue;
      await dbRun(
        env,
        `UPDATE ${table} SET total_time_spent_seconds = COALESCE(total_time_spent_seconds, 0) + ? WHERE id = ?`,
        [Number(visit.total ?? 0), visit.document_id]
      ).catch(() => undefined);
    }
    await dbRun(env, `DELETE FROM document_visits WHERE retention_until < ?`, [cutoff]);
    await dbRun(env, `DELETE FROM document_events WHERE retention_until < ?`, [cutoff]);
    await dbRun(
      env,
      `DELETE FROM document_visit_meta WHERE visit_id NOT IN (SELECT id FROM document_visits)`
    ).catch(() => undefined);
  } catch (error) {
    console.error('TRACKING_RETENTION_ERROR', error);
  }

  // --- Notifications ---------------------------------------------------------
  try {
    const cutoff = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 86400000).toISOString();
    await tursoExecute(env, `DELETE FROM notifications WHERE created_at < ?`, [cutoff]);
  } catch (error) {
    console.error('NOTIFICATION_RETENTION_ERROR', error);
  }

  // --- Saved FAQs and packages ----------------------------------------------
  try {
    await dbRun(env, `DELETE FROM saved_faqs WHERE last_used_at IS NOT NULL AND last_used_at < datetime('now', '-3 months')`);
    await dbRun(env, `DELETE FROM saved_packages WHERE last_used_at IS NOT NULL AND last_used_at < datetime('now', '-3 months')`);
  } catch (error) {
    console.error('SAVED_ITEM_RETENTION_ERROR', error);
  }

  // --- Email delivery log ----------------------------------------------------
  await pruneEmailDeliveries(env, 30).catch((error) => console.error('EMAIL_PRUNE_ERROR', error));

  // --- Account deletion after the grace period ------------------------------
  try {
    const cutoff = new Date(now.getTime() - DELETION_GRACE_DAYS * 86400000).toISOString();
    const users = await tursoQuery(
      env,
      `SELECT id FROM users WHERE deletion_requested_at IS NOT NULL AND deletion_requested_at < ?`,
      [cutoff]
    );
    for (const user of users.rows as any[]) {
      const userId = String(user.id);
      // D1 data is removed first so a failure leaves the account recoverable.
      for (const table of ['proposals', 'contracts', 'forms', 'invoices', 'clients']) {
        await dbRun(env, `DELETE FROM ${table} WHERE user_id = ?`, [userId]).catch((error) =>
          console.error('ACCOUNT_DATA_DELETE_FAILED', table, userId, error)
        );
      }
      await tursoExecute(env, `DELETE FROM user_identities WHERE user_id = ?`, [userId]).catch(() => undefined);
      await tursoExecute(env, `DELETE FROM sessions WHERE user_id = ?`, [userId]).catch(() => undefined);
      await tursoExecute(env, `DELETE FROM notifications WHERE user_id = ?`, [userId]).catch(() => undefined);
      await tursoExecute(env, `DELETE FROM users WHERE id = ?`, [userId]);
    }
  } catch (error) {
    console.error('ACCOUNT_DELETION_ERROR', error);
  }
}
