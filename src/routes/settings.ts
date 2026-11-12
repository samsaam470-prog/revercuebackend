import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { dbQuery, dbRun } from '../utils/db';
import { generateId } from '../utils/ids';
import { userAuthMiddleware } from '../middleware/user-auth';
import { getRevenueSummary, addExpense } from '../services/revenue';
import { getPriceSuggestion } from '../services/price-suggestion';
import { SAVED_FAQ_LIMIT, SAVED_PACKAGE_LIMIT, REVENUE_TRACKER, EXPENSE_ENTRY, WHAT_REVERCUE_KNOWS } from '../config/constants';
import type { Bindings } from '../types';

const settings = new Hono<{ Bindings: Bindings }>();
settings.use('*', userAuthMiddleware);

async function getPlan(env: Bindings, uid: string): Promise<string> {
  const u = await tursoQuery(env, `SELECT plan FROM users WHERE id = ?`, [uid]);
  return u.rows[0]?.plan ?? 'free';
}

settings.get('/profile', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const row = await tursoQuery(c.env, `SELECT * FROM users WHERE id = ?`, [uid]);
  return c.json({ profile: row.rows[0] });
});

settings.patch('/profile', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE users SET name = COALESCE(?, name), business_name = COALESCE(?, business_name), website = COALESCE(?, website), fiverr_profile = COALESCE(?, fiverr_profile), services = COALESCE(?, services), brand_primary = COALESCE(?, brand_primary), brand_secondary = COALESCE(?, brand_secondary), updated_at = ? WHERE id = ?`, [b.name ?? null, b.business_name ?? null, b.website ?? null, b.fiverr_profile ?? null, b.services ? JSON.stringify(b.services) : null, b.brand_primary ?? null, b.brand_secondary ?? null, new Date().toISOString(), uid]);
  return c.json({ success: true });
});

settings.get('/plan', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const user = await tursoQuery(c.env, `SELECT plan, plan_expires_at FROM users WHERE id = ?`, [uid]);
  const activeDocs = await dbQuery(c.env, `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'published'`, [uid]);
  const payments = await tursoQuery(c.env, `SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC`, [uid]);
  return c.json({ plan: user.rows[0]?.plan ?? 'free', expires_at: user.rows[0]?.plan_expires_at ?? null, active_documents: Number(activeDocs[0]?.c ?? 0), payments: payments.rows });
});

settings.post('/plan/upgrade-request', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  await tursoExecute(c.env, `INSERT INTO payment_requests (id, user_id, plan_requested, status, created_at) VALUES (?, ?, ?, 'pending', ?)`, [generateId('preq'), uid, b.plan, new Date().toISOString()]);
  return c.json({ success: true }, 201);
});

settings.post('/security/change-password', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  const user = await tursoQuery(c.env, `SELECT password_hash FROM users WHERE id = ?`, [uid]);
  if (!user.rows[0]?.password_hash) return c.json({ error: 'forbidden' }, 403);
  if (!(await bcrypt.compare(String(b.current_password ?? ''), user.rows[0].password_hash))) return c.json({ error: 'invalid_credentials' }, 401);
  if (!b.new_password || String(b.new_password).length < 8) return c.json({ error: 'invalid_payload' }, 400);
  const hash = await bcrypt.hash(String(b.new_password), 10);
  await tursoExecute(c.env, `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, [hash, new Date().toISOString(), uid]);
  await tursoExecute(c.env, `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [new Date().toISOString(), uid]);
  return c.json({ success: true });
});

settings.post('/security/2fa', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  const user = await tursoQuery(c.env, `SELECT password_hash FROM users WHERE id = ?`, [uid]);
  if (user.rows[0]?.password_hash) {
    if (!(await bcrypt.compare(String(b.current_password ?? ''), user.rows[0].password_hash))) return c.json({ error: 'invalid_credentials' }, 401);
  }
  await tursoExecute(c.env, `UPDATE users SET two_factor_enabled = ?, updated_at = ? WHERE id = ?`, [b.enabled ? 1 : 0, new Date().toISOString(), uid]);
  return c.json({ success: true, two_factor_enabled: !!b.enabled });
});

settings.get('/security/sessions', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const rows = await tursoQuery(c.env, `SELECT id, device, browser, ip_hash, location, last_active_at, created_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_active_at DESC`, [uid]);
  return c.json({ sessions: rows.rows });
});

settings.post('/security/sessions/logout-all', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await tursoExecute(c.env, `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [new Date().toISOString(), uid]);
  return c.json({ success: true });
});

settings.get('/notifications', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const row = await tursoQuery(c.env, `SELECT notifications_enabled, notification_events, newsletter_opt_in, formsubmit_activated FROM users WHERE id = ?`, [uid]);
  return c.json(row.rows[0]);
});

settings.patch('/notifications', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE users SET notifications_enabled = COALESCE(?, notifications_enabled), notification_events = COALESCE(?, notification_events), newsletter_opt_in = COALESCE(?, newsletter_opt_in), updated_at = ? WHERE id = ?`, [b.email_notifications_enabled ?? null, b.notification_events ? JSON.stringify(b.notification_events) : null, b.newsletter_opt_in ?? null, new Date().toISOString(), uid]);
  return c.json({ success: true });
});

settings.post('/formsubmit-activate', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await tursoExecute(c.env, `UPDATE users SET formsubmit_activated = 1, updated_at = ? WHERE id = ?`, [new Date().toISOString(), uid]);
  return c.json({ success: true });
});

settings.get('/saved-faqs', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const rows = await dbQuery(c.env, `SELECT * FROM saved_faqs WHERE user_id = ? ORDER BY created_at DESC`, [uid]);
  return c.json({ data: rows });
});

settings.post('/saved-faqs', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  if (!b.question || !b.answer) return c.json({ error: 'invalid_payload' }, 400);
  const plan = await getPlan(c.env, uid);
  const count = await dbQuery(c.env, `SELECT COUNT(*) as c FROM saved_faqs WHERE user_id = ?`, [uid]);
  if (Number(count[0]?.c ?? 0) >= SAVED_FAQ_LIMIT[plan as keyof typeof SAVED_FAQ_LIMIT]) return c.json({ error: 'plan_limit_reached' }, 403);
  const id = generateId('faq');
  await dbRun(c.env, `INSERT INTO saved_faqs (id, user_id, question, answer, title, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [id, uid, b.question, b.answer, b.title ?? null, new Date().toISOString()]);
  return c.json({ success: true, id }, 201);
});

settings.delete('/saved-faqs/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(c.env, `DELETE FROM saved_faqs WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  return c.json({ success: true });
});

settings.get('/saved-packages', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const rows = await dbQuery(c.env, `SELECT * FROM saved_packages WHERE user_id = ? ORDER BY created_at DESC`, [uid]);
  return c.json({ data: rows });
});

settings.post('/saved-packages', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  if (!b.name) return c.json({ error: 'invalid_payload' }, 400);
  const plan = await getPlan(c.env, uid);
  const count = await dbQuery(c.env, `SELECT COUNT(*) as c FROM saved_packages WHERE user_id = ?`, [uid]);
  if (Number(count[0]?.c ?? 0) >= SAVED_PACKAGE_LIMIT[plan as keyof typeof SAVED_PACKAGE_LIMIT]) return c.json({ error: 'plan_limit_reached' }, 403);
  const id = generateId('pkg');
  await dbRun(c.env, `INSERT INTO saved_packages (id, user_id, name, price, currency, deliverables, description, is_recommended, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, uid, b.name, b.price ?? 0, b.currency ?? 'USD', JSON.stringify(b.deliverables ?? []), b.description ?? null, b.is_recommended ? 1 : 0, new Date().toISOString()]);
  return c.json({ success: true, id }, 201);
});

settings.delete('/saved-packages/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(c.env, `DELETE FROM saved_packages WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  return c.json({ success: true });
});

settings.get('/revenue', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const plan = await getPlan(c.env, uid);
  if (!REVENUE_TRACKER[plan as keyof typeof REVENUE_TRACKER]) return c.json({ error: 'forbidden' }, 403);
  const summary = await getRevenueSummary(c.env, uid);
  const expenses = await dbQuery(c.env, `SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC LIMIT 100`, [uid]);
  return c.json({ ...summary, expenses });
});

settings.post('/expenses', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const plan = await getPlan(c.env, uid);
  if (!EXPENSE_ENTRY[plan as keyof typeof EXPENSE_ENTRY]) return c.json({ error: 'forbidden' }, 403);
  const b = await c.req.json();
  if (!b.amount || !b.category) return c.json({ error: 'invalid_payload' }, 400);
  const id = await addExpense(c.env, uid, b);
  return c.json({ success: true, id }, 201);
});

settings.get('/price-suggestion/:clientId', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const plan = await getPlan(c.env, uid);
  if (plan !== 'scale' && plan !== 'teams') return c.json({ error: 'forbidden' }, 403);
  const margin = Number(c.req.query('margin') ?? 30);
  const result = await getPriceSuggestion(c.env, uid, c.req.param('clientId'), margin);
  return c.json(result);
});

settings.get('/upgrade-status', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const rows = await tursoQuery(c.env, `SELECT id, plan_requested, status, created_at FROM payment_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`, [uid]);
  return c.json({ data: rows.rows });
});
settings.get('/what-revercue-knows', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const plan = await getPlan(c.env, uid);
  if (!WHAT_REVERCUE_KNOWS[plan as keyof typeof WHAT_REVERCUE_KNOWS]) return c.json({ error: 'forbidden' }, 403);
  const row = await tursoQuery(c.env, `SELECT * FROM users WHERE id = ?`, [uid]);
  return c.json({ account: row.rows[0] });
});

settings.post('/delete-account', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  const user = await tursoQuery(c.env, `SELECT email FROM users WHERE id = ?`, [uid]);
  if (b.email_confirmation !== user.rows[0]?.email) return c.json({ error: 'invalid_payload' }, 400);
  await tursoExecute(c.env, `UPDATE users SET deletion_requested_at = ?, updated_at = ? WHERE id = ?`, [new Date().toISOString(), new Date().toISOString(), uid]);
  return c.json({ success: true, deletion_date: new Date(Date.now() + 5 * 86400000).toISOString() });
});

settings.post('/cancel-deletion', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await tursoExecute(c.env, `UPDATE users SET deletion_requested_at = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), uid]);
  return c.json({ success: true });
});

export default settings;

