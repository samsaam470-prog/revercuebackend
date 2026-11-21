import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/turso', async () => await import('./helpers/fake-turso'));

import {
  IdentityStoreError,
  resolveOrProvisionUser,
} from '../src/services/identity';
import { resetFakeTurso, seedUser, tursoState } from './helpers/fake-turso';
import type { Bindings } from '../src/types';

const env = {} as Bindings;

function identity(overrides: Partial<{ subject: string; email: string | null; emailVerified: boolean }> = {}) {
  return {
    subject: 'authaction|new-user',
    email: 'new@example.com',
    emailVerified: true,
    ...overrides,
  };
}

beforeEach(() => {
  resetFakeTurso();
});

describe('AuthAction provisioning', () => {
  it('creates one Revercue user at onboarding step 1 for a new subject', async () => {
    const result = await resolveOrProvisionUser(env, identity());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.user.email).toBe('new@example.com');
    expect(tursoState.users).toHaveLength(1);
    expect(tursoState.users[0].onboarding_step).toBe(1);
    expect(tursoState.identities).toHaveLength(1);
  });

  it('returns the same user on repeated provisioning and never duplicates rows', async () => {
    const first = await resolveOrProvisionUser(env, identity());
    const second = await resolveOrProvisionUser(env, identity());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.user.id).toBe(first.user.id);
    expect(second.created).toBe(false);
    expect(tursoState.users).toHaveLength(1);
    expect(tursoState.identities).toHaveLength(1);
  });

  it('handles concurrent first requests for the same subject', async () => {
    tursoState.delayMs = 2;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolveOrProvisionUser(env, identity()))
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const ids = new Set(results.map((result) => (result.ok ? result.user.id : null)));
    expect(ids.size).toBe(1);
    expect(tursoState.users).toHaveLength(1);
    expect(tursoState.identities).toHaveLength(1);
  });

  it('adopts an existing Revercue user only when AuthAction verified the email', async () => {
    seedUser({ id: 'usr_existing', email: 'existing@example.com', plan: 'growth', onboarding_step: 6 });
    const result = await resolveOrProvisionUser(
      env,
      identity({ subject: 'authaction|returning', email: 'Existing@Example.com', emailVerified: true })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.id).toBe('usr_existing');
    expect(result.linked_existing).toBe(true);
    expect(result.created).toBe(false);
    expect(tursoState.users).toHaveLength(1);
  });

  it('does not adopt an existing account from an unverified email', async () => {
    seedUser({ id: 'usr_existing', email: 'existing@example.com' });
    const result = await resolveOrProvisionUser(
      env,
      identity({ subject: 'authaction|attacker', email: 'existing@example.com', emailVerified: false })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('email_verification_required');
    expect(tursoState.users).toHaveLength(1);
    expect(tursoState.identities).toHaveLength(0);
  });

  it('does not adopt an account from a missing email', async () => {
    seedUser({ id: 'usr_existing', email: 'existing@example.com' });
    const result = await resolveOrProvisionUser(
      env,
      identity({ subject: 'authaction|no-email', email: null, emailVerified: true })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('email_verification_required');
  });

  it('refuses to guess when multiple Revercue users share a verified email', async () => {
    seedUser({ id: 'usr_one', email: 'duplicate@example.com' });
    seedUser({ id: 'usr_two', email: 'DUPLICATE@example.com' });
    const result = await resolveOrProvisionUser(
      env,
      identity({ subject: 'authaction|ambiguous', email: 'duplicate@example.com', emailVerified: true })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('account_conflict');
    expect(tursoState.identities).toHaveLength(0);
  });

  it('returns the existing user for an established identity', async () => {
    const first = await resolveOrProvisionUser(env, identity());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await resolveOrProvisionUser(
      env,
      identity({ email: 'changed@example.com', emailVerified: true })
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.email).toBe('new@example.com');
  });

  it('reports an orphaned identity instead of creating a replacement silently', async () => {
    tursoState.identities.push({
      id: 'idn_orphan',
      user_id: 'usr_missing',
      provider: 'authaction',
      subject: 'authaction|orphan',
      email_at_link: 'orphan@example.com',
      created_at: new Date().toISOString(),
      last_login_at: new Date().toISOString(),
    });
    const result = await resolveOrProvisionUser(
      env,
      identity({ subject: 'authaction|orphan', email: 'orphan@example.com' })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('identity_orphaned');
    expect(tursoState.users).toHaveLength(0);
  });

  it('adopts the winning user when a unique email races a concurrent insert', async () => {
    tursoState.enforceUniqueEmail = true;
    tursoState.delayMs = 2;
    // Two different AuthAction subjects claim the same verified email. If the
    // users table has a unique email constraint, one insert must lose and the
    // loser must adopt the existing row instead of failing.
    const results = await Promise.all([
      resolveOrProvisionUser(env, identity({ subject: 'authaction|race-a' })),
      resolveOrProvisionUser(env, identity({ subject: 'authaction|race-b' })),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const ids = new Set(results.map((result) => (result.ok ? result.user.id : null)));
    expect(ids.size).toBe(1);
    expect(tursoState.users).toHaveLength(1);
  });

  it('surfaces missing identity tables as an IdentityStoreError', async () => {
    tursoState.failIdentityRead = true;
    await expect(resolveOrProvisionUser(env, identity())).rejects.toBeInstanceOf(IdentityStoreError);
  });
});
