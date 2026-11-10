import { Hono } from 'hono';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { dbQuery } from '../utils/db';
import { userAuthMiddleware } from '../middleware/user-auth';
import type { Bindings } from '../types';

const settings = new Hono<{ Bindings: Bindings }>();
settings.use('*', userAuthMiddleware);

settings.get('/profile', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const row = await tursoQuery(c.env, `SELECT * FROM users WHERE id = ?`, [userId]);
  return c.json({ profile: row.rows[0] });
});

settings.patch('/profile', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE users SET name = COALESCE(?, name), business_name = COALESCE(?, business_name), website = COALESCE(?, website), fiverr_profile = COALESCE(?, fiverr_profile), services = COALESCE(?, services), brand_primary = COALESCE(?, brand_primary), brand_secondary = COALESCE(?, brand_secondary), updated_at = ? WHERE id = ?`, [b.name ?? null, b.business_name ?? null, b.website ?? null, b.fiverr_profile ?? null, b.services ? JSON.stringify(b.services) : null, b.brand_primary ?? null, b.brand_secondary ?? null, new Date().toISOString(), userId]);
  return c.json({ success: true });
});

settings.get('/plan', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const user = (await tursoQuery(c.env, `SELECT plan, plan_expires_at FROM users WHERE id = ?`, [userId])).rows[0];
  const activeDocs = await dbQuery(c.env, `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'published'`, [userId]);
  const payments = await tursoQuery(c.env, `SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC`, [userId]);
  return c.json({ plan: user?.plan ?? 'free', expires_at: user?.plan_expires_at ?? null, active_documents: activeDocs[0]?.c ?? 0, payments: payments.rows });
});

settings.get('/notifications', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const row = await tursoQuery(c.env, `SELECT notifications_enabled, notification_events, newsletter_opt_in, formsubmit_activated FROM users WHERE id = ?`, [userId]);
  return c.json(row.rows[0]);
});

settings.patch('/notifications', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE users SET notifications_enabled = COALESCE(?, notifications_enabled), notification_events = COALESCE(?, notification_events), newsletter_opt_in = COALESCE(?, newsletter_opt_in), updated_at = ? WHERE id = ?`, [b.email_notifications_enabled ?? null, b.notification_events ? JSON.stringify(b.notification_events) : null, b.newsletter_opt_in ?? null, new Date().toISOString(), userId]);
  return c.json({ success: true });
});

settings.post('/delete-account', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  if (!b.email_confirmation) return c.json({ error: 'invalid_payload' }, 400);
  const now = new Date().toISOString();
  const deletionDate = new Date(Date.now() + 5 * 86400000).toISOString();
  await tursoExecute(c.env, `UPDATE users SET deletion_requested_at = ?, updated_at = ? WHERE id = ?`, [now, now, userId]);
  return c.json({ success: true, deletion_date: deletionDate });
});

settings.post('/cancel-deletion', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  await tursoExecute(c.env, `UPDATE users SET deletion_requested_at = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), userId]);
  return c.json({ success: true });
});

export default settings;
