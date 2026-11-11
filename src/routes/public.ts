import { Hono } from 'hono';
import { dbFirst, dbRun } from '../utils/db';
import { generateId } from '../utils/ids';
import { createNotification } from '../services/notifications';
import { generatePrompt } from '../services/prompt-creator';
import type { Bindings } from '../types';

const pub = new Hono<{ Bindings: Bindings }>();

pub.get('/p/:publicId', async (c) => {
  const row = await dbFirst(c.env, `SELECT * FROM proposals WHERE public_id = ?`, [c.req.param('publicId')]) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status === 'draft') return c.json({ error: 'forbidden' }, 403);
  if (row.status === 'archived') return c.json({ error: 'gone', closed: true }, 410);
  if (row.password_protected) return c.json({ password_wall: true }, 401);
  await createNotification(c.env, { userId: row.user_id, eventType: 'proposal_opened', clientId: row.client_id, documentId: row.id, title: `Proposal opened: ${row.title}` });
  return c.json({ proposal: row });
});

pub.post('/p/:publicId/unlock', async (c) => c.json({ success: true, session_token: generateId('sess') }));

pub.post('/p/:publicId/events', async (c) => {
  const row = await dbFirst(c.env, `SELECT id, user_id FROM proposals WHERE public_id = ?`, [c.req.param('publicId')]) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  await dbRun(c.env, `INSERT INTO document_visits (id, user_id, document_type, document_id, session_token, opened_at, retention_until) VALUES (?, ?, 'proposal', ?, ?, ?, ?)`, [generateId('visit'), row.user_id, row.id, b.session_token ?? null, new Date().toISOString(), new Date(Date.now() + 5 * 86400000).toISOString()]);
  return c.json({ success: true });
});

pub.get('/c/:publicId', async (c) => {
  const row = await dbFirst(c.env, `SELECT * FROM contracts WHERE public_id = ?`, [c.req.param('publicId')]) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status === 'archived') return c.json({ error: 'gone', closed: true }, 410);
  return c.json({ contract: row });
});

pub.post('/c/:publicId/action', async (c) => {
  const row = await dbFirst(c.env, `SELECT id, user_id FROM contracts WHERE public_id = ?`, [c.req.param('publicId')]) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  if (b.action === 'approve') {
    await dbRun(c.env, `UPDATE contracts SET status = 'approved', approved_at = ? WHERE id = ?`, [new Date().toISOString(), row.id]);
    await createNotification(c.env, { userId: row.user_id, eventType: 'contract_approved', documentId: row.id, title: 'Contract approved' });
  } else if (b.action === 'decline') {
    await dbRun(c.env, `UPDATE contracts SET status = 'declined', declined_at = ? WHERE id = ?`, [new Date().toISOString(), row.id]);
    await createNotification(c.env, { userId: row.user_id, eventType: 'contract_declined', documentId: row.id, title: 'Contract declined' });
  }
  return c.json({ success: true });
});

pub.get('/i/:publicId', async (c) => {
  const row = await dbFirst(c.env, `SELECT * FROM invoices WHERE public_id = ?`, [c.req.param('publicId')]) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status === 'archived') return c.json({ error: 'gone', closed: true }, 410);
  return c.json({ invoice: row });
});

pub.post('/i/:publicId/proof', async (c) => {
  const row = await dbFirst(c.env, `SELECT id, user_id FROM invoices WHERE public_id = ?`, [c.req.param('publicId')]) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  await dbRun(c.env, `UPDATE invoices SET status = 'proof_submitted', proof_submitted_at = ? WHERE id = ?`, [new Date().toISOString(), row.id]);
  await createNotification(c.env, { userId: row.user_id, eventType: 'invoice_paid', documentId: row.id, title: 'Payment proof uploaded' });
  return c.json({ success: true });
});

pub.get('/f/:publicId', async (c) => {
  const row = await dbFirst(c.env, `SELECT * FROM forms WHERE public_id = ?`, [c.req.param('publicId')]) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status === 'closed') return c.json({ error: 'gone', closed: true }, 410);
  return c.json({ form: row });
});

pub.post('/f/:publicId/submit', async (c) => {
  const row = await dbFirst(c.env, `SELECT id, user_id, questions FROM forms WHERE public_id = ?`, [c.req.param('publicId')]) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const prompt = generatePrompt(b.service_type ?? 'project', b.answers ?? {});
  await dbRun(c.env, `UPDATE forms SET generated_prompt = ? WHERE id = ?`, [prompt, row.id]);
  await createNotification(c.env, { userId: row.user_id, eventType: 'form_submitted', documentId: row.id, title: 'Form submitted' });
  return c.json({ success: true, generated_prompt: prompt });
});

export default pub;
