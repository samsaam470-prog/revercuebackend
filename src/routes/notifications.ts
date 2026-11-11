import { Hono } from 'hono';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { userAuthMiddleware } from '../middleware/user-auth';
import type { Bindings } from '../types';

const notifications = new Hono<{ Bindings: Bindings }>();
notifications.use('*', userAuthMiddleware);

notifications.get('/unread-count', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const rows = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0 AND dismissed = 0`, [uid]);
  return c.json({ count: Number(rows.rows[0]?.c ?? 0) });
});

notifications.get('/', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const limit = Math.min(Number(c.req.query('limit') ?? 10), 50);
  const rows = await tursoQuery(c.env, `SELECT * FROM notifications WHERE user_id = ? AND dismissed = 0 ORDER BY created_at DESC LIMIT ?`, [uid, limit]);
  return c.json({ data: rows.rows });
});

notifications.patch('/:id/read', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await tursoExecute(c.env, `UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  return c.json({ success: true });
});

notifications.patch('/read-all', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await tursoExecute(c.env, `UPDATE notifications SET read = 1 WHERE user_id = ?`, [uid]);
  return c.json({ success: true });
});

notifications.delete('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await tursoExecute(c.env, `UPDATE notifications SET dismissed = 1 WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  return c.json({ success: true });
});

export default notifications;
