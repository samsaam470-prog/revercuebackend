import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { dbQuery, dbFirst, dbRun } from '../utils/db';
import { generateId } from '../utils/ids';
import { userAuthMiddleware, getAuth } from '../middleware/user-auth';
import { getRevenueSummary, addExpense } from '../services/revenue';
import { getPriceSuggestion } from '../services/price-suggestion';
import { putObject } from '../services/storage';
import { buildPdf, pdfResponse } from '../services/pdf-binary';
import { jsonError } from '../utils/api-errors';
import {
  parseStoredPreferences,
  mergePreferences,
  serializePreferences,
  DEFAULT_PREFERENCES,
} from '../services/notification-preferences';
import {
  SAVED_FAQ_LIMIT,
  SAVED_PACKAGE_LIMIT,
  REVENUE_TRACKER,
  EXPENSE_ENTRY,
  WHAT_REVERCUE_KNOWS,
  ACTIVE_DOCUMENT_LIMIT,
  ARCHIVE_COUNT_LIMIT,
  PASSWORD_PROTECTED_LIMIT,
  STORAGE_MB,
  IMAGE_UPLOAD_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES,
} from '../config/constants';
import type { Bindings } from '../types';

const settings = new Hono<{ Bindings: Bindings }>();
settings.use('*', userAuthMiddleware);

async function getPlan(env: Bindings, uid: string): Promise<string> {
  const u = await tursoQuery(env, `SELECT plan FROM users WHERE id = ? LIMIT 1`, [uid]);
  return String(u.rows[0]?.plan ?? 'free');
}

function parseJson(value: unknown): any {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

settings.get('/profile', async (c) => {
  const auth = getAuth(c);
  const row = await tursoQuery(c.env, `SELECT * FROM users WHERE id = ? LIMIT 1`, [auth.userId]);
  const branding = await tursoQuery(c.env, `SELECT logo_key FROM user_branding WHERE user_id = ? LIMIT 1`, [
    auth.userId,
  ]).catch(() => ({ rows: [] as any[] }));
  const user = row.rows[0] ?? {};
  const { password_hash, ...safe } = user as any;
  return c.json({
    profile: {
      ...safe,
      services: parseJson(safe.services) ?? [],
      logo_url: branding.rows[0]?.logo_key ? `/api/files/${branding.rows[0].logo_key}` : null,
      notifications: parseStoredPreferences(user),
    },
  });
});

settings.patch('/profile', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  await tursoExecute(
    c.env,
    `UPDATE users SET name = COALESCE(?, name), business_name = COALESCE(?, business_name), website = COALESCE(?, website),
       fiverr_profile = COALESCE(?, fiverr_profile), services = COALESCE(?, services),
       brand_primary = COALESCE(?, brand_primary), brand_secondary = COALESCE(?, brand_secondary), updated_at = ?
     WHERE id = ?`,
    [
      b.name ?? null,
      b.business_name ?? null,
      b.website ?? null,
      b.fiverr_profile ?? null,
      b.services ? JSON.stringify(b.services) : null,
      b.brand_primary ?? null,
      b.brand_secondary ?? null,
      new Date().toISOString(),
      auth.userId,
    ]
  );
  return c.json({ success: true });
});

settings.post('/logo', async (c) => {
  const auth = getAuth(c);
  const contentType = c.req.header('Content-Type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return jsonError(c, 400, 'invalid_payload', 'Upload the logo as multipart/form-data with a `logo` field.');
  }
  const body = await c.req.parseBody();
  const file = (body['logo'] ?? body['file']) as File | undefined;
  if (!(file instanceof File)) return jsonError(c, 400, 'invalid_payload', 'No logo provided.');
  const maxBytes = Number(c.env.MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES);
  if (file.size > maxBytes) return jsonError(c, 413, 'file_too_large', 'The logo is too large.');
  if (!IMAGE_UPLOAD_TYPES.includes(file.type)) {
    return jsonError(c, 400, 'invalid_file_type', 'Upload a PNG, JPEG or WebP image.');
  }
  const extension = file.type === 'image/png' ? 'png' : file.type === 'image/jpeg' ? 'jpg' : 'webp';
  const key = `public/logos/${auth.userId}/${generateId('logo')}.${extension}`;
  const uploaded = await putObject(c.env, key, await file.arrayBuffer(), file.type);
  if (!uploaded.ok) return jsonError(c, 502, 'upload_failed', 'The logo could not be stored.');

  await tursoExecute(
    c.env,
    `INSERT INTO user_branding (user_id, logo_key, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET logo_key = excluded.logo_key, updated_at = excluded.updated_at`,
    [auth.userId, key, new Date().toISOString()]
  );
  return c.json({ success: true, url: `/api/files/${key}`, key });
});

settings.get('/plan', async (c) => {
  const auth = getAuth(c);
  const user = await tursoQuery(c.env, `SELECT plan, plan_expires_at FROM users WHERE id = ? LIMIT 1`, [auth.userId]);
  const plan = String(user.rows[0]?.plan ?? 'free');

  const [activeDocs, archived, protectedDocs, storage, payments] = await Promise.all([
    dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'published'`, [
      auth.userId,
    ]),
    dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'archived'`, [
      auth.userId,
    ]),
    dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND password_protected = 1`, [
      auth.userId,
    ]),
    dbFirst<{ total: number }>(c.env, `SELECT COALESCE(SUM(size_bytes), 0) as total FROM file_uploads WHERE user_id = ?`, [
      auth.userId,
    ]).catch(() => ({ total: 0 })),
    tursoQuery(c.env, `SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [auth.userId]),
  ]);

  const storageLimitMb = STORAGE_MB[plan as keyof typeof STORAGE_MB] ?? 50;
  return c.json({
    plan,
    expires_at: user.rows[0]?.plan_expires_at ?? null,
    renewal_date: user.rows[0]?.plan_expires_at ?? null,
    active_documents: Number(activeDocs?.c ?? 0),
    archive_count: Number(archived?.c ?? 0),
    password_protected: Number(protectedDocs?.c ?? 0),
    storage_gb: Number(((Number(storage?.total ?? 0) / (1024 * 1024)) / 1024).toFixed(3)),
    limits: {
      active_documents: ACTIVE_DOCUMENT_LIMIT[plan as keyof typeof ACTIVE_DOCUMENT_LIMIT] ?? null,
      storage_gb: Number((storageLimitMb / 1024).toFixed(3)),
      archive_count: ARCHIVE_COUNT_LIMIT[plan as keyof typeof ARCHIVE_COUNT_LIMIT] ?? null,
      password_protected: PASSWORD_PROTECTED_LIMIT[plan as keyof typeof PASSWORD_PROTECTED_LIMIT] ?? 0,
    },
    payments: payments.rows,
  });
});

settings.get('/plan/receipt/:paymentId', async (c) => {
  const auth = getAuth(c);
  const row = await tursoQuery(
    c.env,
    `SELECT * FROM payments WHERE id = ? AND user_id = ? LIMIT 1`,
    [c.req.param('paymentId'), auth.userId]
  );
  if (row.rows.length === 0) return jsonError(c, 404, 'not_found', 'Receipt not found.');
  const payment = row.rows[0];
  const bytes = await buildPdf(
    `Revercue receipt ${payment.id}`,
    [
      { heading: 'Payment', body: `${payment.amount} ${payment.currency ?? 'USD'} — ${payment.status}` },
      { heading: 'Plan', body: String(payment.plan ?? '-') },
      { heading: 'Method', body: String(payment.method ?? '-') },
      { heading: 'Reference', body: String(payment.reference ?? '-') },
      { heading: 'Date', body: String(payment.paid_at ?? payment.created_at ?? '-') },
    ],
    { subtitle: 'Issued by Revercue', footer: `Receipt ID ${payment.id}` }
  );
  return pdfResponse(bytes, `revercue-receipt-${payment.id}.pdf`, 'attachment');
});

settings.post('/plan/upgrade-request', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  if (!['starter', 'growth', 'scale', 'teams'].includes(String(b.plan ?? ''))) {
    return jsonError(c, 400, 'invalid_payload', 'Unknown plan.');
  }
  await tursoExecute(
    c.env,
    `INSERT INTO payment_requests (id, user_id, plan_requested, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
    [generateId('preq'), auth.userId, b.plan, new Date().toISOString()]
  );
  return c.json({ success: true }, 201);
});

settings.post('/plan/downgrade', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  const targetPlan = ['free', 'starter', 'growth', 'scale', 'teams'].includes(String(b.plan ?? ''))
    ? String(b.plan)
    : 'free';
  const keepIds: string[] = Array.isArray(b.keep_document_ids) ? b.keep_document_ids.map(String) : [];
  const user = await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ? LIMIT 1`, [auth.userId]);
  const currentPlan = String(user.rows[0]?.plan ?? 'free');
  if (currentPlan === targetPlan) return jsonError(c, 400, 'invalid_payload', 'Already on this plan.');

  const newLimit = ACTIVE_DOCUMENT_LIMIT[targetPlan as keyof typeof ACTIVE_DOCUMENT_LIMIT] ?? 5;
  const allDocs = await dbQuery<any>(
    c.env,
    `SELECT id FROM proposals WHERE user_id = ? AND status = 'published' ORDER BY created_at DESC`,
    [auth.userId]
  );
  const kept = allDocs.filter((d) => keepIds.includes(d.id)).slice(0, newLimit);
  const toArchive = allDocs.filter((d) => !kept.some((k) => k.id === d.id));
  const now = new Date().toISOString();
  for (const doc of toArchive) {
    await dbRun(
      c.env,
      `UPDATE proposals SET status = 'archived', archived_at = ?, archive_retention_days = 30, archive_deletion_date = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [now, new Date(Date.now() + 30 * 86400000).toISOString(), now, doc.id, auth.userId]
    );
  }
  await tursoExecute(c.env, `UPDATE users SET plan = ?, updated_at = ? WHERE id = ?`, [targetPlan, now, auth.userId]);
  return c.json({ success: true, plan: targetPlan, archived_count: toArchive.length });
});

settings.post('/security/change-password', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  // AuthAction owns passwords. Revercue's legacy password only exists during the
  // transition, so this endpoint is honest about who changes the credential.
  const user = await tursoQuery(c.env, `SELECT password_hash FROM users WHERE id = ? LIMIT 1`, [auth.userId]);
  if (!user.rows[0]?.password_hash) {
    return jsonError(
      c,
      409,
      'password_managed_by_authaction',
      'Your password is managed by AuthAction. Change it from your AuthAction account settings.'
    );
  }
  if (!(await bcrypt.compare(String(b.current_password ?? ''), String(user.rows[0].password_hash)))) {
    return jsonError(c, 401, 'invalid_credentials', 'The current password is not correct.');
  }
  if (!b.new_password || String(b.new_password).length < 8) {
    return jsonError(c, 400, 'invalid_payload', 'The new password must be at least 8 characters.');
  }
  const hash = await bcrypt.hash(String(b.new_password), 10);
  await tursoExecute(c.env, `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, [
    hash,
    new Date().toISOString(),
    auth.userId,
  ]);
  await tursoExecute(c.env, `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [
    new Date().toISOString(),
    auth.userId,
  ]);
  return c.json({ success: true });
});

settings.get('/security/sessions', async (c) => {
  const auth = getAuth(c);
  const rows = await tursoQuery(
    c.env,
    `SELECT id, device, browser, location, last_active_at, created_at, ip_hash FROM sessions
     WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_active_at DESC LIMIT 50`,
    [auth.userId]
  );
  const data = rows.rows.map((row: any) => ({
    id: row.id,
    device: row.device,
    browser: row.browser,
    location: row.location,
    last_active_at: row.last_active_at,
    created_at: row.created_at,
    current: auth.sessionId ? row.id === auth.sessionId : false,
  }));
  return c.json({ data });
});

settings.post('/security/sessions/:id/logout', async (c) => {
  const auth = getAuth(c);
  await tursoExecute(c.env, `UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?`, [
    new Date().toISOString(),
    c.req.param('id'),
    auth.userId,
  ]);
  return c.json({ success: true });
});

settings.post('/security/sessions/logout-all', async (c) => {
  const auth = getAuth(c);
  await tursoExecute(c.env, `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [
    new Date().toISOString(),
    auth.userId,
  ]);
  return c.json({ success: true });
});

settings.get('/notifications', async (c) => {
  const auth = getAuth(c);
  const row = await tursoQuery(
    c.env,
    `SELECT notifications_enabled, notification_events, newsletter_opt_in FROM users WHERE id = ? LIMIT 1`,
    [auth.userId]
  );
  return c.json(parseStoredPreferences(row.rows[0] ?? {}));
});

settings.patch('/notifications', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  const row = await tursoQuery(
    c.env,
    `SELECT notifications_enabled, notification_events, newsletter_opt_in FROM users WHERE id = ? LIMIT 1`,
    [auth.userId]
  );
  const current = parseStoredPreferences(row.rows[0] ?? {});
  const merged = mergePreferences(current, b);
  const serialized = serializePreferences(merged);
  await tursoExecute(
    c.env,
    `UPDATE users SET notifications_enabled = ?, notification_events = ?, newsletter_opt_in = ?, updated_at = ? WHERE id = ?`,
    [serialized.notifications_enabled, serialized.notification_events, serialized.newsletter_opt_in, new Date().toISOString(), auth.userId]
  );
  return c.json({ success: true, ...merged });
});

/** FormSubmit is retired. The endpoint stays only to return a clear error. */
settings.post('/formsubmit-activate', async (c) => {
  return jsonError(
    c,
    410,
    'retired',
    'FormSubmit has been removed. Revercue sends its own email and no activation is required.'
  );
});

settings.get('/saved-faqs', async (c) => {
  const auth = getAuth(c);
  const rows = await dbQuery(c.env, `SELECT * FROM saved_faqs WHERE user_id = ? ORDER BY created_at DESC`, [auth.userId]);
  return c.json({ data: rows });
});

settings.post('/saved-faqs', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  if (!b.question || !b.answer) return jsonError(c, 400, 'invalid_payload', 'Question and answer are required.');
  const plan = await getPlan(c.env, auth.userId);
  const count = await dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM saved_faqs WHERE user_id = ?`, [
    auth.userId,
  ]);
  const limit = SAVED_FAQ_LIMIT[plan as keyof typeof SAVED_FAQ_LIMIT] ?? 0;
  if (Number(count?.c ?? 0) >= limit) {
    return jsonError(c, 403, 'plan_limit_reached', `Your plan allows ${limit} saved FAQs.`);
  }
  const id = generateId('faq');
  await dbRun(
    c.env,
    `INSERT INTO saved_faqs (id, user_id, question, answer, title, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, auth.userId, String(b.question).slice(0, 500), String(b.answer).slice(0, 5000), b.title ?? null, new Date().toISOString()]
  );
  return c.json({ success: true, id }, 201);
});

settings.patch('/saved-faqs/:id', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  await dbRun(
    c.env,
    `UPDATE saved_faqs SET question = COALESCE(?, question), answer = COALESCE(?, answer), title = COALESCE(?, title) WHERE id = ? AND user_id = ?`,
    [b.question ?? null, b.answer ?? null, b.title ?? null, c.req.param('id'), auth.userId]
  );
  return c.json({ success: true });
});

settings.post('/saved-faqs/:id/keep', async (c) => {
  const auth = getAuth(c);
  await dbRun(c.env, `UPDATE saved_faqs SET last_used_at = ? WHERE id = ? AND user_id = ?`, [
    new Date().toISOString(),
    c.req.param('id'),
    auth.userId,
  ]);
  return c.json({ success: true });
});

settings.delete('/saved-faqs/:id', async (c) => {
  const auth = getAuth(c);
  await dbRun(c.env, `DELETE FROM saved_faqs WHERE id = ? AND user_id = ?`, [c.req.param('id'), auth.userId]);
  return c.json({ success: true });
});

settings.get('/saved-packages', async (c) => {
  const auth = getAuth(c);
  const rows = await dbQuery(c.env, `SELECT * FROM saved_packages WHERE user_id = ? ORDER BY created_at DESC`, [
    auth.userId,
  ]);
  return c.json({
    data: rows.map((row: any) => ({ ...row, deliverables: parseJson(row.deliverables) ?? row.deliverables })),
  });
});

settings.post('/saved-packages', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  if (!b.name) return jsonError(c, 400, 'invalid_payload', 'A package name is required.');
  const plan = await getPlan(c.env, auth.userId);
  const count = await dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM saved_packages WHERE user_id = ?`, [
    auth.userId,
  ]);
  const limit = SAVED_PACKAGE_LIMIT[plan as keyof typeof SAVED_PACKAGE_LIMIT] ?? 0;
  if (Number(count?.c ?? 0) >= limit) {
    return jsonError(c, 403, 'plan_limit_reached', `Your plan allows ${limit} saved packages.`);
  }
  const id = generateId('pkg');
  await dbRun(
    c.env,
    `INSERT INTO saved_packages (id, user_id, name, price, currency, deliverables, description, is_recommended, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      auth.userId,
      String(b.name).slice(0, 200),
      Number(b.price ?? 0),
      b.currency ?? 'USD',
      JSON.stringify(Array.isArray(b.deliverables) ? b.deliverables : []),
      b.description ?? null,
      b.is_recommended ? 1 : 0,
      new Date().toISOString(),
    ]
  );
  return c.json({ success: true, id }, 201);
});

settings.patch('/saved-packages/:id', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  await dbRun(
    c.env,
    `UPDATE saved_packages SET name = COALESCE(?, name), price = COALESCE(?, price), currency = COALESCE(?, currency),
       deliverables = COALESCE(?, deliverables), description = COALESCE(?, description) WHERE id = ? AND user_id = ?`,
    [
      b.name ?? null,
      b.price ?? null,
      b.currency ?? null,
      b.deliverables ? JSON.stringify(b.deliverables) : null,
      b.description ?? null,
      c.req.param('id'),
      auth.userId,
    ]
  );
  return c.json({ success: true });
});

settings.post('/saved-packages/:id/keep', async (c) => {
  const auth = getAuth(c);
  await dbRun(c.env, `UPDATE saved_packages SET last_used_at = ? WHERE id = ? AND user_id = ?`, [
    new Date().toISOString(),
    c.req.param('id'),
    auth.userId,
  ]);
  return c.json({ success: true });
});

settings.delete('/saved-packages/:id', async (c) => {
  const auth = getAuth(c);
  await dbRun(c.env, `DELETE FROM saved_packages WHERE id = ? AND user_id = ?`, [c.req.param('id'), auth.userId]);
  return c.json({ success: true });
});

settings.get('/revision-prices', async (c) => {
  const auth = getAuth(c);
  const rows = await dbQuery(c.env, `SELECT category, price FROM revision_prices WHERE user_id = ? ORDER BY category`, [
    auth.userId,
  ]);
  return c.json({ data: rows.map((row: any) => ({ id: row.category, category: row.category, price: row.price })) });
});

settings.patch('/revision-prices', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  const entries = Array.isArray(body.data) ? body.data : [];
  if (entries.length > 50) return jsonError(c, 400, 'invalid_payload', 'Too many categories.');
  const now = new Date().toISOString();
  for (const entry of entries) {
    const category = String(entry.category ?? '').slice(0, 80);
    if (!category) continue;
    const price = entry.price === null || entry.price === '' ? null : Number(entry.price);
    if (price !== null && (!Number.isFinite(price) || price < 0)) {
      return jsonError(c, 400, 'invalid_payload', `Invalid price for ${category}.`);
    }
    await dbRun(
      c.env,
      `INSERT INTO revision_prices (user_id, category, price, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, category) DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at`,
      [auth.userId, category, price, now]
    );
  }
  return c.json({ success: true });
});

settings.get('/revenue', async (c) => {
  const auth = getAuth(c);
  const plan = await getPlan(c.env, auth.userId);
  if (!REVENUE_TRACKER[plan as keyof typeof REVENUE_TRACKER]) {
    return jsonError(c, 403, 'forbidden', 'Revenue tracking is not available on your plan.');
  }
  const summary = await getRevenueSummary(c.env, auth.userId);
  const expenses = await dbQuery(c.env, `SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC LIMIT 100`, [
    auth.userId,
  ]);
  return c.json({
    earned: summary.earned_total,
    spent: summary.spent_total,
    profit: summary.profit,
    pending_total: summary.pending_total,
    pending_count: summary.pending_count,
    expenses,
  });
});

settings.post('/expenses', async (c) => {
  const auth = getAuth(c);
  const plan = await getPlan(c.env, auth.userId);
  if (!EXPENSE_ENTRY[plan as keyof typeof EXPENSE_ENTRY]) {
    return jsonError(c, 403, 'forbidden', 'Expense tracking is not available on your plan.');
  }
  const b = await c.req.json().catch(() => ({}));
  if (!b.amount || !b.category) return jsonError(c, 400, 'invalid_payload', 'Amount and category are required.');
  const id = await addExpense(c.env, auth.userId, b);
  return c.json({ success: true, id }, 201);
});

settings.get('/price-suggestion/:clientId', async (c) => {
  const auth = getAuth(c);
  const plan = await getPlan(c.env, auth.userId);
  if (plan !== 'scale' && plan !== 'teams') {
    return jsonError(c, 403, 'forbidden', 'Price suggestions are not available on your plan.');
  }
  const owned = await dbFirst<{ id: string }>(c.env, `SELECT id FROM clients WHERE id = ? AND user_id = ?`, [
    c.req.param('clientId'),
    auth.userId,
  ]);
  if (!owned) return jsonError(c, 404, 'not_found', 'Client not found.');
  const margin = Number(c.req.query('margin') ?? 30);
  return c.json(await getPriceSuggestion(c.env, auth.userId, c.req.param('clientId'), margin));
});

settings.get('/upgrade-status', async (c) => {
  const auth = getAuth(c);
  const rows = await tursoQuery(
    c.env,
    `SELECT id, plan_requested, status, created_at FROM payment_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`,
    [auth.userId]
  );
  return c.json({ data: rows.rows });
});

settings.get('/what-revercue-knows', async (c) => {
  const auth = getAuth(c);
  const plan = await getPlan(c.env, auth.userId);
  if (!WHAT_REVERCUE_KNOWS[plan as keyof typeof WHAT_REVERCUE_KNOWS]) {
    return jsonError(c, 403, 'forbidden', 'This view is not available on your plan.');
  }
  const row = await tursoQuery(c.env, `SELECT * FROM users WHERE id = ? LIMIT 1`, [auth.userId]);
  const user = row.rows[0] ?? {};
  return c.json({
    account: [
      { label: 'Email', value: String(user.email ?? '-') },
      { label: 'Name', value: String(user.name ?? '-') },
      { label: 'Business', value: String(user.business_name ?? '-') },
      { label: 'Plan', value: String(user.plan ?? 'free') },
      { label: 'Member since', value: String(user.created_at ?? '-') },
      { label: 'Email verified', value: user.email_verified ? 'Yes' : 'No' },
    ],
    private: [
      'Your password is never stored by Revercue in readable form; authentication is handled by AuthAction.',
      'Client documents, signatures and signed PDFs are stored privately and served through authorized links only.',
      'Payment proof screenshots are deleted five days after upload.',
    ],
    team_can_see: ['No team features are enabled on your account.'],
    encrypted: ['Traffic is encrypted in transit (HTTPS).'],
    third_parties: [
      { name: 'AuthAction', role: 'Sign-in, passkeys and passwordless authentication' },
      { name: 'Cloudflare', role: 'API hosting' },
      { name: 'Turso', role: 'Account, notification and admin records' },
      { name: 'Backblaze B2', role: 'Private document, signature and PDF storage' },
      { name: 'Cooper Email / OpenMail', role: 'Application email delivery' },
      { name: 'Wikipedia, Openverse, DuckDuckGo, FreeSerp, OpenStreetMap, Iconify', role: 'Public research used by the Extract API' },
    ],
    your_controls: [
      'Export or download any document at any time.',
      'Set per-event email preferences.',
      'Request account deletion; data is removed after a five day grace period.',
    ],
    not_known: [
      'We do not track you across other websites.',
      'We do not sell data.',
      'We do not store full IP addresses except as signing evidence and hashed rate-limit keys.',
    ],
    notes: DEFAULT_PREFERENCES,
  });
});

settings.post('/delete-account', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  const user = await tursoQuery(c.env, `SELECT email FROM users WHERE id = ? LIMIT 1`, [auth.userId]);
  if (String(b.email_confirmation ?? '').trim().toLowerCase() !== String(user.rows[0]?.email ?? '').toLowerCase()) {
    return jsonError(c, 400, 'invalid_payload', 'Type your email address exactly to confirm.');
  }
  await tursoExecute(c.env, `UPDATE users SET deletion_requested_at = ?, updated_at = ? WHERE id = ?`, [
    new Date().toISOString(),
    new Date().toISOString(),
    auth.userId,
  ]);
  return c.json({ success: true, deletion_date: new Date(Date.now() + 5 * 86400000).toISOString() });
});

settings.post('/cancel-deletion', async (c) => {
  const auth = getAuth(c);
  await tursoExecute(c.env, `UPDATE users SET deletion_requested_at = NULL, updated_at = ? WHERE id = ?`, [
    new Date().toISOString(),
    auth.userId,
  ]);
  return c.json({ success: true });
});

export default settings;
