import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../types';
import { getAuth, userAuthMiddleware } from '../middleware/user-auth';
import { jsonError } from '../utils/api-errors';
import { dbFirst, dbQuery, dbRun } from '../utils/db';
import { isDocumentType, readDocument, writeDocument } from '../services/document-adapter';
import {
  AuthorityError,
  acquireOfflineLock,
  completeContributorSession,
  completeOfflineEditing,
  ensureEditingAuthority,
  getEditingAuthority,
  inviteContributor,
  markSyncFailed,
  reopenOfflineEditing,
  revokeContributorInvitation,
  startContributorSession,
  syncOfflineSession,
} from '../services/document-editing-authority';
import {
  clearSessionChat,
  listChatMessages,
  postChatMessage,
} from '../services/collaboration-chat';

/**
 * Shareable Builder and Offline Builder.
 *
 * Everything that changes editing authority is decided here, on the server.
 * Hiding a button in the browser is never the control: the owner routes check
 * `document_editing_state`, and the contributor routes accept only a live,
 * unexpired invitation token that has not been completed or revoked.
 *
 * Scale-only: every owner route rejects plans below Scale.
 */

const collaboration = new Hono<{ Bindings: Bindings }>();

const MAX_CONTENT_BYTES = 256 * 1024;

const inviteSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.').max(200),
  expires_hours: z.number().int().min(1).max(24 * 14).optional(),
});

const contentSchema = z.object({
  content: z.record(z.unknown()),
});

const offlineStartSchema = z.object({
  device_id: z.string().trim().min(8).max(120),
  cloud_version: z.string().trim().max(120).nullable().optional(),
});

const offlineSyncSchema = z.object({
  session_id: z.string().trim().min(3).max(120),
  lock_token: z.string().trim().min(8).max(200),
  expected_version: z.string().trim().max(120).nullable().optional(),
  content: z.record(z.unknown()),
});

function authorityErrorResponse(error: unknown) {
  if (error instanceof AuthorityError) {
    return { status: error.status, body: { error: error.code, message: error.message } };
  }
  return null;
}

function scaleGate(plan: string) {
  if (plan === 'scale') return null;
  return {
    status: 403 as const,
    body: {
      error: 'plan_required',
      message: 'Shareable Builder and Offline Builder are included with Revercue Scale. Upgrade to use them.',
      required_plan: 'scale',
    },
  };
}

/** Document-level check shared by every owner route. */
async function ownerDocument(c: any, type: string, id: string) {
  const auth = getAuth(c);
  if (!isDocumentType(type)) return { error: jsonError(c, 400, 'bad_document_type', 'Unknown document type.') };
  const blocked = scaleGate(auth.plan);
  if (blocked) return { error: c.json(blocked.body, blocked.status) };
  const doc = await readDocument(c.env, type, id, auth.userId);
  if (!doc) return { error: jsonError(c, 404, 'not_found', 'Document not found.') };
  return { auth, doc };
}

// ---------------------------------------------------------------------------
// Contributor access (no Revercue account required)
// ---------------------------------------------------------------------------

const contributor = new Hono<{ Bindings: Bindings }>();

async function invitationByToken(env: Bindings, token: string) {
  return dbFirst<any>(
    env,
    `SELECT * FROM document_contributor_invitations WHERE token = ? LIMIT 1`,
    [token]
  );
}

/** Opens (or resumes) the contributor session and returns the live document. */
contributor.post('/open', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = String((body as any)?.token ?? '').trim();
  if (!token) return jsonError(c, 400, 'token_required', 'An invitation token is required.');

  const invitation = await invitationByToken(c.env, token);
  if (!invitation) return jsonError(c, 404, 'invitation_not_found', 'This invitation link is not valid.');
  if (invitation.status === 'revoked') {
    return jsonError(c, 403, 'invitation_revoked', 'The owner revoked this invitation.');
  }
  if (invitation.status === 'completed') {
    return jsonError(c, 409, 'invitation_completed', 'This contribution is already complete.');
  }
  if (new Date(String(invitation.expires_at)).getTime() < Date.now()) {
    return jsonError(c, 410, 'invitation_expired', 'This invitation link has expired. Ask the owner for a new one.');
  }

  const type = invitation.document_type;
  const documentId = invitation.document_id;
  if (!isDocumentType(type)) return jsonError(c, 400, 'bad_document_type', 'Unknown document type.');

  if (invitation.status === 'pending') {
    const started = await startContributorSession(c.env, token);
    if (!started) return jsonError(c, 409, 'session_unavailable', 'This invitation cannot start right now.');
  }

  const state = await getEditingAuthority(c.env, type, documentId);
  if (!state || state.state !== 'contributor_editing' || state.contributor_session_id !== invitation.id) {
    return jsonError(c, 409, 'not_active', 'This contribution session is not active.');
  }

  const doc = await readDocument(c.env, type, documentId, invitation.owner_user_id);
  if (!doc) return jsonError(c, 404, 'not_found', 'Document not found.');

  return c.json({
    success: true,
    session: {
      invitation_id: invitation.id,
      contributor_email: invitation.contributor_email,
      document_type: type,
      document_id: documentId,
      expires_at: invitation.expires_at,
      last_saved_at: invitation.last_saved_at ?? null,
    },
    document: doc,
    // The contributor may never publish, send or see owner account data.
    permissions: { edit: true, publish: false, send: false, invite: false, view_tracking: false },
  });
});

/** Contributor save. Every write is re-checked against the live session. */
contributor.post('/:token/save', async (c) => {
  const token = c.req.param('token');
  const invitation = await invitationByToken(c.env, token);
  if (!invitation || invitation.status !== 'active') {
    return jsonError(c, 403, 'not_active', 'This contribution session is not active.');
  }
  const state = await getEditingAuthority(c.env, invitation.document_type, invitation.document_id);
  if (!state || state.state !== 'contributor_editing' || state.contributor_session_id !== invitation.id) {
    return jsonError(c, 409, 'not_active', 'The owner ended this contribution session.');
  }

  const raw = await c.req.text();
  if (raw.length > MAX_CONTENT_BYTES) return jsonError(c, 413, 'payload_too_large', 'This document is too large to save.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch {
    return jsonError(c, 400, 'invalid_json', 'The document could not be read.');
  }
  const body = contentSchema.safeParse(parsed);
  if (!body.success) return jsonError(c, 400, 'invalid_body', 'The document content is invalid.');

  const result = await writeDocument(
    c.env,
    invitation.document_type,
    invitation.document_id,
    invitation.owner_user_id,
    body.data.content as Record<string, unknown>
  );
  if (!result.ok) return jsonError(c, 404, 'not_found', 'Document not found.');

  const now = new Date().toISOString();
  await dbRun(c.env, `UPDATE document_contributor_invitations SET last_saved_at = ? WHERE id = ?`, [now, invitation.id]);
  await dbRun(
    c.env,
    `UPDATE document_editing_state SET last_saved_at = ?, updated_at = ? WHERE document_type = ? AND document_id = ?`,
    [now, now, invitation.document_type, invitation.document_id]
  );

  return c.json({ success: true, saved_at: now });
});

/** Contributor "Complete". */
contributor.post('/:token/complete', async (c) => {
  const token = c.req.param('token');
  const invitation = await invitationByToken(c.env, token);
  if (!invitation) return jsonError(c, 404, 'invitation_not_found', 'This invitation link is not valid.');
  if (invitation.status === 'completed') return c.json({ success: true, already: true });

  await completeContributorSession(
    c.env,
    invitation.document_type,
    invitation.document_id,
    invitation.owner_user_id,
    'contributor'
  );
  await clearSessionChat(c.env, invitation.id);
  return c.json({ success: true });
});

/** Temporary chat for this session only. */
contributor.get('/:token/messages', async (c) => {
  const invitation = await invitationByToken(c.env, c.req.param('token'));
  if (!invitation || invitation.status !== 'active') {
    return jsonError(c, 403, 'not_active', 'This contribution session is not active.');
  }
  const messages = await listChatMessages(c.env, invitation.id, c.req.query('after') ?? null);
  return c.json({ data: messages });
});

contributor.post('/:token/messages', async (c) => {
  const invitation = await invitationByToken(c.env, c.req.param('token'));
  if (!invitation || invitation.status !== 'active') {
    return jsonError(c, 403, 'not_active', 'This contribution session is not active.');
  }
  const body = await c.req.json().catch(() => ({}));
  const text = String((body as any)?.body ?? '').trim();
  if (!text) return jsonError(c, 400, 'empty_message', 'Write a message first.');
  const message = await postChatMessage(c.env, invitation.id, 'contributor', text);
  return c.json({ success: true, message });
});

/** Live state poll: contributor sees owner actions, owner sees contributor activity. */
contributor.get('/:token/state', async (c) => {
  const invitation = await invitationByToken(c.env, c.req.param('token'));
  if (!invitation) return jsonError(c, 404, 'invitation_not_found', 'This invitation link is not valid.');
  const state = await getEditingAuthority(c.env, invitation.document_type, invitation.document_id);
  return c.json({
    status: invitation.status,
    state: state?.state ?? null,
    last_saved_at: invitation.last_saved_at ?? null,
    expires_at: invitation.expires_at,
  });
});

collaboration.route('/contributor', contributor);

// ---------------------------------------------------------------------------
// Owner routes
// ---------------------------------------------------------------------------

collaboration.use('/*', userAuthMiddleware);

/** Current editing authority plus contributor history for this document. */
collaboration.get('/:type/:id', async (c) => {
  const { error, auth, doc } = await ownerDocument(c, c.req.param('type'), c.req.param('id'));
  if (error) return error;
  const type = doc!.type;
  const state = await ensureEditingAuthority(c.env, type, doc!.id, auth!.userId, doc!.updated_at);
  const invitations = await dbQuery<any>(
    c.env,
    `SELECT id, contributor_email, status, expires_at, created_at, completed_at, last_saved_at
       FROM document_contributor_invitations
      WHERE document_type = ? AND document_id = ? AND owner_user_id = ?
      ORDER BY created_at DESC LIMIT 25`,
    [type, doc!.id, auth!.userId]
  );
  const previous = await dbQuery<any>(
    c.env,
    `SELECT contributor_email, MAX(created_at) AS last_used
       FROM document_contributor_invitations
      WHERE owner_user_id = ?
      GROUP BY contributor_email ORDER BY last_used DESC LIMIT 10`,
    [auth!.userId]
  );
  return c.json({
    success: true,
    state,
    can_edit: state.state === 'normal_online_editing',
    invitations,
    previous_contributors: previous,
  });
});

/** Creates an invitation and returns the one link the owner shares. */
collaboration.post('/:type/:id/invitation', async (c) => {
  const { error, auth, doc } = await ownerDocument(c, c.req.param('type'), c.req.param('id'));
  if (error) return error;
  const parsed = inviteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return jsonError(c, 400, 'invalid_body', parsed.error.issues[0]?.message ?? 'Enter a contributor email.');
  }
  try {
    await ensureEditingAuthority(c.env, doc!.type, doc!.id, auth!.userId, doc!.updated_at);
    const invitation = await inviteContributor(
      c.env,
      doc!.type,
      doc!.id,
      auth!.userId,
      parsed.data.email,
      parsed.data.expires_hours ?? 72
    );
    const origin = (c.env.FRONTEND_ORIGIN ?? 'https://revercue.co.uk').replace(/\/$/, '');
    return c.json({
      success: true,
      invitation: {
        id: invitation.id,
        contributor_email: parsed.data.email,
        expires_at: invitation.expires_at,
        url: `${origin}/contribute/${invitation.token}`,
      },
    });
  } catch (err) {
    const mapped = authorityErrorResponse(err);
    if (mapped) return c.json(mapped.body, mapped.status as any);
    throw err;
  }
});

/** Ends the contribution (used by the owner's "Complete Contribution"). */
collaboration.post('/:type/:id/complete', async (c) => {
  const { error, auth, doc } = await ownerDocument(c, c.req.param('type'), c.req.param('id'));
  if (error) return error;
  try {
    const active = await dbFirst<any>(
      c.env,
      `SELECT id FROM document_contributor_invitations
        WHERE document_type = ? AND document_id = ? AND status = 'active' LIMIT 1`,
      [doc!.type, doc!.id]
    );
    await completeContributorSession(c.env, doc!.type, doc!.id, auth!.userId, 'owner');
    if (active?.id) await clearSessionChat(c.env, active.id);
    return c.json({ success: true });
  } catch (err) {
    const mapped = authorityErrorResponse(err);
    if (mapped) return c.json(mapped.body, mapped.status as any);
    throw err;
  }
});

/** Revokes the invitation and ends any active session. */
collaboration.delete('/:type/:id/invitation', async (c) => {
  const { error, auth, doc } = await ownerDocument(c, c.req.param('type'), c.req.param('id'));
  if (error) return error;
  try {
    const rows = await dbQuery<any>(
      c.env,
      `SELECT id FROM document_contributor_invitations
        WHERE document_type = ? AND document_id = ? AND status IN ('pending','active')`,
      [doc!.type, doc!.id]
    );
    await revokeContributorInvitation(c.env, doc!.type, doc!.id, auth!.userId);
    for (const row of rows) await clearSessionChat(c.env, String(row.id));
    return c.json({ success: true });
  } catch (err) {
    const mapped = authorityErrorResponse(err);
    if (mapped) return c.json(mapped.body, mapped.status as any);
    throw err;
  }
});

/** Owner-side chat, available only while a contribution session is live. */
collaboration.get('/:type/:id/messages', async (c) => {
  const { error, auth, doc } = await ownerDocument(c, c.req.param('type'), c.req.param('id'));
  if (error) return error;
  const state = await getEditingAuthority(c.env, doc!.type, doc!.id);
  if (!state || state.state !== 'contributor_editing' || !state.contributor_session_id) {
    return c.json({ data: [], session_active: false });
  }
  void auth;
  const messages = await listChatMessages(c.env, state.contributor_session_id, c.req.query('after') ?? null);
  return c.json({ data: messages, session_active: true });
});

collaboration.post('/:type/:id/messages', async (c) => {
  const { error, doc } = await ownerDocument(c, c.req.param('type'), c.req.param('id'));
  if (error) return error;
  const state = await getEditingAuthority(c.env, doc!.type, doc!.id);
  if (!state || state.state !== 'contributor_editing' || !state.contributor_session_id) {
    return jsonError(c, 409, 'not_active', 'The collaboration chat is only available while a contributor is editing.');
  }
  const body = await c.req.json().catch(() => ({}));
  const text = String((body as any)?.body ?? '').trim();
  if (!text) return jsonError(c, 400, 'empty_message', 'Write a message first.');
  const message = await postChatMessage(c.env, state.contributor_session_id, 'owner', text);
  return c.json({ success: true, message });
});

/** Live document for the owner: they watch, they do not edit. */
collaboration.get('/:type/:id/preview', async (c) => {
  const { error, auth, doc } = await ownerDocument(c, c.req.param('type'), c.req.param('id'));
  if (error) return error;
  const fresh = await readDocument(c.env, doc!.type, doc!.id, auth!.userId);
  const state = await getEditingAuthority(c.env, doc!.type, doc!.id);
  return c.json({ success: true, document: fresh, state });
});

// ---- Offline Builder -------------------------------------------------------

collaboration.post('/:type/:id/offline/start', async (c) => {
  const { error, auth, doc } = await ownerDocument(c, c.req.param('type'), c.req.param('id'));
  if (error) return error;
  const parsed = offlineStartSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return jsonError(c, 400, 'invalid_body', 'A device identifier is required.');
  try {
    await ensureEditingAuthority(c.env, doc!.type, doc!.id, auth!.userId, doc!.updated_at);
    const lock = await acquireOfflineLock(
      c.env,
      doc!.type,
      doc!.id,
      auth!.userId,
      parsed.data.device_id,
      parsed.data.cloud_version ?? doc!.updated_at
    );
    const fresh = await readDocument(c.env, doc!.type, doc!.id, auth!.userId);
    return c.json({ success: true, ...lock, document: fresh, prepared_at: new Date().toISOString() });
  } catch (err) {
    const mapped = authorityErrorResponse(err);
    if (mapped) return c.json(mapped.body, mapped.status as any);
    throw err;
  }
});

collaboration.post('/:type/:id/offline/complete', async (c) => {
  const { error, auth, doc } = await ownerDocument(c, c.req.param('type'), c.req.param('id'));
  if (error) return error;
  const body = (await c.req.json().catch(() => ({}))) as any;
  const sessionId = String(body?.session_id ?? '').trim();
  if (!sessionId) return jsonError(c, 400, 'session_required', 'An offline session is required.');
  try {
    await completeOfflineEditing(c.env, doc!.type, doc!.id, auth!.userId, sessionId);
    return c.json({ success: true, completed_at: new Date().toISOString() });
  } catch (err) {
    const mapped = authorityErrorResponse(err);
    if (mapped) return c.json(mapped.body, mapped.status as any);
    throw err;
  }
});

collaboration.post('/:type/:id/offline/reopen', async (c) => {
  const { error, auth, doc } = await ownerDocument(c, c.req.param('type'), c.req.param('id'));
  if (error) return error;
  const body = (await c.req.json().catch(() => ({}))) as any;
  const sessionId = String(body?.session_id ?? '').trim();
  if (!sessionId) return jsonError(c, 400, 'session_required', 'An offline session is required.');
  try {
    await reopenOfflineEditing(c.env, doc!.type, doc!.id, auth!.userId, sessionId);
    return c.json({ success: true });
  } catch (err) {
    const mapped = authorityErrorResponse(err);
    if (mapped) return c.json(mapped.body, mapped.status as any);
    throw err;
  }
});

/** Commits the completed offline snapshot and only then releases the lock. */
collaboration.post('/:type/:id/offline/sync', async (c) => {
  const { error, auth, doc } = await ownerDocument(c, c.req.param('type'), c.req.param('id'));
  if (error) return error;
  const parsed = offlineSyncSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return jsonError(c, 400, 'invalid_body', 'The offline snapshot is incomplete.');
  try {
    const write = await writeDocument(
      c.env,
      doc!.type,
      doc!.id,
      auth!.userId,
      parsed.data.content as Record<string, unknown>
    );
    if (!write.ok) return jsonError(c, 404, 'not_found', 'Document not found.');
    await syncOfflineSession(
      c.env,
      doc!.type,
      doc!.id,
      auth!.userId,
      parsed.data.session_id,
      parsed.data.lock_token,
      parsed.data.expected_version ?? null,
      write.updated_at
    );
    return c.json({ success: true, cloud_version: write.updated_at });
  } catch (err) {
    const mapped = authorityErrorResponse(err);
    if (mapped) {
      // A failed sync must leave the lock in place and keep the local snapshot.
      await markSyncFailed(
        c.env,
        doc!.type,
        doc!.id,
        auth!.userId,
        parsed.data.session_id,
        String(mapped.body.message)
      ).catch(() => undefined);
      return c.json(mapped.body, mapped.status as any);
    }
    throw err;
  }
});

/** Recovery: a lost device can be released by the owner, keeping the lock honest. */
collaboration.post('/:type/:id/offline/release', async (c) => {
  const { error, auth, doc } = await ownerDocument(c, c.req.param('type'), c.req.param('id'));
  if (error) return error;
  const state = await getEditingAuthority(c.env, doc!.type, doc!.id);
  if (!state || state.user_id !== auth!.userId) return jsonError(c, 403, 'forbidden', 'Not allowed.');
  if (!['offline_editing', 'offline_completed', 'sync_failed', 'offline_preparing'].includes(state.state)) {
    return jsonError(c, 409, 'not_locked', 'This document is not locked by an offline session.');
  }
  const body = (await c.req.json().catch(() => ({}))) as any;
  if (body?.confirm !== true) {
    return jsonError(c, 400, 'confirm_required', 'Confirm that unsynchronised offline changes will be discarded.');
  }
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `UPDATE document_offline_sessions SET status = 'released', sync_error = 'released_by_owner', updated_at = ? WHERE document_type = ? AND document_id = ? AND status IN ('preparing','active','completed')`,
    [now, doc!.type, doc!.id]
  );
  await dbRun(
    c.env,
    `UPDATE document_editing_state SET state = 'normal_online_editing', authority_kind = 'owner', authority_id = ?, lock_token = NULL, offline_session_id = NULL, updated_at = ? WHERE document_type = ? AND document_id = ?`,
    [auth!.userId, now, doc!.type, doc!.id]
  );
  await dbRun(
    c.env,
    `INSERT INTO document_editing_events (id, document_type, document_id, user_id, event_type, from_state, to_state, authority_kind, authority_id, metadata, created_at) VALUES (?, ?, ?, ?, 'offline_released', ?, 'normal_online_editing', 'owner', ?, NULL, ?)`,
    [`dee_${crypto.randomUUID()}`, doc!.type, doc!.id, auth!.userId, state.state, auth!.userId, now]
  );
  return c.json({ success: true });
});

export default collaboration;
