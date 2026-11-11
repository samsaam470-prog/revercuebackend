import { Hono } from 'hono';
import { tursoQuery } from '../utils/turso';
import { dbQuery, dbRun } from '../utils/db';
import { generateId } from '../utils/ids';
import { userAuthMiddleware } from '../middleware/user-auth';
import { sanitizeHtml, fetchFromB2, uploadToB2 } from '../services/storage';
import { CUSTOM_TEMPLATE_LIMIT } from '../config/constants';
import type { Bindings } from '../types';

const templates = new Hono<{ Bindings: Bindings }>();
templates.use('*', userAuthMiddleware);

templates.get('/', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const user = await tursoQuery(c.env, `SELECT services FROM users WHERE id = ?`, [uid]);
  const services: string[] = JSON.parse(user.rows[0]?.services ?? '[]');
  const builtIn = await dbQuery(c.env, `SELECT id, name, type, tags, b2_key, source, status, times_used FROM templates WHERE source = 'built_in' AND status IN ('active','featured')`);
  const custom = await dbQuery(c.env, `SELECT id, name, type, tags, b2_key, source, status FROM templates WHERE source = 'custom' AND user_id = ? AND status IN ('active','featured')`, [uid]);
  const mark = (t: any) => ({ ...t, suggested: JSON.parse(t.tags || '[]').some((tag: string) => services.includes(tag)) });
  return c.json({ built_in: builtIn.map(mark), custom: custom.map(mark) });
});

templates.get('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const row = await dbQuery(c.env, `SELECT * FROM templates WHERE id = ? AND (source = 'built_in' OR user_id = ?)`, [c.req.param('id'), uid]);
  if (row.length === 0) return c.json({ error: 'not_found' }, 404);
  const t: any = row[0];
  let html: string | null = null;
  if (t.b2_key) {
    try {
      const res = await fetchFromB2(c.env, t.b2_key);
      html = await res.text();
    } catch {
      html = null;
    }
  }
  return c.json({ template: t, html });
});

templates.post('/upload', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const user = await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ?`, [uid]);
  const plan = user.rows[0]?.plan ?? 'free';
  const limit = CUSTOM_TEMPLATE_LIMIT[plan as keyof typeof CUSTOM_TEMPLATE_LIMIT];
  if (limit === 0) return c.json({ error: 'forbidden', message: 'Custom templates are not available on this plan.' }, 403);

  const count = await dbQuery(c.env, `SELECT COUNT(*) as c FROM templates WHERE source = 'custom' AND user_id = ?`, [uid]);
  if (Number(count[0]?.c ?? 0) >= limit) return c.json({ error: 'plan_limit_reached', message: `You have ${limit} of ${limit} custom templates.` }, 403);

  const body = await c.req.parseBody();
  const name = String(body['name'] ?? '').trim();
  const type = String(body['type'] ?? 'proposal');
  const tags = String(body['tags'] ?? '[]');
  if (!name) return c.json({ error: 'invalid_payload', message: 'Name is required.' }, 400);

  let html = '';
  const url = String(body['url'] ?? '').trim();
  const file = body['file'] as File | undefined;

  if (url) {
    const res = await fetch(url);
    if (!res.ok) return c.json({ error: 'fetch_failed', message: 'Could not fetch the URL.' }, 400);
    html = await res.text();
  } else if (file) {
    html = await file.text();
  } else {
    return c.json({ error: 'invalid_payload', message: 'Provide an HTML file or a URL.' }, 400);
  }

  const sanitized = sanitizeHtml(html);
  const key = `custom-templates/${uid}/${generateId('tpl')}.html`;
  const ok = await uploadToB2(c.env, key, new TextEncoder().encode(sanitized).buffer, 'text/html');
  if (!ok) return c.json({ error: 'upload_failed' }, 500);

  const id = generateId('tpl');
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `INSERT INTO templates (id, name, type, tags, b2_key, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'custom', 'active', ?, ?)`,
    [id, name, type, tags, key, now, now]
  );
  return c.json({ success: true, id, b2_key: key }, 201);
});

templates.delete('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(c.env, `DELETE FROM templates WHERE id = ? AND source = 'custom' AND user_id = ?`, [c.req.param('id'), uid]);
  return c.json({ success: true });
});

export default templates;
