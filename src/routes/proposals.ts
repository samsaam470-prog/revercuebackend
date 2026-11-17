import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { dbQuery, dbFirst, dbRun } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { generateId, generatePublicId } from '../utils/ids';
import { userAuthMiddleware, getAuth } from '../middleware/user-auth';
import { createNotification } from '../services/notifications';
import { scheduleSummary } from '../services/summary';
import { parsePagination, paginated, statusFilter } from '../utils/pagination';
import { jsonError } from '../utils/api-errors';
import { getTrackingSummary } from '../services/tracking';
import { buildDocumentPdf } from '../services/pdf';
import { pdfResponse } from '../services/pdf-binary';
import { ACTIVE_DOCUMENT_LIMIT, ARCHIVE_COUNT_LIMIT, ARCHIVE_RETENTION_DAYS, DRAFT_RETENTION_DAYS, PASSWORD_PROTECTED_LIMIT } from '../config/constants';
import type { Bindings } from '../types';

const proposals = new Hono<{ Bindings: Bindings }>();
proposals.use('*', userAuthMiddleware);

const LIST_STATUSES = ['draft', 'published', 'accepted', 'declined', 'archived'] as const;

async function getPlan(env: Bindings, uid: string): Promise<string> {
  const u = await tursoQuery(env, `SELECT plan FROM users WHERE id = ? LIMIT 1`, [uid]);
  return String(u.rows[0]?.plan ?? 'free');
}

proposals.get('/', async (c) => {
  const auth = getAuth(c);
  const pagination = parsePagination(c);
  const status = statusFilter(c.req.query('status'), LIST_STATUSES);

  let where = 'user_id = ?';
  const args: any[] = [auth.userId];
  if (status) {
    where += ' AND status = ?';
    args.push(status);
  }

  const totalRow = await dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM proposals WHERE ${where}`, args);
  const rows = await dbQuery(
    c.env,
    `SELECT id, title, client_id, status, public_id, total_time_spent_seconds, published_at, created_at, updated_at
     FROM proposals WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...args, pagination.limit, pagination.offset]
  );
  return c.json(paginated(rows, Number(totalRow?.c ?? 0), pagination));
});

proposals.post('/draft', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  if (!b.title) return jsonError(c, 400, 'invalid_payload', 'A proposal title is required.');

  const plan = await getPlan(c.env, auth.userId);
  const publishedCount = await dbFirst<{ c: number }>(
    c.env,
    `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'published'`,
    [auth.userId]
  );
  const limit = ACTIVE_DOCUMENT_LIMIT[plan as keyof typeof ACTIVE_DOCUMENT_LIMIT] ?? 5;
  if (Number(publishedCount?.c ?? 0) >= limit) {
    return jsonError(c, 403, 'plan_limit_reached', `Your plan allows ${limit} active documents.`);
  }

  let clientId: string | null = b.client_id ?? null;
  if (clientId) {
    const owned = await dbFirst<{ id: string }>(c.env, `SELECT id FROM clients WHERE id = ? AND user_id = ?`, [
      clientId,
      auth.userId,
    ]);
    if (!owned) return jsonError(c, 400, 'invalid_payload', 'Unknown client.');
  } else if (b.client_name && b.client_email) {
    const email = String(b.client_email).trim().toLowerCase();
    const existing = await dbFirst<{ id: string }>(c.env, `SELECT id FROM clients WHERE user_id = ? AND lower(email) = ?`, [
      auth.userId,
      email,
    ]);
    if (existing) clientId = existing.id;
    else {
      clientId = generateId('cli');
      const now = new Date().toISOString();
      await dbRun(
        c.env,
        `INSERT INTO clients (id, user_id, name, email, industry, target_audience, website_url, source, last_message_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'auto_proposal', ?, ?, ?)`,
        [
          clientId,
          auth.userId,
          String(b.client_name).slice(0, 200),
          email,
          b.industry ?? null,
          b.target_audience ?? null,
          b.client_website ?? null,
          now,
          now,
          now,
        ]
      );
    }
  } else {
    return jsonError(c, 400, 'invalid_payload', 'Provide a client_id, or a client_name and client_email.');
  }

  if (b.industry || b.client_website) {
    await dbRun(
      c.env,
      `UPDATE clients SET industry = COALESCE(?, industry), target_audience = COALESCE(?, target_audience), website_url = COALESCE(?, website_url), updated_at = ? WHERE id = ? AND user_id = ?`,
      [b.industry ?? null, b.target_audience ?? null, b.client_website ?? null, new Date().toISOString(), clientId, auth.userId]
    );
  }

  const id = generateId('prop');
  const now = new Date().toISOString();
  const content = {
    problem: b.problem ?? '',
    sections: b.sections ?? [],
    packages: b.packages ?? [],
    currency: b.currency ?? 'USD',
    timeline: b.timeline_length ?? b.timeline ?? null,
    tone: b.tone ?? 'formal',
    faqs: b.faqs ?? [],
    questions: b.questions ?? [],
    blocks: b.blocks ?? [],
    call_to_action: b.cta ?? null,
    target_audience: b.target_audience ?? null,
  };
  await dbRun(
    c.env,
    `INSERT INTO proposals (id, user_id, client_id, title, content, status, draft_created_at, draft_retention_days, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    [
      id,
      auth.userId,
      clientId,
      String(b.title).slice(0, 300),
      JSON.stringify(content),
      now,
      DRAFT_RETENTION_DAYS[plan as keyof typeof DRAFT_RETENTION_DAYS] ?? 10,
      now,
      now,
    ]
  );
  await dbRun(
    c.env,
    `INSERT INTO communication_log (id, user_id, client_id, entry_type, linked_document_type, linked_document_id, created_at) VALUES (?, ?, ?, 'document_created', 'proposal', ?, ?)`,
    [generateId('log'), auth.userId, clientId, id, now]
  );
  return c.json({ success: true, id, status: 'draft', client_id: clientId }, 201);
});

proposals.get('/:id', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT * FROM proposals WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  const tracking = await getTrackingSummary(c.env, 'proposal', row.id);
  return c.json({ proposal: { ...row, tracking } });
});

proposals.patch('/:id', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  const row = await dbFirst<any>(c.env, `SELECT id FROM proposals WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `UPDATE proposals SET title = COALESCE(?, title), content = COALESCE(?, content), updated_at = ? WHERE id = ? AND user_id = ?`,
    [body.title ?? null, body.content ? JSON.stringify(body.content) : null, now, row.id, auth.userId]
  );
  return c.json({ success: true, updated_at: now });
});

proposals.post('/:id/autosave', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  await dbRun(
    c.env,
    `UPDATE proposals SET content = COALESCE(?, content), updated_at = ? WHERE id = ? AND user_id = ?`,
    [b.content ? JSON.stringify(b.content) : null, new Date().toISOString(), c.req.param('id'), auth.userId]
  );
  return c.json({ success: true });
});

proposals.post('/:id/publish', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT * FROM proposals WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  if (row.status === 'archived') return jsonError(c, 409, 'archived', 'Unarchive the proposal before publishing.');

  const publicId = row.public_id ?? generatePublicId();
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `UPDATE proposals SET status = 'published', public_id = ?, published_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    [publicId, now, now, row.id, auth.userId]
  );
  await createNotification(c.env, {
    userId: auth.userId,
    eventType: 'document_created',
    clientId: row.client_id,
    documentId: row.id,
    title: `Proposal published: ${row.title}`,
  });
  const base = (c.env.APP_URL || c.env.FRONTEND_ORIGIN || 'https://revercue.pages.dev').replace(/\/$/, '');
  return c.json({ success: true, public_id: publicId, url: `${base}/p/${publicId}` });
});

proposals.post('/:id/duplicate', async (c) => {
  const auth = getAuth(c);
  const plan = await getPlan(c.env, auth.userId);
  const row = await dbFirst<any>(c.env, `SELECT * FROM proposals WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  const body = await c.req.json().catch(() => ({}));
  let clientId = row.client_id;
  if (body.client_id) {
    const owned = await dbFirst<{ id: string }>(c.env, `SELECT id FROM clients WHERE id = ? AND user_id = ?`, [
      body.client_id,
      auth.userId,
    ]);
    if (!owned) return jsonError(c, 400, 'invalid_payload', 'Unknown client.');
    clientId = body.client_id;
  }
  const id = generateId('prop');
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `INSERT INTO proposals (id, user_id, client_id, title, content, status, draft_created_at, draft_retention_days, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    [
      id,
      auth.userId,
      clientId,
      `${row.title} (copy)`,
      row.content,
      now,
      DRAFT_RETENTION_DAYS[plan as keyof typeof DRAFT_RETENTION_DAYS] ?? 10,
      now,
      now,
    ]
  );
  return c.json({ success: true, id, status: 'draft' }, 201);
});

proposals.post('/:id/archive', async (c) => {
  const auth = getAuth(c);
  const plan = await getPlan(c.env, auth.userId);
  const archived = await dbFirst<{ c: number }>(
    c.env,
    `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'archived'`,
    [auth.userId]
  );
  const limit = ARCHIVE_COUNT_LIMIT[plan as keyof typeof ARCHIVE_COUNT_LIMIT] ?? 5;
  if (Number(archived?.c ?? 0) >= limit) {
    return jsonError(c, 403, 'archive_limit_reached', `Your plan allows ${limit} archived documents.`);
  }
  const row = await dbFirst<any>(c.env, `SELECT id, client_id FROM proposals WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');

  const now = new Date().toISOString();
  const days = ARCHIVE_RETENTION_DAYS[plan as keyof typeof ARCHIVE_RETENTION_DAYS] ?? 30;
  const deletion = new Date(Date.now() + days * 86400000).toISOString();
  await dbRun(
    c.env,
    `UPDATE proposals SET status = 'archived', archived_at = ?, archive_retention_days = ?, archive_deletion_date = ?, retention_paused_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    [now, days, deletion, now, now, row.id, auth.userId]
  );
  if (row.client_id) await scheduleSummary(c.env, row.client_id, auth.userId);
  return c.json({ success: true, status: 'archived', archive_deletion_date: deletion });
});

proposals.post('/:id/unarchive', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT id, public_id FROM proposals WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  const restored = row.public_id ? 'published' : 'draft';
  await dbRun(
    c.env,
    `UPDATE proposals SET status = ?, archived_at = NULL, archive_deletion_date = NULL, retention_paused_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?`,
    [restored, new Date().toISOString(), row.id, auth.userId]
  );
  return c.json({ success: true, status: restored });
});

proposals.post('/:id/share', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  const row = await dbFirst<any>(c.env, `SELECT client_id FROM proposals WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `INSERT INTO communication_log (id, user_id, client_id, entry_type, channel, linked_document_type, linked_document_id, created_at)
     VALUES (?, ?, ?, 'document_shared', ?, 'proposal', ?, ?)`,
    [generateId('log'), auth.userId, row.client_id, String(body.channel ?? 'other').slice(0, 40), c.req.param('id'), now]
  );
  if (row.client_id) {
    await dbRun(c.env, `UPDATE clients SET last_message_at = ? WHERE id = ? AND user_id = ?`, [
      now,
      row.client_id,
      auth.userId,
    ]);
  }
  return c.json({ success: true });
});

proposals.post('/:id/password', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  const row = await dbFirst<any>(c.env, `SELECT id FROM proposals WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');

  if (body.remove) {
    await dbRun(c.env, `UPDATE proposals SET password_hash = NULL, password_protected = 0, updated_at = ? WHERE id = ? AND user_id = ?`, [
      new Date().toISOString(),
      row.id,
      auth.userId,
    ]);
    return c.json({ success: true, password_protected: false });
  }

  const plan = await getPlan(c.env, auth.userId);
  const limit = PASSWORD_PROTECTED_LIMIT[plan as keyof typeof PASSWORD_PROTECTED_LIMIT] ?? 0;
  if (limit === 0) return jsonError(c, 403, 'forbidden', 'Password protection is not available on your plan.');

  const password = String(body.password ?? '');
  if (password.length < 6 || password.length > 128) {
    return jsonError(c, 400, 'invalid_payload', 'The password must be between 6 and 128 characters.');
  }
  const hash = await bcrypt.hash(password, 10);
  await dbRun(c.env, `UPDATE proposals SET password_hash = ?, password_protected = 1, updated_at = ? WHERE id = ? AND user_id = ?`, [
    hash,
    new Date().toISOString(),
    row.id,
    auth.userId,
  ]);
  return c.json({ success: true, password_protected: true });
});

proposals.get('/:id/tracking', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT id FROM proposals WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  return c.json(await getTrackingSummary(c.env, 'proposal', row.id));
});

proposals.get('/:id/pdf', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT id FROM proposals WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  const generated = await buildDocumentPdf(c.env, 'proposal', row.id);
  if (!generated) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  return pdfResponse(generated.bytes, `proposal-${row.id}.pdf`, 'attachment');
});

proposals.delete('/:id', async (c) => {
  const auth = getAuth(c);
  await dbRun(c.env, `DELETE FROM proposals WHERE id = ? AND user_id = ?`, [c.req.param('id'), auth.userId]);
  return c.json({ success: true });
});

export default proposals;
