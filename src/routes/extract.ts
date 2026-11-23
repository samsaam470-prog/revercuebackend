import { Hono } from 'hono';
import { runLayer1, fetchVisualAssets } from '../services/pipeline';
import { userAuthMiddleware } from '../middleware/user-auth';
import { checkRateLimit } from '../services/rate-limit';
import type { Bindings } from '../types';

const extract = new Hono<{ Bindings: Bindings }>();
extract.use('*', userAuthMiddleware);

extract.post('/', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const rl = await checkRateLimit(c.env, 'extract:' + uid, 20, 3600);
  if (!rl.allowed) return c.json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429);

  const body = await c.req.json().catch(() => ({}));
  const clientName = body.client_name ? String(body.client_name) : 'the client';
  const industry = body.industry ? String(body.industry) : (body.service ? String(body.service) : 'general');
  const service = body.service ? String(body.service) : (body.industry ? String(body.industry) : 'freelance services');
  if (!industry || !service) {
    return c.json({ error: 'invalid_payload', message: 'industry or service is required.' }, 400);
  }
  try {
    const result = await runLayer1(c.env, {
      client_name: clientName,
      client_email: body.client_email,
      industry,
      service,
      client_website: body.client_website,
      user_website: body.user_website,
      business_name: body.business_name,
      location: body.location,
    });
    // Flatten notes/images to top level for frontend compatibility while keeping result.
    const flat = (result as any) ?? {};
    return c.json({ success: true, user_id: uid, result, notes: flat.notes ?? [], images: flat.images ?? [] });
  } catch (err: any) {
    console.error('EXTRACT_FAILED', err.message);
    return c.json({ error: 'extract_failed', message: err.message ?? 'Unknown error' }, 500);
  }
});

extract.post('/visuals', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const rl = await checkRateLimit(c.env, 'visuals:' + uid, 30, 3600);
  if (!rl.allowed) return c.json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429);

  const body = await c.req.json().catch(() => ({}));
  if (!Array.isArray(body.requests)) return c.json({ error: 'invalid_payload' }, 400);
  try {
    const assets = await fetchVisualAssets(c.env, body.requests);
    return c.json({ success: true, assets });
  } catch (err: any) {
    console.error('VISUALS_FAILED', err.message);
    return c.json({ error: 'visuals_failed', message: err.message ?? 'Unknown error' }, 500);
  }
});

export default extract;
