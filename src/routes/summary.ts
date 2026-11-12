import { Hono } from 'hono';
import { dbFirst } from '../utils/db';
import { scheduleSummary, generateSummary } from '../services/summary';
import { userAuthMiddleware } from '../middleware/user-auth';
import type { Bindings } from '../types';

const summary = new Hono<{ Bindings: Bindings }>();
summary.use('*', userAuthMiddleware);

summary.get('/:clientId', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const client = await dbFirst<any>(c.env, `SELECT summary, summary_generated_at FROM clients WHERE id = ? AND user_id = ?`, [c.req.param('clientId'), uid]);
  if (!client) return c.json({ error: 'not_found' }, 404);
  return c.json({ summary: client.summary, generated_at: client.summary_generated_at });
});

summary.post('/:clientId/schedule', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const client = await dbFirst<any>(c.env, `SELECT id FROM clients WHERE id = ? AND user_id = ?`, [c.req.param('clientId'), uid]);
  if (!client) return c.json({ error: 'not_found' }, 404);
  await scheduleSummary(c.env, c.req.param('clientId'), uid);
  return c.json({ success: true });
});

summary.post('/:clientId/generate', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const client = await dbFirst<any>(c.env, `SELECT id FROM clients WHERE id = ? AND user_id = ?`, [c.req.param('clientId'), uid]);
  if (!client) return c.json({ error: 'not_found' }, 404);
  try {
    const result = await generateSummary(c.env, c.req.param('clientId'));
    return c.json({ success: true, ...result });
  } catch (err: any) {
    return c.json({ error: 'summary_failed', message: err.message ?? 'Unknown' }, 500);
  }
});

export default summary;
