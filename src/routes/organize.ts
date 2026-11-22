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
  const industry = body.industry ? String(body.industry) : 'general';
  const service = body.service ? String(body.service) : 'freelance services';

  try {
    const fixed = await fixWithPatterns(
      c.env,
      {
        user_id: uid,
        client_id: body.client_id ?? null,
        industry,
        service,
        tone: String(body.tone ?? 'formal'),
        sections: Array.isArray(body.sections) ? body.sections : [],
      },
      body.layer2 ?? body.research ?? {}
    );
    const inputSections = Array.isArray(body.sections) ? body.sections : [];
    const sectionsObj: Record<string, string> = {};
    for (const s of inputSections) sectionsObj[String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_')] = '';
    return c.json({ success: true, result: fixed, sections: sectionsObj });
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
