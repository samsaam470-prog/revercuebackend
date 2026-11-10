import { Hono } from 'hono';
import { fetchFromB2 } from '../services/storage';
import type { Bindings } from '../types';

const files = new Hono<{ Bindings: Bindings }>();

files.get('/*', async (c) => {
  const key = c.req.path.replace('/api/files/', '');
  if (!key) return c.json({ error: 'invalid_payload' }, 400);
  try {
    return await fetchFromB2(c.env, key);
  } catch (err) {
    return c.json({ error: 'not_found' }, 404);
  }
});

export default files;
