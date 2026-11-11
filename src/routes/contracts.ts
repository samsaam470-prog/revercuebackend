import { Hono } from 'hono';
import { dbQuery, dbFirst, dbRun } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { generateId, generatePublicId } from '../utils/ids';
import { userAuthMiddleware } from '../middleware/user-auth';
import { createNotification } from '../services/notifications';
import { ACTIVE_DOCUMENT_LIMIT, ARCHIVE_COUNT_LIMIT, ARCHIVE_RETENTION_DAYS, DRAFT_RETENTION_DAYS, PASSWORD_PROTECTED_LIMIT } from '../config/constants';
import type { Bindings } from '../types';

const contracts = new Hono<{ Bindings: Bindings }>();
contracts.use('*', userAuthMiddleware);

async function getPlan(env: Bindings, uid: string): Promise<string> {
  const u = await tursoQuery(env, `SELECT plan FROM users WHERE id = ?`, [uid]);
  return u.rows[0]?.plan ?? 'free';
}

contracts.get('/', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const rows = await dbQuery(c.env, `SELECT id, title, client_id, status, public_id, total_time_spent_seconds, created_at FROM contracts WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`, [uid]);
  return c.json({ data: rows });
});

contracts.post('/draft', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json().catch(() => ({}));
  if (!b.client_id || !b.title) return c.json({ error: 'invalid_payload' }, 400);
  const plan = await getPlan(c.env, uid);
  const published = await dbQuery(c.env, `SELECT COUNT(*) as c FROM contracts WHERE user_id = ? AND status = 'published'`, [uid]);
  if (Number(published[0]?.c ?? 0) >= ACTIVE_DOCUMENT_LIMIT[plan as keyof typeof ACTIVE_DOCUMENT_LIMIT]) return c.json({ error: 'plan_limit_reached' }, 403);
  const id = generateId('con');
  const now = new Date().toISOString();
  const content = { scope: b.scope ?? null, payment_terms: b.payment_terms ?? null, timeline: b.timeline ?? null, revisions: b.revisions ?? null, cancellation: b.cancellation ?? null, currency: b.currency ?? 'USD' };
  await dbRun(c.env, `INSERT INTO contracts (id, user_id, client_id, linked_proposal_id, title, content, after_approval, status, draft_created_at, draft_retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`, [id, uid, b.client_id, b.linked_proposal_id ?? null, b.title, JSON.stringify(content), b.after_approval ?? 'pdf_only', now, DRAFT_RETENTION_DAYS[plan as keyof typeof DRAFT_RETENTION_DAYS], now, now]);
  return c.json({ success: true, id, status: 'draft' }, 201);
});

contracts.get('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const row = await dbFirst(c.env, `SELECT * FROM contracts WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ contract: row });
});

contracts.patch('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  await dbRun(c.env, `UPDATE contracts SET title = COALESCE(?, title), content = COALESCE(?, content), after_approval = COALESCE(?, after_approval), updated_at = ? WHERE id = ? AND user_id = ?`, [b.title ?? null, b.content ? JSON.stringify(b.content) : null, b.after_approval ?? null, new Date().toISOString(), c.req.param('id'), uid]);
  return c.json({ success: true });
});

contracts.post('/:id/publish', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const id = c.req.param('id');
  const row = (await dbFirst(c.env, `SELECT * FROM contracts WHERE id = ? AND user_id = ?`, [id, uid])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const publicId = row.public_id ?? generatePublicId();
  const now = new Date().toISOString();
  await dbRun(c.env, `UPDATE contracts SET status = 'published', public_id = ?, published_at = ?, updated_at = ? WHERE id = ?`, [publicId, now, now, id]);
  await createNotification(c.env, { userId: uid, eventType: 'document_created', clientId: row.client_id, documentId: id, title: `Contract published: ${row.title}` });
  return c.json({ success: true, public_id: publicId, url: `https://revercue.pages.dev/c/${publicId}` });
});

contracts.post('/:id/archive', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const plan = await getPlan(c.env, uid);
  const archived = await dbQuery(c.env, `SELECT COUNT(*) as c FROM contracts WHERE user_id = ? AND status = 'archived'`, [uid]);
  if (Number(archived[0]?.c ?? 0) >= ARCHIVE_COUNT_LIMIT[plan as keyof typeof ARCHIVE_COUNT_LIMIT]) return c.json({ error: 'archive_limit_reached' }, 403);
  const now = new Date().toISOString();
  const days = ARCHIVE_RETENTION_DAYS[plan as keyof typeof ARCHIVE_RETENTION_DAYS];
  const del = new Date(Date.now() + days * 86400000).toISOString();
  await dbRun(c.env, `UPDATE contracts SET status = 'archived', archived_at = ?, archive_retention_days = ?, archive_deletion_date = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [now, days, del, now, c.req.param('id'), uid]);
  return c.json({ success: true, status: 'archived', archive_deletion_date: del });
});

contracts.post('/:id/password', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  if (b.remove) { await dbRun(c.env, `UPDATE contracts SET password_hash = NULL, password_protected = 0 WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]); return c.json({ success: true, password_protected: false }); }
  const plan = await getPlan(c.env, uid);
  if (PASSWORD_PROTECTED_LIMIT[plan as keyof typeof PASSWORD_PROTECTED_LIMIT] === 0) return c.json({ error: 'forbidden' }, 403);
  const { argon2id } = await import('hash-wasm');
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const hash = await argon2id({ password: String(b.password ?? ''), salt, parallelism: 1, iterations: 3, memorySize: 19456, hashLength: 32, outputType: 'encoded' });
  await dbRun(c.env, `UPDATE contracts SET password_hash = ?, password_protected = 1 WHERE id = ? AND user_id = ?`, [hash as string, c.req.param('id'), uid]);
  return c.json({ success: true, password_protected: true });
});

contracts.delete('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(c.env, `DELETE FROM contracts WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  return c.json({ success: true });
});

export default contracts;
