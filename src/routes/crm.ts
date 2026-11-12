import { Hono } from 'hono';
import { dbQuery, dbFirst, dbRun } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { generateId } from '../utils/ids';
import { userAuthMiddleware } from '../middleware/user-auth';
import { recomputeInterest } from '../services/interest';
import { scheduleSummary } from '../services/summary';
import { NOTES_PER_CLIENT } from '../config/constants';
import type { Bindings } from '../types';

const crm = new Hono<{ Bindings: Bindings }>();
crm.use('*', userAuthMiddleware);

crm.get('/clients', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const search = c.req.query('search') ?? '';
  const rows = await dbQuery(c.env, `SELECT id, name, email, company, channel, last_message_at, status, interest_level, industry FROM clients WHERE user_id = ? AND (name LIKE ? OR email LIKE ?) ORDER BY last_message_at DESC LIMIT 100`, [uid, `%${search}%`, `%${search}%`]);
  return c.json({ data: rows });
});

crm.post('/clients', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json().catch(() => ({}));
  if (!b.name || !b.email) return c.json({ error: 'invalid_payload' }, 400);
  const id = generateId('cli');
  const now = new Date().toISOString();
  await dbRun(c.env, `INSERT INTO clients (id, user_id, name, email, company, phone, channel, industry, target_audience, website_url, source, last_message_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`, [id, uid, b.name, b.email, b.company ?? null, b.phone ?? null, b.channel ?? null, b.industry ?? null, b.target_audience ?? null, b.website_url ?? null, now, now, now]);
  return c.json({ success: true, id }, 201);
});

crm.get('/clients/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const client = await dbFirst(c.env, `SELECT * FROM clients WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  if (!client) return c.json({ error: 'not_found' }, 404);
  const communication = await dbQuery(c.env, `SELECT * FROM communication_log WHERE user_id = ? AND client_id = ? ORDER BY created_at DESC LIMIT 100`, [uid, c.req.param('id')]);
  const notes = await dbQuery(c.env, `SELECT * FROM client_notes WHERE client_id = ? ORDER BY created_at DESC`, [c.req.param('id')]);
  const proposals = await dbQuery(c.env, `SELECT id, title, status FROM proposals WHERE client_id = ?`, [c.req.param('id')]);
  const contracts = await dbQuery(c.env, `SELECT id, title, status FROM contracts WHERE client_id = ?`, [c.req.param('id')]);
  const invoices = await dbQuery(c.env, `SELECT id, invoice_number, status, total FROM invoices WHERE client_id = ?`, [c.req.param('id')]);
  const forms = await dbQuery(c.env, `SELECT id, title, status FROM forms WHERE client_id = ?`, [c.req.param('id')]);
  return c.json({ client, communication, notes, documents: { proposals, contracts, invoices, forms } });
});

crm.patch('/clients/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  await dbRun(c.env, `UPDATE clients SET name = COALESCE(?, name), email = COALESCE(?, email), company = COALESCE(?, company), phone = COALESCE(?, phone), channel = COALESCE(?, channel), industry = COALESCE(?, industry), target_audience = COALESCE(?, target_audience), website_url = COALESCE(?, website_url), value_prop = COALESCE(?, value_prop), updated_at = ? WHERE id = ? AND user_id = ?`, [b.name ?? null, b.email ?? null, b.company ?? null, b.phone ?? null, b.channel ?? null, b.industry ?? null, b.target_audience ?? null, b.website_url ?? null, b.value_prop ?? null, new Date().toISOString(), c.req.param('id'), uid]);
  return c.json({ success: true });
});

crm.delete('/clients/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(c.env, `DELETE FROM clients WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  return c.json({ success: true });
});

crm.post('/clients/:id/archive', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(c.env, `UPDATE clients SET status = 'archived', updated_at = ? WHERE id = ? AND user_id = ?`, [new Date().toISOString(), c.req.param('id'), uid]);
  await scheduleSummary(c.env, c.req.param('id'), uid);
  return c.json({ success: true, status: 'archived' });
});

crm.post('/clients/:id/not-interested', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(c.env, `UPDATE clients SET status = 'not_interested', marked_not_interested_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [new Date().toISOString(), new Date().toISOString(), c.req.param('id'), uid]);
  await scheduleSummary(c.env, c.req.param('id'), uid);
  return c.json({ success: true, status: 'not_interested' });
});

crm.post('/clients/:id/notes', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  if (!b.note) return c.json({ error: 'invalid_payload' }, 400);
  const user = await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ?`, [uid]);
  const plan = user.rows[0]?.plan ?? 'free';
  const count = await dbQuery(c.env, `SELECT COUNT(*) as c FROM client_notes WHERE client_id = ?`, [c.req.param('id')]);
  if (Number(count[0]?.c ?? 0) >= NOTES_PER_CLIENT[plan as keyof typeof NOTES_PER_CLIENT]) return c.json({ error: 'plan_limit_reached' }, 403);
  const id = generateId('note');
  await dbRun(c.env, `INSERT INTO client_notes (id, user_id, client_id, note, created_at) VALUES (?, ?, ?, ?, ?)`, [id, uid, c.req.param('id'), b.note, new Date().toISOString()]);
  return c.json({ success: true, id }, 201);
});

crm.get('/clients/:id/communication', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const rows = await dbQuery(c.env, `SELECT * FROM communication_log WHERE user_id = ? AND client_id = ? ORDER BY created_at DESC LIMIT 100`, [uid, c.req.param('id')]);
  return c.json({ data: rows });
});

crm.post('/clients/:id/communication', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  if (!b.entry_type) return c.json({ error: 'invalid_payload' }, 400);
  const id = generateId('log');
  const now = new Date().toISOString();
  await dbRun(c.env, `INSERT INTO communication_log (id, user_id, client_id, entry_type, direction, channel, message_text, estimated_time, linked_document_type, linked_document_id, next_step, follow_up_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, uid, c.req.param('id'), b.entry_type, b.direction ?? null, b.channel ?? null, b.message_text ?? null, b.estimated_time ?? null, b.linked_document_type ?? null, b.linked_document_id ?? null, b.next_step ?? null, b.follow_up_date ?? null, now]);
  await dbRun(c.env, `UPDATE clients SET last_message_at = ? WHERE id = ?`, [now, c.req.param('id')]);
  try { await recomputeInterest(c.env, uid, c.req.param('id')); } catch {}
  return c.json({ success: true, id }, 201);
});

crm.patch('/communication/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  await dbRun(c.env, `UPDATE communication_log SET follow_up_done = COALESCE(?, follow_up_done), message_text = COALESCE(?, message_text), next_step = COALESCE(?, next_step) WHERE id = ? AND user_id = ?`, [b.follow_up_done ?? null, b.message_text ?? null, b.next_step ?? null, c.req.param('id'), uid]);
  return c.json({ success: true });
});

crm.delete('/communication/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(c.env, `DELETE FROM communication_log WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  return c.json({ success: true });
});

export default crm;
