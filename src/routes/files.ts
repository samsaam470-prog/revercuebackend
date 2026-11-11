import { Hono } from 'hono';
import { fetchFromB2, uploadToB2 } from '../services/storage';
import { userAuthMiddleware } from '../middleware/user-auth';
import { generateId } from '../utils/ids';
import type { Bindings } from '../types';

const files = new Hono<{ Bindings: Bindings }>();

files.get('/*', async (c) => {
  const key = c.req.path.replace('/api/files/', '');
  if (!key) return c.json({ error: 'invalid_payload' }, 400);
  try {
    return await fetchFromB2(c.env, key);
  } catch {
    return c.json({ error: 'not_found' }, 404);
  }
});

files.post('/upload', userAuthMiddleware, async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const body = await c.req.parseBody();
  const file = body['file'] as File;
  const prefix = String(body['prefix'] ?? 'uploads');
  if (!file) return c.json({ error: 'invalid_payload', message: 'No file provided.' }, 400);
  if (file.size > 10 * 1024 * 1024) return c.json({ error: 'invalid_payload', message: 'File must be under 10 MB.' }, 400);
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${prefix}/${uid}/${generateId('f')}-${safeName}`;
  const ok = await uploadToB2(c.env, key, await file.arrayBuffer(), file.type || 'application/octet-stream');
  if (!ok) return c.json({ error: 'upload_failed' }, 500);
  return c.json({ success: true, key, url: `/api/files/${key}` }, 201);
});

export default files;
