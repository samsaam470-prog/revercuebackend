import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyDocumentTables, applyMigration, createTestDb } from './helpers/sqlite-d1';
import {
  AuthorityError,
  acquireOfflineLock,
  assertTransition,
  completeContributorSession,
  completeOfflineEditing,
  ensureEditingAuthority,
  getEditingAuthority,
  inviteContributor,
  isContributorEditable,
  isOwnerEditable,
  markSyncFailed,
  reopenOfflineEditing,
  revokeContributorInvitation,
  startContributorSession,
  syncOfflineSession,
} from '../src/services/document-editing-authority';
import {
  CHAT_TTL_MINUTES,
  clearSessionChat,
  listChatMessages,
  postChatMessage,
  purgeExpiredChat,
} from '../src/services/collaboration-chat';
import { readDocument, writeDocument } from '../src/services/document-adapter';

const OWNER = 'usr_owner';
const DOC = 'doc_1';
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
     VALUES ('inv_1', ?, 'cli_1', 'INV-1', '[{"label":"Deposit","amount":500}]', 'Thanks', 'GBP', 0, 500, '2026-12-10', NULL, '2026-11-28T10:00:00.000Z', '2026-11-28T09:00:00.000Z')`
  ).run(OWNER);
});

describe('editing authority state machine', () => {
  it('rejects transitions that would create a second editor', () => {
    expect(() => assertTransition('normal_online_editing', 'offline_editing')).toThrow(AuthorityError);
    expect(() => assertTransition('contributor_editing', 'offline_editing')).toThrow(AuthorityError);
    expect(() => assertTransition('offline_editing', 'syncing')).toThrow(AuthorityError);
    expect(() => assertTransition('normal_online_editing', 'contributor_invited')).not.toThrow();
  });

  it('exposes exactly one editable state at a time', () => {
    const states = [
      'normal_online_editing',
      'contributor_invited',
      'contributor_editing',
      'offline_preparing',
      'offline_editing',
      'offline_completed',
      'syncing',
      'sync_failed',
      'conflict_review',
    ] as const;
    for (const state of states) {
      const editable = [isOwnerEditable(state), isContributorEditable(state), state === 'offline_editing'].filter(Boolean);
      expect(editable.length).toBeLessThanOrEqual(1);
    }
  });

  it('refuses authority changes from a user who does not own the document', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');
    await expect(inviteContributor(env, 'proposal', DOC, 'usr_other', 'a@b.com')).rejects.toThrow(AuthorityError);
  });
});

describe('Shareable Builder', () => {
  it('creates an unguessable invitation and moves the document to contributor_invited', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');
    const invite = await inviteContributor(env, 'proposal', DOC, OWNER, 'sam@example.com');
    expect(invite.token.length).toBeGreaterThanOrEqual(32);
    const state = await getEditingAuthority(env, 'proposal', DOC);
    expect(state?.state).toBe('contributor_invited');
    const row = db
      .prepare(`SELECT contributor_email, status FROM document_contributor_invitations WHERE id = ?`)
      .get(invite.id);
    expect(row.contributor_email).toBe('sam@example.com');
    expect(row.status).toBe('pending');
  });

  it('allows only one live contributor: a second invitation while editing is refused', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');
    const first = await inviteContributor(env, 'proposal', DOC, OWNER, 'one@example.com');
    await startContributorSession(env, first.token);
    await expect(inviteContributor(env, 'proposal', DOC, OWNER, 'two@example.com')).rejects.toMatchObject({
      code: 'busy',
    });
  });

  it('does not redeem a token twice and blocks a revoked link', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');
    const invite = await inviteContributor(env, 'proposal', DOC, OWNER, 'sam@example.com');
    expect(await startContributorSession(env, invite.token)).not.toBeNull();
    expect(await startContributorSession(env, invite.token)).toBeNull();

    await revokeContributorInvitation(env, 'proposal', DOC, OWNER);
    const row = db.prepare(`SELECT status FROM document_contributor_invitations WHERE id = ?`).get(invite.id);
    expect(row.status).toBe('revoked');
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('normal_online_editing');
  });

  it('reopens a fresh link once an unopened invitation expired', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');
    const invite = await inviteContributor(env, 'proposal', DOC, OWNER, 'sam@example.com');
    db.prepare(`UPDATE document_contributor_invitations SET status = 'expired' WHERE id = ?`).run(invite.id);
    await expect(inviteContributor(env, 'proposal', DOC, OWNER, 'sam@example.com')).resolves.toBeTruthy();
  });

  it('restores owner control on either completion route', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');
    const byContributor = await inviteContributor(env, 'proposal', DOC, OWNER, 'sam@example.com');
    await startContributorSession(env, byContributor.token);
    await completeContributorSession(env, 'proposal', DOC, OWNER, 'contributor');
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('normal_online_editing');

    const byOwner = await inviteContributor(env, 'proposal', DOC, OWNER, 'sam@example.com');
    await startContributorSession(env, byOwner.token);
    await completeContributorSession(env, 'proposal', DOC, OWNER, 'owner');
    const state = await getEditingAuthority(env, 'proposal', DOC);
    expect(state?.state).toBe('normal_online_editing');
    expect(state?.authority_kind).toBe('owner');
    expect(state?.contributor_session_id).toBeNull();
  });

  it('keeps a completed invitation out of reach of the contributor link', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');
    const invite = await inviteContributor(env, 'proposal', DOC, OWNER, 'sam@example.com');
    await startContributorSession(env, invite.token);
    await completeContributorSession(env, 'proposal', DOC, OWNER, 'contributor');
    expect(await startContributorSession(env, invite.token)).toBeNull();
  });

  it('records auditable events without chat content', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');
    const invite = await inviteContributor(env, 'proposal', DOC, OWNER, 'sam@example.com');
    await startContributorSession(env, invite.token);
    await postChatMessage(env, invite.id, 'owner', 'secret chat line');
    await completeContributorSession(env, 'proposal', DOC, OWNER, 'owner');
    const events = db.prepare(`SELECT event_type, to_state, metadata FROM document_editing_events`).all();
    expect(events.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain('secret chat line');
    expect(serialised).not.toContain('sam@example.com');
  });
});

describe('temporary collaboration chat', () => {
  it('stores messages only for a live session and clears them on completion', async () => {
    await ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');
    const invite = await inviteContributor(env, 'proposal', DOC, OWNER, 'sam@example.com');
    await startContributorSession(env, invite.token);

    await postChatMessage(env, invite.id, 'owner', 'Can you shorten the summary?');
    await postChatMessage(env, invite.id, 'contributor', 'Done, have a look.');
    const messages = await listChatMessages(env, invite.id);
    expect(messages.map((m) => m.author)).toEqual(['owner', 'contributor']);

    await clearSessionChat(env, invite.id);
    expect(await listChatMessages(env, invite.id)).toHaveLength(0);
  });

  it('purges messages past their short TTL', async () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO collaboration_messages (id, session_id, author, body, created_at, expires_at)
       VALUES ('m1', 's1', 'owner', 'old', ?, ?)`
    ).run(now, new Date(Date.now() - 1000).toISOString());
    await purgeExpiredChat(env);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM collaboration_messages`).get().c).toBe(0);
    expect(CHAT_TTL_MINUTES).toBeLessThanOrEqual(240);
  });
});

describe('Offline Builder', () => {
  const prepareState = async () => ensureEditingAuthority(env, 'proposal', DOC, OWNER, '2026-11-28T10:00:00.000Z');

  it('locks the document and blocks contributor invitations while offline', async () => {
    await prepareState();
    const lock = await acquireOfflineLock(env, 'proposal', DOC, OWNER, 'device-abc-123', '2026-11-28T10:00:00.000Z');
    const state = await getEditingAuthority(env, 'proposal', DOC);
    expect(state?.state).toBe('offline_editing');
    expect(state?.offline_session_id).toBe(lock.sessionId);
    await expect(inviteContributor(env, 'proposal', DOC, OWNER, 'sam@example.com')).rejects.toMatchObject({ code: 'busy' });
  });

  it('refuses to start while a contributor controls the document', async () => {
    await prepareState();
    const invite = await inviteContributor(env, 'proposal', DOC, OWNER, 'sam@example.com');
    await startContributorSession(env, invite.token);
    await expect(
      acquireOfflineLock(env, 'proposal', DOC, OWNER, 'device-abc-123', null)
    ).rejects.toMatchObject({ code: 'busy' });
  });

  it('requires Complete before Sync and then releases the lock', async () => {
    await prepareState();
    const lock = await acquireOfflineLock(env, 'proposal', DOC, OWNER, 'device-abc-123', 'v1');
    await expect(
      syncOfflineSession(env, 'proposal', DOC, OWNER, lock.sessionId, lock.lockToken, 'v1', 'v2')
    ).rejects.toMatchObject({ code: 'not_ready' });

    await completeOfflineEditing(env, 'proposal', DOC, OWNER, lock.sessionId);
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('offline_completed');

    await syncOfflineSession(env, 'proposal', DOC, OWNER, lock.sessionId, lock.lockToken, 'v1', 'v2');
    const state = await getEditingAuthority(env, 'proposal', DOC);
    expect(state?.state).toBe('normal_online_editing');
    expect(state?.lock_token).toBeNull();
    expect(state?.cloud_version).toBe('v2');
  });

  it('rejects a stale expected version and keeps the lock', async () => {
    await prepareState();
    const lock = await acquireOfflineLock(env, 'proposal', DOC, OWNER, 'device-abc-123', 'v1');
    await completeOfflineEditing(env, 'proposal', DOC, OWNER, lock.sessionId);
    await expect(
      syncOfflineSession(env, 'proposal', DOC, OWNER, lock.sessionId, lock.lockToken, 'v9', 'v10')
    ).rejects.toMatchObject({ code: 'stale_version' });
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('offline_completed');
  });

  it('rejects a lock token from another device and allows retry after a recorded failure', async () => {
    await prepareState();
    const lock = await acquireOfflineLock(env, 'proposal', DOC, OWNER, 'device-abc-123', 'v1');
    await completeOfflineEditing(env, 'proposal', DOC, OWNER, lock.sessionId);
    await expect(
      syncOfflineSession(env, 'proposal', DOC, OWNER, lock.sessionId, 'wrong-token', 'v1', 'v2')
    ).rejects.toMatchObject({ code: 'lock_mismatch' });

    await markSyncFailed(env, 'proposal', DOC, OWNER, lock.sessionId, 'network down');
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('offline_completed');
    await syncOfflineSession(env, 'proposal', DOC, OWNER, lock.sessionId, lock.lockToken, 'v1', 'v2');
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('normal_online_editing');
  });

  it('supports reopening a completed offline session', async () => {
    await prepareState();
    const lock = await acquireOfflineLock(env, 'proposal', DOC, OWNER, 'device-abc-123', 'v1');
    await completeOfflineEditing(env, 'proposal', DOC, OWNER, lock.sessionId);
    await reopenOfflineEditing(env, 'proposal', DOC, OWNER, lock.sessionId);
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('offline_editing');
  });

  it('keeps the online document locked when sync never happens', async () => {
    await prepareState();
    await acquireOfflineLock(env, 'proposal', DOC, OWNER, 'device-abc-123', 'v1');
    expect((await getEditingAuthority(env, 'proposal', DOC))?.state).toBe('offline_editing');
    await expect(inviteContributor(env, 'proposal', DOC, OWNER, 'sam@example.com')).rejects.toThrow();
  });
});

describe('document adapter covers every builder', () => {
  it('round-trips proposal content', async () => {
    const doc = await readDocument(env, 'proposal', DOC, OWNER);
    expect(doc?.title).toBe('Website proposal');
    await writeDocument(env, 'proposal', DOC, OWNER, { content: { sections: [{ heading: 'New intro' }] } });
    const reread = await readDocument(env, 'proposal', DOC, OWNER);
    expect((reread?.content as any).sections[0].heading).toBe('New intro');
  });

  it('round-trips invoice fields and refuses a foreign owner', async () => {
    const invoice = await readDocument(env, 'invoice', 'inv_1', OWNER);
    expect((invoice?.content as any).currency).toBe('GBP');
    await writeDocument(env, 'invoice', 'inv_1', OWNER, { notes: 'Updated note', total: 750 });
    const reread = await readDocument(env, 'invoice', 'inv_1', OWNER);
    expect((reread?.content as any).notes).toBe('Updated note');
    expect((reread?.content as any).total).toBe(750);
    expect(await readDocument(env, 'invoice', 'inv_1', 'usr_other')).toBeNull();
    expect((await writeDocument(env, 'invoice', 'inv_1', 'usr_other', { notes: 'x' })).ok).toBe(false);
  });
});
