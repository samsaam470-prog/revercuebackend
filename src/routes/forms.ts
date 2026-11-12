import { Hono } from 'hono';
import { dbQuery, dbFirst, dbRun } from '../utils/db';
import { generateId, generatePublicId } from '../utils/ids';
import { userAuthMiddleware } from '../middleware/user-auth';
import { createNotification } from '../services/notifications';
import { generatePrompt } from '../services/prompt-creator';
import type { Bindings } from '../types';

const forms = new Hono<{ Bindings: Bindings }>();
forms.use('*', userAuthMiddleware);

forms.get('/', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const rows = await dbQuery(c.env, `SELECT id, title, status, public_id, created_at FROM forms WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`, [uid]);
  return c.json({ data: rows });
});

forms.post('/draft', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json().catch(() => ({}));
  if (!b.title) return c.json({ error: 'invalid_payload' }, 400);
  const id = generateId('form');
  const now = new Date().toISOString();
  await dbRun(c.env, `INSERT INTO forms (id, user_id, client_id, title, description, questions, branching, status, draft_created_at, draft_retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, 30, ?, ?)`, [id, uid, b.client_id ?? null, b.title, b.description ?? null, JSON.stringify(b.questions ?? []), JSON.stringify(b.branching ?? {}), now, now, now]);
  return c.json({ success: true, id, status: 'draft' }, 201);
});

forms.get('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const row = await dbFirst(c.env, `SELECT * FROM forms WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ form: row });
});

forms.patch('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  await dbRun(c.env, `UPDATE forms SET title = COALESCE(?, title), description = COALESCE(?, description), questions = COALESCE(?, questions), branching = COALESCE(?, branching), updated_at = ? WHERE id = ? AND user_id = ?`, [b.title ?? null, b.description ?? null, b.questions ? JSON.stringify(b.questions) : null, b.branching ? JSON.stringify(b.branching) : null, new Date().toISOString(), c.req.param('id'), uid]);
  return c.json({ success: true });
});

forms.post('/:id/publish', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const id = c.req.param('id');
  const row = (await dbFirst(c.env, `SELECT * FROM forms WHERE id = ? AND user_id = ?`, [id, uid])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const publicId = row.public_id ?? generatePublicId();
  const now = new Date().toISOString();
  await dbRun(c.env, `UPDATE forms SET status = 'published', public_id = ?, published_at = ?, updated_at = ? WHERE id = ?`, [publicId, now, now, id]);
  await createNotification(c.env, { userId: uid, eventType: 'document_created', clientId: row.client_id, documentId: id, title: `Form published: ${row.title}` });
  return c.json({ success: true, public_id: publicId, url: `https://revercue.pages.dev/f/${publicId}` });
});

forms.delete('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(c.env, `DELETE FROM forms WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  return c.json({ success: true });
});

export default forms;
