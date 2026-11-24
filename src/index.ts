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
import billingRouter from './routes/billing';
import webhooksRouter from './routes/webhooks';
import notificationsRouter from './routes/notifications';
import announcementsRouter from './routes/announcements';
import templatesRouter from './routes/templates';
import adminRouter from './routes/admin';
import adminActionsRouter from './routes/admin-actions';
import extractRouter from './routes/extract';
import organizeRouter from './routes/organize';
import summaryRouter from './routes/summary';
import marketingRouter from './routes/marketing';
import stagingAuthRouter from './routes/staging-auth';
import { runHourly } from './cron/summary';
import { runAuthActionSync } from './services/authaction-sync';
import { runPublishCron } from './cron/publish';
import { newReferenceCode } from './utils/http';

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', async (c, next) => {
  const configured = (c.env.FRONTEND_ORIGIN ?? '').trim();
  const extra = (c.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowed = [...new Set([configured, ...extra].filter(Boolean))];
  // Never fall back to '*'. If no origin is configured, cross-origin browser
  // requests receive no CORS permission; same-origin requests still work.
  const origin = (requestOrigin: string) =>
    allowed.includes(requestOrigin) ? requestOrigin : undefined;
  const corsMiddleware = cors({
    origin,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Password-Session'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length', 'Content-Disposition'],
    credentials: false,
    maxAge: 600,
  });
  return corsMiddleware(c, next);
});

app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('Referrer-Policy', 'no-referrer');
  c.res.headers.set('X-Frame-Options', 'DENY');
  // API responses are user-specific; never let a shared cache keep them.
  if (!c.res.headers.has('Cache-Control')) {
    c.res.headers.set('Cache-Control', 'no-store');
  }
});

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    status: 'healthy',
    version: '2.1.0',
    timestamp: new Date().toISOString(),
    api_base_url: c.env.API_BASE_URL ?? 'https://api.revercue.co.uk',
    features: {
      authaction: Boolean(c.env.AUTHACTION_ISSUER && c.env.AUTHACTION_AUDIENCE),
      legacy_auth: (c.env.ALLOW_LEGACY_AUTH ?? 'true').toLowerCase() !== 'false',
      email_configured: Boolean((c.env.COOPER_API_KEY && c.env.COOPER_INBOX_ID) || (c.env.OPENMAIL_API_KEY && c.env.OPENMAIL_INBOX_ID)),
      signing_links: Boolean(c.env.SIGNING_LINK_SECRET),
    },
  })
);

app.route('/api/auth', authRouter);
app.route('/api/staging', stagingAuthRouter);
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
app.route('/api/settings/billing', billingRouter);
app.route('/api/webhooks', webhooksRouter);
app.route('/api/notifications', notificationsRouter);
app.route('/api/announcements', announcementsRouter);
app.route('/api/templates', templatesRouter);
app.route('/api/admin', adminRouter);
app.route('/api/admin', adminActionsRouter);
app.route('/api/extract', extractRouter);
app.route('/api/organize', organizeRouter);
app.route('/api/summary', summaryRouter);
// Public marketing endpoints: /api/newsletter, /api/contact, /api/waitlist, /api/beta
app.route('/api', marketingRouter);

app.onError(async (err, c) => {
  const status = (err as any)?.status;
  const reference = newReferenceCode();
  console.error('UNHANDLED_ERROR', reference, c.req.method, c.req.path, err);
  if (c.env.ENVIRONMENT !== 'staging') {
  try {
    const { tursoExecute } = await import('./utils/turso');
    const { generateId } = await import('./utils/ids');
    await tursoExecute(
      c.env,
      `INSERT INTO error_logs (id, reference_code, route, message, stack, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        generateId('err'),
        reference,
        `${c.req.method} ${c.req.path}`,
        String(err?.message ?? 'unknown').slice(0, 1000),
        String(err?.stack ?? '').slice(0, 4000),
        new Date().toISOString(),
      ]
    );
  } catch (logError) {
    console.error('ERROR_LOG_WRITE_FAILED', logError);
  }
  }
  // Never leak internal error messages (SQL, provider responses) to clients.
  return c.json(
    {
      error: 'internal_server_error',
      message: 'Something went wrong. Quote the reference if you contact support.',
      reference,
    },
    typeof status === 'number' && status >= 400 && status < 600 ? (status as 500) : 500
  );
});

app.notFound((c) => c.json({ error: 'not_found', message: 'Route not found.' }, 404));

export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) => {
    ctx.waitUntil(runHourly(env));
    ctx.waitUntil(runAuthActionSync(env, 'cron').catch(() => undefined));
    ctx.waitUntil(runPublishCron(env).catch(() => undefined));
  },
};
