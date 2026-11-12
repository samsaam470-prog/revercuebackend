import { Hono } from 'hono';
import { fixWithPatterns } from '../services/patterns';
import { resolveVisuals } from '../services/visuals';
import { userAuthMiddleware } from '../middleware/user-auth';
import type { Bindings } from '../types';

const organize = new Hono<{ Bindings: Bindings }>();
organize.use('*', userAuthMiddleware);

organize.post('/', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const body = await c.req.json().catch(() => ({}));
  if (!body.industry || !body.service) return c.json({ error: 'invalid_payload' }, 400);

  try {
    const fixed = await fixWithPatterns(
      c.env,
      {
        user_id: uid,
        client_id: body.client_id ?? null,
        industry: String(body.industry),
        service: String(body.service),
        tone: String(body.tone ?? 'formal'),
        sections: Array.isArray(body.sections) ? body.sections : [],
      },
      body.layer2 ?? {}
    );
    return c.json({ success: true, result: fixed });
  } catch (err: any) {
    return c.json({ error: 'organize_failed', message: err.message ?? 'Unknown' }, 500);
  }
});

organize.post('/visuals', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!Array.isArray(body.requests)) return c.json({ error: 'invalid_payload' }, 400);
  try {
    const { assets, rejected } = await resolveVisuals(c.env, body.requests);
    return c.json({ success: true, assets, rejected });
  } catch (err: any) {
    return c.json({ error: 'visuals_failed', message: err.message ?? 'Unknown' }, 500);
  }
});

export default organize;
