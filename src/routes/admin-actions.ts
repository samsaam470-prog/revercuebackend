import { Hono } from 'hono';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { dbQuery, dbRun } from '../utils/db';
import { generateId } from '../utils/ids';
import { adminAuthMiddleware } from '../middleware/admin-auth';
import type { Bindings } from '../types';

const adminActions = new Hono<{ Bindings: Bindings }>();
adminActions.use('*', adminAuthMiddleware);

adminActions.post('/waitlist/:id/invite', async (c) => {
  const row = await tursoQuery(c.env, `SELECT email, plan_requested FROM waitlist WHERE id = ?`, [c.req.param('id')]);
  if (row.rows.length === 0) return c.json({ error: 'not_found' }, 404);
  await tursoExecute(c.env, `UPDATE waitlist SET status = 'invited', invited_at = ? WHERE id = ?`, [new Date().toISOString(), c.req.param('id')]);
  return c.json({ success: true, email: row.rows[0].email, plan: row.rows[0].plan_requested });
});

adminActions.post('/waitlist/:id/mark-paid', async (c) => {
  const b = await c.req.json();
  const row = await tursoQuery(c.env, `SELECT email, plan_requested FROM waitlist WHERE id = ?`, [c.req.param('id')]);
  if (row.rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const email = String(row.rows[0].email).toLowerCase();
  const plan = b.plan ?? row.rows[0].plan_requested ?? 'starter';
  const user = await tursoQuery(c.env, `SELECT id FROM users WHERE email = ?`, [email]);
  if (user.rows.length === 0) return c.json({ error: 'user_not_found', message: 'The user has not signed up yet.' }, 404);
  const userId = user.rows[0].id;
  await tursoExecute(c.env, `UPDATE users SET plan = ?, plan_expires_at = ?, updated_at = ? WHERE id = ?`, [plan, new Date(Date.now() + 30 * 86400000).toISOString(), new Date().toISOString(), userId]);
  await tursoExecute(c.env, `INSERT INTO payments (id, user_id, plan, amount, currency, method, reference, status, paid_at, created_at) VALUES (?, ?, ?, ?, 'USD', 'payoneer', ?, 'paid', ?, ?)`, [generateId('pay'), userId, plan, b.amount ?? 0, b.reference ?? null, new Date().toISOString(), new Date().toISOString()]);
  await tursoExecute(c.env, `UPDATE waitlist SET status = 'paid', paid_at = ? WHERE id = ?`, [new Date().toISOString(), c.req.param('id')]);
  return c.json({ success: true });
});

adminActions.post('/upgrade-requests/:id/confirm', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const req = await tursoQuery(c.env, `SELECT user_id, plan_requested FROM payment_requests WHERE id = ?`, [c.req.param('id')]);
  if (req.rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const userId = req.rows[0].user_id;
  const plan = b.plan ?? req.rows[0].plan_requested;
  const now = new Date().toISOString();
  await tursoExecute(c.env, `UPDATE users SET plan = ?, plan_expires_at = ?, updated_at = ? WHERE id = ?`, [plan, new Date(Date.now() + 30 * 86400000).toISOString(), now, userId]);
  await tursoExecute(c.env, `INSERT INTO payments (id, user_id, plan, amount, currency, method, reference, status, paid_at, created_at) VALUES (?, ?, ?, ?, 'USD', 'payoneer', ?, 'paid', ?, ?)`, [generateId('pay'), userId, plan, b.amount ?? 0, b.reference ?? null, now, now]);
  await tursoExecute(c.env, `UPDATE payment_requests SET status = 'confirmed' WHERE id = ?`, [c.req.param('id')]);
  return c.json({ success: true, user_id: userId, plan });
});

adminActions.get('/upgrade-requests', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM payment_requests WHERE status = 'pending' ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});
adminActions.post('/payments', async (c) => {
  const b = await c.req.json();
  if (!b.user_id || !b.amount) return c.json({ error: 'invalid_payload' }, 400);
  const id = generateId('pay');
  await tursoExecute(c.env, `INSERT INTO payments (id, user_id, plan, amount, currency, method, reference, status, paid_at, created_at) VALUES (?, ?, ?, ?, ?, 'payoneer', ?, ?, ?, ?)`, [id, b.user_id, b.plan ?? null, b.amount, b.currency ?? 'USD', b.reference ?? null, b.status ?? 'paid', b.paid_at ?? new Date().toISOString(), new Date().toISOString()]);
  return c.json({ success: true, id }, 201);
});

adminActions.post('/templates/upload', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'] as File;
  const name = String(body['name'] ?? '').trim();
  const type = String(body['type'] ?? 'proposal');
  if (!file || !name) return c.json({ error: 'invalid_payload' }, 400);
  const { uploadToB2 } = await import('../services/storage');
  const { sanitizeHtml } = await import('../services/storage');
  const html = await file.text();
  const sanitized = sanitizeHtml(html);
  const key = `templates/${Date.now()}-${name.replace(/[^a-z0-9]/gi, '_')}.html`;
  const ok = await uploadToB2(c.env, key, new TextEncoder().encode(sanitized).buffer as ArrayBuffer, 'text/html');
  if (!ok) return c.json({ error: 'upload_failed' }, 500);
  const id = generateId('tpl');
  const now = new Date().toISOString();
  await dbRun(c.env, `INSERT INTO templates (id, name, type, tags, b2_key, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'built_in', 'active', ?, ?)`, [id, name, type, JSON.stringify(body['tags'] ? String(body['tags']).split(',') : []), key, now, now]);
  return c.json({ success: true, id, b2_key: key }, 201);
});

adminActions.get('/payments/:id/receipt', async (c) => {
  const row = await tursoQuery(c.env, `SELECT * FROM payments WHERE id = ?`, [c.req.param('id')]);
  if (row.rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const p = row.rows[0];
  const { buildPdf } = await import('../services/pdf-binary');
  const bytes = await buildPdf(`Receipt ${p.id}`, [
    { heading: 'Payment', body: `${p.amount} ${p.currency ?? 'USD'} — ${p.status}` },
    { heading: 'Reference', body: String(p.reference ?? '—') },
    { heading: 'Date', body: String(p.paid_at ?? p.created_at) },
  ]);
  return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="receipt-${p.id}.pdf"` } });
});
adminActions.post('/templates', async (c) => {
  const b = await c.req.json();
  if (!b.name || !b.type) return c.json({ error: 'invalid_payload' }, 400);
  const id = generateId('tpl');
  const now = new Date().toISOString();
  await dbRun(c.env, `INSERT INTO templates (id, name, type, tags, b2_key, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'built_in', 'active', ?, ?)`, [id, b.name, b.type, JSON.stringify(b.tags ?? []), b.b2_key ?? null, now, now]);
  return c.json({ success: true, id }, 201);
});

adminActions.patch('/templates/:id', async (c) => {
  const b = await c.req.json();
  await dbRun(c.env, `UPDATE templates SET name = COALESCE(?, name), tags = COALESCE(?, tags), status = COALESCE(?, status), updated_at = ? WHERE id = ?`, [b.name ?? null, b.tags ? JSON.stringify(b.tags) : null, b.status ?? null, new Date().toISOString(), c.req.param('id')]);
  return c.json({ success: true });
});

adminActions.delete('/templates/:id', async (c) => {
  await dbRun(c.env, `DELETE FROM templates WHERE id = ?`, [c.req.param('id')]);
  return c.json({ success: true });
});

adminActions.post('/health/retry-email/:id', async (c) => {
  return c.json({ success: true, note: 'Email retry is a no-op in this build. The FormSubmit send is already retried by the email-notify service.' });
});

adminActions.post('/health/run-cron/:job', async (c) => {
  const job = c.req.param('job');
  if (job === 'retention') { const { runRetention } = await import('../cron/retention'); await runRetention(c.env); return c.json({ success: true, job }); }
  if (job === 'summary') { const { processDueJobs } = await import('../services/summary'); const r = await processDueJobs(c.env); return c.json({ success: true, job, ...r }); }
  if (job === 'proof-cleanup') { const { runProofCleanup } = await import('../cron/pdf-cleanup'); await runProofCleanup(c.env); return c.json({ success: true, job }); }
  return c.json({ error: 'invalid_job' }, 400);
});

adminActions.patch('/notes/:id', async (c) => {
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE admin_notes SET note = COALESCE(?, note) WHERE id = ?`, [b.note ?? null, c.req.param('id')]);
  return c.json({ success: true });
});

adminActions.delete('/notes/:id', async (c) => {
  await tursoExecute(c.env, `DELETE FROM admin_notes WHERE id = ?`, [c.req.param('id')]);
  return c.json({ success: true });
});

export default adminActions;


