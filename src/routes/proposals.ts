import { Hono } from 'hono';
import { z } from 'zod';
import { dbQuery, dbFirst, dbRun } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { generateId, generatePublicId } from '../utils/ids';
import { createNotification } from '../services/notifications';
import { userAuthMiddleware } from '../middleware/user-auth';
import type { Bindings } from '../types';

const proposals = new Hono<{ Bindings: Bindings }>();
proposals.use('*', userAuthMiddleware);

const draftSchema = z.object({
  client_id: z.string().optional(),
  client_name: z.string().optional(),
  client_email: z.string().email().optional(),
  title: z.string().min(1),
  problem: z.string().min(10),
  sections: z.array(z.string()).min(1),
  currency: z.string().default('USD'),
  timeline_length: z.string().optional(),
  tone: z.string().optional(),
});

proposals.post('/draft', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const body = await c.req.json().catch(() => ({}));
  const parsed = draftSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_payload', details: parsed.error.format() }, 400);
  const d = parsed.data;

  let clientId = d.client_id;
  if (!clientId) {
    if (!d.client_name || !d.client_email) return c.json({ error: 'invalid_payload', message: 'Client name and email required for new client.' }, 400);
    clientId = generateId('cli');
    const now = new Date().toISOString();
    await dbRun(c.env, `INSERT INTO clients (id, user_id, name, email, source, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, 'auto_proposal', ?, ?, ?)`, [clientId, userId, d.client_name, d.client_email, now, now, now]);
  }

  const plan = (await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ?`, [userId])).rows[0]?.plan ?? 'free';
  const limits: Record<string, number> = { free: 5, starter: 20, growth: 100, scale: 300, teams: 500 };
  const count = await dbQuery(c.env, `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'published'`, [userId]);
  if ((count[0]?.c ?? 0) >= (limits[plan] ?? 5)) {
    return c.json({ error: 'plan_limit_reached', message: 'Active document limit reached.' }, 403);
  }

  const id = generateId('prop');
  const now = new Date().toISOString();
  await dbRun(c.env,
    `INSERT INTO proposals (id, user_id, client_id, title, content, status, draft_created_at, draft_retention_days, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    [id, userId, clientId, d.title, JSON.stringify({ problem: d.problem, sections: d.sections, tone: d.tone ?? 'formal' }), now, plan === 'free' ? 10 : plan === 'starter' ? 30 : plan === 'growth' ? 50 : 80, now, now]);

  return c.json({ success: true, id, status: 'draft' }, 201);
});

proposals.get('/', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const rows = await dbQuery(c.env, `SELECT id, title, client_id, status, public_id, total_time_spent_seconds, created_at FROM proposals WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`, [userId]);
  return c.json({ data: rows });
});

proposals.get('/:id', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const id = c.req.param('id');
  const row = await dbFirst(c.env, `SELECT * FROM proposals WHERE id = ? AND user_id = ?`, [id, userId]);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ proposal: row });
});

proposals.patch('/:id', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const id = c.req.param('id');
  const b = await c.req.json();
  const now = new Date().toISOString();
  await dbRun(c.env, `UPDATE proposals SET title = COALESCE(?, title), content = COALESCE(?, content), updated_at = ? WHERE id = ? AND user_id = ?`, [b.title ?? null, b.content ? JSON.stringify(b.content) : null, now, id, userId]);
  return c.json({ success: true, updated_at: now });
});

proposals.post('/:id/publish', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const id = c.req.param('id');
  const row = await dbFirst(c.env, `SELECT * FROM proposals WHERE id = ? AND user_id = ?`, [id, userId]) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const publicId = row.public_id ?? generatePublicId();
  const now = new Date().toISOString();
  await dbRun(c.env, `UPDATE proposals SET status = 'published', public_id = ?, published_at = ?, updated_at = ? WHERE id = ?`, [publicId, now, now, id]);
  await createNotification(c.env, { userId, eventType: 'document_created', documentId: id, title: `Proposal published: ${row.title}` });
  return c.json({ success: true, public_id: publicId, url: `https://revercue.pages.dev/p/${publicId}` });
});

proposals.post('/:id/duplicate', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const id = c.req.param('id');
  const row = await dbFirst(c.env, `SELECT * FROM proposals WHERE id = ? AND user_id = ?`, [id, userId]) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const newId = generateId('prop');
  const now = new Date().toISOString();
  await dbRun(c.env, `INSERT INTO proposals (id, user_id, client_id, title, content, status, draft_created_at, draft_retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`, [newId, userId, row.client_id, row.title, row.content, now, 30, now, now]);
  return c.json({ success: true, id: newId, status: 'draft' }, 201);
});

proposals.post('/:id/archive', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const id = c.req.param('id');
  const now = new Date().toISOString();
  const plan = (await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ?`, [userId])).rows[0]?.plan ?? 'free';
  const limits: Record<string, number> = { free: 5, starter: 15, growth: 30, scale: 30, teams: 30 };
  const retentionDays: Record<string, number> = { free: 15, starter: 30, growth: 30, scale: 30, teams: 30 };
  const count = await dbQuery(c.env, `SELECT COUNT(*) as c FROM proposals WHERE user_id = ? AND status = 'archived'`, [userId]);
  if ((count[0]?.c ?? 0) >= (limits[plan] ?? 5)) return c.json({ error: 'archive_limit_reached' }, 403);
  const deletionDate = new Date(Date.now() + (retentionDays[plan] ?? 30) * 86400000).toISOString();
  await dbRun(c.env, `UPDATE proposals SET status = 'archived', archived_at = ?, archive_retention_days = ?, archive_deletion_date = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [now, retentionDays[plan] ?? 30, deletionDate, now, id, userId]);
  return c.json({ success: true, status: 'archived', archive_deletion_date: deletionDate });
});

proposals.post('/:id/unarchive', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const id = c.req.param('id');
  const now = new Date().toISOString();
  await dbRun(c.env, `UPDATE proposals SET status = 'published', archived_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?`, [now, id, userId]);
  return c.json({ success: true, status: 'published' });
});

proposals.post('/:id/share', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const row = await dbFirst(c.env, `SELECT client_id FROM proposals WHERE id = ? AND user_id = ?`, [id, userId]) as any;
  if (!row) return c.json({ error: 'not_found' }, 404);
  const logId = generateId('log');
  await dbRun(c.env, `INSERT INTO communication_log (id, user_id, client_id, entry_type, channel, linked_document_type, linked_document_id, created_at) VALUES (?, ?, ?, 'document_shared', ?, 'proposal', ?, ?)`, [logId, userId, row.client_id, b.channel ?? 'other', id, new Date().toISOString()]);
  return c.json({ success: true });
});

proposals.delete('/:id', async (c) => {
  const userId = (c.get('user' as never) as any).sub;
  const id = c.req.param('id');
  await dbRun(c.env, `DELETE FROM proposals WHERE id = ? AND user_id = ?`, [id, userId]);
  return c.json({ success: true });
});

export default proposals;
