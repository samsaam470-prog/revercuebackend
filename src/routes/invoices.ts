import { Hono } from 'hono';
import { dbFirst, dbQuery, dbRun } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { generateId, generatePublicId } from '../utils/ids';
import { userAuthMiddleware, getAuth } from '../middleware/user-auth';
import { createNotification } from '../services/notifications';
import { parsePagination, paginated, statusFilter } from '../utils/pagination';
import { jsonError } from '../utils/api-errors';
import { archiveDocument, unarchiveDocument } from '../services/archive';
import { getTrackingSummary } from '../services/tracking';
import { activeDocumentLimitBody, checkActiveDocumentLimit } from '../services/plan-limits';
import { resolveClientId } from '../services/clients';
import { buildDocumentPdf } from '../services/pdf';
import { pdfResponse } from '../services/pdf-binary';
import type { Bindings } from '../types';

const invoices = new Hono<{ Bindings: Bindings }>();

function parseJson(value: unknown): any {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}
invoices.use('*', userAuthMiddleware);

const LIST_STATUSES = [
  'draft',
  'published',
  'proof_submitted',
  'confirmed',
  'paid',
  'overdue',
  'archived',
] as const;

invoices.get('/', async (c) => {
  const auth = getAuth(c);
  const pagination = parsePagination(c);
  const status = statusFilter(c.req.query('status'), LIST_STATUSES);

  let where = 'user_id = ?';
  const args: any[] = [auth.userId];
  if (status) {
    where += ' AND status = ?';
    args.push(status);
  }

  const totalRow = await dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM invoices WHERE ${where}`, args);
  const rows = await dbQuery(
    c.env,
    `SELECT id, invoice_number, client_id, status, total, currency, public_id, due_date, created_at, updated_at
     FROM invoices WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...args, pagination.limit, pagination.offset]
  );
  return c.json(paginated(rows, Number(totalRow?.c ?? 0), pagination));
});

async function nextInvoiceNumber(env: Bindings, userId: string): Promise<string> {
  const count = await dbFirst<{ c: number }>(
    env,
    `SELECT COUNT(*) as c FROM invoices WHERE user_id = ?`,
    [userId]
  );
  return `INV-${new Date().getFullYear()}-${String(Number(count?.c ?? 0) + 1).padStart(4, '0')}`;
}

invoices.post('/draft', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  if (!Array.isArray(body.line_items) || body.line_items.length === 0) {
    return jsonError(c, 400, 'invalid_payload', 'At least one line item is required.');
  }

  const clientId = await resolveClientId(c.env, auth.userId, {
    client_id: body.client_id,
    client_name: body.client_name,
    client_email: body.client_email,
    source: 'auto_invoice',
  });
  if (!clientId) {
    return jsonError(c, 400, 'invalid_payload', 'Provide a client_id, or a client_name and client_email.');
  }

  const id = generateId('inv');
  const now = new Date().toISOString();
  const invoiceNumber = await nextInvoiceNumber(c.env, auth.userId);
  await dbRun(
    c.env,
    `INSERT INTO invoices (id, user_id, client_id, linked_contract_id, invoice_number, line_items, currency, tax, total, payment_arrangement, due_date, notes, status, draft_created_at, draft_retention_days, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, 30, ?, ?)`,
    [
      id,
      auth.userId,
      clientId,
      body.linked_contract_id ?? null,
      invoiceNumber,
      JSON.stringify(body.line_items),
      body.currency ?? 'USD',
      Number(body.tax ?? 0),
      Number(body.total ?? 0),
      JSON.stringify(body.payment_arrangement ?? {}),
      body.due_date ?? null,
      body.notes ?? null,
      now,
      now,
      now,
    ]
  );

  if (body.tax_label) {
    await dbRun(
      c.env,
      `INSERT INTO document_meta (document_type, document_id, data, updated_at) VALUES ('invoice', ?, ?, ?)
       ON CONFLICT(document_type, document_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      [id, JSON.stringify({ tax_label: String(body.tax_label).slice(0, 40) }), now]
    ).catch((error) => console.error('INVOICE_META_WRITE_FAILED', error));
  }

  return c.json({ success: true, id, invoice_number: invoiceNumber, status: 'draft' }, 201);
});

invoices.get('/:id', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT * FROM invoices WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  const [tracking, meta] = await Promise.all([
    getTrackingSummary(c.env, 'invoice', row.id),
    dbFirst<any>(c.env, `SELECT data FROM document_meta WHERE document_type = 'invoice' AND document_id = ?`, [row.id]).catch(
      () => null
    ),
  ]);
  let extra = {};
  try {
    extra = meta?.data ? JSON.parse(meta.data) : {};
  } catch {
    extra = {};
  }
  const lineItems = parseJson(row.line_items);
  return c.json({
    invoice: {
      ...row,
      line_items: Array.isArray(lineItems) ? lineItems : [],
      ...extra,
      tracking,
    },
  });
});

invoices.patch('/:id', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  const row = await dbFirst<any>(c.env, `SELECT id, status FROM invoices WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  if (row.status === 'confirmed' || row.status === 'paid') {
    return jsonError(c, 409, 'invoice_confirmed', 'A confirmed invoice is a record and cannot be edited.');
  }
  if (row.status === 'archived') return jsonError(c, 409, 'archived', 'Unarchive the invoice before editing it.');

  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `UPDATE invoices SET line_items = COALESCE(?, line_items), payment_arrangement = COALESCE(?, payment_arrangement),
       due_date = COALESCE(?, due_date), notes = COALESCE(?, notes), total = COALESCE(?, total),
       tax = COALESCE(?, tax), currency = COALESCE(?, currency), updated_at = ?
     WHERE id = ? AND user_id = ?`,
    [
      body.line_items ? JSON.stringify(body.line_items) : null,
      body.payment_arrangement ? JSON.stringify(body.payment_arrangement) : null,
      body.due_date ?? null,
      body.notes ?? null,
      body.total ?? null,
      body.tax ?? null,
      body.currency ?? null,
      now,
      row.id,
      auth.userId,
    ]
  );
  return c.json({ success: true, updated_at: now });
});

invoices.post('/:id/publish', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT * FROM invoices WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  if (row.status === 'archived') return jsonError(c, 409, 'archived', 'Unarchive the invoice before publishing.');

  const active = await checkActiveDocumentLimit(c.env, auth.userId, row.status === 'published');
  if (!active.allowed) return c.json(activeDocumentLimitBody(active), 403);

  const publicId = row.public_id ?? generatePublicId();
  const now = new Date().toISOString();
  await dbRun(c.env, `UPDATE invoices SET status = 'published', public_id = ?, published_at = ?, updated_at = ? WHERE id = ?`, [
    publicId,
    now,
    now,
    row.id,
  ]);
  await createNotification(c.env, {
    userId: auth.userId,
    eventType: 'document_created',
    clientId: row.client_id,
    documentId: row.id,
    title: `Invoice published: ${row.invoice_number}`,
  });
  const base = (c.env.APP_URL || c.env.FRONTEND_ORIGIN || 'https://revercue.co.uk').replace(/\/$/, '');
  return c.json({ success: true, public_id: publicId, url: `${base}/i/${publicId}` });
});

invoices.post('/:id/duplicate', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT * FROM invoices WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  const body = await c.req.json().catch(() => ({}));
  const clientId = body.client_id
    ? await resolveClientId(c.env, auth.userId, { client_id: body.client_id })
    : row.client_id;
  const id = generateId('inv');
  const now = new Date().toISOString();
  const invoiceNumber = await nextInvoiceNumber(c.env, auth.userId);
  await dbRun(
    c.env,
    `INSERT INTO invoices (id, user_id, client_id, linked_contract_id, invoice_number, line_items, currency, tax, total, payment_arrangement, due_date, notes, status, draft_created_at, draft_retention_days, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, 30, ?, ?)`,
    [
      id,
      auth.userId,
      clientId,
      invoiceNumber,
      row.line_items,
      row.currency ?? 'USD',
      row.tax ?? 0,
      row.total ?? 0,
      row.payment_arrangement,
      row.due_date ?? null,
      row.notes ?? null,
      now,
      now,
      now,
    ]
  );
  return c.json({ success: true, id, invoice_number: invoiceNumber, status: 'draft' }, 201);
});

invoices.post('/:id/archive', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT id, status FROM invoices WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  if (row.status === 'confirmed' || row.status === 'paid') {
    return jsonError(c, 409, 'invoice_confirmed', 'A paid invoice is an accounting record and cannot be archived.');
  }
  try {
    const result = await archiveDocument(c.env, 'invoice', row.id, auth.userId, auth.plan, row.status);
    return c.json({ success: true, status: 'archived', ...result });
  } catch (error: any) {
    if (error?.message === 'archive_limit_reached') {
      return jsonError(c, 403, 'archive_limit_reached', 'You reached the archive limit for your plan.');
    }
    console.error('INVOICE_ARCHIVE_FAILED', error);
    return jsonError(c, 500, 'archive_failed', 'The invoice could not be archived.');
  }
});

invoices.post('/:id/unarchive', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT id FROM invoices WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  const result = await unarchiveDocument(c.env, 'invoice', row.id, auth.userId);
  return c.json({ success: true, ...result });
});

invoices.post('/:id/share', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  const row = await dbFirst<any>(c.env, `SELECT id, client_id, public_id FROM invoices WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  if (!row.public_id) return jsonError(c, 409, 'not_published', 'Publish the invoice before sharing it.');
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `INSERT INTO communication_log (id, user_id, client_id, entry_type, channel, linked_document_type, linked_document_id, created_at)
     VALUES (?, ?, ?, 'document_shared', ?, 'invoice', ?, ?)`,
    [generateId('log'), auth.userId, row.client_id, String(body.channel ?? 'other').slice(0, 40), row.id, now]
  );
  return c.json({ success: true });
});

invoices.post('/:id/confirm-payment', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT * FROM invoices WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  if (row.status === 'confirmed' || row.status === 'paid') {
    return c.json({ success: true, status: row.status });
  }

  const now = new Date().toISOString();
  await dbRun(c.env, `UPDATE invoices SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [
    now,
    now,
    row.id,
    auth.userId,
  ]);
  await tursoQuery(
    c.env,
    `INSERT INTO payments (id, user_id, plan, amount, currency, method, reference, status, paid_at, created_at)
     VALUES (?, ?, 'invoice', ?, ?, 'manual', ?, 'paid', ?, ?)`,
    [generateId('pay'), auth.userId, row.total ?? 0, row.currency ?? 'USD', row.id, now, now]
  ).catch((error) => console.error('PAYMENT_RECORD_FAILED', error));

  await createNotification(c.env, {
    userId: auth.userId,
    eventType: 'invoice_paid',
    clientId: row.client_id,
    documentId: row.id,
    title: `Payment confirmed: ${row.invoice_number}`,
    documentTitle: row.invoice_number,
  });
  return c.json({ success: true, status: 'confirmed' });
});

invoices.get('/:id/pdf', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT id FROM invoices WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  const generated = await buildDocumentPdf(c.env, 'invoice', row.id);
  if (!generated) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  return pdfResponse(generated.bytes, `invoice-${row.id}.pdf`, 'attachment');
});

invoices.get('/:id/tracking', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT id FROM invoices WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  return c.json(await getTrackingSummary(c.env, 'invoice', row.id));
});

invoices.delete('/:id', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT id, status FROM invoices WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  if (row.status === 'confirmed' || row.status === 'paid') {
    return jsonError(
      c,
      409,
      'invoice_confirmed',
      'A confirmed invoice is an accounting record. It cannot be deleted; archive or export it instead.'
    );
  }
  await dbRun(c.env, `DELETE FROM document_uploads WHERE document_type = 'invoice' AND document_id = ?`, [row.id]);
  await dbRun(c.env, `DELETE FROM document_meta WHERE document_type = 'invoice' AND document_id = ?`, [row.id]);
  await dbRun(c.env, `DELETE FROM invoices WHERE id = ? AND user_id = ?`, [row.id, auth.userId]);
  return c.json({ success: true });
});

export default invoices;
