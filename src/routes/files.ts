import { Hono } from 'hono';
import { fetchFromB2, uploadToB2 } from '../services/storage';
import { userAuthMiddleware } from '../middleware/user-auth';
import { generateId } from '../utils/ids';
import { tursoQuery } from '../utils/turso';
import { dbQuery } from '../utils/db';
import { STORAGE_MB } from '../config/constants';
import type { Bindings } from '../types';

const files = new Hono<{ Bindings: Bindings }>();

files.get('/*', async (c) => {
  const key = c.req.path.replace('/api/files/', '');
  if (!key) return c.json({ error: 'invalid_payload' }, 400);
  try { return await fetchFromB2(c.env, key); }
  catch { return c.json({ error: 'not_found' }, 404); }
});

files.post('/upload', userAuthMiddleware, async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const body = await c.req.parseBody();
  const file = body['file'] as File;
  const prefix = String(body['prefix'] ?? 'uploads');
  if (!file) return c.json({ error: 'invalid_payload', message: 'No file provided.' }, 400);
  if (file.size > 10 * 1024 * 1024) return c.json({ error: 'invalid_payload', message: 'File must be under 10 MB.' }, 400);

  const user = await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ?`, [uid]);
  const plan = user.rows[0]?.plan ?? 'free';
  const limitMb = STORAGE_MB[plan as keyof typeof STORAGE_MB] ?? 50;

  const usedRows = await dbQuery<{ total: number }>(c.env, `SELECT COALESCE(SUM(size_bytes), 0) as total FROM file_uploads WHERE user_id = ?`, [uid]).catch(() => [{ total: 0 }]);
  const usedMb = Number(usedRows[0]?.total ?? 0) / (1024 * 1024);
  if (usedMb + file.size / (1024 * 1024) > limitMb) return c.json({ error: 'plan_limit_reached', message: `Storage limit reached (${limitMb} MB on your plan).` }, 403);

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${prefix}/${uid}/${generateId('f')}-${safeName}`;
  const ok = await uploadToB2(c.env, key, await file.arrayBuffer(), file.type || 'application/octet-stream');
  if (!ok) return c.json({ error: 'upload_failed' }, 500);

  await dbQuery(c.env, `INSERT INTO file_uploads (id, user_id, key, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)`, [generateId('fu'), uid, key, file.size, new Date().toISOString()]).catch(() => {});
  return c.json({ success: true, key, url: `/api/files/${key}` }, 201);
});

export default files;
