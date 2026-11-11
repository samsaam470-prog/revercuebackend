import { Hono } from 'hono';
import { dbFirst, dbRun } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { generateId } from '../utils/ids';
import { createNotification } from '../services/notifications';
import { generatePrompt } from '../services/prompt-creator';
import { sanitizeHtml } from '../services/storage';
import type { Bindings } from '../types';

const pub = new Hono<{ Bindings: Bindings }>();

async function checkPassword(env: Bindings, hash: string | null, input: string): Promise<boolean> {
  if (!hash) return true;
  const { argon2Verify } = await import('hash-wasm');
  try { return await argon2Verify({ password: input, hash }); } catch { return false; }
}

pub.get('/p/:publicId', async (c) => {
  const row = (await dbFirst(c.env, `SELECT * FROM proposals WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status === 'draft') return c.json({ error: 'forbidden' }, 403);
  if (row.status === 'archived') return c.json({ error: 'gone', closed: true }, 410);
  if (row.password_protected) {
    const session = c.req.header('X-Password-Session') ?? '';
    if (!session) return c.json({ password_wall: true }, 401);
  }
  await createNotification(c.env, { userId: row.user_id, eventType: 'proposal_opened', clientId: row.client_id, documentId: row.id, title: `Proposal opened: ${row.title}` });
  await dbRun(c.env, `INSERT INTO document_visits (id, user_id, document_type, document_id, opened_at, retention_until) VALUES (?, ?, 'proposal', ?, ?, ?)`, [generateId('visit'), row.user_id, row.id, new Date().toISOString(), new Date(Date.now() + 5 * 86400000).toISOString()]);
  const content = row.content ? JSON.parse(row.content) : {};
  if (content.html) content.html = sanitizeHtml(content.html);
  return c.json({ proposal: { ...row, content } });
});

pub.post('/p/:publicId/unlock', async (c) => {
  const row = (await dbFirst(c.env, `SELECT * FROM proposals WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const ok = await checkPassword(c.env, row.password_hash, String(b.password ?? ''));
  if (!ok) return c.json({ error: 'invalid_password' }, 401);
  return c.json({ success: true, session_token: generateId('sess') });
});

pub.post('/p/:publicId/events', async (c) => {
  const row = (await dbFirst(c.env, `SELECT id, user_id FROM proposals WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  await dbRun(c.env, `INSERT INTO document_events (id, visit_id, event_type, event_data, server_timestamp, retention_until) VALUES (?, ?, ?, ?, ?, ?)`, [generateId('evt'), b.visit_id ?? generateId('visit'), b.event_type ?? 'unknown', JSON.stringify(b.event_data ?? {}), new Date().toISOString(), new Date(Date.now() + 5 * 86400000).toISOString()]);
  return c.json({ success: true });
});

pub.post('/p/:publicId/question', async (c) => {
  const row = (await dbFirst(c.env, `SELECT id, user_id, client_id FROM proposals WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  await createNotification(c.env, { userId: row.user_id, eventType: 'client_replied', clientId: row.client_id, documentId: row.id, title: `Client question: ${String(b.question_text ?? '').slice(0, 80)}` });
  return c.json({ success: true }, 201);
});

pub.get('/c/:publicId', async (c) => {
  const row = (await dbFirst(c.env, `SELECT * FROM contracts WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status === 'archived') return c.json({ error: 'gone', closed: true }, 410);
  return c.json({ contract: row });
});

pub.post('/c/:publicId/action', async (c) => {
  const row = (await dbFirst(c.env, `SELECT id, user_id, client_id, status FROM contracts WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  if (b.action === 'approve') {
    await dbRun(c.env, `UPDATE contracts SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?`, [new Date().toISOString(), new Date().toISOString(), row.id]);
    await createNotification(c.env, { userId: row.user_id, eventType: 'contract_approved', clientId: row.client_id, documentId: row.id, title: 'Contract approved' });
  } else if (b.action === 'decline') {
    await dbRun(c.env, `UPDATE contracts SET status = 'declined', declined_at = ?, updated_at = ? WHERE id = ?`, [new Date().toISOString(), new Date().toISOString(), row.id]);
    await createNotification(c.env, { userId: row.user_id, eventType: 'contract_declined', clientId: row.client_id, documentId: row.id, title: 'Contract declined' });
  } else if (b.action === 'question') {
    await createNotification(c.env, { userId: row.user_id, eventType: 'client_replied', clientId: row.client_id, documentId: row.id, title: `Contract question: ${String(b.question ?? '').slice(0, 80)}` });
  } else {
    return c.json({ error: 'invalid_payload' }, 400);
  }
  return c.json({ success: true });
});

pub.get('/i/:publicId', async (c) => {
  const row = (await dbFirst(c.env, `SELECT * FROM invoices WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status === 'archived') return c.json({ error: 'gone', closed: true }, 410);
  return c.json({ invoice: row });
});

pub.post('/i/:publicId/buy-now', async (c) => {
  const row = (await dbFirst(c.env, `SELECT id, user_id, client_id, payment_arrangement FROM invoices WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const arr = row.payment_arrangement ? JSON.parse(row.payment_arrangement) : {};
  await createNotification(c.env, { userId: row.user_id, eventType: 'invoice_paid', clientId: row.client_id, documentId: row.id, title: 'Client clicked Buy Now' });
  if (arr.type === 'link' && arr.url) return c.json({ success: true, redirect: arr.url });
  return c.json({ success: true, show_account_details: true });
});

pub.post('/i/:publicId/proof', async (c) => {
  const row = (await dbFirst(c.env, `SELECT id, user_id, client_id FROM invoices WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  await dbRun(c.env, `UPDATE invoices SET status = 'proof_submitted', proof_submitted_at = ?, updated_at = ? WHERE id = ?`, [new Date().toISOString(), new Date().toISOString(), row.id]);
  await createNotification(c.env, { userId: row.user_id, eventType: 'invoice_paid', clientId: row.client_id, documentId: row.id, title: 'Payment proof uploaded' });
  return c.json({ success: true });
});

pub.get('/f/:publicId', async (c) => {
  const row = (await dbFirst(c.env, `SELECT * FROM forms WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status === 'closed' || row.status === 'archived') return c.json({ error: 'gone', closed: true }, 410);
  return c.json({ form: row });
});

pub.post('/f/:publicId/submit', async (c) => {
  const row = (await dbFirst(c.env, `SELECT id, user_id, client_id, thank_you_config FROM forms WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const user = await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ?`, [row.user_id]);
  const plan = user.rows[0]?.plan ?? 'free';
  const prompt = generatePrompt(b.service_type ?? 'project', b.answers ?? {});
  await dbRun(c.env, `UPDATE forms SET generated_prompt = ? WHERE id = ?`, [prompt, row.id]);
  await createNotification(c.env, { userId: row.user_id, eventType: 'form_submitted', clientId: row.client_id, documentId: row.id, title: 'Form submitted' });
  const thankYou = (plan === 'scale' || plan === 'teams') && row.thank_you_config ? JSON.parse(row.thank_you_config) : null;
  return c.json({ success: true, generated_prompt: prompt, thank_you_config: thankYou });
});


pub.post('/c/:publicId/unlock', async (c) => {
  const row = (await dbFirst(c.env, `SELECT * FROM contracts WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const ok = await checkPassword(c.env, row.password_hash, String(b.password ?? ''));
  if (!ok) return c.json({ error: 'invalid_password' }, 401);
  return c.json({ success: true, session_token: generateId('sess') });
});

pub.post('/i/:publicId/unlock', async (c) => {
  const row = (await dbFirst(c.env, `SELECT * FROM invoices WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const ok = await checkPassword(c.env, row.password_hash, String(b.password ?? ''));
  if (!ok) return c.json({ error: 'invalid_password' }, 401);
  return c.json({ success: true, session_token: generateId('sess') });
});

pub.post('/f/:publicId/unlock', async (c) => {
  const row = (await dbFirst(c.env, `SELECT * FROM forms WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const ok = await checkPassword(c.env, row.password_hash, String(b.password ?? ''));
  if (!ok) return c.json({ error: 'invalid_password' }, 401);
  return c.json({ success: true, session_token: generateId('sess') });
});
export default pub;

