import { Hono } from 'hono';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { userAuthMiddleware } from '../middleware/user-auth';
import type { Bindings } from '../types';

const notifications = new Hono<{ Bindings: Bindings }>();

notifications.get('/stream', userAuthMiddleware, async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = (data: any) => {
    writer.write(encoder.encode(`event: notification\ndata: ${JSON.stringify(data)}\n\n`));
  };

  c.executionCtx.waitUntil((async () => {
    send({ type: 'connected', userId });
    const interval = setInterval(async () => {
      try {
        const rows = await tursoQuery(c.env, `SELECT id, event_type, title, created_at FROM notifications WHERE user_id = ? AND read = 0 ORDER BY created_at DESC LIMIT 1`, [userId]);
        if (rows.rows.length > 0) send(rows.rows[0]);
      } catch {}
    }, 30000);
    setTimeout(() => { clearInterval(interval); writer.close(); }, 300000);
  })());

  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
});

notifications.get('/', userAuthMiddleware, async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const limit = Math.min(Number(c.req.query('limit') ?? 10), 50);
  const rows = await tursoQuery(c.env, `SELECT * FROM notifications WHERE user_id = ? AND dismissed = 0 ORDER BY created_at DESC LIMIT ?`, [userId, limit]);
  return c.json({ data: rows.rows });
});

notifications.get('/unread-count', userAuthMiddleware, async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const rows = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0`, [userId]);
  return c.json({ count: Number(rows.rows[0]?.c ?? 0) });
});

notifications.patch('/:id/read', userAuthMiddleware, async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  await tursoExecute(c.env, `UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?`, [c.req.param('id'), userId]);
  return c.json({ success: true });
});

notifications.patch('/read-all', userAuthMiddleware, async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  await tursoExecute(c.env, `UPDATE notifications SET read = 1 WHERE user_id = ?`, [userId]);
  return c.json({ success: true });
});

notifications.delete('/:id', userAuthMiddleware, async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  await tursoExecute(c.env, `UPDATE notifications SET dismissed = 1 WHERE id = ? AND user_id = ?`, [c.req.param('id'), userId]);
  return c.json({ success: true });
});

export default notifications;
