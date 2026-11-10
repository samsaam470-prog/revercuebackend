import { Hono } from 'hono';
import { createAdminToken } from '../middleware/admin-auth';
import { adminAuthMiddleware } from '../middleware/admin-auth';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { dbQuery } from '../utils/db';
import type { Bindings } from '../types';

const admin = new Hono<{ Bindings: Bindings }>();

admin.post('/login', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (b.username !== c.env.ADMIN_USER || b.password !== c.env.ADMIN_PASS) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  const token = await createAdminToken(b.username, c.env.ADMIN_JWT_KEY);
  return c.json({ success: true, token });
});

admin.use('*', adminAuthMiddleware);

admin.get('/overview', async (c) => {
  const totalUsers = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM users`);
  const paidUsers = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM users WHERE plan IN ('starter','growth','scale','teams')`);
  const waitlist = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM waitlist WHERE status = 'pending'`);
  const beta = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM beta_testers WHERE status = 'new'`);
  const contact = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM contact_messages WHERE status = 'new'`);
  return c.json({
    total_users: Number(totalUsers.rows[0]?.c ?? 0),
    paid_users: Number(paidUsers.rows[0]?.c ?? 0),
    waitlist_pending: Number(waitlist.rows[0]?.c ?? 0),
    beta_testers_new: Number(beta.rows[0]?.c ?? 0),
    contact_messages_new: Number(contact.rows[0]?.c ?? 0),
  });
});

admin.get('/users', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT id, email, name, plan, newsletter_opt_in, formsubmit_activated, created_at, last_login_at FROM users ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.get('/users/:id', async (c) => {
  const row = await tursoQuery(c.env, `SELECT * FROM users WHERE id = ?`, [c.req.param('id')]);
  return c.json({ user: row.rows[0] });
});

admin.patch('/users/:id/plan', async (c) => {
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE users SET plan = ?, plan_expires_at = ?, updated_at = ? WHERE id = ?`, [b.plan, b.expires_at ?? null, new Date().toISOString(), c.req.param('id')]);
  return c.json({ success: true });
});

admin.get('/waitlist', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM waitlist ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.get('/beta-testers', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM beta_testers ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.get('/contact-messages', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.get('/website-help', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM website_help_requests ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.get('/payments', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM payments ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.get('/feedback', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM feedback ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

admin.get('/templates', async (c) => {
  const rows = await dbQuery(c.env, `SELECT * FROM templates ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows });
});

admin.get('/health', async (c) => {
  const errors = await tursoQuery(c.env, `SELECT * FROM error_logs ORDER BY created_at DESC LIMIT 20`);
  return c.json({ errors: errors.rows });
});

admin.get('/notes', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM admin_notes ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});

export default admin;
