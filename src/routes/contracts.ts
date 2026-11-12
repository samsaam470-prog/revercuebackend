import { Hono } from 'hono';
import { dbQuery, dbFirst, dbRun } from '../utils/db';
import { generateId, generatePublicId } from '../utils/ids';
import { userAuthMiddleware } from '../middleware/user-auth';
import { createNotification } from '../services/notifications';
import { scheduleSummary } from '../services/summary';
import type { Bindings } from '../types';

const contracts = new Hono<{ Bindings: Bindings }>();
contracts.use('*', userAuthMiddleware);

contracts.get('/', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const rows = await dbQuery(c.env, `SELECT id, title, client_id, status, public_id, created_at FROM contracts WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`, [uid]);
  return c.json({ data: rows });
});

contracts.post('/draft', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json().catch(() => ({}));
  if (!b.client_id || !b.title) return c.json({ error: 'invalid_payload' }, 400);
  const id = generateId('con');
  const now = new Date().toISOString();
  await dbRun(c.env, `INSERT INTO contracts (id, user_id, client_id, linked_proposal_id, title, content, after_approval, status, draft_created_at, draft_retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, 30, ?, ?)`, [id, uid, b.client_id, b.linked_proposal_id ?? null, b.title, JSON.stringify(b.content ?? {}), b.after_approval ?? 'pdf_only', now, now, now]);
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

contracts.delete('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(c.env, `DELETE FROM contracts WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  return c.json({ success: true });
});

export default contracts;
