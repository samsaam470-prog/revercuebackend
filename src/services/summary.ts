import { dbFirst, dbRun, dbQuery } from '../utils/db';
import { createNotification } from './notifications';
import { generateId } from '../utils/ids';
import type { Bindings } from '../types';

export async function scheduleSummary(env: Bindings, clientId: string, userId: string): Promise<void> {
  const existing = await dbFirst<{ id: string }>(
    env,
    `SELECT id FROM summary_jobs WHERE client_id = ? AND status IN ('pending','running') LIMIT 1`,
    [clientId]
  );
  if (existing) return;

  const runAt = new Date(Date.now() + 15 * 86400000).toISOString();
  const now = new Date().toISOString();
  await dbRun(
    env,
    `INSERT INTO summary_jobs (id, client_id, user_id, run_at, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
    [generateId('job'), clientId, userId, runAt, now]
  );
  await dbRun(env, `UPDATE clients SET summary_scheduled_at = ? WHERE id = ?`, [runAt, clientId]);
}

export async function generateSummary(env: Bindings, clientId: string): Promise<{ summary: string; generated_at: string }> {
  const client = await dbFirst<any>(env, `SELECT * FROM clients WHERE id = ?`, [clientId]);
  if (!client) throw new Error('Client not found');

  const docs = await dbQuery<any>(
    env,
    `SELECT 'proposal' as type, title, status, created_at FROM proposals WHERE client_id = ?
     UNION ALL SELECT 'contract', title, status, created_at FROM contracts WHERE client_id = ?
     UNION ALL SELECT 'form', title, status, created_at FROM forms WHERE client_id = ?
     UNION ALL SELECT 'invoice', invoice_number, status, created_at FROM invoices WHERE client_id = ?`,
    [clientId, clientId, clientId, clientId]
  );

  const log = await dbQuery<any>(
    env,
    `SELECT entry_type, message_text, created_at FROM communication_log WHERE client_id = ? ORDER BY created_at DESC LIMIT 10`,
    [clientId]
  );

  const parts: string[] = [];
  parts.push(`${client.name} is a ${client.industry ?? 'business'} business.`);
  if (client.value_prop) parts.push(`They focus on ${client.value_prop}.`);

  const paidCount = docs.filter((d) => d.status === 'confirmed' || d.status === 'paid').length;
  const approvedCount = docs.filter((d) => d.status === 'approved').length;
  parts.push(`Over the relationship, we created ${docs.length} document${docs.length === 1 ? '' : 's'}.`);
  if (approvedCount > 0) parts.push(`${approvedCount} contract${approvedCount === 1 ? ' was' : 's were'} approved.`);
  if (paidCount > 0) parts.push(`${paidCount} invoice${paidCount === 1 ? ' was' : 's were'} paid.`);
  if (log.length > 0 && log[0].message_text) {
    parts.push(`The last conversation was about: ${String(log[0].message_text).slice(0, 100)}.`);
  }

  const summary = parts.join(' ');
  const generatedAt = new Date().toISOString();
  await dbRun(env, `UPDATE clients SET summary = ?, summary_generated_at = ? WHERE id = ?`, [summary, generatedAt, clientId]);

  await createNotification(env, {
    userId: client.user_id,
    eventType: 'system_summary_ready',
    clientId,
    title: `Summary ready for ${client.name}`,
    body: 'The client summary is ready. Open the client record to read it.',
  });

  return { summary, generated_at: generatedAt };
}

export async function processDueJobs(env: Bindings): Promise<{ processed: number; failed: number }> {
  const now = new Date().toISOString();
  const jobs = await dbQuery<{ id: string; client_id: string }>(
    env,
    `SELECT id, client_id FROM summary_jobs WHERE status = 'pending' AND run_at <= ? LIMIT 50`,
    [now]
  );
  let processed = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await dbRun(env, `UPDATE summary_jobs SET status = 'running' WHERE id = ?`, [job.id]);
      await generateSummary(env, job.client_id);
      await dbRun(env, `UPDATE summary_jobs SET status = 'done', completed_at = ? WHERE id = ?`, [new Date().toISOString(), job.id]);
      processed++;
    } catch (err: any) {
      await dbRun(env, `UPDATE summary_jobs SET status = 'failed', error = ? WHERE id = ?`, [err.message ?? 'unknown', job.id]);
      failed++;
    }
  }
  return { processed, failed };
}
