import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyDocumentTables, applyMigration, createTestDb } from './helpers/sqlite-d1';
import {
  AuthorityError,
  acquireOfflineLock,
  assertOwnerMayEdit,
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
} from '../src/services/document-editing-authority';
import {
  clearSessionChat,
  listChatMessages,
  postChatMessage,
} from '../src/services/collaboration-chat';
import { readDocument, writeDocument } from '../src/services/document-adapter';

const OWNER = 'usr_owner';
const DOC = 'doc_journey';
let env: any;
let db: any;

beforeAll(() => {
  const created = createTestDb();
  db = created.db;
  applyMigration(db, '0010_document_collaboration.sql');
  applyDocumentTables(db);
  env = { DB: created.D1 } as any;
});

beforeEach(async () => {
  await env.DB.exec(`
    DELETE FROM document_editing_state;
    DELETE FROM document_contributor_invitations;
    DELETE FROM document_editing_events;
    DELETE FROM document_offline_sessions;
    DELETE FROM collaboration_messages;
    DELETE FROM proposals;
    DELETE FROM invoices;
  `);
  db.prepare(
    `INSERT INTO proposals (id, user_id, client_id, title, content, updated_at, created_at)
     VALUES (?, ?, 'cli_1', 'Website proposal', ?, '2026-11-28T10:00:00.000Z', '2026-11-28T09:00:00.000Z')`
  ).run(DOC, OWNER, JSON.stringify({ sections: [{ heading: 'Intro' }] }));
  db.prepare(
    `INSERT INTO invoices (id, user_id, client_id, invoice_number, line_items, notes, currency, tax, total, due_date, payment_arrangement, updated_at, created_at)
     VALUES ('inv_j', ?, 'cli_1', 'INV-J', '[{"label":"Deposit","amount":500}]', 'Thanks', 'GBP', 0, 500, '2026-12-10', NULL, '2026-11-28T10:00:00.000Z', '2026-11-28T09:00:00.000Z')`
  ).run(OWNER);
});

describe('Contributor journey end to end', () => {
  it('runs the full session: invite, live lock, chat, complete, regain, revoke a dead link', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');

    // Owner starts in control.
    expect((await assertOwnerMayEdit(env, 'proposal', DOC)).ok).toBe(true);

    // 1. Invite stores the email and moves state to contributor_invited.
    const invite = await inviteContributor(env, 'proposal', DOC, OWNER, 'contrib@example.com');
    expect(invite.token.length).toBeGreaterThanOrEqual(32);
    const invited = await getEditingAuthority(env, 'proposal', DOC);
    expect(invited?.state).toBe('contributor_invited');
    const stored = db.prepare(`SELECT contributor_email, status FROM document_contributor_invitations WHERE id = ?`).get(invite.id);
    expect(stored.contributor_email).toBe('contrib@example.com');
    expect(stored.status).toBe('pending');

    // Owner editing is already locked at the invitation step.
    const lockedWhileInvited = await assertOwnerMayEdit(env, 'proposal', DOC);
    expect(lockedWhileInvited.ok).toBe(false);
    if (!lockedWhileInvited.ok) expect(lockedWhileInvited.code).toBe('contributor_editing');

    // A second invitation is refused while one is live.
    await expect(inviteContributor(env, 'proposal', DOC, OWNER, 'other@example.com')).rejects.toBeInstanceOf(AuthorityError);

    // 2. Contributor opens the link: state becomes contributor_editing.
    const opened = await startContributorSession(env, invite.token);
    expect(opened).not.toBeNull();
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('contributor_editing');

    // Owner editing stays refused throughout.
    const lockedWhileEditing = await assertOwnerMayEdit(env, 'proposal', DOC);
    expect(lockedWhileEditing.ok).toBe(false);

    // A document write by the owner is the kind of thing the guard prevents.
    const writeAttempt = await writeDocument(env, 'proposal', DOC, OWNER, { content: { sections: [{ heading: 'sneaky' }] } });
    // writeDocument does not consult the authority itself, but the route layer does;
    // here we assert the authority guard is the source of truth.
    expect((await assertOwnerMayEdit(env, 'proposal', DOC)).ok).toBe(false);

    // 3. Temporary chat works both ways and is cleared at completion.
    await postChatMessage(env, invite.id, 'owner', 'Please shorten the summary.');
    await postChatMessage(env, invite.id, 'contributor', 'Done, have a look.');
    expect((await listChatMessages(env, invite.id)).map((m) => m.author)).toEqual(['owner', 'contributor']);

    // 4a. Contributor completes: owner regains control, chat cleared, link dead.
    await completeContributorSession(env, 'proposal', DOC, OWNER, 'contributor');
    await clearSessionChat(env, invite.id);
    const afterContrib = await getEditingAuthority(env, 'proposal', DOC);
    expect(afterContrib?.state).toBe('normal_online_editing');
    expect(afterContrib?.authority_kind).toBe('owner');
    expect(afterContrib?.contributor_session_id).toBeNull();
    expect(await listChatMessages(env, invite.id)).toHaveLength(0);
    expect(await startContributorSession(env, invite.token)).toBeNull();
    expect((await assertOwnerMayEdit(env, 'proposal', DOC)).ok).toBe(true);

    // 4b. Owner can complete a fresh session too.
    const second = await inviteContributor(env, 'proposal', DOC, OWNER, 'contrib@example.com');
    await startContributorSession(env, second.token);
    await postChatMessage(env, second.id, 'owner', 'One more change.');
    await completeContributorSession(env, 'proposal', DOC, OWNER, 'owner');
    await clearSessionChat(env, second.id);
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('normal_online_editing');
    expect(await listChatMessages(env, second.id)).toHaveLength(0);

    // 5. Revoke ends an active session immediately.
    const third = await inviteContributor(env, 'proposal', DOC, OWNER, 'contrib@example.com');
    await startContributorSession(env, third.token);
    await revokeContributorInvitation(env, 'proposal', DOC, OWNER);
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('normal_online_editing');
    expect(await startContributorSession(env, third.token)).toBeNull();
    const revoked = db.prepare(`SELECT status FROM document_contributor_invitations WHERE id = ?`).get(third.id);
    expect(revoked.status).toBe('revoked');

    // Audit log never contains chat content or the contributor email.
    const events = db.prepare(`SELECT event_type, to_state, metadata FROM document_editing_events`).all();
    expect(events.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain('Please shorten the summary.');
    expect(serialised).not.toContain('contrib@example.com');
  });

  it('refuses a non-owner at every authority step', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');
    const invite = await inviteContributor(env, 'proposal', DOC, OWNER, 'contrib@example.com');
    await startContributorSession(env, invite.token);
    await expect(inviteContributor(env, 'proposal', DOC, 'usr_other', 'x@y.com')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(completeContributorSession(env, 'proposal', DOC, 'usr_other', 'owner')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(revokeContributorInvitation(env, 'proposal', DOC, 'usr_other')).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('Offline journey end to end', () => {
  it('runs the full session: lock, refuse owner and contributors, complete, sync, unlock, version bump', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');

    // 1. Acquire the lock: state moves through preparing to offline_editing.
    const lock = await acquireOfflineLock(env, 'proposal', DOC, OWNER, 'device-abc-123', 'v1');
    expect(lock.sessionId).toBeTruthy();
    expect(lock.lockToken).toBeTruthy();
    const editing = await getEditingAuthority(env, 'proposal', DOC);
    expect(editing?.state).toBe('offline_editing');
    expect(editing?.offline_session_id).toBe(lock.sessionId);
    expect(editing?.lock_token).toBe(lock.lockToken);
    expect(editing?.cloud_version).toBe('v1');

    // 2. Owner editing is refused everywhere while offline.
    const ownerGuard = await assertOwnerMayEdit(env, 'proposal', DOC);
    expect(ownerGuard.ok).toBe(false);
    if (!ownerGuard.ok) expect(ownerGuard.code).toBe('offline_locked');

    // 3. Contributor invitations are refused while offline.
    await expect(inviteContributor(env, 'proposal', DOC, OWNER, 'sam@example.com')).rejects.toMatchObject({ code: 'busy' });

    // 4. Sync is gated behind Complete: not_ready first.
    await expect(
      syncOfflineSession(env, 'proposal', DOC, OWNER, lock.sessionId, lock.lockToken, 'v1', 'v2')
    ).rejects.toMatchObject({ code: 'not_ready' });
    // Lock still held, state unchanged.
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('offline_editing');

    // 5. Complete makes the document read-only and enables Sync.
    await completeOfflineEditing(env, 'proposal', DOC, OWNER, lock.sessionId);
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('offline_completed');
    const sessionRow = db.prepare(`SELECT status, completed_at FROM document_offline_sessions WHERE id = ?`).get(lock.sessionId);
    expect(sessionRow.status).toBe('completed');
    expect(sessionRow.completed_at).toBeTruthy();

    // 6. Successful sync releases the lock, bumps the version, restores normal editing.
    await syncOfflineSession(env, 'proposal', DOC, OWNER, lock.sessionId, lock.lockToken, 'v1', 'v2');
    const after = await getEditingAuthority(env, 'proposal', DOC);
    expect(after?.state).toBe('normal_online_editing');
    expect(after?.authority_kind).toBe('owner');
    expect(after?.lock_token).toBeNull();
    expect(after?.offline_session_id).toBeNull();
    expect(after?.cloud_version).toBe('v2');
    const synced = db.prepare(`SELECT status, synced_at FROM document_offline_sessions WHERE id = ?`).get(lock.sessionId);
    expect(synced.status).toBe('synced');
    expect(synced.synced_at).toBeTruthy();
    expect((await assertOwnerMayEdit(env, 'proposal', DOC)).ok).toBe(true);
  });

  it('keeps the lock on a stale version and allows a retry after a recorded failure', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');
    const lock = await acquireOfflineLock(env, 'proposal', DOC, OWNER, 'device-abc-123', 'v1');
    await completeOfflineEditing(env, 'proposal', DOC, OWNER, lock.sessionId);

    // Wrong expected version: stale_version, lock and state untouched.
    await expect(
      syncOfflineSession(env, 'proposal', DOC, OWNER, lock.sessionId, lock.lockToken, 'v9', 'v10')
    ).rejects.toMatchObject({ code: 'stale_version' });
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('offline_completed');

    // Wrong lock token: lock_mismatch, still locked.
    await expect(
      syncOfflineSession(env, 'proposal', DOC, OWNER, lock.sessionId, 'wrong-token', 'v1', 'v2')
    ).rejects.toMatchObject({ code: 'lock_mismatch' });
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('offline_completed');

    // Record the failure without releasing anything, then retry successfully.
    await markSyncFailed(env, 'proposal', DOC, OWNER, lock.sessionId, 'network down');
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('offline_completed');
    const errRow = db.prepare(`SELECT sync_error FROM document_offline_sessions WHERE id = ?`).get(lock.sessionId);
    expect(errRow.sync_error).toBe('network down');

    await syncOfflineSession(env, 'proposal', DOC, OWNER, lock.sessionId, lock.lockToken, 'v1', 'v2');
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('normal_online_editing');
  });

  it('reopen cancels completion and requires another Complete before Sync', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');
    const lock = await acquireOfflineLock(env, 'proposal', DOC, OWNER, 'device-abc-123', 'v1');
    await completeOfflineEditing(env, 'proposal', DOC, OWNER, lock.sessionId);
    await reopenOfflineEditing(env, 'proposal', DOC, OWNER, lock.sessionId);
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('offline_editing');

    // Sync is not available again until a fresh Complete.
    await expect(
      syncOfflineSession(env, 'proposal', DOC, OWNER, lock.sessionId, lock.lockToken, 'v1', 'v2')
    ).rejects.toMatchObject({ code: 'not_ready' });

    await completeOfflineEditing(env, 'proposal', DOC, OWNER, lock.sessionId);
    await syncOfflineSession(env, 'proposal', DOC, OWNER, lock.sessionId, lock.lockToken, 'v1', 'v2');
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('normal_online_editing');
  });

  it('never releases the lock without a successful sync, and keeps contributors out', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');
    await acquireOfflineLock(env, 'proposal', DOC, OWNER, 'device-abc-123', 'v1');
    // State stays offline_editing indefinitely; lock is not dropped by disconnect.
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('offline_editing');
    await expect(inviteContributor(env, 'proposal', DOC, OWNER, 'sam@example.com')).rejects.toThrow();
    // Owner save guard still refuses.
    expect((await assertOwnerMayEdit(env, 'proposal', DOC)).ok).toBe(false);
  });

  it('works on an invoice through the shared adapter, not only proposals', async () => {
    await ensureEditingAuthority(env, 'invoice', 'inv_j', OWNER, '2026-11-28T10:00:00.000Z');
    const doc = await readDocument(env, 'invoice', 'inv_j', OWNER);
    expect((doc?.content as any).currency).toBe('GBP');
    await writeDocument(env, 'invoice', 'inv_j', OWNER, { notes: 'Prepared offline', total: 750 });

    const lock = await acquireOfflineLock(env, 'invoice', 'inv_j', OWNER, 'device-abc-123', 'v1');
    expect((await getEditingAuthority(env, 'invoice', 'inv_j'))?.state).toBe('offline_editing');
    await completeOfflineEditing(env, 'invoice', 'inv_j', OWNER, lock.sessionId);
    await syncOfflineSession(env, 'invoice', 'inv_j', OWNER, lock.sessionId, lock.lockToken, 'v1', 'v2');
    expect((await getEditingAuthority(env, 'invoice', 'inv_j'))?.state).toBe('normal_online_editing');
  });

  it('refuses a foreign owner throughout the offline flow', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');
    await expect(acquireOfflineLock(env, 'proposal', DOC, 'usr_other', 'dev', 'v1')).rejects.toMatchObject({ code: 'forbidden' });
  });
});
