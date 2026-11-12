import { Hono } from 'hono';
import { dbFirst, dbRun } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { generateId } from '../utils/ids';
import { createNotification } from '../services/notifications';
import { generatePrompt } from '../services/prompt-creator';
import { trackEvent } from '../services/tracking';
import type { Bindings } from '../types';

const pub = new Hono<{ Bindings: Bindings }>();

async function checkPassword(hash: string | null, input: string): Promise<boolean> {
  if (!hash) return true;
  const bcrypt = (await import('bcryptjs')).default;
  try { return await bcrypt.compare(input, hash); } catch { return false; }
}

async function getUserPlan(env: Bindings, userId: string): Promise<string> {
  const r = await tursoQuery(env, `SELECT plan FROM users WHERE id = ?`, [userId]);
  return r.rows[0]?.plan ?? 'free';
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
  const plan = await getUserPlan(c.env, row.user_id);
  await createNotification(c.env, { userId: row.user_id, eventType: 'proposal_opened', clientId: row.client_id, documentId: row.id, title: `Proposal opened: ${row.title}`, documentTitle: row.title });
  await trackEvent(c.env, { userId: row.user_id, plan, documentType: 'proposal', documentId: row.id, eventType: 'opened' });
  return c.json({ proposal: row });
});

pub.post('/p/:publicId/unlock', async (c) => {
  const row = (await dbFirst(c.env, `SELECT * FROM proposals WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const ok = await checkPassword(row.password_hash, String(b.password ?? ''));
  if (!ok) return c.json({ error: 'invalid_password' }, 401);
  return c.json({ success: true, session_token: generateId('sess') });
});

pub.post('/p/:publicId/events', async (c) => {
  const row = (await dbFirst(c.env, `SELECT id, user_id FROM proposals WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const plan = await getUserPlan(c.env, row.user_id);
  await trackEvent(c.env, { userId: row.user_id, plan, documentType: 'proposal', documentId: row.id, visitId: b.visit_id, eventType: b.event_type ?? 'unknown', eventData: b.event_data });
  return c.json({ success: true });
});

pub.post('/p/:publicId/question', async (c) => {
  const row = (await dbFirst(c.env, `SELECT id, user_id, client_id FROM proposals WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  await createNotification(c.env, { userId: row.user_id, eventType: 'client_replied', clientId: row.client_id, documentId: row.id, title: `Client question: ${String(b.question_text ?? '').slice(0, 80)}`, documentTitle: 'Proposal question' });
  return c.json({ success: true }, 201);
});

pub.get('/c/:publicId', async (c) => {
  const row = (await dbFirst(c.env, `SELECT * FROM contracts WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status === 'archived') return c.json({ error: 'gone', closed: true }, 410);
  return c.json({ contract: row });
});

pub.post('/c/:publicId/action', async (c) => {
  const row = (await dbFirst(c.env, `SELECT id, user_id, client_id, status, after_approval, linked_proposal_id, title FROM contracts WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  if (b.action === 'approve') {
    await dbRun(c.env, `UPDATE contracts SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?`, [new Date().toISOString(), new Date().toISOString(), row.id]);
    await createNotification(c.env, { userId: row.user_id, eventType: 'contract_approved', clientId: row.client_id, documentId: row.id, title: 'Contract approved', documentTitle: row.title });
    return c.json({ success: true, after_approval: row.after_approval ?? 'pdf_only' });
  } else if (b.action === 'decline') {
    await dbRun(c.env, `UPDATE contracts SET status = 'declined', declined_at = ?, updated_at = ? WHERE id = ?`, [new Date().toISOString(), new Date().toISOString(), row.id]);
    await createNotification(c.env, { userId: row.user_id, eventType: 'contract_declined', clientId: row.client_id, documentId: row.id, title: 'Contract declined', documentTitle: row.title });
  } else if (b.action === 'question') {
    await createNotification(c.env, { userId: row.user_id, eventType: 'client_replied', clientId: row.client_id, documentId: row.id, title: `Contract question: ${String(b.question ?? '').slice(0, 80)}`, documentTitle: row.title });
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
  const row = (await dbFirst(c.env, `SELECT id, user_id, client_id, payment_arrangement, invoice_number FROM invoices WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const arr = row.payment_arrangement ? JSON.parse(row.payment_arrangement) : {};
  await createNotification(c.env, { userId: row.user_id, eventType: 'invoice_paid', clientId: row.client_id, documentId: row.id, title: 'Client clicked Buy Now', documentTitle: row.invoice_number });
  if (arr.type === 'link' && arr.url) return c.json({ success: true, redirect: arr.url });
  return c.json({ success: true, show_account_details: true });
});

pub.post('/i/:publicId/proof', async (c) => {
  const row = (await dbFirst(c.env, `SELECT id, user_id, client_id, invoice_number FROM invoices WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  await dbRun(c.env, `UPDATE invoices SET status = 'proof_submitted', proof_submitted_at = ?, updated_at = ? WHERE id = ?`, [new Date().toISOString(), new Date().toISOString(), row.id]);
  await createNotification(c.env, { userId: row.user_id, eventType: 'invoice_proof_submitted', clientId: row.client_id, documentId: row.id, title: 'Payment proof uploaded', documentTitle: row.invoice_number });
  return c.json({ success: true });
});

pub.get('/f/:publicId', async (c) => {
  const row = (await dbFirst(c.env, `SELECT * FROM forms WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status === 'closed' || row.status === 'archived') return c.json({ error: 'gone', closed: true }, 410);
  return c.json({ form: row });
});

pub.post('/f/:publicId/submit', async (c) => {
  const row = (await dbFirst(c.env, `SELECT id, user_id, client_id, thank_you_config, questions, title FROM forms WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const prompt = generatePrompt(b.service_type ?? 'project', b.answers ?? {});
  await dbRun(c.env, `UPDATE forms SET generated_prompt = ? WHERE id = ?`, [prompt, row.id]);
  await createNotification(c.env, { userId: row.user_id, eventType: 'form_submitted', clientId: row.client_id, documentId: row.id, title: 'Form submitted', documentTitle: row.title });
  return c.json({ success: true, generated_prompt: prompt });
});


pub.get('/p/:publicId/pdf', async (c) => {
  const row = (await dbFirst(c.env, `SELECT id FROM proposals WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const { generateDocumentPdf } = await import('../services/pdf');
  const pdf = await generateDocumentPdf(c.env, 'proposal', row.id);
  if (!pdf) return c.json({ error: 'pdf_failed' }, 500);
  return new Response(pdf.html, { headers: { 'Content-Type': 'text/html', 'Content-Disposition': `inline; filename="${row.id}.html"` } });
});

pub.get('/c/:publicId/pdf', async (c) => {
  const row = (await dbFirst(c.env, `SELECT id FROM contracts WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const { generateDocumentPdf } = await import('../services/pdf');
  const pdf = await generateDocumentPdf(c.env, 'contract', row.id);
  if (!pdf) return c.json({ error: 'pdf_failed' }, 500);
  return new Response(pdf.html, { headers: { 'Content-Type': 'text/html', 'Content-Disposition': `inline; filename="${row.id}.html"` } });
});

pub.get('/i/:publicId/pdf', async (c) => {
  const row = (await dbFirst(c.env, `SELECT id FROM invoices WHERE public_id = ?`, [c.req.param('publicId')])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const { generateDocumentPdf } = await import('../services/pdf');
  const pdf = await generateDocumentPdf(c.env, 'invoice', row.id);
  if (!pdf) return c.json({ error: 'pdf_failed' }, 500);
  return new Response(pdf.html, { headers: { 'Content-Type': 'text/html', 'Content-Disposition': `inline; filename="${row.id}.html"` } });
});
export default pub;

