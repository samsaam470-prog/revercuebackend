import { Hono } from 'hono';
import { tursoQuery } from '../utils/turso';
import { dbQuery } from '../utils/db';
import type { Bindings } from '../types';

const dashboard = new Hono<{ Bindings: Bindings }>();

dashboard.get('/summary', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const [activeDocs, clients, followUpsDue] = await Promise.all([
    dbQuery(c.env, `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'published'`, [userId]),
    dbQuery(c.env, `SELECT COUNT(*) as c FROM clients WHERE user_id = ? AND status = 'active'`, [userId]),
    dbQuery(c.env, `SELECT COUNT(*) as c FROM communication_log WHERE user_id = ? AND follow_up_done = 0 AND follow_up_date <= ?`, [userId, new Date().toISOString()]),
  ]);
  const revenue = await tursoQuery(c.env, `SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE user_id = ? AND status = 'paid' AND paid_at >= ?`, [userId, new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()]);
  return c.json({
    active_documents: activeDocs[0]?.c ?? 0,
    clients: clients[0]?.c ?? 0,
    follow_ups_due: followUpsDue[0]?.c ?? 0,
    revenue_this_month: Number(revenue.rows[0]?.total ?? 0),
  });
});

dashboard.get('/suggestions', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const user = await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ?`, [userId]);
  const plan = user.rows[0]?.plan ?? 'free';
  if (plan === 'free' || plan === 'starter') return c.json({ suggestions: [] });
  const rows = await dbQuery(c.env,
    `SELECT p.id as document_id, p.client_id, p.published_at, c.name as client_name
     FROM proposals p JOIN clients c ON p.client_id = c.id
     WHERE p.user_id = ? AND p.status = 'published' AND p.published_at < ?
     LIMIT 5`,
    [userId, new Date(Date.now() - 2 * 86400000).toISOString()]);
  const suggestions = rows.map((r: any) => ({
    id: `sug_${r.document_id}`,
    type: 'follow_up',
    client_id: r.client_id,
    document_id: r.document_id,
    title: `Follow up with ${r.client_name}`,
    body: `Proposal sent 2+ days ago, no response.`,
    action_url: `/crm/${r.client_id}`,
  }));
  return c.json({ suggestions });
});

dashboard.get('/activity', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const limit = Math.min(Number(c.req.query('limit') ?? 10), 50);
  const rows = await tursoQuery(c.env,
    `SELECT id, event_type, client_id, document_id, title, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit]);
  return c.json({ activity: rows.rows });
});

export default dashboard;
