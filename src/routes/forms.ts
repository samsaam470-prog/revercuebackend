import { Hono } from 'hono';
import { dbQuery, dbFirst, dbRun } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { generateId, generatePublicId } from '../utils/ids';
import { userAuthMiddleware } from '../middleware/user-auth';
import { createNotification } from '../services/notifications';
import { generatePrompt } from '../services/prompt-creator';
import { ADAPTIVE_FORM_LIMIT, CUSTOM_THANK_YOU, ACTIVE_DOCUMENT_LIMIT, DRAFT_RETENTION_DAYS } from '../config/constants';
import type { Bindings } from '../types';

const forms = new Hono<{ Bindings: Bindings }>();
forms.use('*', userAuthMiddleware);

async function getPlan(env: Bindings, uid: string): Promise<string> {
  const u = await tursoQuery(env, `SELECT plan FROM users WHERE id = ?`, [uid]);
  return u.rows[0]?.plan ?? 'free';
}

forms.get('/', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const rows = await dbQuery(c.env, `SELECT id, title, status, public_id, created_at FROM forms WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`, [uid]);
  return c.json({ data: rows });
});

forms.post('/draft', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json().catch(() => ({}));
  if (!b.title) return c.json({ error: 'invalid_payload' }, 400);
  const plan = await getPlan(c.env, uid);
  const published = await dbQuery(c.env, `SELECT COUNT(*) as c FROM forms WHERE user_id = ? AND status = 'published'`, [uid]);
  if (Number(published[0]?.c ?? 0) >= ACTIVE_DOCUMENT_LIMIT[plan as keyof typeof ACTIVE_DOCUMENT_LIMIT]) return c.json({ error: 'plan_limit_reached' }, 403);
  const branching = b.branching ?? {};
  if (Object.keys(branching).length > 0 && ADAPTIVE_FORM_LIMIT[plan as keyof typeof ADAPTIVE_FORM_LIMIT] === 0) return c.json({ error: 'forbidden', message: 'Adaptive forms are available on Growth and above.' }, 403);
  const id = generateId('form');
  const now = new Date().toISOString();
  await dbRun(c.env, `INSERT INTO forms (id, user_id, client_id, title, description, questions, branching, thank_you_config, status, draft_created_at, draft_retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`, [id, uid, b.client_id ?? null, b.title, b.description ?? null, JSON.stringify(b.questions ?? []), JSON.stringify(branching), b.thank_you_config && CUSTOM_THANK_YOU[plan as keyof typeof CUSTOM_THANK_YOU] ? JSON.stringify(b.thank_you_config) : null, now, DRAFT_RETENTION_DAYS[plan as keyof typeof DRAFT_RETENTION_DAYS], now, now]);
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
  const plan = await getPlan(c.env, uid);
  const thankYou = b.thank_you_config && CUSTOM_THANK_YOU[plan as keyof typeof CUSTOM_THANK_YOU] ? JSON.stringify(b.thank_you_config) : null;
  await dbRun(c.env, `UPDATE forms SET title = COALESCE(?, title), description = COALESCE(?, description), questions = COALESCE(?, questions), branching = COALESCE(?, branching), thank_you_config = COALESCE(?, thank_you_config), updated_at = ? WHERE id = ? AND user_id = ?`, [b.title ?? null, b.description ?? null, b.questions ? JSON.stringify(b.questions) : null, b.branching ? JSON.stringify(b.branching) : null, thankYou, new Date().toISOString(), c.req.param('id'), uid]);
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

forms.post('/:id/submit', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const row = (await dbFirst(c.env, `SELECT * FROM forms WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const prompt = generatePrompt(b.service_type ?? 'project', b.answers ?? {});
  await dbRun(c.env, `UPDATE forms SET generated_prompt = ? WHERE id = ?`, [prompt, c.req.param('id')]);
  await createNotification(c.env, { userId: uid, eventType: 'form_submitted', clientId: row.client_id, documentId: c.req.param('id'), title: `Form submitted: ${row.title}` });
  return c.json({ success: true, generated_prompt: prompt });
});

forms.delete('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(c.env, `DELETE FROM forms WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  return c.json({ success: true });
});

export default forms;
