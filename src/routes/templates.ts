import { Hono } from 'hono';
import { tursoQuery } from '../utils/turso';
import { dbQuery } from '../utils/db';
import { userAuthMiddleware } from '../middleware/user-auth';
import type { Bindings } from '../types';

const templates = new Hono<{ Bindings: Bindings }>();
templates.use('*', userAuthMiddleware);

templates.get('/', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const user = await tursoQuery(c.env, `SELECT services FROM users WHERE id = ?`, [uid]);
  const services = JSON.parse(user.rows[0]?.services ?? '[]');
  const builtIn = await dbQuery(c.env, `SELECT id, name, type, tags, b2_key, source, status, times_used FROM templates WHERE source = 'built_in' AND status IN ('active','featured')`);
  const custom = await dbQuery(c.env, `SELECT id, name, type, tags, b2_key, source, status FROM templates WHERE source = 'custom' AND user_id = ? AND status IN ('active','featured')`, [uid]);
  const mark = (t: any) => ({ ...t, suggested: JSON.parse(t.tags || '[]').some((tag: string) => services.includes(tag)) });
  return c.json({ built_in: builtIn.map(mark), custom: custom.map(mark) });
});

templates.get('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const row = await dbQuery(c.env, `SELECT * FROM templates WHERE id = ? AND (source = 'built_in' OR user_id = ?)`, [c.req.param('id'), uid]);
  return c.json({ template: row[0] ?? null });
});

export default templates;
