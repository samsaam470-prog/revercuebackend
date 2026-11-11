import { Hono } from 'hono';
import { createAdminToken, adminAuthMiddleware } from '../middleware/admin-auth';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { dbQuery } from '../utils/db';
import { generateId } from '../utils/ids';
import type { Bindings } from '../types';

const admin = new Hono<{ Bindings: Bindings }>();

admin.post('/login', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (b.username !== c.env.ADMIN_USER || b.password !== c.env.ADMIN_PASS) return c.json({ error: 'invalid_credentials' }, 401);
  return c.json({ success: true, token: await createAdminToken(b.username, c.env.ADMIN_JWT_KEY) });
});

admin.use('*', adminAuthMiddleware);

admin.get('/overview', async (c) => {
  const total = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM users`);
  const paid = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM users WHERE plan IN ('starter','growth','scale','teams')`);
  const waitlist = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM waitlist WHERE status = 'pending'`);
  const beta = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM beta_testers WHERE status = 'new'`);
  const contact = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM contact_messages WHERE status = 'new'`);
  const revenue = await tursoQuery(c.env, `SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'paid'`);
  return c.json({ total_users: Number(total.rows[0]?.c ?? 0), paid_users: Number(paid.rows[0]?.c ?? 0), waitlist_pending: Number(waitlist.rows[0]?.c ?? 0), beta_testers_new: Number(beta.rows[0]?.c ?? 0), contact_messages_new: Number(contact.rows[0]?.c ?? 0), total_revenue: Number(revenue.rows[0]?.total ?? 0) });
});

admin.get('/users', async (c) => {
  const plan = c.req.query('plan');
  const search = c.req.query('search') ?? '';
  let sql = `SELECT id, email, name, plan, newsletter_opt_in, formsubmit_activated, created_at, last_login_at FROM users WHERE (email LIKE ? OR name LIKE ?)`;
  const args: any[] = [`%${search}%`, `%${search}%`];
  if (plan) { sql += ` AND plan = ?`; args.push(plan); }
  sql += ` ORDER BY created_at DESC LIMIT 100`;
  const rows = await tursoQuery(c.env, sql, args);
  return c.json({ data: rows.rows });
});

admin.get('/users/:id', async (c) => {
  const row = await tursoQuery(c.env, `SELECT * FROM users WHERE id = ?`, [c.req.param('id')]);
  if (row.rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const payments = await tursoQuery(c.env, `SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC`, [c.req.param('id')]);
  const feedback = await tursoQuery(c.env, `SELECT * FROM feedback WHERE user_id = ?`, [c.req.param('id')]);
  const notes = await tursoQuery(c.env, `SELECT * FROM admin_notes WHERE target_type = 'user' AND target_id = ?`, [c.req.param('id')]);
  return c.json({ user: row.rows[0], payments: payments.rows, feedback: feedback.rows, notes: notes.rows });
});

admin.patch('/users/:id/plan', async (c) => {
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE users SET plan = ?, plan_expires_at = ?, updated_at = ? WHERE id = ?`, [b.plan, b.expires_at ?? null, new Date().toISOString(), c.req.param('id')]);
  if (b.plan !== 'free') {
    await tursoExecute(c.env, `INSERT INTO payments (id, user_id, plan, amount, currency, method, reference, status, paid_at, created_at) VALUES (?, ?, ?, ?, 'USD', 'payoneer', ?, 'paid', ?, ?)`, [generateId('pay'), c.req.param('id'), b.plan, b.amount ?? 0, b.reference ?? null, new Date().toISOString(), new Date().toISOString()]);
  }
  return c.json({ success: true });
});

admin.delete('/users/:id', async (c) => {
  await tursoExecute(c.env, `DELETE FROM users WHERE id = ?`, [c.req.param('id')]);
  return c.json({ success: true });
});

admin.get('/waitlist', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM waitlist ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.patch('/waitlist/:id/status', async (c) => {
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE waitlist SET status = ?, invited_at = COALESCE(?, invited_at), paid_at = COALESCE(?, paid_at) WHERE id = ?`, [b.status, b.status === 'invited' ? new Date().toISOString() : null, b.status === 'paid' ? new Date().toISOString() : null, c.req.param('id')]);
  return c.json({ success: true });
});

admin.get('/beta-testers', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM beta_testers ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.patch('/beta-testers/:id/status', async (c) => {
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE beta_testers SET status = ? WHERE id = ?`, [b.status, c.req.param('id')]);
  return c.json({ success: true });
});

admin.get('/contact-messages', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.patch('/contact-messages/:id/status', async (c) => {
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE contact_messages SET status = ? WHERE id = ?`, [b.status, c.req.param('id')]);
  return c.json({ success: true });
});

admin.get('/website-help', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM website_help_requests ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.patch('/website-help/:id/status', async (c) => {
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE website_help_requests SET status = ? WHERE id = ?`, [b.status, c.req.param('id')]);
  return c.json({ success: true });
});

admin.get('/payments', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM payments ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.get('/feedback', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM feedback ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.patch('/feedback/:id/status', async (c) => {
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE feedback SET status = ? WHERE id = ?`, [b.status, c.req.param('id')]);
  return c.json({ success: true });
});

admin.get('/templates', async (c) => {
  const rows = await dbQuery(c.env, `SELECT * FROM templates ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows });
});

admin.get('/suggestions/instructions', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM instructions ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.post('/suggestions/instructions', async (c) => {
  const b = await c.req.json();
  if (!b.name || !b.body || !b.action) return c.json({ error: 'invalid_payload' }, 400);
  const id = generateId('ins');
  await tursoExecute(c.env, `INSERT INTO instructions (id, name, body, action, tags, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`, [id, b.name, b.body, b.action, JSON.stringify(b.tags ?? []), new Date().toISOString(), new Date().toISOString()]);
  return c.json({ success: true, id }, 201);
});

admin.get('/suggestions/patterns', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM patterns ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.post('/suggestions/patterns', async (c) => {
  const b = await c.req.json();
  if (!b.name || !b.rule) return c.json({ error: 'invalid_payload' }, 400);
  const id = generateId('pat');
  await tursoExecute(c.env, `INSERT INTO patterns (id, name, rule, tags, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`, [id, b.name, JSON.stringify(b.rule), JSON.stringify(b.tags ?? []), new Date().toISOString(), new Date().toISOString()]);
  return c.json({ success: true, id }, 201);
});

admin.get('/suggestions/pairings', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM pairings ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.post('/suggestions/pairings', async (c) => {
  const b = await c.req.json();
  if (!b.pattern_id || !b.instruction_id) return c.json({ error: 'invalid_payload' }, 400);
  const id = generateId('pair');
  await tursoExecute(c.env, `INSERT INTO pairings (id, pattern_id, instruction_id, plan, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`, [id, b.pattern_id, b.instruction_id, b.plan ?? 'growth', b.priority ?? 1, new Date().toISOString(), new Date().toISOString()]);
  return c.json({ success: true, id }, 201);
});

admin.get('/health', async (c) => {
  const errors = await tursoQuery(c.env, `SELECT * FROM error_logs ORDER BY created_at DESC LIMIT 20`);
  return c.json({ errors: errors.rows });
});

admin.get('/notes', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM admin_notes ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.post('/notes', async (c) => {
  const b = await c.req.json();
  if (!b.note) return c.json({ error: 'invalid_payload' }, 400);
  const id = generateId('note');
  await tursoExecute(c.env, `INSERT INTO admin_notes (id, admin_user_id, target_type, target_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [id, 'admin', b.target_type ?? 'general', b.target_id ?? null, b.note, new Date().toISOString()]);
  return c.json({ success: true, id }, 201);
});

export default admin;
