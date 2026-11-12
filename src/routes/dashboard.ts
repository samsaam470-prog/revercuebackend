import { Hono } from 'hono';
import { tursoQuery } from '../utils/turso';
import { dbQuery } from '../utils/db';
import { userAuthMiddleware } from '../middleware/user-auth';
import { getUnreadCount } from '../services/notifications';
import { getRevenueSummary } from '../services/revenue';
import { generateSuggestions } from '../services/suggestions-engine';
import type { Bindings } from '../types';

const dashboard = new Hono<{ Bindings: Bindings }>();
dashboard.use('*', userAuthMiddleware);

dashboard.get('/summary', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const active = await dbQuery(c.env, `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'published'`, [uid]);
  const clients = await dbQuery(c.env, `SELECT COUNT(*) as c FROM clients WHERE user_id = ? AND status = 'active'`, [uid]);
  const followUps = await dbQuery(c.env, `SELECT COUNT(*) as c FROM communication_log WHERE user_id = ? AND follow_up_done = 0 AND follow_up_date <= ?`, [uid, new Date().toISOString()]);
  const revenue = await getRevenueSummary(c.env, uid);
  const unread = await getUnreadCount(c.env, uid);
  return c.json({ active_documents: Number(active[0]?.c ?? 0), clients: Number(clients[0]?.c ?? 0), follow_ups_due: Number(followUps[0]?.c ?? 0), revenue_this_month: revenue.earned_total, pending_total: revenue.pending_total, pending_count: revenue.pending_count, unread_notifications: unread });
});

dashboard.get('/suggestions', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const user = await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ?`, [uid]);
  const plan = user.rows[0]?.plan ?? 'free';
  const suggestions = await generateSuggestions(c.env, uid, plan);
  return c.json({ suggestions });
});

dashboard.get('/activity', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const limit = Math.min(Number(c.req.query('limit') ?? 10), 50);
  const rows = await tursoQuery(c.env, `SELECT id, event_type, client_id, document_id, title, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [uid, limit]);
  return c.json({ activity: rows.rows });
});

export default dashboard;
