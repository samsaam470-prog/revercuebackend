import { Hono } from 'hono';
import { createAdminToken, adminAuthMiddleware } from '../middleware/admin-auth';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { dbQuery, dbFirst } from '../utils/db';
import { generateId } from '../utils/ids';
import { stringsEqual } from '../utils/crypto';
import { parsePagination, paginated } from '../utils/pagination';
import { jsonError } from '../utils/api-errors';
import { clientIp } from '../utils/http';
import { logAdminAction, requireAdminUser } from '../services/admin-audit';
import { listRetentionFailures } from '../services/retention';
import { retryDeliveryById } from '../services/email';
import { NEWSLETTER_EXPORT_LIMIT, ADMIN_LIST_LIMIT } from '../config/constants';
import type { Bindings } from '../types';

/**
 * Admin API.
 *
 * The dashboard UI does not exist yet; these endpoints are the contract it will
 * use. Authorization is a separate admin JWT (never a user token), every
 * mutation is audited, and no endpoint can grant a user admin rights because
 * user-level routes never write an admin role.
 */

const admin = new Hono<{ Bindings: Bindings }>();

admin.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username ?? '');
  const password = String(body.password ?? '');
  if (!c.env.ADMIN_USER || !c.env.ADMIN_PASS || !c.env.ADMIN_JWT_KEY) {
    return jsonError(c, 500, 'config_error', 'Admin authentication is not configured.');
  }
  const usernameOk = stringsEqual(username, c.env.ADMIN_USER);
  const passwordOk = stringsEqual(password, c.env.ADMIN_PASS);
  if (!usernameOk || !passwordOk) {
    return jsonError(c, 401, 'invalid_credentials', 'Invalid credentials.');
  }
  await logAdminAction(c.env, {
    adminUser: username,
    action: 'admin.login',
    ip: clientIp(c),
  });
  return c.json({ success: true, token: await createAdminToken(username, c.env.ADMIN_JWT_KEY) });
});

admin.use('*', adminAuthMiddleware);

admin.get('/overview', async (c) => {
  const [total, paid, waitlist, beta, contact, revenue, newsletter, signedContracts] = await Promise.all([
    tursoQuery(c.env, `SELECT COUNT(*) as c FROM users`),
    tursoQuery(c.env, `SELECT COUNT(*) as c FROM users WHERE plan IN ('starter','growth','scale','teams')`),
    tursoQuery(c.env, `SELECT COUNT(*) as c FROM waitlist WHERE status = 'pending'`),
    tursoQuery(c.env, `SELECT COUNT(*) as c FROM beta_testers WHERE status = 'new'`),
    tursoQuery(c.env, `SELECT COUNT(*) as c FROM contact_messages WHERE status = 'new'`),
    tursoQuery(c.env, `SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'paid'`),
    tursoQuery(c.env, `SELECT COUNT(*) as c FROM newsletter_subscribers WHERE status = 'active'`).catch(() => ({ rows: [{ c: 0 }] })),
    dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM contracts WHERE status = 'fully_signed'`),
  ]);

  return c.json({
    total_users: Number(total.rows[0]?.c ?? 0),
    paid_users: Number(paid.rows[0]?.c ?? 0),
    waitlist_pending: Number(waitlist.rows[0]?.c ?? 0),
    beta_testers_new: Number(beta.rows[0]?.c ?? 0),
    contact_messages_new: Number(contact.rows[0]?.c ?? 0),
    total_revenue: Number(revenue.rows[0]?.total ?? 0),
    newsletter_active: Number(newsletter.rows[0]?.c ?? 0),
    fully_signed_contracts: Number(signedContracts?.c ?? 0),
  });
});

admin.get('/metrics', async (c) => {
  const [documents, proposals, contracts, forms, invoices, trackedVisits, emailsSent, emailsFailed, retentionFailures] =
    await Promise.all([
      dbFirst<{ c: number }>(c.env, `SELECT (SELECT COUNT(*) FROM proposals) + (SELECT COUNT(*) FROM contracts) + (SELECT COUNT(*) FROM forms) + (SELECT COUNT(*) FROM invoices) as c`),
      dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM proposals`),
      dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM contracts`),
      dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM forms`),
      dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM invoices`),
      dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM document_visits`),
      tursoQuery(c.env, `SELECT COUNT(*) as c FROM email_deliveries WHERE status = 'sent'`).catch(() => ({ rows: [{ c: 0 }] })),
      tursoQuery(c.env, `SELECT COUNT(*) as c FROM email_deliveries WHERE status IN ('failed','abandoned')`).catch(() => ({ rows: [{ c: 0 }] })),
      dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM retention_deliveries WHERE status = 'failed'`),
    ]);
  return c.json({
    documents: {
      total: Number(documents?.c ?? 0),
      proposals: Number(proposals?.c ?? 0),
      contracts: Number(contracts?.c ?? 0),
      forms: Number(forms?.c ?? 0),
      invoices: Number(invoices?.c ?? 0),
    },
    tracked_visits: Number(trackedVisits?.c ?? 0),
    emails_sent: Number(emailsSent.rows[0]?.c ?? 0),
    emails_failed: Number(emailsFailed.rows[0]?.c ?? 0),
    retention_failures: Number(retentionFailures?.c ?? 0),
  });
});

admin.get('/users', async (c) => {
  const pagination = parsePagination(c, ADMIN_LIST_LIMIT);
  const plan = c.req.query('plan');
  const search = (c.req.query('search') ?? '').slice(0, 100);
  let where = `(email LIKE ? OR COALESCE(name,'') LIKE ?)`;
  const args: any[] = [`%${search}%`, `%${search}%`];
  if (plan) {
    where += ` AND plan = ?`;
    args.push(plan);
  }
  const total = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM users WHERE ${where}`, args);
  const rows = await tursoQuery(
    c.env,
    `SELECT id, email, name, plan, plan_expires_at, newsletter_opt_in, email_verified, created_at, last_login_at
     FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...args, pagination.limit, pagination.offset]
  );
  return c.json(paginated(rows.rows, Number(total.rows[0]?.c ?? 0), pagination));
});

admin.get('/users/:id', async (c) => {
  const row = await tursoQuery(c.env, `SELECT * FROM users WHERE id = ? LIMIT 1`, [c.req.param('id')]);
  if (row.rows.length === 0) return jsonError(c, 404, 'not_found', 'User not found.');
  const { password_hash, ...user } = row.rows[0] as any;
  const [payments, feedback, notes, identities, documents] = await Promise.all([
    tursoQuery(c.env, `SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC`, [c.req.param('id')]),
    tursoQuery(c.env, `SELECT * FROM feedback WHERE user_id = ?`, [c.req.param('id')]),
    tursoQuery(c.env, `SELECT * FROM admin_notes WHERE target_type = 'user' AND target_id = ?`, [c.req.param('id')]),
    tursoQuery(c.env, `SELECT provider, email_at_link, created_at, last_login_at FROM user_identities WHERE user_id = ?`, [c.req.param('id')]).catch(() => ({ rows: [] })),
    dbFirst<{ proposals: number; contracts: number; forms: number; invoices: number }>(
      c.env,
      `SELECT (SELECT COUNT(*) FROM proposals WHERE user_id = ?) as proposals,
              (SELECT COUNT(*) FROM contracts WHERE user_id = ?) as contracts,
              (SELECT COUNT(*) FROM forms WHERE user_id = ?) as forms,
              (SELECT COUNT(*) FROM invoices WHERE user_id = ?) as invoices`,
      [c.req.param('id'), c.req.param('id'), c.req.param('id'), c.req.param('id')]
    ),
  ]);
  return c.json({
    user,
    payments: payments.rows,
    feedback: feedback.rows,
    notes: notes.rows,
    identities: identities.rows,
    documents: documents ?? { proposals: 0, contracts: 0, forms: 0, invoices: 0 },
  });
});

admin.patch('/users/:id/plan', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!['free', 'starter', 'growth', 'scale', 'teams'].includes(String(body.plan ?? ''))) {
    return jsonError(c, 400, 'invalid_payload', 'Unknown plan.');
  }
  const user = await tursoQuery(c.env, `SELECT id FROM users WHERE id = ? LIMIT 1`, [c.req.param('id')]);
  if (user.rows.length === 0) return jsonError(c, 404, 'not_found', 'User not found.');

  await tursoExecute(c.env, `UPDATE users SET plan = ?, plan_expires_at = ?, updated_at = ? WHERE id = ?`, [
    body.plan,
    body.expires_at ?? null,
    new Date().toISOString(),
    c.req.param('id'),
  ]);
  if (body.plan !== 'free') {
    await tursoExecute(
      c.env,
      `INSERT INTO payments (id, user_id, plan, amount, currency, method, reference, status, paid_at, created_at)
       VALUES (?, ?, ?, ?, 'USD', 'manual', ?, 'paid', ?, ?)`,
      [
        generateId('pay'),
        c.req.param('id'),
        body.plan,
        Number(body.amount ?? 0),
        body.reference ?? null,
        new Date().toISOString(),
        new Date().toISOString(),
      ]
    );
  }
  await logAdminAction(c.env, {
    adminUser: requireAdminUser(c),
    action: 'user.plan_changed',
    targetType: 'user',
    targetId: c.req.param('id'),
    metadata: { plan: body.plan, amount: body.amount ?? 0 },
    ip: clientIp(c),
  });
  return c.json({ success: true });
});

admin.delete('/users/:id', async (c) => {
  const user = await tursoQuery(c.env, `SELECT id, email FROM users WHERE id = ? LIMIT 1`, [c.req.param('id')]);
  if (user.rows.length === 0) return jsonError(c, 404, 'not_found', 'User not found.');
  await tursoExecute(c.env, `DELETE FROM user_identities WHERE user_id = ?`, [c.req.param('id')]).catch(() => undefined);
  await tursoExecute(c.env, `DELETE FROM sessions WHERE user_id = ?`, [c.req.param('id')]).catch(() => undefined);
  await tursoExecute(c.env, `DELETE FROM users WHERE id = ?`, [c.req.param('id')]);
  await logAdminAction(c.env, {
    adminUser: requireAdminUser(c),
    action: 'user.deleted',
    targetType: 'user',
    targetId: c.req.param('id'),
    metadata: { email: user.rows[0].email },
    ip: clientIp(c),
  });
  return c.json({ success: true });
});

function simpleList(table: string, orderBy = 'created_at DESC') {
  return async (c: any) => {
    const pagination = parsePagination(c, ADMIN_LIST_LIMIT);
    const total = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM ${table}`);
    const rows = await tursoQuery(
      c.env,
      `SELECT * FROM ${table} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [pagination.limit, pagination.offset]
    );
    return c.json(paginated(rows.rows, Number(total.rows[0]?.c ?? 0), pagination));
  };
}

admin.get('/waitlist', simpleList('waitlist'));
admin.get('/beta-testers', simpleList('beta_testers'));
admin.get('/contact-messages', simpleList('contact_messages'));
admin.get('/website-help', simpleList('website_help_requests'));
admin.get('/payments', simpleList('payments'));
admin.get('/feedback', simpleList('feedback'));
admin.get('/notes', simpleList('admin_notes'));

admin.patch('/waitlist/:id/status', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.status) return jsonError(c, 400, 'invalid_payload', 'A status is required.');
  await tursoExecute(
    c.env,
    `UPDATE waitlist SET status = ?, invited_at = COALESCE(?, invited_at), paid_at = COALESCE(?, paid_at) WHERE id = ?`,
    [
      String(body.status),
      body.status === 'invited' ? new Date().toISOString() : null,
      body.status === 'paid' ? new Date().toISOString() : null,
      c.req.param('id'),
    ]
  );
  await logAdminAction(c.env, {
    adminUser: requireAdminUser(c),
    action: 'waitlist.status_changed',
    targetType: 'waitlist',
    targetId: c.req.param('id'),
    metadata: { status: body.status },
  });
  return c.json({ success: true });
});

admin.patch('/beta-testers/:id/status', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.status) return jsonError(c, 400, 'invalid_payload', 'A status is required.');
  await tursoExecute(c.env, `UPDATE beta_testers SET status = ? WHERE id = ?`, [String(body.status), c.req.param('id')]);
  await logAdminAction(c.env, {
    adminUser: requireAdminUser(c),
    action: 'beta.status_changed',
    targetType: 'beta_tester',
    targetId: c.req.param('id'),
    metadata: { status: body.status },
  });
  return c.json({ success: true });
});

admin.patch('/contact-messages/:id/status', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.status) return jsonError(c, 400, 'invalid_payload', 'A status is required.');
  await tursoExecute(c.env, `UPDATE contact_messages SET status = ? WHERE id = ?`, [String(body.status), c.req.param('id')]);
  return c.json({ success: true });
});

admin.patch('/website-help/:id/status', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.status) return jsonError(c, 400, 'invalid_payload', 'A status is required.');
  await tursoExecute(c.env, `UPDATE website_help_requests SET status = ? WHERE id = ?`, [String(body.status), c.req.param('id')]);
  return c.json({ success: true });
});

admin.patch('/feedback/:id/status', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.status) return jsonError(c, 400, 'invalid_payload', 'A status is required.');
  await tursoExecute(c.env, `UPDATE feedback SET status = ? WHERE id = ?`, [String(body.status), c.req.param('id')]);
  return c.json({ success: true });
});

// --- Newsletter -------------------------------------------------------------

admin.get('/newsletter', async (c) => {
  const pagination = parsePagination(c, ADMIN_LIST_LIMIT);
  const status = c.req.query('status');
  let where = '1 = 1';
  const args: any[] = [];
  if (status && ['pending', 'active', 'unsubscribed'].includes(status)) {
    where += ' AND status = ?';
    args.push(status);
  }
  const total = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM newsletter_subscribers WHERE ${where}`, args);
  const rows = await tursoQuery(
    c.env,
    `SELECT id, email, status, consent_source, consent_at, confirmed_at, unsubscribed_at, created_at
     FROM newsletter_subscribers WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...args, pagination.limit, pagination.offset]
  );
  return c.json(paginated(rows.rows, Number(total.rows[0]?.c ?? 0), pagination));
});

admin.get('/newsletter/export', async (c) => {
  const rows = await tursoQuery(
    c.env,
    `SELECT email, status, consent_source, consent_at, confirmed_at, unsubscribed_at, created_at
     FROM newsletter_subscribers ORDER BY created_at DESC LIMIT ?`,
    [NEWSLETTER_EXPORT_LIMIT]
  );
  const header = ['email', 'status', 'consent_source', 'consent_at', 'confirmed_at', 'unsubscribed_at', 'created_at'];
  const lines = [header.join(',')];
  for (const row of rows.rows as any[]) {
    lines.push(
      header
        .map((key) => {
          const value = row[key] === null || row[key] === undefined ? '' : String(row[key]);
          return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(',')
    );
  }
  await logAdminAction(c.env, {
    adminUser: requireAdminUser(c),
    action: 'newsletter.exported',
    metadata: { rows: rows.rows.length },
  });
  return new Response(`\uFEFF${lines.join('\r\n')}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="revercue-newsletter-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
});

// --- Templates --------------------------------------------------------------

admin.get('/templates', async (c) => {
  const pagination = parsePagination(c, ADMIN_LIST_LIMIT);
  const source = c.req.query('source');
  const where = source === 'built_in' || source === 'custom' ? 'WHERE t.source = ?' : '';
  const args: any[] = source === 'built_in' || source === 'custom' ? [source] : [];
  const total = await tursoQuery(
    c.env,
    `SELECT COUNT(*) as c FROM templates t ${where}`,
    args
  );
  const rows = await dbQuery(
    c.env,
    `SELECT t.*, m.description, m.category FROM templates t
     LEFT JOIN template_metadata m ON m.template_id = t.id
     ${where.replace('t.source', 't.source')} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
    [...args, pagination.limit, pagination.offset]
  );
  return c.json(paginated(rows, Number(total.rows[0]?.c ?? 0), pagination));
});

// --- Operational health -----------------------------------------------------

admin.get('/health', async (c) => {
  const [errors, retentionFailures, emailFailures] = await Promise.all([
    tursoQuery(c.env, `SELECT * FROM error_logs ORDER BY created_at DESC LIMIT 20`),
    listRetentionFailures(c.env, 20).catch(() => []),
    tursoQuery(
      c.env,
      `SELECT id, kind, to_email, subject, status, attempts, last_error, created_at, next_attempt_at
       FROM email_deliveries WHERE status IN ('failed','abandoned') ORDER BY updated_at DESC LIMIT 20`
    ).catch(() => ({ rows: [] })),
  ]);
  return c.json({
    errors: errors.rows,
    retention_failures: retentionFailures,
    email_failures: emailFailures.rows,
  });
});

admin.get('/retention-failures', async (c) => {
  return c.json({ data: await listRetentionFailures(c.env, ADMIN_LIST_LIMIT) });
});

admin.get('/email-deliveries', async (c) => {
  const pagination = parsePagination(c, ADMIN_LIST_LIMIT);
  const status = c.req.query('status');
  const where = status && ['queued', 'sending', 'sent', 'failed', 'abandoned', 'skipped'].includes(status) ? 'WHERE status = ?' : '';
  const args: any[] = where ? [status] : [];
  const total = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM email_deliveries ${where}`, args);
  const rows = await tursoQuery(
    c.env,
    `SELECT id, user_id, to_email, kind, subject, provider, status, attempts, last_error, created_at, sent_at, next_attempt_at
     FROM email_deliveries ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...args, pagination.limit, pagination.offset]
  );
  return c.json(paginated(rows.rows, Number(total.rows[0]?.c ?? 0), pagination));
});

admin.post('/email-deliveries/:id/retry', async (c) => {
  const result = await retryDeliveryById(c.env, c.req.param('id'));
  await logAdminAction(c.env, {
    adminUser: requireAdminUser(c),
    action: 'email.retried',
    targetType: 'email_delivery',
    targetId: c.req.param('id'),
    metadata: { ok: result.ok, status: result.status },
  });
  if (result.status === 'not_found') return jsonError(c, 404, 'not_found', 'Delivery not found.');
  return c.json({ success: result.ok, status: result.status, error: result.error ?? null });
});

admin.get('/errors', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM error_logs ORDER BY created_at DESC LIMIT ?`, [ADMIN_LIST_LIMIT]);
  return c.json({ data: rows.rows });
});

admin.get('/audit-log', async (c) => {
  const pagination = parsePagination(c, ADMIN_LIST_LIMIT);
  const total = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM admin_audit_log`);
  const rows = await tursoQuery(
    c.env,
    `SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [pagination.limit, pagination.offset]
  );
  return c.json(paginated(rows.rows, Number(total.rows[0]?.c ?? 0), pagination));
});

admin.get('/suggestions/instructions', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM instructions ORDER BY created_at DESC LIMIT ?`, [ADMIN_LIST_LIMIT]);
  return c.json({ data: rows.rows });
});

admin.post('/suggestions/instructions', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.name || !b.body || !b.action) return jsonError(c, 400, 'invalid_payload', 'name, body and action are required.');
  const id = generateId('ins');
  await tursoExecute(
    c.env,
    `INSERT INTO instructions (id, name, body, action, tags, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [id, b.name, b.body, b.action, JSON.stringify(b.tags ?? []), new Date().toISOString(), new Date().toISOString()]
  );
  await logAdminAction(c.env, { adminUser: requireAdminUser(c), action: 'instruction.created', targetType: 'instruction', targetId: id });
  return c.json({ success: true, id }, 201);
});

admin.get('/suggestions/patterns', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM patterns ORDER BY created_at DESC LIMIT ?`, [ADMIN_LIST_LIMIT]);
  return c.json({ data: rows.rows });
});

admin.post('/suggestions/patterns', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.name || !b.rule) return jsonError(c, 400, 'invalid_payload', 'name and rule are required.');
  const id = generateId('pat');
  await tursoExecute(
    c.env,
    `INSERT INTO patterns (id, name, rule, tags, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [id, b.name, JSON.stringify(b.rule), JSON.stringify(b.tags ?? []), new Date().toISOString(), new Date().toISOString()]
  );
  return c.json({ success: true, id }, 201);
});

admin.get('/suggestions/pairings', async (c) => {
  const rows = await tursoQuery(c.env, `SELECT * FROM pairings ORDER BY created_at DESC LIMIT ?`, [ADMIN_LIST_LIMIT]);
  return c.json({ data: rows.rows });
});

admin.post('/suggestions/pairings', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.pattern_id || !b.instruction_id) return jsonError(c, 400, 'invalid_payload', 'pattern_id and instruction_id are required.');
  const id = generateId('pair');
  await tursoExecute(
    c.env,
    `INSERT INTO pairings (id, pattern_id, instruction_id, plan, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [id, b.pattern_id, b.instruction_id, b.plan ?? 'growth', b.priority ?? 1, new Date().toISOString(), new Date().toISOString()]
  );
  return c.json({ success: true, id }, 201);
});

admin.post('/notes', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.note) return jsonError(c, 400, 'invalid_payload', 'A note is required.');
  const id = generateId('note');
  await tursoExecute(
    c.env,
    `INSERT INTO admin_notes (id, admin_user_id, target_type, target_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, requireAdminUser(c), b.target_type ?? (b.user_id ? 'user' : 'general'), b.target_id ?? b.user_id ?? null, String(b.note).slice(0, 5000), new Date().toISOString()]
  );
  await logAdminAction(c.env, { adminUser: requireAdminUser(c), action: 'note.created', targetType: b.target_type ?? 'general', targetId: id });
  return c.json({ success: true, id }, 201);
});

export default admin;
