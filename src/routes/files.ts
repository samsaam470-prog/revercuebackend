import { Hono } from 'hono';
import { fetchFromB2, isPublicKey, putObject, safeFilename } from '../services/storage';
import { userAuthMiddleware, getAuth, authenticateRequest, optionalUserAuth } from '../middleware/user-auth';
import { generateId } from '../utils/ids';
import { tursoQuery } from '../utils/turso';
import { dbFirst, dbRun } from '../utils/db';
import { STORAGE_MB, DEFAULT_MAX_UPLOAD_BYTES } from '../config/constants';
import { createSignedToken, verifySignedToken } from '../utils/crypto';
import { jsonError } from '../utils/api-errors';
import type { Bindings } from '../types';

const files = new Hono<{ Bindings: Bindings }>();

const ALLOWED_UPLOAD_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const FILE_TOKEN_TTL_SECONDS = 3600;

async function createFileToken(env: Bindings, key: string): Promise<string> {
  return createSignedToken(env.SIGNING_LINK_SECRET || env.USER_JWT_KEY, {
    k: key,
    exp: Math.floor(Date.now() / 1000) + FILE_TOKEN_TTL_SECONDS,
  });
}

async function fileTokenMatches(env: Bindings, token: string, key: string): Promise<boolean> {
  const result = await verifySignedToken<{ k: string; exp: number }>(
    env.SIGNING_LINK_SECRET || env.USER_JWT_KEY,
    token
  );
  return result.ok && result.payload.k === key;
}

/**
 * Object proxy.
 *
 * Public assets (`public/` keys) are served as-is. Everything else is private:
 * it is served only to the authenticated owner of an `uploads/<userId>/` key, or
 * with a short-lived signed token issued at upload time. Signatures, proofs and
 * signed PDFs are never reachable through this proxy at all — they have their
 * own authorized download routes.
 */
files.get('/*', optionalUserAuth, async (c) => {
  const key = decodeURIComponent(c.req.path.replace('/api/files/', ''));
  if (!key || key.includes('..')) return jsonError(c, 400, 'invalid_payload', 'Invalid key.');

  if (isPublicKey(key)) {
    try {
      return await fetchFromB2(c.env, key);
    } catch {
      return jsonError(c, 404, 'not_found', 'File not found.');
    }
  }

  if (key.startsWith('private/')) {
    return jsonError(c, 403, 'forbidden', 'Private files are only available through an authorized download route.');
  }

  const token = c.req.query('token') ?? '';
  if (token && (await fileTokenMatches(c.env, token, key))) {
    try {
      return await fetchFromB2(c.env, key);
    } catch {
      return jsonError(c, 404, 'not_found', 'File not found.');
    }
  }

  const auth = c.get('auth' as never) as unknown as { userId?: string } | undefined;
  if (!auth?.userId) {
    const result = await authenticateRequest(c);
    if ('failure' in result) return jsonError(c, 401, 'unauthorized', 'Sign in to download this file.');
    if (!key.startsWith(`uploads/${result.auth.userId}/`)) {
      return jsonError(c, 403, 'forbidden', 'This file belongs to another account.');
    }
    try {
      return await fetchFromB2(c.env, key);
    } catch {
      return jsonError(c, 404, 'not_found', 'File not found.');
    }
  }

  if (!key.startsWith(`uploads/${auth.userId}/`)) {
    return jsonError(c, 403, 'forbidden', 'This file belongs to another account.');
  }
  try {
    return await fetchFromB2(c.env, key);
  } catch {
    return jsonError(c, 404, 'not_found', 'File not found.');
  }
});

files.post('/upload', userAuthMiddleware, async (c) => {
  const auth = getAuth(c);
  const body = await c.req.parseBody();
  const file = (body['file'] ?? body['logo']) as File | undefined;
  const purpose = String(body['purpose'] ?? body['prefix'] ?? 'uploads').slice(0, 40);
  if (!(file instanceof File)) return jsonError(c, 400, 'invalid_payload', 'No file provided.');

  const maxBytes = Number(c.env.MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES);
  if (file.size <= 0) return jsonError(c, 400, 'invalid_payload', 'The file is empty.');
  if (file.size > maxBytes) return jsonError(c, 413, 'file_too_large', `Files must be under ${Math.round(maxBytes / (1024 * 1024))} MB.`);
  if (file.type && !ALLOWED_UPLOAD_TYPES.includes(file.type)) {
    return jsonError(c, 400, 'invalid_file_type', 'That file type is not allowed.');
  }

  const user = await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ? LIMIT 1`, [auth.userId]);
  const plan = String(user.rows[0]?.plan ?? 'free');
  const limitMb = STORAGE_MB[plan as keyof typeof STORAGE_MB] ?? 50;

  const used = await dbFirst<{ total: number }>(
    c.env,
    `SELECT COALESCE(SUM(size_bytes), 0) as total FROM file_uploads WHERE user_id = ?`,
    [auth.userId]
  );
  const usedMb = Number(used?.total ?? 0) / (1024 * 1024);
  if (usedMb + file.size / (1024 * 1024) > limitMb) {
    return jsonError(c, 403, 'plan_limit_reached', `Storage limit reached (${limitMb} MB on your plan).`);
  }

  // Document images are embedded in proposals/contracts that render on public
  // pages and in PDFs, so they must live under a public key and need no
  // short-lived token. Other uploads stay private to the owner.
  const isPublic = purpose === 'document-image' || purpose === 'image' || purpose.startsWith('public');
  const key = isPublic
    ? `public/documents/${auth.userId}/${generateId('img')}-${safeFilename(file.name)}`
    : `uploads/${auth.userId}/${purpose}/${generateId('f')}-${safeFilename(file.name)}`;
  const uploaded = await putObject(c.env, key, await file.arrayBuffer(), file.type || 'application/octet-stream');
  if (!uploaded.ok) return jsonError(c, 502, 'upload_failed', 'The file could not be stored. Try again.');

  await dbRun(
    c.env,
    `INSERT INTO file_uploads (id, user_id, key, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)`,
    [generateId('fu'), auth.userId, key, file.size, new Date().toISOString()]
  ).catch((error) => console.error('FILE_UPLOAD_RECORD_FAILED', error));

  if (isPublic) {
    return c.json({ success: true, key, url: `/api/files/${key}` }, 201);
  }
  const token = await createFileToken(c.env, key);
  return c.json({ success: true, key, url: `/api/files/${key}?token=${encodeURIComponent(token)}` }, 201);
});

export default files;
