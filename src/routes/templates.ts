import { Hono } from 'hono';
import { tursoQuery } from '../utils/turso';
import { dbQuery, dbFirst, dbRun } from '../utils/db';
import { generateId } from '../utils/ids';
import { userAuthMiddleware, getAuth } from '../middleware/user-auth';
import { sanitizeHtml, fetchFromB2, putObject, safeFilename } from '../services/storage';
import { safeFetchPublic } from '../utils/url-safety';
import { CUSTOM_TEMPLATE_LIMIT, TEMPLATE_UPLOAD_TYPES, DEFAULT_MAX_UPLOAD_BYTES } from '../config/constants';
import { jsonError } from '../utils/api-errors';
import type { Bindings } from '../types';

const templates = new Hono<{ Bindings: Bindings }>();
templates.use('*', userAuthMiddleware);

const TEMPLATE_TYPES = ['proposal', 'contract'] as const;

/** Tags arrive either as JSON (`["a","b"]`) or as a comma separated string. */
export function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim().slice(0, 40)).filter(Boolean).slice(0, 20);
  }
  if (typeof value !== 'string' || !value.trim()) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim().slice(0, 40)).filter(Boolean).slice(0, 20);
      }
    } catch {
      // Fall through to comma splitting.
    }
  }
  return trimmed
    .split(',')
    .map((item) => item.trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 20);
}

function withMetadata(template: any, metadata: any) {
  return {
    ...template,
    tags: parseTags(template.tags),
    description: metadata?.description ?? null,
    category: metadata?.category ?? null,
  };
}

templates.get('/', async (c) => {
  const auth = getAuth(c);
  const requestedType = c.req.query('type');
  const type = requestedType && TEMPLATE_TYPES.includes(requestedType as any) ? requestedType : null;

  const user = await tursoQuery(c.env, `SELECT services FROM users WHERE id = ? LIMIT 1`, [auth.userId]);
  let services: string[] = [];
  try {
    services = JSON.parse(String(user.rows[0]?.services ?? '[]'));
  } catch {
    services = [];
  }

  const typeClause = type ? ` AND type = ?` : '';
  const builtInArgs: any[] = type ? [type] : [];
  const customArgs: any[] = type ? [auth.userId, type] : [auth.userId];

  const builtIn = await dbQuery(
    c.env,
    `SELECT t.id, t.name, t.type, t.tags, t.b2_key, t.source, t.status, t.times_used, t.created_at,
            m.description, m.category
     FROM templates t LEFT JOIN template_metadata m ON m.template_id = t.id
     WHERE t.source = 'built_in' AND t.status IN ('active','featured')${typeClause}
     ORDER BY t.times_used DESC, t.created_at DESC LIMIT 100`,
    builtInArgs
  );
  const custom = await dbQuery(
    c.env,
    `SELECT t.id, t.name, t.type, t.tags, t.b2_key, t.source, t.status, t.created_at,
            m.description, m.category
     FROM templates t LEFT JOIN template_metadata m ON m.template_id = t.id
     WHERE t.source = 'custom' AND t.user_id = ? AND t.status IN ('active','featured')${typeClause}
     ORDER BY t.created_at DESC LIMIT 100`,
    customArgs
  );

  const mark = (template: any) => {
    const tags = parseTags(template.tags);
    return {
      ...withMetadata(template, template),
      tags,
      suggested: tags.some((tag) => services.includes(tag)),
    };
  };

  return c.json({ built_in: builtIn.map(mark), custom: custom.map(mark) });
});

templates.get('/:id', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(
    c.env,
    `SELECT * FROM templates WHERE id = ? AND (source = 'built_in' OR user_id = ?) LIMIT 1`,
    [c.req.param('id'), auth.userId]
  );
  if (!row) return jsonError(c, 404, 'not_found', 'Template not found.');

  const metadata = await dbFirst<any>(c.env, `SELECT description, category FROM template_metadata WHERE template_id = ?`, [
    row.id,
  ]);
  let html: string | null = null;
  if (row.b2_key) {
    try {
      const response = await fetchFromB2(c.env, row.b2_key);
      html = await response.text();
    } catch (error) {
      console.error('TEMPLATE_FETCH_FAILED', row.id, error);
      html = null;
    }
  }
  return c.json({ template: withMetadata(row, metadata), html });
});

templates.post('/upload', async (c) => {
  const auth = getAuth(c);
  const user = await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ? LIMIT 1`, [auth.userId]);
  const plan = String(user.rows[0]?.plan ?? 'free');
  const limit = CUSTOM_TEMPLATE_LIMIT[plan as keyof typeof CUSTOM_TEMPLATE_LIMIT] ?? 0;
  if (limit === 0) {
    return jsonError(c, 403, 'forbidden', 'Custom templates are not available on this plan.');
  }

  const count = await dbFirst<{ c: number }>(
    c.env,
    `SELECT COUNT(*) as c FROM templates WHERE source = 'custom' AND user_id = ?`,
    [auth.userId]
  );
  if (Number(count?.c ?? 0) >= limit) {
    return jsonError(c, 403, 'plan_limit_reached', `You have ${limit} of ${limit} custom templates.`);
  }

  const body = await c.req.parseBody();
  const name = String(body['name'] ?? '').trim();
  const type = String(body['type'] ?? 'proposal');
  const tags = parseTags(body['tags']);
  const description = body['description'] ? String(body['description']).slice(0, 500) : null;
  const category = body['category'] ? String(body['category']).slice(0, 60) : null;
  if (!name) return jsonError(c, 400, 'invalid_payload', 'Name is required.');
  if (!TEMPLATE_TYPES.includes(type as any)) {
    return jsonError(c, 400, 'invalid_payload', 'Type must be proposal or contract.');
  }

  let html = '';
  const url = String(body['url'] ?? '').trim();
  const file = body['file'] as File | undefined;
  const maxBytes = Number(c.env.MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES);

  if (url) {
    const fetched = await safeFetchPublic(url, { maxBytes, timeoutMs: 8000 });
    if (!fetched.ok) {
      return jsonError(c, 400, 'fetch_failed', `Could not fetch that URL (${fetched.reason ?? fetched.status}).`);
    }
    html = fetched.body;
  } else if (file instanceof File) {
    if (file.size > maxBytes) return jsonError(c, 413, 'file_too_large', 'The template file is too large.');
    if (file.type && !TEMPLATE_UPLOAD_TYPES.includes(file.type)) {
      return jsonError(c, 400, 'invalid_file_type', 'Upload an HTML file.');
    }
    html = await file.text();
  } else {
    return jsonError(c, 400, 'invalid_payload', 'Provide an HTML file or a URL.');
  }

  if (!html.trim()) return jsonError(c, 400, 'invalid_payload', 'The template is empty.');
  const sanitized = sanitizeHtml(html);
  const key = `public/custom-templates/${auth.userId}/${generateId('tpl')}-${safeFilename(name)}.html`;
  const uploaded = await putObject(c.env, key, new TextEncoder().encode(sanitized), 'text/html');
  if (!uploaded.ok) return jsonError(c, 502, 'upload_failed', 'The template could not be stored.');

  const id = generateId('tpl');
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `INSERT INTO templates (id, name, type, tags, b2_key, source, status, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'custom', 'active', ?, ?, ?)`,
    [id, name.slice(0, 200), type, JSON.stringify(tags), key, auth.userId, now, now]
  );
  if (description || category) {
    await dbRun(
      c.env,
      `INSERT INTO template_metadata (template_id, description, category, updated_at) VALUES (?, ?, ?, ?)`,
      [id, description, category, now]
    ).catch((error) => console.error('TEMPLATE_METADATA_WRITE_FAILED', error));
  }

  return c.json({ success: true, id, b2_key: key }, 201);
});

templates.patch('/:id', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  const row = await dbFirst<any>(
    c.env,
    `SELECT id FROM templates WHERE id = ? AND source = 'custom' AND user_id = ? LIMIT 1`,
    [c.req.param('id'), auth.userId]
  );
  if (!row) return jsonError(c, 404, 'not_found', 'Template not found.');

  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `UPDATE templates SET name = COALESCE(?, name), tags = COALESCE(?, tags), updated_at = ? WHERE id = ? AND user_id = ?`,
    [body.name ?? null, body.tags !== undefined ? JSON.stringify(parseTags(body.tags)) : null, now, row.id, auth.userId]
  );
  if (body.description !== undefined || body.category !== undefined) {
    await dbRun(
      c.env,
      `INSERT INTO template_metadata (template_id, description, category, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(template_id) DO UPDATE SET
         description = COALESCE(excluded.description, template_metadata.description),
         category = COALESCE(excluded.category, template_metadata.category),
         updated_at = excluded.updated_at`,
      [row.id, body.description ?? null, body.category ?? null, now]
    );
  }
  return c.json({ success: true });
});

templates.delete('/:id', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(
    c.env,
    `SELECT id FROM templates WHERE id = ? AND source = 'custom' AND user_id = ? LIMIT 1`,
    [c.req.param('id'), auth.userId]
  );
  if (!row) return jsonError(c, 404, 'not_found', 'Template not found.');
  await dbRun(c.env, `DELETE FROM template_metadata WHERE template_id = ?`, [row.id]);
  await dbRun(c.env, `DELETE FROM templates WHERE id = ? AND user_id = ?`, [row.id, auth.userId]);
  return c.json({ success: true });
});

export default templates;
