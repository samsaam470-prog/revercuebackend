import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Bindings } from './types';

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', async (c, next) => {
  const configured = (c.env.FRONTEND_ORIGIN ?? '').trim();
  const origin = configured || '*';
  const corsMiddleware = cors({
    origin,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length', 'Content-Disposition'],
    credentials: false,
    maxAge: 600,
  });
  return corsMiddleware(c, next);
});

app.get('/api/health', (c) =>
  c.json({ ok: true, status: 'healthy', timestamp: new Date().toISOString() })
);

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'internal_server_error', message: 'Something went wrong.' }, 500);
});

app.notFound((c) => c.json({ error: 'not_found', message: 'Route not found.' }, 404));

export default app;
