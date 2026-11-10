import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Bindings } from './types';
import authRouter from './routes/auth';
import onboardingRouter from './routes/onboarding';
import dashboardRouter from './routes/dashboard';
import proposalsRouter from './routes/proposals';
import contractsRouter from './routes/contracts';
import formsRouter from './routes/forms';
import invoicesRouter from './routes/invoices';
import publicRouter from './routes/public';
import filesRouter from './routes/files';
import crmRouter from './routes/crm';
import settingsRouter from './routes/settings';
import notificationsRouter from './routes/notifications';
import adminRouter from './routes/admin';

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

app.route('/api/auth', authRouter);
app.route('/api/onboarding', onboardingRouter);
app.route('/api/dashboard', dashboardRouter);
app.route('/api/proposals', proposalsRouter);
app.route('/api/contracts', contractsRouter);
app.route('/api/forms', formsRouter);
app.route('/api/invoices', invoicesRouter);
app.route('/api/public', publicRouter);
app.route('/api/files', filesRouter);
app.route('/api/crm', crmRouter);
app.route('/api/settings', settingsRouter);
app.route('/api/notifications', notificationsRouter);
app.route('/api/admin', adminRouter);

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'internal_server_error', message: 'Something went wrong.' }, 500);
});

app.notFound((c) => c.json({ error: 'not_found', message: 'Route not found.' }, 404));

export default app;
