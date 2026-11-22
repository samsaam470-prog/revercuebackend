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
import { createNotification } from '../services/notifications';
import { runAuthActionSync, getLastSyncStatus, getIdentityCounts } from '../services/authaction-sync';
import { getManagementUser } from '../services/authaction-management';
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
    ).catch(() => ({ proposals: 0, contracts: 0, forms: 0, invoices: 0 })),
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

// --- AuthAction identity directory -----------------------------------------

admin.get('/identities/sync-status', async (c) => {
  const [status, counts] = await Promise.all([getLastSyncStatus(c.env), getIdentityCounts(c.env)]);
  return c.json({ sync: status, counts });
});

admin.post('/identities/sync', async (c) => {
  // Avoid overlapping runs: if a run is currently 'running', return its status.
  const last = await getLastSyncStatus(c.env);
  if (last && last.status === 'running') {
    return c.json({ success: false, message: 'A sync is already running.', run: last }, 409);
  }
  const result = await runAuthActionSync(c.env, requireAdminUser(c));
  await logAdminAction(c.env, {
    adminUser: requireAdminUser(c),
    action: 'authaction.sync',
    metadata: { status: result.status, totalFetched: result.totalFetched, upserted: result.upserted },
    ip: clientIp(c),
  });
  return c.json({ success: result.status === 'success', ...result });
});

admin.get('/identities', async (c) => {
  const pagination = parsePagination(c, ADMIN_LIST_LIMIT);
  const search = (c.req.query('search') ?? '').slice(0, 100);
  const status = c.req.query('status'); // linked | unlinked | onboarding_incomplete | blocked
  const plan = c.req.query('plan');
  const linked = c.req.query('linked'); // 'true' | 'false'

  const conds: string[] = [];
  const args: any[] = [];
  if (search) {
    conds.push(`(a.email LIKE ? OR COALESCE(a.name,'') LIKE ? OR a.id LIKE ?)`);
    args.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (linked === 'true') conds.push(`a.linked_user_id IS NOT NULL`);
  else if (linked === 'false') conds.push(`a.linked_user_id IS NULL`);
  if (status === 'linked') conds.push(`a.linked_user_id IS NOT NULL`);
  else if (status === 'unlinked') conds.push(`a.linked_user_id IS NULL`);
  else if (status === 'blocked') conds.push(`a.is_blocked = 1`);
  if (status === 'onboarding_incomplete') {
    conds.push(`a.linked_user_id IN (SELECT id FROM users WHERE COALESCE(onboarding_step,0) > 0 AND COALESCE(onboarding_step,0) < 6)`);
  }
  if (plan) {
    conds.push(`a.linked_user_id IN (SELECT id FROM users WHERE plan = ?)`);
    args.push(plan);
  }
  const where = conds.length ? conds.join(' AND ') : '1 = 1';

  const total = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM authaction_identities a WHERE ${where}`, args);
  const rows = await tursoQuery(
    c.env,
    `SELECT a.*, u.plan as user_plan, u.onboarding_step as user_onboarding_step, u.email as user_email
     FROM authaction_identities a
     LEFT JOIN users u ON u.id = a.linked_user_id
     WHERE ${where}
     ORDER BY a.authaction_created_at DESC, a.synced_at DESC LIMIT ? OFFSET ?`,
    [...args, pagination.limit, pagination.offset]
  );
  return c.json(paginated(rows.rows, Number(total.rows[0]?.c ?? 0), pagination));
});

admin.get('/identities/:id', async (c) => {
  const id = c.req.param('id');
  const rows = await tursoQuery(c.env, `SELECT * FROM authaction_identities WHERE id = ? LIMIT 1`, [id]);
  if (rows.rows.length === 0) {
    // Fall back to live fetch from AuthAction.
    const live = await getManagementUser(c.env, id).catch(() => null);
    if (!live) return jsonError(c, 404, 'not_found', 'Identity not found.');
    return c.json({ identity: live, linked_user: null, payments: [], feedback: [], notes: [], documents: { proposals: 0, contracts: 0, forms: 0, invoices: 0 } });
  }
  const identity = rows.rows[0];
  const linkedUserId = identity.linked_user_id;
  let linkedUser: any = null;
  let payments: any[] = [];
  let feedback: any[] = [];
  let notes: any[] = [];
  let documents = { proposals: 0, contracts: 0, forms: 0, invoices: 0 };
  let onboarding = null;
  if (linkedUserId) {
    const u = await tursoQuery(c.env, `SELECT * FROM users WHERE id = ? LIMIT 1`, [linkedUserId]);
    if (u.rows.length > 0) {
      const { password_hash, ...user } = u.rows[0] as any;
      linkedUser = user;
      const [p, f, n, d] = await Promise.all([
        tursoQuery(c.env, `SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC`, [linkedUserId]),
        tursoQuery(c.env, `SELECT * FROM feedback WHERE user_id = ?`, [linkedUserId]),
        tursoQuery(c.env, `SELECT * FROM admin_notes WHERE target_type = 'user' AND target_id = ?`, [linkedUserId]),
        dbFirst<{ proposals: number; contracts: number; forms: number; invoices: number }>(
          c.env,
          `SELECT (SELECT COUNT(*) FROM proposals WHERE user_id = ?) as proposals,
                  (SELECT COUNT(*) FROM contracts WHERE user_id = ?) as contracts,
                  (SELECT COUNT(*) FROM forms WHERE user_id = ?) as forms,
                  (SELECT COUNT(*) FROM invoices WHERE user_id = ?) as invoices`,
          [linkedUserId, linkedUserId, linkedUserId, linkedUserId]
        ).catch(() => ({ proposals: 0, contracts: 0, forms: 0, invoices: 0 })),
      ]);
      payments = p.rows;
      feedback = f.rows;
      notes = n.rows;
      documents = d ?? documents;
    }
  }
  return c.json({ identity, linked_user: linkedUser, payments, feedback, notes, documents, onboarding });
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
  createNotification(c.env, {
    userId: c.req.param('id'),
    eventType: 'subscription_activated',
    title: 'Subscription updated',
    body: `Your plan has been updated to ${body.plan}.`,
  }).catch(() => undefined);
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

// --- Announcements (admin) -------------------------------------------------

admin.get('/announcements', async (c) => {
  const pagination = parsePagination(c, ADMIN_LIST_LIMIT);
  const status = c.req.query('status');
  let where = '1 = 1';
  const args: any[] = [];
  if (status && ['draft', 'scheduled', 'published', 'archived'].includes(status)) {
    where += ' AND status = ?';
    args.push(status);
  }
  const total = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM announcements WHERE ${where}`, args);
  const rows = await tursoQuery(
    c.env,
    `SELECT * FROM announcements WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...args, pagination.limit, pagination.offset]
  );
  return c.json(paginated(rows.rows, Number(total.rows[0]?.c ?? 0), pagination));
});

admin.post('/announcements', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.title || !b.body) return jsonError(c, 400, 'invalid_payload', 'title and body are required.');
  const id = generateId('ann');
  const now = new Date().toISOString();
  const status = b.status && ['draft', 'scheduled', 'published', 'archived'].includes(b.status) ? b.status : 'draft';
  await tursoExecute(
    c.env,
    `INSERT INTO announcements (id, title, body, type, image_url, link_url, target_audience, target_plans, status, starts_at, expires_at, created_by, published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      String(b.title).slice(0, 300),
      String(b.body),
      b.type && ['general', 'update', 'feature', 'maintenance', 'important'].includes(b.type) ? b.type : 'general',
      b.image_url ?? null,
      b.link_url ?? null,
      b.target_audience ?? 'all',
      b.target_plans ? JSON.stringify(b.target_plans) : null,
      status,
      b.starts_at ?? null,
      b.expires_at ?? null,
      requireAdminUser(c),
      status === 'published' ? now : null,
      now,
      now,
    ]
  );
  await logAdminAction(c.env, { adminUser: requireAdminUser(c), action: 'announcement.created', targetType: 'announcement', targetId: id });
  return c.json({ success: true, id }, 201);
});

admin.patch('/announcements/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const id = c.req.param('id');
  const existing = await tursoQuery(c.env, `SELECT id, status FROM announcements WHERE id = ? LIMIT 1`, [id]);
  if (existing.rows.length === 0) return jsonError(c, 404, 'not_found', 'Announcement not found.');
  const now = new Date().toISOString();
  const fields: string[] = [];
  const args: any[] = [];
  const updatable = ['title', 'body', 'type', 'image_url', 'link_url', 'target_audience', 'target_plans', 'starts_at', 'expires_at', 'status'];
  for (const key of updatable) {
    if (b[key] !== undefined) {
      fields.push(`${key} = ?`);
      if (key === 'target_plans') args.push(b[key] ? JSON.stringify(b[key]) : null);
      else args.push(b[key]);
    }
  }
  if (b.status === 'published' && existing.rows[0].status !== 'published') {
    fields.push('published_at = ?');
    args.push(now);
  }
  if (fields.length === 0) return c.json({ success: true });
  fields.push('updated_at = ?');
  args.push(now, id);
  await tursoExecute(c.env, `UPDATE announcements SET ${fields.join(', ')} WHERE id = ?`, args);
  await logAdminAction(c.env, { adminUser: requireAdminUser(c), action: 'announcement.updated', targetType: 'announcement', targetId: id, metadata: b });
  return c.json({ success: true });
});

admin.delete('/announcements/:id', async (c) => {
  const id = c.req.param('id');
  await tursoExecute(c.env, `UPDATE announcements SET status = 'archived', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
  await logAdminAction(c.env, { adminUser: requireAdminUser(c), action: 'announcement.archived', targetType: 'announcement', targetId: id });
  return c.json({ success: true });
});

// --- Admin notifications (campaigns) ---------------------------------------

admin.get('/notifications', async (c) => {
  const pagination = parsePagination(c, ADMIN_LIST_LIMIT);
  const status = c.req.query('status');
  let where = '1 = 1';
  const args: any[] = [];
  if (status && ['draft', 'scheduled', 'sent', 'cancelled'].includes(status)) {
    where += ' AND status = ?';
    args.push(status);
  }
  const total = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM admin_notification_campaigns WHERE ${where}`, args);
  const rows = await tursoQuery(
    c.env,
    `SELECT * FROM admin_notification_campaigns WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...args, pagination.limit, pagination.offset]
  );
  return c.json(paginated(rows.rows, Number(total.rows[0]?.c ?? 0), pagination));
});

async function resolveTargetUsers(env: Bindings, campaign: any): Promise<string[]> {
  const audience = campaign.target_audience ?? 'all';
  if (audience === 'specific' && campaign.target_user_ids) {
    try { return JSON.parse(campaign.target_user_ids); } catch { return []; }
  }
  let sql = `SELECT id FROM users`;
  const args: any[] = [];
  const conds: string[] = [];
  if (audience === 'free') { conds.push(`plan = 'free'`); }
  else if (audience === 'paid') { conds.push(`plan IN ('starter','growth','scale','teams')`); }
  else if (audience === 'active_subscribers') { conds.push(`plan IN ('starter','growth','scale','teams')`); }
  if (campaign.target_plans) {
    try {
      const plans = JSON.parse(campaign.target_plans);
      if (Array.isArray(plans) && plans.length) {
        conds.push(`plan IN (${plans.map(() => '?').join(',')})`);
        args.push(...plans);
      }
    } catch {}
  }
  if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
  const rows = await tursoQuery(env, sql, args);
  return rows.rows.map((r: any) => String(r.id));
}

admin.post('/notifications', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.title) return jsonError(c, 400, 'invalid_payload', 'title is required.');
  const id = generateId('anc');
  const now = new Date().toISOString();
  const status = b.scheduled_at ? 'scheduled' : (b.send_now === false ? 'draft' : 'sent');
  await tursoExecute(
    c.env,
    `INSERT INTO admin_notification_campaigns (id, title, body, category, target_audience, target_plans, target_user_ids, scheduled_at, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      String(b.title).slice(0, 300),
      b.body ?? null,
      b.category ?? 'general',
      b.target_audience ?? 'all',
      b.target_plans ? JSON.stringify(b.target_plans) : null,
      b.target_user_ids ? JSON.stringify(b.target_user_ids) : null,
      b.scheduled_at ?? null,
      status,
      requireAdminUser(c),
      now,
      now,
    ]
  );

  // If sending now, deliver immediately.
  if (status === 'sent') {
    await deliverCampaign(c.env, id);
  }
  await logAdminAction(c.env, { adminUser: requireAdminUser(c), action: 'notification.created', targetType: 'admin_notification', targetId: id, metadata: { status } });
  return c.json({ success: true, id, status }, 201);
});

export async function deliverCampaign(env: Bindings, campaignId: string): Promise<void> {
  const rows = await tursoQuery(env, `SELECT * FROM admin_notification_campaigns WHERE id = ? LIMIT 1`, [campaignId]);
  if (rows.rows.length === 0) return;
  const campaign = rows.rows[0];
  const userIds = await resolveTargetUsers(env, campaign);
  const now = new Date().toISOString();
  let sent = 0;
  let failed = 0;
  for (const userId of userIds) {
    const deliveryId = generateId('and');
    try {
      const notifId = await (async () => {
        const nid = generateId('notif');
        await tursoExecute(
          env,
          `INSERT INTO notifications (id, user_id, event_type, client_id, document_id, title, body, read, dismissed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
          [nid, userId, `admin:${campaign.category ?? 'general'}`, null, null, campaign.title, campaign.body ?? null, now]
        );
        return nid;
      })();
      await tursoExecute(
        env,
        `INSERT INTO admin_notification_deliveries (id, campaign_id, user_id, notification_id, status, attempts, delivered_at, created_at) VALUES (?, ?, ?, ?, 'sent', 1, ?, ?)`,
        [deliveryId, campaignId, userId, notifId, now, now]
      );
      sent += 1;
    } catch (e: any) {
      await tursoExecute(
        env,
        `INSERT INTO admin_notification_deliveries (id, campaign_id, user_id, notification_id, status, attempts, last_error, created_at) VALUES (?, ?, ?, NULL, 'failed', 1, ?, ?)`,
        [deliveryId, campaignId, userId, String(e?.message ?? e).slice(0, 500), now]
      ).catch(() => undefined);
      failed += 1;
    }
  }
  await tursoExecute(
    env,
    `UPDATE admin_notification_campaigns SET status = 'sent', published_at = COALESCE(published_at, ?), delivery_total = ?, delivery_sent = ?, delivery_failed = ?, updated_at = ? WHERE id = ?`,
    [now, userIds.length, sent, failed, now, campaignId]
  );
}

admin.post('/notifications/:id/send', async (c) => {
  const id = c.req.param('id');
  await deliverCampaign(c.env, id);
  await logAdminAction(c.env, { adminUser: requireAdminUser(c), action: 'notification.sent', targetType: 'admin_notification', targetId: id });
  return c.json({ success: true });
});

admin.post('/notifications/:id/retry', async (c) => {
  // Retry failed deliveries for a campaign.
  const id = c.req.param('id');
  const failed = await tursoQuery(c.env, `SELECT * FROM admin_notification_deliveries WHERE campaign_id = ? AND status = 'failed'`, [id]);
  const campaignRows = await tursoQuery(c.env, `SELECT * FROM admin_notification_campaigns WHERE id = ? LIMIT 1`, [id]);
  if (campaignRows.rows.length === 0) return jsonError(c, 404, 'not_found', 'Campaign not found.');
  const campaign = campaignRows.rows[0];
  const now = new Date().toISOString();
  let retried = 0;
  for (const d of failed.rows) {
    const deliveryId = generateId('and');
    try {
      const nid = generateId('notif');
      await tursoExecute(
        c.env,
        `INSERT INTO notifications (id, user_id, event_type, title, body, read, dismissed, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
        [nid, d.user_id, `admin:${campaign.category ?? 'general'}`, campaign.title, campaign.body ?? null, now]
      );
      await tursoExecute(
        c.env,
        `UPDATE admin_notification_deliveries SET status = 'sent', notification_id = ?, delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?`,
        [nid, now, d.id]
      );
      retried += 1;
    } catch (e: any) {
      await tursoExecute(
        c.env,
        `UPDATE admin_notification_deliveries SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
        [String(e?.message ?? e).slice(0, 500), d.id]
      ).catch(() => undefined);
    }
  }
  await logAdminAction(c.env, { adminUser: requireAdminUser(c), action: 'notification.retried', targetType: 'admin_notification', targetId: id, metadata: { retried } });
  return c.json({ success: true, retried });
});

admin.post('/notifications/:id/cancel', async (c) => {
  const id = c.req.param('id');
  await tursoExecute(c.env, `UPDATE admin_notification_campaigns SET status = 'cancelled', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
  await logAdminAction(c.env, { adminUser: requireAdminUser(c), action: 'notification.cancelled', targetType: 'admin_notification', targetId: id });
  return c.json({ success: true });
});

admin.get('/notifications/:id', async (c) => {
  const id = c.req.param('id');
  const campaignRows = await tursoQuery(c.env, `SELECT * FROM admin_notification_campaigns WHERE id = ? LIMIT 1`, [id]);
  if (campaignRows.rows.length === 0) return jsonError(c, 404, 'not_found', 'Campaign not found.');
  const deliveries = await tursoQuery(c.env, `SELECT * FROM admin_notification_deliveries WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 200`, [id]);
  // read/unread counts
  const readCount = await tursoQuery(c.env, `SELECT COUNT(*) as c FROM admin_notification_deliveries WHERE campaign_id = ? AND read_at IS NOT NULL`, [id]);
  return c.json({
    campaign: campaignRows.rows[0],
    deliveries: deliveries.rows,
    read_count: Number(readCount.rows[0]?.c ?? 0),
  });
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
