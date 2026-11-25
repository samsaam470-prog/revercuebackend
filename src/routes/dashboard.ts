import { Hono } from 'hono';
import { tursoQuery } from '../utils/turso';
import { dbQuery, dbFirst, dbRun } from '../utils/db';
import { userAuthMiddleware, getAuth } from '../middleware/user-auth';
import { getUnreadCount } from '../services/notifications';
import { getRevenueSummary } from '../services/revenue';
import { generateSuggestions } from '../services/suggestions-engine';
import { jsonError } from '../utils/api-errors';
import type { Bindings } from '../types';

const dashboard = new Hono<{ Bindings: Bindings }>();
dashboard.use('*', userAuthMiddleware);

dashboard.get('/summary', async (c) => {
  const auth = getAuth(c);
  const [active, clients, followUps, revenue, unread] = await Promise.all([
    dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'published'`, [auth.userId]),
    dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM clients WHERE user_id = ? AND COALESCE(status,'active') = 'active'`, [auth.userId]),
    dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM communication_log WHERE user_id = ? AND COALESCE(follow_up_done,0) = 0 AND follow_up_date IS NOT NULL AND follow_up_date <= ?`, [auth.userId, new Date().toISOString()]),
    getRevenueSummary(c.env, auth.userId),
    getUnreadCount(c.env, auth.userId),
  ]);
  return c.json({
    active_documents: Number(active?.c ?? 0),
    clients: Number(clients?.c ?? 0),
    follow_ups_due: Number(followUps?.c ?? 0),
    revenue_total: revenue.earned_total,
    // Deprecated alias kept for one deploy window so the previous frontend build
    // never reads a missing field while Cloudflare Pages picks up the new one.
    revenue_this_month: revenue.earned_total,
    earned_total: revenue.earned_total,
    pending_total: revenue.pending_total,
    pending_count: revenue.pending_count,
    unread_notifications: unread,
  });
});

dashboard.get('/suggestions', async (c) => {
  const auth = getAuth(c);
  const generated = await generateSuggestions(c.env, auth.userId, auth.plan);
  const dismissed = await dbQuery<{ suggestion_id: string }>(
    c.env,
    `SELECT suggestion_id FROM suggestion_dismissals WHERE user_id = ?`,
    [auth.userId]
  ).catch(() => []);
  const dismissedIds = new Set(dismissed.map((row) => row.suggestion_id));
  return c.json({ suggestions: generated.filter((suggestion) => !dismissedIds.has(suggestion.id)) });
});

dashboard.post('/suggestions/:id/dismiss', async (c) => {
  const auth = getAuth(c);
  const id = c.req.param('id');
  if (!id || id.length > 200) return jsonError(c, 400, 'invalid_payload', 'Invalid suggestion id.');
  await dbRun(
    c.env,
    `INSERT OR IGNORE INTO suggestion_dismissals (id, user_id, suggestion_id, created_at) VALUES (?, ?, ?, ?)`,
    [`sd_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`, auth.userId, id, new Date().toISOString()]
  );
  return c.json({ success: true });
});

dashboard.get('/activity', async (c) => {
  const auth = getAuth(c);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 10) || 10, 1), 50);
  const rows = await tursoQuery(
    c.env,
    `SELECT id, event_type, client_id, document_id, title, created_at FROM notifications
     WHERE user_id = ? AND dismissed = 0 ORDER BY created_at DESC LIMIT ?`,
    [auth.userId, limit]
  );
  return c.json({ activity: rows.rows });
});

export default dashboard;
