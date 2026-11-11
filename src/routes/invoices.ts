import { Hono } from 'hono';
import { dbQuery, dbFirst, dbRun } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { generateId, generatePublicId } from '../utils/ids';
import { userAuthMiddleware } from '../middleware/user-auth';
import { createNotification } from '../services/notifications';
import { ACTIVE_DOCUMENT_LIMIT, DRAFT_RETENTION_DAYS, PASSWORD_PROTECTED_LIMIT } from '../config/constants';
import type { Bindings } from '../types';

const invoices = new Hono<{ Bindings: Bindings }>();
invoices.use('*', userAuthMiddleware);

async function getPlan(env: Bindings, uid: string): Promise<string> {
  const u = await tursoQuery(env, `SELECT plan FROM users WHERE id = ?`, [uid]);
  return u.rows[0]?.plan ?? 'free';
}

invoices.get('/', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const rows = await dbQuery(c.env, `SELECT id, invoice_number, client_id, status, total, currency, public_id, created_at FROM invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`, [uid]);
  return c.json({ data: rows });
});

invoices.post('/draft', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json().catch(() => ({}));
  if (!b.client_id || !b.line_items || !Array.isArray(b.line_items) || b.line_items.length === 0) return c.json({ error: 'invalid_payload' }, 400);
  const plan = await getPlan(c.env, uid);
  const published = await dbQuery(c.env, `SELECT COUNT(*) as c FROM invoices WHERE user_id = ? AND status = 'published'`, [uid]);
  if (Number(published[0]?.c ?? 0) >= ACTIVE_DOCUMENT_LIMIT[plan as keyof typeof ACTIVE_DOCUMENT_LIMIT]) return c.json({ error: 'plan_limit_reached' }, 403);
  const id = generateId('inv');
  const now = new Date().toISOString();
  const count = await dbQuery(c.env, `SELECT COUNT(*) as c FROM invoices WHERE user_id = ?`, [uid]);
  const invoiceNumber = `INV-${new Date().getFullYear()}-${String(Number(count[0]?.c ?? 0) + 1).padStart(4, '0')}`;
  await dbRun(c.env, `INSERT INTO invoices (id, user_id, client_id, linked_contract_id, invoice_number, line_items, currency, tax, total, payment_arrangement, due_date, notes, status, draft_created_at, draft_retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`, [id, uid, b.client_id, b.linked_contract_id ?? null, invoiceNumber, JSON.stringify(b.line_items), b.currency ?? 'USD', b.tax ?? 0, b.total ?? 0, JSON.stringify(b.payment_arrangement ?? {}), b.due_date ?? null, b.notes ?? null, now, DRAFT_RETENTION_DAYS[plan as keyof typeof DRAFT_RETENTION_DAYS], now, now]);
  return c.json({ success: true, id, invoice_number: invoiceNumber, status: 'draft' }, 201);
});

invoices.get('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const row = await dbFirst(c.env, `SELECT * FROM invoices WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ invoice: row });
});

invoices.patch('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  await dbRun(c.env, `UPDATE invoices SET line_items = COALESCE(?, line_items), payment_arrangement = COALESCE(?, payment_arrangement), due_date = COALESCE(?, due_date), notes = COALESCE(?, notes), total = COALESCE(?, total), updated_at = ? WHERE id = ? AND user_id = ?`, [b.line_items ? JSON.stringify(b.line_items) : null, b.payment_arrangement ? JSON.stringify(b.payment_arrangement) : null, b.due_date ?? null, b.notes ?? null, b.total ?? null, new Date().toISOString(), c.req.param('id'), uid]);
  return c.json({ success: true });
});

invoices.post('/:id/publish', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const id = c.req.param('id');
  const row = (await dbFirst(c.env, `SELECT * FROM invoices WHERE id = ? AND user_id = ?`, [id, uid])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const publicId = row.public_id ?? generatePublicId();
  const now = new Date().toISOString();
  await dbRun(c.env, `UPDATE invoices SET status = 'published', public_id = ?, published_at = ?, updated_at = ? WHERE id = ?`, [publicId, now, now, id]);
  await createNotification(c.env, { userId: uid, eventType: 'document_created', clientId: row.client_id, documentId: id, title: `Invoice published: ${row.invoice_number}` });
  return c.json({ success: true, public_id: publicId, url: `https://revercue.pages.dev/i/${publicId}` });
});

invoices.post('/:id/confirm-payment', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const now = new Date().toISOString();
  await dbRun(c.env, `UPDATE invoices SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [now, now, c.req.param('id'), uid]);
  const row = (await dbFirst(c.env, `SELECT total, currency FROM invoices WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid])) as any;
  if (row) {
    await tursoQuery(c.env, `INSERT INTO payments (id, user_id, plan, amount, currency, method, reference, status, paid_at, created_at) VALUES (?, ?, 'invoice', ?, ?, 'payoneer', ?, 'paid', ?, ?)`, [generateId('pay'), uid, row.total ?? 0, row.currency ?? 'USD', c.req.param('id'), now, now]);
  }
  return c.json({ success: true, status: 'confirmed' });
});

invoices.post('/:id/password', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  if (b.remove) { await dbRun(c.env, `UPDATE invoices SET password_hash = NULL, password_protected = 0 WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]); return c.json({ success: true, password_protected: false }); }
  const plan = await getPlan(c.env, uid);
  if (PASSWORD_PROTECTED_LIMIT[plan as keyof typeof PASSWORD_PROTECTED_LIMIT] === 0) return c.json({ error: 'forbidden' }, 403);
  const bcrypt = (await import('bcryptjs')).default;
  const hash = await bcrypt.hash(String(b.password ?? ''), 10);
  await dbRun(c.env, `UPDATE invoices SET password_hash = ?, password_protected = 1 WHERE id = ? AND user_id = ?`, [hash as string, c.req.param('id'), uid]);
  return c.json({ success: true, password_protected: true });
});

invoices.delete('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(c.env, `DELETE FROM invoices WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  return c.json({ success: true });
});

export default invoices;

