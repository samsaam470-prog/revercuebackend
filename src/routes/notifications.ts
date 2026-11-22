import { Hono } from 'hono';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { userAuthMiddleware, getAuth } from '../middleware/user-auth';
import { parsePagination, paginated } from '../utils/pagination';
import { listNotificationsSince } from '../services/notifications';
import { SSE_DEFAULT_MAX_SECONDS, SSE_DEFAULT_POLL_MS, SSE_KEEPALIVE_MS, SSE_MAX_POLL_MS, SSE_MIN_POLL_MS } from '../config/constants';
import type { Bindings } from '../types';

const notifications = new Hono<{ Bindings: Bindings }>();
notifications.use('*', userAuthMiddleware);

notifications.get('/unread-count', async (c) => {
  const auth = getAuth(c);
  const rows = await tursoQuery(
    c.env,
    `SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0 AND dismissed = 0`,
    [auth.userId]
  );
  return c.json({ count: Number(rows.rows[0]?.c ?? 0) });
});

/**
 * Authenticated Server-Sent Events stream.
 *
 * Constraints that make this safe on Workers:
 *  - the connection is capped (`SSE_MAX_SECONDS`, default 300s) and then the
 *    client reconnects with `Last-Event-ID`, so no request lives forever;
 *  - polling is bounded (`SSE_POLL_MS`, 1-15s);
 *  - every row is filtered by the authenticated user id, so one subscriber can
 *    never receive another user's notification;
 *  - keepalive comments stop proxies from dropping an idle connection.
 *
 * Polling via GET /api/notifications remains the fallback and is what the
 * current frontend uses.
 */
notifications.get('/stream', async (c) => {
  const auth = getAuth(c);
  const maxSeconds = Math.min(
    Math.max(Number(c.env.SSE_MAX_SECONDS ?? SSE_DEFAULT_MAX_SECONDS) || SSE_DEFAULT_MAX_SECONDS, 5),
    600
  );
  const pollMs = Math.min(
    Math.max(Number(c.env.SSE_POLL_MS ?? SSE_DEFAULT_POLL_MS) || SSE_DEFAULT_POLL_MS, SSE_MIN_POLL_MS),
    SSE_MAX_POLL_MS
  );
  const keepaliveMs = Math.max(
    (Number(c.env.SSE_KEEPALIVE_SECONDS ?? 0) || 0) * 1000 || SSE_KEEPALIVE_MS,
    5000
  );

  const lastEventId = c.req.header('Last-Event-ID') ?? '';
  const sinceParam = lastEventId || c.req.query('since') || '';
  const isIso = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(sinceParam) && !Number.isNaN(Date.parse(sinceParam));
  let since = isIso ? sinceParam : new Date().toISOString();

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let closed = false;

  const signal = c.req.raw.signal;
  if (signal) {
    signal.addEventListener('abort', () => {
      closed = true;
    });
  }

  const write = async (chunk: string) => {
    if (closed) return;
    try {
      await writer.write(encoder.encode(chunk));
    } catch {
      closed = true;
    }
  };

  const pump = async () => {
    try {
      await write(`retry: 5000\n: connected\n\n`);
      const deadline = Date.now() + maxSeconds * 1000;
      let lastKeepalive = Date.now();

      while (!closed && Date.now() < deadline) {
        try {
          const rows = await listNotificationsSince(c.env, auth.userId, since, 25);
          for (const notification of rows) {
            // Defense in depth: the SQL already scopes by user id.
            if (notification.user_id !== auth.userId) continue;
            const payload = {
              id: notification.id,
              event_type: notification.event_type,
              client_id: notification.client_id,
              document_id: notification.document_id,
              title: notification.title,
              body: notification.body,
              read: Boolean(notification.read),
              created_at: notification.created_at,
            };
            await write(`id: ${notification.created_at}\nevent: notification\ndata: ${JSON.stringify(payload)}\n\n`);
            since = notification.created_at;
          }
        } catch (error) {
          console.error('SSE_POLL_FAILED', error);
          await write(`event: stream_error\ndata: {"message":"poll_failed"}\n\n`);
        }

        if (Date.now() - lastKeepalive >= keepaliveMs) {
          await write(`: keepalive ${new Date().toISOString()}\n\n`);
          lastKeepalive = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }

      // Tell the client to reconnect rather than leaving a silent dead socket.
      await write(`event: reconnect\ndata: {"since":"${since}","max_seconds":${maxSeconds}}\n\n`);
    } finally {
      try {
        await writer.close();
      } catch {
        // The client may already be gone.
      }
    }
  };

  try {
    c.executionCtx?.waitUntil(pump());
  } catch {
    void pump();
  }

  return new Response(readable as unknown as BodyInit, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

notifications.get('/', async (c) => {
  const auth = getAuth(c);
  const pagination = parsePagination(c, 10, 50);
  const filter = c.req.query('filter') ?? 'all';

  let where = `user_id = ? AND dismissed = 0`;
  const args: any[] = [auth.userId];
  if (filter === 'unread') where += ` AND read = 0`;
  if (filter === 'client') where += ` AND client_id IS NOT NULL`;
  if (filter === 'system') where += ` AND client_id IS NULL`;

  const totalRow = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM notifications WHERE ${where}`, args);
  const rows = await tursoQuery(
    c.env,
    `SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...args, pagination.limit, pagination.offset]
  );

  const data = rows.rows.map((row: any) => ({ ...row, read: Boolean(row.read), dismissed: Boolean(row.dismissed) }));
  return c.json(paginated(data, Number(totalRow.rows[0]?.c ?? 0), pagination));
});

notifications.patch('/:id/read', async (c) => {
  const auth = getAuth(c);
  await tursoExecute(c.env, `UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  await tursoExecute(
    c.env,
    `UPDATE admin_notification_deliveries SET read_at = ? WHERE notification_id = ? AND user_id = ? AND read_at IS NULL`,
    [new Date().toISOString(), c.req.param('id'), auth.userId]
  ).catch(() => undefined);
  return c.json({ success: true });
});

notifications.patch('/read-all', async (c) => {
  const auth = getAuth(c);
  await tursoExecute(c.env, `UPDATE notifications SET read = 1 WHERE user_id = ?`, [auth.userId]);
  return c.json({ success: true });
});

notifications.delete('/:id', async (c) => {
  const auth = getAuth(c);
  await tursoExecute(c.env, `UPDATE notifications SET dismissed = 1 WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  return c.json({ success: true });
});

export default notifications;
