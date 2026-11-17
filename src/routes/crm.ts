import { Hono } from 'hono';
import { dbQuery, dbFirst, dbRun } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { generateId } from '../utils/ids';
import { userAuthMiddleware, getAuth } from '../middleware/user-auth';
import { recomputeInterest, getInterestBreakdown } from '../services/interest';
import { scheduleSummary } from '../services/summary';
import { parsePagination, paginated } from '../utils/pagination';
import { jsonError } from '../utils/api-errors';
import { NOTES_PER_CLIENT } from '../config/constants';
import type { Bindings } from '../types';

const crm = new Hono<{ Bindings: Bindings }>();
crm.use('*', userAuthMiddleware);

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

crm.get('/clients', async (c) => {
  const auth = getAuth(c);
  const pagination = parsePagination(c);
  const search = (c.req.query('search') ?? '').slice(0, 100);
  const filter = c.req.query('filter') ?? 'all';

  let where = `user_id = ? AND (name LIKE ? OR email LIKE ? OR COALESCE(company,'') LIKE ?)`;
  const args: any[] = [auth.userId, `%${search}%`, `%${search}%`, `%${search}%`];
  if (filter === 'archived') where += ` AND status = 'archived'`;
  else if (filter === 'active') where += ` AND COALESCE(status,'active') = 'active'`;
  else if (filter === 'not_interested') where += ` AND status = 'not_interested'`;

  const totalRow = await dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM clients WHERE ${where}`, args);
  const rows = await dbQuery(
    c.env,
    `SELECT id, name, email, company, phone, channel, last_message_at, status, interest_level, industry
     FROM clients WHERE ${where} ORDER BY last_message_at DESC LIMIT ? OFFSET ?`,
    [...args, pagination.limit, pagination.offset]
  );
  return c.json(paginated(rows, Number(totalRow?.c ?? 0), pagination));
});

/**
 * CSV export. Registered before `/clients/:id` so "export" is not captured as
 * a client id. The frontend reads this as a Blob (`raw: true`).
 */
crm.get('/clients/export', async (c) => {
  const auth = getAuth(c);
  const rows = await dbQuery<any>(
    c.env,
    `SELECT id, name, email, company, phone, channel, status, interest_level, industry, website_url, last_message_at, created_at
     FROM clients WHERE user_id = ? ORDER BY created_at DESC LIMIT 5000`,
    [auth.userId]
  );
  const header = [
    'id',
    'name',
    'email',
    'company',
    'phone',
    'channel',
    'status',
    'interest_level',
    'industry',
    'website',
    'last_message_at',
    'created_at',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.name,
        row.email,
        row.company,
        row.phone,
        row.channel,
        row.status,
        row.interest_level,
        row.industry,
        row.website_url,
        row.last_message_at,
        row.created_at,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  const filename = `revercue-clients-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(`\uFEFF${lines.join('\r\n')}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
});

crm.post('/clients', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  if (!b.name || !b.email) return jsonError(c, 400, 'invalid_payload', 'Name and email are required.');
  const email = String(b.email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return jsonError(c, 400, 'invalid_email', 'Enter a valid email.');

  const existing = await dbFirst<{ id: string }>(
    c.env,
    `SELECT id FROM clients WHERE user_id = ? AND lower(email) = ? LIMIT 1`,
    [auth.userId, email]
  );
  if (existing) return jsonError(c, 409, 'conflict', 'A client with that email already exists.');

  const id = generateId('cli');
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `INSERT INTO clients (id, user_id, name, email, company, phone, channel, industry, target_audience, website_url, source, last_message_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`,
    [
      id,
      auth.userId,
      String(b.name).slice(0, 200),
      email,
      b.company ?? null,
      b.phone ?? null,
      b.channel ?? null,
      b.industry ?? null,
      b.target_audience ?? null,
      b.website_url ?? null,
      now,
      now,
      now,
    ]
  );
  return c.json({ success: true, id }, 201);
});

crm.get('/clients/:id', async (c) => {
  const auth = getAuth(c);
  const client = await dbFirst(c.env, `SELECT * FROM clients WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!client) return jsonError(c, 404, 'not_found', 'Client not found.');

  const [communication, notes, proposals, contracts, invoices, forms] = await Promise.all([
    dbQuery(c.env, `SELECT * FROM communication_log WHERE user_id = ? AND client_id = ? ORDER BY created_at DESC LIMIT 100`, [auth.userId, c.req.param('id')]),
    dbQuery(c.env, `SELECT * FROM client_notes WHERE client_id = ? AND user_id = ? ORDER BY created_at DESC`, [c.req.param('id'), auth.userId]),
    dbQuery(c.env, `SELECT id, title, status, public_id FROM proposals WHERE client_id = ? AND user_id = ?`, [c.req.param('id'), auth.userId]),
    dbQuery(c.env, `SELECT id, title, status, public_id FROM contracts WHERE client_id = ? AND user_id = ?`, [c.req.param('id'), auth.userId]),
    dbQuery(c.env, `SELECT id, invoice_number, status, total, currency, public_id FROM invoices WHERE client_id = ? AND user_id = ?`, [c.req.param('id'), auth.userId]),
    dbQuery(c.env, `SELECT id, title, status, public_id FROM forms WHERE client_id = ? AND user_id = ?`, [c.req.param('id'), auth.userId]),
  ]);

  return c.json({ client, communication, notes, documents: { proposals, contracts, invoices, forms } });
});

crm.patch('/clients/:id', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  const owned = await dbFirst<{ id: string }>(c.env, `SELECT id FROM clients WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!owned) return jsonError(c, 404, 'not_found', 'Client not found.');
  await dbRun(
    c.env,
    `UPDATE clients SET name = COALESCE(?, name), email = COALESCE(?, email), company = COALESCE(?, company),
       phone = COALESCE(?, phone), channel = COALESCE(?, channel), industry = COALESCE(?, industry),
       target_audience = COALESCE(?, target_audience), website_url = COALESCE(?, website_url),
       value_prop = COALESCE(?, value_prop), updated_at = ?
     WHERE id = ? AND user_id = ?`,
    [
      b.name ?? null,
      b.email ? String(b.email).trim().toLowerCase() : null,
      b.company ?? null,
      b.phone ?? null,
      b.channel ?? null,
      b.industry ?? null,
      b.target_audience ?? null,
      b.website_url ?? null,
      b.value_prop ?? null,
      new Date().toISOString(),
      c.req.param('id'),
      auth.userId,
    ]
  );
  return c.json({ success: true });
});

crm.delete('/clients/:id', async (c) => {
  const auth = getAuth(c);
  const owned = await dbFirst<{ id: string }>(c.env, `SELECT id FROM clients WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!owned) return jsonError(c, 404, 'not_found', 'Client not found.');

  const keepDocuments = (c.req.query('keep_documents') ?? 'true') !== 'false';
  const documents = await dbFirst<{ c: number }>(
    c.env,
    `SELECT (SELECT COUNT(*) FROM proposals WHERE client_id = ?) + (SELECT COUNT(*) FROM contracts WHERE client_id = ?) + (SELECT COUNT(*) FROM invoices WHERE client_id = ?) + (SELECT COUNT(*) FROM forms WHERE client_id = ?) as c`,
    [owned.id, owned.id, owned.id, owned.id]
  );
  if (!keepDocuments && Number(documents?.c ?? 0) > 0) {
    return jsonError(
      c,
      409,
      'client_has_documents',
      'This client has documents. Delete the documents first, or keep them (keep_documents=true).'
    );
  }

  await dbRun(c.env, `DELETE FROM client_notes WHERE client_id = ? AND user_id = ?`, [owned.id, auth.userId]);
  await dbRun(c.env, `DELETE FROM clients WHERE id = ? AND user_id = ?`, [owned.id, auth.userId]);
  return c.json({ success: true });
});

crm.post('/clients/:id/archive', async (c) => {
  const auth = getAuth(c);
  const result = await dbRunResultSafe(c.env, `UPDATE clients SET status = 'archived', updated_at = ? WHERE id = ? AND user_id = ?`, [
    new Date().toISOString(),
    c.req.param('id'),
    auth.userId,
  ]);
  if (!result) return jsonError(c, 404, 'not_found', 'Client not found.');
  await scheduleSummary(c.env, c.req.param('id'), auth.userId);
  return c.json({ success: true, status: 'archived' });
});

crm.post('/clients/:id/not-interested', async (c) => {
  const auth = getAuth(c);
  const now = new Date().toISOString();
  const result = await dbRunResultSafe(
    c.env,
    `UPDATE clients SET status = 'not_interested', marked_not_interested_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    [now, now, c.req.param('id'), auth.userId]
  );
  if (!result) return jsonError(c, 404, 'not_found', 'Client not found.');
  await scheduleSummary(c.env, c.req.param('id'), auth.userId);
  return c.json({ success: true, status: 'not_interested' });
});

crm.get('/clients/:id/interest', async (c) => {
  const auth = getAuth(c);
  if (auth.plan !== 'scale' && auth.plan !== 'teams') {
    return jsonError(c, 403, 'forbidden', 'Interest scoring is not available on your plan.');
  }
  const client = await dbFirst<any>(
    c.env,
    `SELECT interest_level, marked_not_interested_at FROM clients WHERE id = ? AND user_id = ?`,
    [c.req.param('id'), auth.userId]
  );
  if (!client) return jsonError(c, 404, 'not_found', 'Client not found.');
  const breakdown = await getInterestBreakdown(c.env, auth.userId, c.req.param('id'));
  const score = client.interest_level ?? 50;
  return c.json({
    score,
    label: score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold',
    signals: breakdown.contributions.map((row: any) => ({
      label: row.signal,
      value: row.value,
      contribution: 0,
    })),
    arithmetic: breakdown.arithmetic,
  });
});

crm.post('/clients/:id/notes', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  if (!b.note) return jsonError(c, 400, 'invalid_payload', 'A note is required.');
  const owned = await dbFirst<{ id: string }>(c.env, `SELECT id FROM clients WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!owned) return jsonError(c, 404, 'not_found', 'Client not found.');

  const count = await dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM client_notes WHERE client_id = ? AND user_id = ?`, [
    owned.id,
    auth.userId,
  ]);
  const limit = NOTES_PER_CLIENT[auth.plan as keyof typeof NOTES_PER_CLIENT] ?? 3;
  if (Number(count?.c ?? 0) >= limit) {
    return jsonError(c, 403, 'plan_limit_reached', `Your plan allows ${limit} notes per client.`);
  }
  const id = generateId('note');
  await dbRun(c.env, `INSERT INTO client_notes (id, user_id, client_id, note, created_at) VALUES (?, ?, ?, ?, ?)`, [
    id,
    auth.userId,
    owned.id,
    String(b.note).slice(0, 5000),
    new Date().toISOString(),
  ]);
  return c.json({ success: true, id }, 201);
});

crm.get('/clients/:id/communication', async (c) => {
  const auth = getAuth(c);
  const rows = await dbQuery(
    c.env,
    `SELECT * FROM communication_log WHERE user_id = ? AND client_id = ? ORDER BY created_at DESC LIMIT 100`,
    [auth.userId, c.req.param('id')]
  );
  return c.json({ data: rows });
});

crm.post('/clients/:id/communication', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  if (!b.entry_type) return jsonError(c, 400, 'invalid_payload', 'An entry type is required.');
  const owned = await dbFirst<{ id: string }>(c.env, `SELECT id FROM clients WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!owned) return jsonError(c, 404, 'not_found', 'Client not found.');

  const id = generateId('log');
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `INSERT INTO communication_log (id, user_id, client_id, entry_type, direction, channel, message_text, estimated_time, linked_document_type, linked_document_id, next_step, follow_up_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      auth.userId,
      owned.id,
      String(b.entry_type).slice(0, 40),
      b.direction ?? null,
      b.channel ?? null,
      b.message_text ? String(b.message_text).slice(0, 5000) : null,
      b.estimated_time ?? null,
      b.linked_document_type ?? null,
      b.linked_document_id ?? null,
      b.next_step ?? null,
      b.follow_up_date ?? null,
      now,
    ]
  );
  await dbRun(c.env, `UPDATE clients SET last_message_at = ? WHERE id = ? AND user_id = ?`, [now, owned.id, auth.userId]);
  try {
    await recomputeInterest(c.env, auth.userId, owned.id);
  } catch (error) {
    console.error('INTEREST_RECOMPUTE_FAILED', error);
  }
  return c.json({ success: true, id }, 201);
});

crm.patch('/communication/:id', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  await dbRun(
    c.env,
    `UPDATE communication_log SET follow_up_done = COALESCE(?, follow_up_done), message_text = COALESCE(?, message_text), next_step = COALESCE(?, next_step) WHERE id = ? AND user_id = ?`,
    [b.follow_up_done ?? null, b.message_text ?? null, b.next_step ?? null, c.req.param('id'), auth.userId]
  );
  return c.json({ success: true });
});

crm.delete('/communication/:id', async (c) => {
  const auth = getAuth(c);
  await dbRun(c.env, `DELETE FROM communication_log WHERE id = ? AND user_id = ?`, [c.req.param('id'), auth.userId]);
  return c.json({ success: true });
});

crm.post('/clients/:id/suggest-message', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  const draft = String(b.draft ?? '').slice(0, 2000);
  if (!draft) return jsonError(c, 400, 'invalid_payload', 'A draft is required.');
  const owned = await dbFirst<{ id: string }>(c.env, `SELECT id FROM clients WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!owned) return jsonError(c, 404, 'not_found', 'Client not found.');
  const log = await dbQuery<any>(
    c.env,
    `SELECT message_text FROM communication_log WHERE user_id = ? AND client_id = ? AND message_text IS NOT NULL ORDER BY created_at DESC LIMIT 3`,
    [auth.userId, owned.id]
  );
  return c.json({
    success: true,
    draft,
    context: log.map((row) => row.message_text),
    note: 'Use the frontend Web LLM to rewrite the draft.',
  });
});

async function dbRunResultSafe(
  env: Bindings,
  sql: string,
  args: any[]
): Promise<boolean> {
  const { dbRunResult } = await import('../utils/db');
  const result = await dbRunResult(env, sql, args);
  return result.changes > 0;
}

export default crm;
