import { Hono } from 'hono';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { dbQuery, dbRun } from '../utils/db';
import { generateId } from '../utils/ids';
import { adminAuthMiddleware } from '../middleware/admin-auth';
import { logAdminAction, requireAdminUser } from '../services/admin-audit';
import { createNotification } from '../services/notifications';
import { PLAN_PRICES } from '../config/constants';
import { retryDeliveryById } from '../services/email';
import { jsonError } from '../utils/api-errors';
import { clientIp } from '../utils/http';
import type { Bindings } from '../types';

const adminActions = new Hono<{ Bindings: Bindings }>();
adminActions.use('*', adminAuthMiddleware);

adminActions.post('/waitlist/:id/invite', async (c) => {
  const row = await tursoQuery(c.env, `SELECT email, plan_requested FROM waitlist WHERE id = ?`, [c.req.param('id')]);
  if (row.rows.length === 0) return c.json({ error: 'not_found' }, 404);
  await tursoExecute(c.env, `UPDATE waitlist SET status = 'invited', invited_at = ? WHERE id = ?`, [new Date().toISOString(), c.req.param('id')]);
  return c.json({ success: true, email: row.rows[0].email, plan: row.rows[0].plan_requested });
});

adminActions.post('/waitlist/:id/mark-paid', async (c) => {
  const b = await c.req.json();
  const row = await tursoQuery(c.env, `SELECT email, plan_requested FROM waitlist WHERE id = ?`, [c.req.param('id')]);
  if (row.rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const email = String(row.rows[0].email).toLowerCase();
  const plan = b.plan ?? row.rows[0].plan_requested ?? 'starter';
  const amount = Number(b.amount ?? 0) > 0 ? Number(b.amount) : (PLAN_PRICES[plan as keyof typeof PLAN_PRICES] ?? 0);
  const user = await tursoQuery(c.env, `SELECT id FROM users WHERE email = ?`, [email]);
  if (user.rows.length === 0) return c.json({ error: 'user_not_found', message: 'The user has not signed up yet.' }, 404);
  const userId = user.rows[0].id;
  await tursoExecute(c.env, `UPDATE users SET plan = ?, plan_expires_at = ?, updated_at = ? WHERE id = ?`, [plan, new Date(Date.now() + 30 * 86400000).toISOString(), new Date().toISOString(), userId]);
  await tursoExecute(c.env, `INSERT INTO payments (id, user_id, plan, amount, currency, method, reference, status, paid_at, created_at) VALUES (?, ?, ?, ?, 'USD', 'payoneer', ?, 'paid', ?, ?)`, [generateId('pay'), userId, plan, amount, b.reference ?? null, new Date().toISOString(), new Date().toISOString()]);
  await tursoExecute(c.env, `UPDATE waitlist SET status = 'paid', paid_at = ? WHERE id = ?`, [new Date().toISOString(), c.req.param('id')]);
  createNotification(c.env, { userId, eventType: 'payment_successful', title: 'Payment received', body: `Your payment for the ${plan} plan was recorded.` }).catch(() => undefined);
  createNotification(c.env, { userId, eventType: 'subscription_activated', title: 'Subscription activated', body: `Your ${plan} plan is now active.` }).catch(() => undefined);
  await logAdminAction(c.env, {
    adminUser: requireAdminUser(c),
    action: 'waitlist.marked_paid',
    targetType: 'user',
    targetId: userId,
    metadata: { plan, amount },
    ip: clientIp(c),
  });
  return c.json({ success: true });
});

adminActions.post('/upgrade-requests/:id/confirm', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const req = await tursoQuery(c.env, `SELECT user_id, plan_requested FROM payment_requests WHERE id = ?`, [c.req.param('id')]);
  if (req.rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const userId = req.rows[0].user_id;
  const plan = b.plan ?? req.rows[0].plan_requested;
  const amount = Number(b.amount ?? 0) > 0 ? Number(b.amount) : (PLAN_PRICES[plan as keyof typeof PLAN_PRICES] ?? 0);
  const now = new Date().toISOString();
  await tursoExecute(c.env, `UPDATE users SET plan = ?, plan_expires_at = ?, updated_at = ? WHERE id = ?`, [plan, new Date(Date.now() + 30 * 86400000).toISOString(), now, userId]);
  await tursoExecute(c.env, `INSERT INTO payments (id, user_id, plan, amount, currency, method, reference, status, paid_at, created_at) VALUES (?, ?, ?, ?, 'USD', 'payoneer', ?, 'paid', ?, ?)`, [generateId('pay'), userId, plan, amount, b.reference ?? null, now, now]);
  await tursoExecute(c.env, `UPDATE payment_requests SET status = 'confirmed' WHERE id = ?`, [c.req.param('id')]);
  createNotification(c.env, { userId, eventType: 'payment_successful', title: 'Payment received', body: `Your payment for the ${plan} plan was recorded.` }).catch(() => undefined);
  createNotification(c.env, { userId, eventType: 'subscription_activated', title: 'Subscription activated', body: `Your ${plan} plan is now active.` }).catch(() => undefined);
  await logAdminAction(c.env, {
    adminUser: requireAdminUser(c),
    action: 'upgrade_request.confirmed',
    targetType: 'payment_request',
    targetId: c.req.param('id'),
    metadata: { user_id: userId, plan, amount },
  });
  return c.json({ success: true, user_id: userId, plan });
});

adminActions.get('/upgrade-requests', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM payment_requests WHERE status = 'pending' ORDER BY created_at DESC LIMIT 100`);
  return c.json({ data: rows.rows });
});
adminActions.post('/payments', async (c) => {
  const b = await c.req.json();
  if (!b.user_id || !b.amount) return c.json({ error: 'invalid_payload' }, 400);
  const id = generateId('pay');
  const status = String(b.status ?? 'paid');
  await tursoExecute(c.env, `INSERT INTO payments (id, user_id, plan, amount, currency, method, reference, status, paid_at, created_at) VALUES (?, ?, ?, ?, ?, 'payoneer', ?, ?, ?, ?)`, [id, b.user_id, b.plan ?? null, b.amount, b.currency ?? 'USD', b.reference ?? null, status, b.paid_at ?? new Date().toISOString(), new Date().toISOString()]);
  /* A recorded failure is something the customer must act on, so the account
     owner is told. Best effort: the admin action has already been saved. */
  if (status === 'failed') {
    createNotification(c.env, {
      userId: b.user_id,
      eventType: 'payment_failed',
      title: 'Payment could not be completed',
      body: `A payment of ${b.amount} ${b.currency ?? 'USD'} did not go through. Update your payment method or contact support@revercue.co.uk.`,
    }).catch(() => undefined);
  }
  return c.json({ success: true, id }, 201);
});

adminActions.post('/templates/upload', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'] as File;
  const name = String(body['name'] ?? '').trim();
  const type = String(body['type'] ?? 'proposal');
  if (!file || !name) return c.json({ error: 'invalid_payload' }, 400);
  const { uploadToB2 } = await import('../services/storage');
  const { sanitizeHtml } = await import('../services/storage');
  const html = await file.text();
  const sanitized = sanitizeHtml(html);
  const key = `templates/${Date.now()}-${name.replace(/[^a-z0-9]/gi, '_')}.html`;
  const ok = await uploadToB2(c.env, key, new TextEncoder().encode(sanitized).buffer as ArrayBuffer, 'text/html');
  if (!ok) return c.json({ error: 'upload_failed' }, 500);
  const id = generateId('tpl');
  const now = new Date().toISOString();
  await dbRun(c.env, `INSERT INTO templates (id, name, type, tags, b2_key, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'built_in', 'active', ?, ?)`, [id, name, type, JSON.stringify(body['tags'] ? String(body['tags']).split(',') : []), key, now, now]);
  return c.json({ success: true, id, b2_key: key }, 201);
});

adminActions.get('/payments/:id/receipt', async (c) => {
  const row = await tursoQuery(c.env, `SELECT * FROM payments WHERE id = ?`, [c.req.param('id')]);
  if (row.rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const p = row.rows[0];
  const { buildPdf } = await import('../services/pdf-binary');
  const bytes = await buildPdf(`Receipt ${p.id}`, [
    { heading: 'Payment', body: `${p.amount} ${p.currency ?? 'USD'} — ${p.status}` },
    { heading: 'Reference', body: String(p.reference ?? '—') },
    { heading: 'Date', body: String(p.paid_at ?? p.created_at) },
  ]);
  return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="receipt-${p.id}.pdf"` } });
});
adminActions.post('/templates', async (c) => {
  const b = await c.req.json();
  if (!b.name || !b.type) return c.json({ error: 'invalid_payload' }, 400);
  const id = generateId('tpl');
  const now = new Date().toISOString();
  await dbRun(c.env, `INSERT INTO templates (id, name, type, tags, b2_key, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'built_in', 'active', ?, ?)`, [id, b.name, b.type, JSON.stringify(b.tags ?? []), b.b2_key ?? null, now, now]);
  return c.json({ success: true, id }, 201);
});

/** Administrators manage built-in templates only; a user's custom template is private. */
adminActions.patch('/templates/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const status = ['active', 'featured', 'inactive', 'draft'].includes(String(b.status ?? '')) ? b.status : null;
  const existing = await dbQuery<any>(c.env, `SELECT id, source FROM templates WHERE id = ? LIMIT 1`, [c.req.param('id')]);
  if (existing.length === 0) return jsonError(c, 404, 'not_found', 'Template not found.');
  if (existing[0].source !== 'built_in') {
    return jsonError(c, 403, 'forbidden', 'Only built-in templates can be managed by administrators.');
  }
  await dbRun(
    c.env,
    `UPDATE templates SET name = COALESCE(?, name), tags = COALESCE(?, tags), type = COALESCE(?, type), status = COALESCE(?, status), updated_at = ? WHERE id = ? AND source = 'built_in'`,
    [
      b.name ?? null,
      b.tags !== undefined ? JSON.stringify(Array.isArray(b.tags) ? b.tags : String(b.tags).split(',').map((s: string) => s.trim()).filter(Boolean)) : null,
      ['proposal', 'contract'].includes(String(b.type ?? '')) ? b.type : null,
      status,
      new Date().toISOString(),
      c.req.param('id'),
    ]
  );
  if (b.description !== undefined || b.category !== undefined) {
    await dbRun(
      c.env,
      `INSERT INTO template_metadata (template_id, description, category, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(template_id) DO UPDATE SET description = COALESCE(excluded.description, template_metadata.description), category = COALESCE(excluded.category, template_metadata.category), updated_at = excluded.updated_at`,
      [c.req.param('id'), b.description ?? null, b.category ?? null, new Date().toISOString()]
    ).catch((error) => console.error('TEMPLATE_METADATA_WRITE_FAILED', error));
  }
  await logAdminAction(c.env, {
    adminUser: requireAdminUser(c),
    action: 'template.updated',
    targetType: 'template',
    targetId: c.req.param('id'),
    metadata: { status: status ?? undefined },
  });
  return c.json({ success: true });
});

adminActions.post('/templates/:id/publish', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const status = body.featured === true ? 'featured' : 'active';
  await dbRun(c.env, `UPDATE templates SET status = ?, updated_at = ? WHERE id = ? AND source = 'built_in'`, [
    status,
    new Date().toISOString(),
    c.req.param('id'),
  ]);
  await logAdminAction(c.env, {
    adminUser: requireAdminUser(c),
    action: 'template.published',
    targetType: 'template',
    targetId: c.req.param('id'),
    metadata: { status },
  });
  return c.json({ success: true, status });
});

adminActions.post('/templates/:id/unpublish', async (c) => {
  await dbRun(c.env, `UPDATE templates SET status = 'inactive', updated_at = ? WHERE id = ? AND source = 'built_in'`, [
    new Date().toISOString(),
    c.req.param('id'),
  ]);
  await logAdminAction(c.env, {
    adminUser: requireAdminUser(c),
    action: 'template.unpublished',
    targetType: 'template',
    targetId: c.req.param('id'),
  });
  return c.json({ success: true, status: 'inactive' });
});

adminActions.delete('/templates/:id', async (c) => {
  const existing = await dbQuery<any>(c.env, `SELECT id, source FROM templates WHERE id = ? LIMIT 1`, [c.req.param('id')]);
  if (existing.length === 0) return jsonError(c, 404, 'not_found', 'Template not found.');
  if (existing[0].source !== 'built_in') {
    return jsonError(c, 403, 'forbidden', 'Only built-in templates can be deleted by administrators.');
  }
  await dbRun(c.env, `DELETE FROM template_metadata WHERE template_id = ?`, [c.req.param('id')]);
  await dbRun(c.env, `DELETE FROM templates WHERE id = ? AND source = 'built_in'`, [c.req.param('id')]);
  await logAdminAction(c.env, {
    adminUser: requireAdminUser(c),
    action: 'template.deleted',
    targetType: 'template',
    targetId: c.req.param('id'),
  });
  return c.json({ success: true });
});

adminActions.post('/health/retry-email/:id', async (c) => {
  const result = await retryDeliveryById(c.env, c.req.param('id'));
  if (result.status === 'not_found') return jsonError(c, 404, 'not_found', 'Delivery not found.');
  await logAdminAction(c.env, {
    adminUser: requireAdminUser(c),
    action: 'email.retried',
    targetType: 'email_delivery',
    targetId: c.req.param('id'),
    metadata: { ok: result.ok, status: result.status },
  });
  return c.json({ success: result.ok, status: result.status, error: result.error ?? null });
});

adminActions.post('/health/run-cron/:job', async (c) => {
  const job = c.req.param('job');
  if (job === 'retention') { const { runRetention } = await import('../cron/retention'); await runRetention(c.env); return c.json({ success: true, job }); }
  if (job === 'summary') { const { processDueJobs } = await import('../services/summary'); const r = await processDueJobs(c.env); return c.json({ success: true, job, ...r }); }
  if (job === 'proof-cleanup') { const { runProofCleanup } = await import('../cron/pdf-cleanup'); await runProofCleanup(c.env); return c.json({ success: true, job }); }
  return c.json({ error: 'invalid_job' }, 400);
});

adminActions.patch('/notes/:id', async (c) => {
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE admin_notes SET note = COALESCE(?, note) WHERE id = ?`, [b.note ?? null, c.req.param('id')]);
  return c.json({ success: true });
});

adminActions.delete('/notes/:id', async (c) => {
  await tursoExecute(c.env, `DELETE FROM admin_notes WHERE id = ?`, [c.req.param('id')]);
  return c.json({ success: true });
});

export default adminActions;


