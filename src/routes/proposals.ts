import { Hono } from 'hono';
import { dbQuery, dbFirst, dbRun } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { generateId, generatePublicId } from '../utils/ids';
import { userAuthMiddleware } from '../middleware/user-auth';
import { createNotification } from '../services/notifications';
import { ACTIVE_DOCUMENT_LIMIT, ARCHIVE_COUNT_LIMIT, ARCHIVE_RETENTION_DAYS, DRAFT_RETENTION_DAYS, PASSWORD_PROTECTED_LIMIT } from '../config/constants';
import type { Bindings } from '../types';

const proposals = new Hono<{ Bindings: Bindings }>();
proposals.use('*', userAuthMiddleware);

async function getPlan(env: Bindings, uid: string): Promise<string> {
  const u = await tursoQuery(env, `SELECT plan FROM users WHERE id = ?`, [uid]);
  return u.rows[0]?.plan ?? 'free';
}

proposals.get('/', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const status = c.req.query('status');
  const sql = status
    ? `SELECT id, title, client_id, status, public_id, total_time_spent_seconds, created_at FROM proposals WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 100`
    : `SELECT id, title, client_id, status, public_id, total_time_spent_seconds, created_at FROM proposals WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`;
  const rows = await dbQuery(c.env, sql, status ? [uid, status] : [uid]);
  return c.json({ data: rows });
});

proposals.post('/draft', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json().catch(() => ({}));
  if (!b.title || !b.problem) return c.json({ error: 'invalid_payload', message: 'Title and problem are required.' }, 400);

  const plan = await getPlan(c.env, uid);
  const publishedCount = await dbQuery(c.env, `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'published'`, [uid]);
  if (Number(publishedCount[0]?.c ?? 0) >= ACTIVE_DOCUMENT_LIMIT[plan as keyof typeof ACTIVE_DOCUMENT_LIMIT]) {
    return c.json({ error: 'plan_limit_reached', message: 'Active document limit reached. Archive or delete one to create a new one.' }, 403);
  }

  let clientId: string = b.client_id;
  if (!clientId) {
    if (!b.client_name || !b.client_email) return c.json({ error: 'invalid_payload', message: 'Client name and email are required for a new client.' }, 400);
    const existing = await dbFirst(c.env, `SELECT id FROM clients WHERE user_id = ? AND email = ?`, [uid, b.client_email]);
    if (existing) {
      clientId = (existing as any).id;
    } else {
      clientId = generateId('cli');
      const now = new Date().toISOString();
      await dbRun(
        c.env,
        `INSERT INTO clients (id, user_id, name, email, source, last_message_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'auto_proposal', ?, ?, ?)`,
        [clientId, uid, b.client_name, b.client_email, now, now, now]
      );
    }
  }

  const id = generateId('prop');
  const now = new Date().toISOString();
  const content = {
    problem: b.problem,
    sections: b.sections ?? ['introduction', 'scope', 'pricing'],
    currency: b.currency ?? 'USD',
    timeline: b.timeline_length ?? null,
    tone: b.tone ?? 'formal',
    faqs: b.faqs ?? [],
    questions: b.questions ?? [],
    blocks: [],
  };
  await dbRun(
    c.env,
    `INSERT INTO proposals (id, user_id, client_id, title, content, status, draft_created_at, draft_retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    [id, uid, clientId, b.title, JSON.stringify(content), now, DRAFT_RETENTION_DAYS[plan as keyof typeof DRAFT_RETENTION_DAYS], now, now]
  );

  await dbRun(
    c.env,
    `INSERT INTO communication_log (id, user_id, client_id, entry_type, linked_document_type, linked_document_id, created_at) VALUES (?, ?, ?, 'document_created', 'proposal', ?, ?)`,
    [generateId('log'), uid, clientId, id, now]
  );

  return c.json({ success: true, id, status: 'draft', client_id: clientId }, 201);
});

proposals.get('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const row = await dbFirst(c.env, `SELECT * FROM proposals WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ proposal: row });
});

proposals.patch('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `UPDATE proposals SET title = COALESCE(?, title), content = COALESCE(?, content), updated_at = ? WHERE id = ? AND user_id = ?`,
    [b.title ?? null, b.content ? JSON.stringify(b.content) : null, now, c.req.param('id'), uid]
  );
  return c.json({ success: true, updated_at: now });
});

proposals.post('/:id/autosave', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json().catch(() => ({}));
  await dbRun(
    c.env,
    `UPDATE proposals SET content = COALESCE(?, content), updated_at = ? WHERE id = ? AND user_id = ?`,
    [b.content ? JSON.stringify(b.content) : null, new Date().toISOString(), c.req.param('id'), uid]
  );
  return c.json({ success: true });
});

proposals.post('/:id/publish', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const id = c.req.param('id');
  const row = (await dbFirst(c.env, `SELECT * FROM proposals WHERE id = ? AND user_id = ?`, [id, uid])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status === 'published') return c.json({ success: true, public_id: row.public_id });
  const publicId = row.public_id ?? generatePublicId();
  const now = new Date().toISOString();
  await dbRun(c.env, `UPDATE proposals SET status = 'published', public_id = ?, published_at = ?, updated_at = ? WHERE id = ?`, [publicId, now, now, id]);
  await createNotification(c.env, { userId: uid, eventType: 'document_created', clientId: row.client_id, documentId: id, title: `Proposal published: ${row.title}` });
  return c.json({ success: true, public_id: publicId, url: `https://revercue.pages.dev/p/${publicId}` });
});

proposals.post('/:id/duplicate', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json().catch(() => ({}));
  const plan = await getPlan(c.env, uid);
  const publishedCount = await dbQuery(c.env, `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'published'`, [uid]);
  if (Number(publishedCount[0]?.c ?? 0) >= ACTIVE_DOCUMENT_LIMIT[plan as keyof typeof ACTIVE_DOCUMENT_LIMIT]) {
    return c.json({ error: 'plan_limit_reached' }, 403);
  }
  const row = (await dbFirst(c.env, `SELECT * FROM proposals WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const id = generateId('prop');
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `INSERT INTO proposals (id, user_id, client_id, title, content, status, draft_created_at, draft_retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    [id, uid, b.client_id ?? row.client_id, row.title, row.content, now, DRAFT_RETENTION_DAYS[plan as keyof typeof DRAFT_RETENTION_DAYS], now, now]
  );
  return c.json({ success: true, id, status: 'draft' }, 201);
});

proposals.post('/:id/archive', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const plan = await getPlan(c.env, uid);
  const archived = await dbQuery(c.env, `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'archived'`, [uid]);
  if (Number(archived[0]?.c ?? 0) >= ARCHIVE_COUNT_LIMIT[plan as keyof typeof ARCHIVE_COUNT_LIMIT]) {
    return c.json({ error: 'archive_limit_reached', message: 'Archive limit reached. Unarchive or delete one.' }, 403);
  }
  const now = new Date().toISOString();
  const days = ARCHIVE_RETENTION_DAYS[plan as keyof typeof ARCHIVE_RETENTION_DAYS];
  const del = new Date(Date.now() + days * 86400000).toISOString();
  await dbRun(
    c.env,
    `UPDATE proposals SET status = 'archived', archived_at = ?, archive_retention_days = ?, archive_deletion_date = ?, retention_paused_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    [now, days, del, now, now, c.req.param('id'), uid]
  );
  return c.json({ success: true, status: 'archived', archive_deletion_date: del });
});

proposals.post('/:id/unarchive', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(
    c.env,
    `UPDATE proposals SET status = 'published', archived_at = NULL, archive_deletion_date = NULL, retention_paused_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?`,
    [new Date().toISOString(), c.req.param('id'), uid]
  );
  return c.json({ success: true, status: 'published' });
});

proposals.post('/:id/share', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json().catch(() => ({}));
  const row = (await dbFirst(c.env, `SELECT client_id FROM proposals WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid])) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  await dbRun(
    c.env,
    `INSERT INTO communication_log (id, user_id, client_id, entry_type, channel, linked_document_type, linked_document_id, created_at) VALUES (?, ?, ?, 'document_shared', ?, 'proposal', ?, ?)`,
    [generateId('log'), uid, row.client_id, b.channel ?? 'other', c.req.param('id'), new Date().toISOString()]
  );
  await dbRun(c.env, `UPDATE clients SET last_message_at = ? WHERE id = ?`, [new Date().toISOString(), row.client_id]);
  return c.json({ success: true });
});

proposals.post('/:id/password', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  if (b.remove) {
    await dbRun(c.env, `UPDATE proposals SET password_hash = NULL, password_protected = 0 WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
    return c.json({ success: true, password_protected: false });
  }
  const plan = await getPlan(c.env, uid);
  if (PASSWORD_PROTECTED_LIMIT[plan as keyof typeof PASSWORD_PROTECTED_LIMIT] === 0) {
    return c.json({ error: 'forbidden', message: 'Password protection is not available on this plan.' }, 403);
  }
  if (!b.password || String(b.password).length < 6) return c.json({ error: 'invalid_payload', message: 'Password must be at least 6 characters.' }, 400);
  const { argon2id } = await import('hash-wasm');
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await argon2id({ password: String(b.password), salt, parallelism: 1, iterations: 3, memorySize: 19456, hashLength: 32, outputType: 'encoded' });
  await dbRun(c.env, `UPDATE proposals SET password_hash = ?, password_protected = 1 WHERE id = ? AND user_id = ?`, [hash as string, c.req.param('id'), uid]);
  return c.json({ success: true, password_protected: true });
});

proposals.delete('/:id', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  await dbRun(c.env, `DELETE FROM proposals WHERE id = ? AND user_id = ?`, [c.req.param('id'), uid]);
  return c.json({ success: true });
});

export default proposals;
