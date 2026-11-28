import { dbFirst, dbRun } from '../utils/db';
import type { Bindings } from '../types';

export type EditingState =
  | 'normal_online_editing'
  | 'contributor_invited'
  | 'contributor_editing'
  | 'offline_preparing'
  | 'offline_editing'
  | 'offline_completed'
  | 'syncing'
  | 'sync_failed'
  | 'conflict_review';

export type AuthorityKind = 'owner' | 'contributor' | 'offline';

export interface EditingAuthority {
  id: string;
  document_type: string;
  document_id: string;
  user_id: string;
  state: EditingState;
  authority_kind: AuthorityKind;
  authority_id: string | null;
  lock_token: string | null;
  cloud_version: string | null;
  offline_session_id: string | null;
  contributor_session_id: string | null;
  last_saved_at: string | null;
  created_at: string;
  updated_at: string;
}

const VALID_TRANSITIONS: Record<EditingState, EditingState[]> = {
  normal_online_editing: ['contributor_invited', 'offline_preparing'],
  contributor_invited: ['contributor_editing', 'normal_online_editing'],
  contributor_editing: ['normal_online_editing'],
  offline_preparing: ['offline_editing', 'normal_online_editing'],
  offline_editing: ['offline_completed', 'normal_online_editing'],
  offline_completed: ['syncing', 'offline_editing'],
  syncing: ['normal_online_editing', 'sync_failed', 'conflict_review'],
  sync_failed: ['syncing', 'offline_completed', 'conflict_review'],
  conflict_review: ['normal_online_editing'],
};

export class AuthorityError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = 'AuthorityError';
    this.code = code;
    this.status = status;
  }
}

export function assertTransition(from: EditingState, to: EditingState): void {
  if (!VALID_TRANSITIONS[from]?.includes(to)) {
    throw new AuthorityError(
      'invalid_transition',
      `Cannot move from ${from} to ${to}.`,
      409
    );
  }
}

export function isOwnerEditable(state: EditingState): boolean {
  return state === 'normal_online_editing';
}

export function isContributorEditable(state: EditingState): boolean {
  return state === 'contributor_editing';
}

export function isOfflineEditable(state: EditingState): boolean {
  return state === 'offline_editing';
}

export async function getEditingAuthority(
  env: Bindings,
  documentType: string,
  documentId: string
): Promise<EditingAuthority | null> {
  return dbFirst<EditingAuthority>(
    env,
    `SELECT * FROM document_editing_state WHERE document_type = ? AND document_id = ?`,
    [documentType, documentId]
  );
}

export async function ensureEditingAuthority(
  env: Bindings,
  documentType: string,
  documentId: string,
  userId: string,
  cloudVersion: string | null = null
): Promise<EditingAuthority> {
  const existing = await getEditingAuthority(env, documentType, documentId);
  if (existing) return existing;
  const id = `dea_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await dbRun(
    env,
    `INSERT INTO document_editing_state
     (id, document_type, document_id, user_id, state, authority_kind, authority_id,
      lock_token, cloud_version, offline_session_id, contributor_session_id,
      last_saved_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'normal_online_editing', 'owner', ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
    [id, documentType, documentId, userId, userId, cloudVersion, now, now]
  );
  return (await getEditingAuthority(env, documentType, documentId)) as EditingAuthority;
}

export async function transitionAuthority(
  env: Bindings,
  documentType: string,
  documentId: string,
  userId: string,
  to: EditingState,
  authorityKind: AuthorityKind,
  authorityId: string | null,
  lockToken: string | null = null,
  cloudVersion: string | null = null
): Promise<EditingAuthority> {
  const current = await getEditingAuthority(env, documentType, documentId);
  if (!current) {
    throw new AuthorityError('not_found', 'Editing authority not found.', 404);
  }
  if (current.user_id !== userId) {
    throw new AuthorityError('forbidden', 'Only the document owner may change editing authority.', 403);
  }
  assertTransition(current.state, to);
  const now = new Date().toISOString();
  await dbRun(
    env,
    `UPDATE document_editing_state
     SET state = ?, authority_kind = ?, authority_id = ?, lock_token = COALESCE(?, lock_token),
         cloud_version = COALESCE(?, cloud_version), updated_at = ?
     WHERE document_type = ? AND document_id = ?`,
    [to, authorityKind, authorityId, lockToken, cloudVersion, now, documentType, documentId]
  );
  await dbRun(
    env,
    `INSERT INTO document_editing_events
     (id, document_type, document_id, user_id, event_type, from_state, to_state,
      authority_kind, authority_id, metadata, created_at)
     VALUES (?, ?, ?, ?, 'transition', ?, ?, ?, ?, NULL, ?)`,
    [`dee_${crypto.randomUUID()}`, documentType, documentId, userId, current.state, to, authorityKind, authorityId, now]
  );
  return (await getEditingAuthority(env, documentType, documentId)) as EditingAuthority;
}

export async function inviteContributor(
  env: Bindings,
  documentType: string,
  documentId: string,
  ownerUserId: string,
  contributorEmail: string,
  expiresHours = 72
): Promise<{ id: string; token: string; expires_at: string }> {
  const current = await getEditingAuthority(env, documentType, documentId);
  if (!current || current.user_id !== ownerUserId) {
    throw new AuthorityError('forbidden', 'Only the document owner may invite a contributor.', 403);
  }
  // A pending invitation that was never opened must not block the owner
  // forever: expire it here so a fresh link can be generated.
  if (current.state === 'contributor_invited') {
    const pending = await dbFirst<any>(
      env,
      `SELECT id, expires_at FROM document_contributor_invitations
        WHERE document_type = ? AND document_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [documentType, documentId]
    );
    if (!pending || new Date(String(pending.expires_at)).getTime() <= Date.now()) {
      if (pending) {
        await dbRun(env, `UPDATE document_contributor_invitations SET status = 'expired' WHERE id = ?`, [pending.id]);
      }
      await transitionAuthority(env, documentType, documentId, ownerUserId, 'normal_online_editing', 'owner', ownerUserId);
    }
  } else if (current.state !== 'normal_online_editing') {
    throw new AuthorityError('busy', 'The document is not available for a new contributor right now.', 409);
  }
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const id = `dci_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + expiresHours * 3600_000).toISOString();
  await dbRun(
    env,
    `INSERT INTO document_contributor_invitations
     (id, document_type, document_id, owner_user_id, contributor_email, token, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [id, documentType, documentId, ownerUserId, contributorEmail, token, expiresAt, now]
  );
  await transitionAuthority(env, documentType, documentId, ownerUserId, 'contributor_invited', 'contributor', null);
  return { id, token, expires_at: expiresAt };
}

export async function redeemContributorInvitation(
  env: Bindings,
  token: string
): Promise<{ invitationId: string; documentType: string; documentId: string; ownerUserId: string } | null> {
  const row = await dbFirst<any>(
    env,
    `SELECT * FROM document_contributor_invitations WHERE token = ?`,
    [token]
  );
  if (!row) return null;
  if (row.status !== 'pending') return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return {
    invitationId: row.id,
    documentType: row.document_type,
    documentId: row.document_id,
    ownerUserId: row.owner_user_id,
  };
}

export async function startContributorSession(
  env: Bindings,
  token: string
): Promise<{ documentType: string; documentId: string } | null> {
  const redeemed = await redeemContributorInvitation(env, token);
  if (!redeemed) return null;
  const now = new Date().toISOString();
  await dbRun(
    env,
    `UPDATE document_contributor_invitations SET status = 'active' WHERE token = ?`,
    [token]
  );
  await transitionAuthority(
    env,
    redeemed.documentType,
    redeemed.documentId,
    redeemed.ownerUserId,
    'contributor_editing',
    'contributor',
    redeemed.invitationId
  );
  await dbRun(
    env,
    `UPDATE document_editing_state SET contributor_session_id = ?, updated_at = ? WHERE document_type = ? AND document_id = ?`,
    [redeemed.invitationId, now, redeemed.documentType, redeemed.documentId]
  );
  return { documentType: redeemed.documentType, documentId: redeemed.documentId };
}

export async function completeContributorSession(
  env: Bindings,
  documentType: string,
  documentId: string,
  ownerUserId: string,
  by: 'contributor' | 'owner'
): Promise<void> {
  const current = await getEditingAuthority(env, documentType, documentId);
  if (!current || current.user_id !== ownerUserId) {
    throw new AuthorityError('forbidden', 'Only the document owner may complete a contribution.', 403);
  }
  if (current.state !== 'contributor_editing' && current.state !== 'contributor_invited') {
    throw new AuthorityError('not_editing', 'No active contributor session.', 409);
  }
  const now = new Date().toISOString();
  await dbRun(
    env,
    `UPDATE document_contributor_invitations SET status = 'completed', completed_at = ? WHERE document_type = ? AND document_id = ? AND status = 'active'`,
    [now, documentType, documentId]
  );
  await transitionAuthority(env, documentType, documentId, ownerUserId, 'normal_online_editing', 'owner', ownerUserId);
  await dbRun(
    env,
    `UPDATE document_editing_state SET contributor_session_id = NULL, updated_at = ? WHERE document_type = ? AND document_id = ?`,
    [now, documentType, documentId]
  );
}

export async function revokeContributorInvitation(
  env: Bindings,
  documentType: string,
  documentId: string,
  ownerUserId: string
): Promise<void> {
  const current = await getEditingAuthority(env, documentType, documentId);
  if (!current || current.user_id !== ownerUserId) {
    throw new AuthorityError('forbidden', 'Only the document owner may revoke a contributor.', 403);
  }
  const now = new Date().toISOString();
  await dbRun(
    env,
    `UPDATE document_contributor_invitations SET status = 'revoked', revoked_at = ? WHERE document_type = ? AND document_id = ? AND status IN ('pending','active')`,
    [now, documentType, documentId]
  );
  if (current.state === 'contributor_editing' || current.state === 'contributor_invited') {
    await transitionAuthority(env, documentType, documentId, ownerUserId, 'normal_online_editing', 'owner', ownerUserId);
  }
}

export async function acquireOfflineLock(
  env: Bindings,
  documentType: string,
  documentId: string,
  userId: string,
  deviceId: string,
  cloudVersion: string | null
): Promise<{ sessionId: string; lockToken: string }> {
  const current = await getEditingAuthority(env, documentType, documentId);
  if (!current || current.user_id !== userId) {
    throw new AuthorityError('forbidden', 'Only the document owner may enable Offline Mode.', 403);
  }
  if (current.state !== 'normal_online_editing') {
    throw new AuthorityError('busy', 'Resolve any active contributor session before enabling Offline Mode.', 409);
  }
  const sessionId = `dos_${crypto.randomUUID()}`;
  const lockToken = crypto.randomUUID();
  const now = new Date().toISOString();
  await dbRun(
    env,
    `INSERT INTO document_offline_sessions (id, document_type, document_id, user_id, device_id, status, prepared_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'preparing', ?, ?, ?)`,
    [sessionId, documentType, documentId, userId, deviceId, cloudVersion, now, now]
  );
  await transitionAuthority(env, documentType, documentId, userId, 'offline_preparing', 'offline', sessionId, lockToken, cloudVersion);
  await dbRun(
    env,
    `UPDATE document_offline_sessions SET status = 'active', updated_at = ? WHERE id = ?`,
    [now, sessionId]
  );
  await transitionAuthority(env, documentType, documentId, userId, 'offline_editing', 'offline', sessionId, lockToken, cloudVersion);
  await dbRun(
    env,
    `UPDATE document_editing_state SET offline_session_id = ?, updated_at = ? WHERE document_type = ? AND document_id = ?`,
    [sessionId, now, documentType, documentId]
  );
  return { sessionId, lockToken };
}

export async function completeOfflineEditing(
  env: Bindings,
  documentType: string,
  documentId: string,
  userId: string,
  sessionId: string
): Promise<void> {
  const current = await getEditingAuthority(env, documentType, documentId);
  if (!current || current.user_id !== userId) {
    throw new AuthorityError('forbidden', 'Only the document owner may complete offline editing.', 403);
  }
  if (current.state !== 'offline_editing' || current.offline_session_id !== sessionId) {
    throw new AuthorityError('not_editing', 'No matching active offline session.', 409);
  }
  const now = new Date().toISOString();
  await dbRun(
    env,
    `UPDATE document_offline_sessions SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
    [now, now, sessionId]
  );
  await transitionAuthority(env, documentType, documentId, userId, 'offline_completed', 'offline', sessionId);
}

export async function syncOfflineSession(
  env: Bindings,
  documentType: string,
  documentId: string,
  userId: string,
  sessionId: string,
  lockToken: string,
  expectedCloudVersion: string | null,
  newCloudVersion: string
): Promise<void> {
  const current = await getEditingAuthority(env, documentType, documentId);
  if (!current || current.user_id !== userId) {
    throw new AuthorityError('forbidden', 'Only the document owner may sync.', 403);
  }
  if (current.state !== 'offline_completed' && current.state !== 'sync_failed') {
    throw new AuthorityError('not_ready', 'Complete offline editing before syncing.', 409);
  }
  if (current.lock_token !== lockToken || current.offline_session_id !== sessionId) {
    throw new AuthorityError('lock_mismatch', 'Offline lock does not match this session.', 409);
  }
  if (expectedCloudVersion && current.cloud_version && current.cloud_version !== expectedCloudVersion) {
    throw new AuthorityError('stale_version', 'The cloud document changed since preparation. Review before syncing.', 409);
  }
  const now = new Date().toISOString();
  await transitionAuthority(env, documentType, documentId, userId, 'syncing', 'offline', sessionId, lockToken, newCloudVersion);
  await dbRun(
    env,
    `UPDATE document_offline_sessions SET status = 'synced', synced_at = ?, updated_at = ? WHERE id = ?`,
    [now, now, sessionId]
  );
  await dbRun(
    env,
    `UPDATE document_editing_state SET state = 'normal_online_editing', authority_kind = 'owner', authority_id = ?, lock_token = NULL, offline_session_id = NULL, cloud_version = ?, updated_at = ? WHERE document_type = ? AND document_id = ?`,
    [userId, newCloudVersion, now, documentType, documentId]
  );
  await dbRun(
    env,
    `INSERT INTO document_editing_events (id, document_type, document_id, user_id, event_type, from_state, to_state, authority_kind, authority_id, metadata, created_at) VALUES (?, ?, ?, ?, 'synced', 'syncing', 'normal_online_editing', 'owner', ?, ?, ?)`,
    [`dee_${crypto.randomUUID()}`, documentType, documentId, userId, userId, JSON.stringify({ sessionId }), now]
  );
}

/** Records a failed sync without touching the lock or the local snapshot. */
export async function markSyncFailed(
  env: Bindings,
  documentType: string,
  documentId: string,
  userId: string,
  sessionId: string,
  reason: string
): Promise<void> {
  const now = new Date().toISOString();
  await dbRun(
    env,
    `UPDATE document_offline_sessions SET sync_error = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    [reason.slice(0, 500), now, sessionId, userId]
  );
  const current = await getEditingAuthority(env, documentType, documentId);
  if (current?.state === 'syncing') {
    await transitionAuthority(env, documentType, documentId, userId, 'sync_failed', 'offline', sessionId, current.lock_token);
  }
}

export async function reopenOfflineEditing(
  env: Bindings,
  documentType: string,
  documentId: string,
  userId: string,
  sessionId: string
): Promise<void> {
  const current = await getEditingAuthority(env, documentType, documentId);
  if (!current || current.user_id !== userId) {
    throw new AuthorityError('forbidden', 'Only the document owner may reopen offline editing.', 403);
  }
  if (current.state !== 'offline_completed') {
    throw new AuthorityError('not_completed', 'Offline editing is not in a completed state.', 409);
  }
  const now = new Date().toISOString();
  await dbRun(
    env,
    `UPDATE document_offline_sessions SET status = 'reopened', updated_at = ? WHERE id = ?`,
    [now, sessionId]
  );
  await transitionAuthority(env, documentType, documentId, userId, 'offline_editing', 'offline', sessionId);
}
/**
 * Guard for the ordinary owner save routes. While a contributor controls the
 * document or an offline session holds the lock, the owner's browser must not
 * be able to overwrite the document — hiding the editor is not enforcement.
 */
export async function assertOwnerMayEdit(
  env: Bindings,
  documentType: string,
  documentId: string
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const state = await getEditingAuthority(env, documentType, documentId);
  if (!state) return { ok: true };
  if (state.state === 'normal_online_editing') return { ok: true };
  if (state.state === 'contributor_editing' || state.state === 'contributor_invited') {
    return {
      ok: false,
      code: 'contributor_editing',
      message: 'A contributor currently controls this document. Complete the contribution to edit again.',
    };
  }
  return {
    ok: false,
    code: 'offline_locked',
    message: 'Offline Mode holds the editing lock on this document. Sync or release it before editing online.',
  };
}
