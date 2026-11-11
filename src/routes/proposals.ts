import { Hono } from 'hono';
import { dbQuery, dbFirst, dbRun } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { generateId, generatePublicId } from '../utils/ids';
import { userAuthMiddleware } from '../middleware/user-auth';
import { createNotification } from '../services/notifications';
import { ACTIVE_DOCUMENT_LIMIT, ARCHIVE_COUNT_LIMIT, ARCHIVE_RETENTION_DAYS, DRAFT_RETENTION_DAYS, PASSWORD_PROTECTED_LIMIT } from '../config/constants';
import type { Bindings } from '../types';

const proposals = new Hono<{ Bindings: Bindings }>();
proposals.use('*', userAuthMiddleware);

function hashPassword(p: string): string { return p; }

proposals.get('/', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const rows = await dbQuery(c.env, `SELECT id, title, client_id, status, public_id, total_time_spent_seconds, created_at FROM proposals WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`, [uid]);
  return c.json({ data: rows });
});

proposals.post('/draft', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json().catch(() => ({}));
  if (!b.title || !b.problem) return c.json({ error: 'invalid_payload' }, 400);
  const user = await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ?`, [uid]);
  const plan = user.rows[0]?.plan ?? 'free';
  const count = await dbQuery(c.env, `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'published'`, [uid]);
  if (Number(count[0]?.c ?? 0) >= ACTIVE_DOCUMENT_LIMIT[plan as keyof typeof ACTIVE_DOCUMENT_LIMIT]) return c.json({ error: 'plan_limit_reached' }, 403);

  let clientId = b.client_id;
  if (!clientId) {
    if (!b.client_name || !b.client_email) return c.json({ error: 'invalid_payload' }, 400);
    clientId = generateId('cli');
    const now = new Date().toISOString();
    await dbRun(c.env, `INSERT INTO clients (id, user_id, name, email, source, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, 'auto_proposal', ?, ?, ?)`, [clientId, uid, b.client_name, b.client_email, now, now, now]);
  }
  const id = generateId('prop');
  const now = new Date().toISOString();
  await dbRun(c.env, `INSERT INTO proposals (id, user_id, client_id, title, content, status, draft_created_at, draft_retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`, [id, uid, clientId, b.title, JSON.stringify({ problem: b.problem, sections: b.sections ?? [], currency: b.currency ?? 'USD', timeline: b.timeline_length ?? null, tone: b.tone ?? 'formal' }), now, DRAFT_RETENTION_DAYS[plan as keyof typeof DRAFT_RETENTION_DAYS], now, now]);
  return c.json({ success: true, id, status: 'draft' }, 201);
});

proposals.get('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const row = await dbFirst(c.env, `SELECT * FROM proposals WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ proposal: row });
});

proposals.patch('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  await dbRun(c.env, `UPDATE proposals SET title = COALESCE(?, title), content = COALESCE(?, content), updated_at = ? WHERE id = ? AND user_id = ?`, [b.title ?? null, b.content ? JSON.stringify(b.content) : null, new Date().toISOString(), c.req.param('id'), uid]);
  return c.json({ success: true });
});

proposals.post('/:id/autosave', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json().catch(() => ({}));
  await dbRun(c.env, `UPDATE proposals SET content = COALESCE(?, content), updated_at = ? WHERE id = ? AND user_id = ?`, [b.content ? JSON.stringify(b.content) : null, new Date().toISOString(), c.req.param('id'), uid]);
  return c.json({ success: true });
});

proposals.post('/:id/publish', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const id = c.req.param('id');
  const row = await dbFirst(c.env, `SELECT * FROM proposals WHERE id = ? AND user_id = ?`, [id, uid]) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const publicId = row.public_id ?? generatePublicId();
  const now = new Date().toISOString();
  await dbRun(c.env, `UPDATE proposals SET status = 'published', public_id = ?, published_at = ?, updated_at = ? WHERE id = ?`, [publicId, now, now, id]);
  await createNotification(c.env, { userId: uid, eventType: 'document_created', documentId: id, title: `Proposal published: ${row.title}` });
  return c.json({ success: true, public_id: publicId, url: `https://revercue.pages.dev/p/${publicId}` });
});

proposals.post('/:id/duplicate', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const row = await dbFirst(c.env, `SELECT * FROM proposals WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const id = generateId('prop');
  const now = new Date().toISOString();
  await dbRun(c.env, `INSERT INTO proposals (id, user_id, client_id, title, content, status, draft_created_at, draft_retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, 30, ?, ?)`, [id, uid, row.client_id, row.title, row.content, now, now, now]);
  return c.json({ success: true, id, status: 'draft' }, 201);
});

proposals.post('/:id/archive', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const user = await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ?`, [uid]);
  const plan = user.rows[0]?.plan ?? 'free';
  const count = await dbQuery(c.env, `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'archived'`, [uid]);
  if (Number(count[0]?.c ?? 0) >= ARCHIVE_COUNT_LIMIT[plan as keyof typeof ARCHIVE_COUNT_LIMIT]) return c.json({ error: 'archive_limit_reached' }, 403);
  const now = new Date().toISOString();
  const del = new Date(Date.now() + ARCHIVE_RETENTION_DAYS[plan as keyof typeof ARCHIVE_RETENTION_DAYS] * 86400000).toISOString();
  await dbRun(c.env, `UPDATE proposals SET status = 'archived', archived_at = ?, archive_retention_days = ?, archive_deletion_date = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [now, ARCHIVE_RETENTION_DAYS[plan as keyof typeof ARCHIVE_RETENTION_DAYS], del, now, c.req.param('id'), uid]);
  return c.json({ success: true, status: 'archived', archive_deletion_date: del });
});

proposals.post('/:id/unarchive', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(c.env, `UPDATE proposals SET status = 'published', archived_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?`, [new Date().toISOString(), c.req.param('id'), uid]);
  return c.json({ success: true, status: 'published' });
});

proposals.post('/:id/share', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const row = await dbFirst(c.env, `SELECT client_id FROM proposals WHERE id = ? AND user_id = ?`, [id, uid]) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  await dbRun(c.env, `INSERT INTO communication_log (id, user_id, client_id, entry_type, channel, linked_document_type, linked_document_id, created_at) VALUES (?, ?, ?, 'document_shared', ?, 'proposal', ?, ?)`, [generateId('log'), uid, row.client_id, b.channel ?? 'other', id, new Date().toISOString()]);
  return c.json({ success: true });
});

proposals.post('/:id/password', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  if (b.remove) {
    await dbRun(c.env, `UPDATE proposals SET password_hash = NULL, password_protected = 0 WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
    return c.json({ success: true, password_protected: false });
  }
  const user = await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ?`, [uid]);
  const plan = user.rows[0]?.plan ?? 'free';
  if (PASSWORD_PROTECTED_LIMIT[plan as keyof typeof PASSWORD_PROTECTED_LIMIT] === 0) return c.json({ error: 'forbidden' }, 403);
  await dbRun(c.env, `UPDATE proposals SET password_hash = ?, password_protected = 1 WHERE id = ? AND user_id = ?`, [hashPassword(String(b.password ?? '')), c.req.param('id'), uid]);
  return c.json({ success: true, password_protected: true });
});

proposals.delete('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(c.env, `DELETE FROM proposals WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  return c.json({ success: true });
});

export default proposals;
