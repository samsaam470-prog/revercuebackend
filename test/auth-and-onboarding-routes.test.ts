import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const authState = vi.hoisted(() => ({
  identity: {
    subject: 'authaction|route-user',
    email: 'route@example.com',
    emailVerified: true,
    claims: {},
  } as {
    subject: string;
    email: string | null;
    emailVerified: boolean;
    claims: Record<string, unknown>;
  },
}));

vi.mock('../src/services/authaction', () => ({
  isAuthActionConfigured: () => true,
  looksLikeAuthActionToken: () => true,
  verifyAccessToken: async () => authState.identity,
  AuthActionTokenError: class AuthActionTokenError extends Error {},
  AuthActionConfigError: class AuthActionConfigError extends Error {},
}));

vi.mock('../src/utils/turso', async () => await import('./helpers/fake-turso'));

import authRouter from '../src/routes/auth';
import onboardingRouter from '../src/routes/onboarding';
import { resetFakeTurso, seedUser, tursoState } from './helpers/fake-turso';
import type { Bindings } from '../src/types';

const env = {
  USER_JWT_KEY: 'test-user-key',
  AUTHACTION_ISSUER: 'https://revercue.in.authaction.com',
  AUTHACTION_AUDIENCE: 'revercue-api.samsaam470.workers.dev',
  ALLOW_LEGACY_AUTH: 'false',
} as unknown as Bindings;

const app = new Hono<{ Bindings: Bindings }>();
app.route('/api/auth', authRouter);
app.route('/api/onboarding', onboardingRouter);

function request(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      Authorization: 'Bearer header.payload.signature',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  }, env);
}

async function me() {
  const response = await request('/api/auth/me');
  return { response, body: (await response.json()) as any };
}

beforeEach(() => {
  resetFakeTurso();
  authState.identity = {
    subject: 'authaction|route-user',
    email: 'route@example.com',
    emailVerified: true,
    claims: {},
  };
});

describe('GET /api/auth/me and direct provisioning', () => {
  it('provisions a new authenticated user and reports onboarding', async () => {
    const { response, body } = await me();
    expect(response.status).toBe(200);
    expect(body.authenticated).toBe(true);
    expect(body.user.email).toBe('route@example.com');
    expect(body.user.onboarding_step).toBe(1);
    expect(body.user.onboarding_required).toBe(true);
    expect(body.user.onboarding_complete).toBe(false);
    expect(body.onboarding).toMatchObject({
      required: true,
      complete: false,
      step: 1,
      next_step: 1,
      destination: '/onboarding/step-1',
    });
  });

  it('is idempotent across repeated and concurrent callbacks', async () => {
    tursoState.delayMs = 1;
    const responses = await Promise.all(Array.from({ length: 6 }, () => me()));
    expect(responses.every(({ response }) => response.status === 200)).toBe(true);
    const ids = new Set(responses.map(({ body }) => body.user.id));
    expect(ids.size).toBe(1);
    expect(tursoState.users).toHaveLength(1);
    expect(tursoState.identities).toHaveLength(1);
  });

  it('returns an existing application user and completed onboarding', async () => {
    seedUser({
      id: 'usr_returning',
      email: 'route@example.com',
      plan: 'growth',
      onboarding_step: 6,
    });
    const { response, body } = await me();
    expect(response.status).toBe(200);
    expect(body.user.id).toBe('usr_returning');
    expect(body.user.plan).toBe('growth');
    expect(body.onboarding).toMatchObject({
      required: false,
      complete: true,
      step: 6,
      destination: '/dashboard',
    });
  });

  it('does not use an unverified email to claim an existing account', async () => {
    seedUser({ id: 'usr_existing', email: 'route@example.com' });
    authState.identity.emailVerified = false;
    const { response, body } = await me();
    expect(response.status).toBe(403);
    expect(body.error).toBe('email_verification_required');
    expect(body.error).not.toBe('account_link_required');
    expect(tursoState.identities).toHaveLength(0);
  });

  it('returns a specific 503 when the identity store is unavailable', async () => {
    tursoState.failIdentityRead = true;
    const { response, body } = await me();
    expect(response.status).toBe(503);
    expect(body.error).toBe('identity_store_unavailable');
  });

  it('no longer exposes the account-linking OTP routes', async () => {
    const start = await request('/api/auth/link/start', { method: 'POST', body: '{}' });
    const confirm = await request('/api/auth/link/confirm', { method: 'POST', body: '{}' });
    expect(start.status).toBe(404);
    expect(confirm.status).toBe(404);
  });
});

describe('onboarding endpoints', () => {
  it('validates step 1 and updates only the authenticated user', async () => {
    const own = seedUser({ id: 'usr_own', email: 'route@example.com', onboarding_step: 1 });
    const other = seedUser({ id: 'usr_other', email: 'other@example.com', onboarding_step: 1 });
    tursoState.identities.push({
      id: 'idn_own',
      user_id: own.id,
      provider: 'authaction',
      subject: authState.identity.subject,
      email_at_link: own.email,
      created_at: new Date().toISOString(),
      last_login_at: new Date().toISOString(),
    });

    const invalid = await request('/api/onboarding/step-1', {
      method: 'PATCH',
      body: JSON.stringify({ account_type: 'not-a-type' }),
    });
    expect(invalid.status).toBe(400);

    const valid = await request('/api/onboarding/step-1', {
      method: 'PATCH',
      body: JSON.stringify({ account_type: 'agency' }),
    });
    expect(valid.status).toBe(200);
    expect(tursoState.users.find((user) => user.id === own.id)?.onboarding_step).toBe(2);
    expect(tursoState.users.find((user) => user.id === other.id)?.onboarding_step).toBe(1);
  });

  it('requires Terms acceptance at step 4', async () => {
    seedUser({ id: 'usr_own', email: 'route@example.com', onboarding_step: 3 });
    tursoState.identities.push({
      id: 'idn_own',
      user_id: 'usr_own',
      provider: 'authaction',
      subject: authState.identity.subject,
      email_at_link: 'route@example.com',
      created_at: new Date().toISOString(),
      last_login_at: new Date().toISOString(),
    });

    const missing = await request('/api/onboarding/step-4', {
      method: 'PATCH',
      body: JSON.stringify({ newsletter_opt_in: false }),
    });
    expect(missing.status).toBe(400);

    const valid = await request('/api/onboarding/step-4', {
      method: 'PATCH',
      body: JSON.stringify({ tos_accepted: true, newsletter_opt_in: true }),
    });
    expect(valid.status).toBe(200);
    expect(tursoState.users[0].newsletter_opt_in).toBe('1');
    expect(tursoState.users[0].onboarding_step).toBe(5);
  });

  it('records a waitlist request against the authenticated email and completes onboarding', async () => {
    seedUser({ id: 'usr_own', email: 'route@example.com', onboarding_step: 5 });
    tursoState.identities.push({
      id: 'idn_own',
      user_id: 'usr_own',
      provider: 'authaction',
      subject: authState.identity.subject,
      email_at_link: 'route@example.com',
      created_at: new Date().toISOString(),
      last_login_at: new Date().toISOString(),
    });

    const response = await request('/api/onboarding/step-5', {
      method: 'PATCH',
      body: JSON.stringify({ plan: 'waitlist', plan_requested: 'starter' }),
    });
    expect(response.status).toBe(200);
    expect(tursoState.waitlist[0].email).toBe('route@example.com');
    expect(tursoState.waitlist[0].plan_requested).toBe('starter');
    expect(tursoState.users[0].onboarding_step).toBe(6);
  });

  it('rejects a tutorial update with no boolean state', async () => {
    seedUser({ id: 'usr_own', email: 'route@example.com', onboarding_step: 6 });
    tursoState.identities.push({
      id: 'idn_own',
      user_id: 'usr_own',
      provider: 'authaction',
      subject: authState.identity.subject,
      email_at_link: 'route@example.com',
      created_at: new Date().toISOString(),
      last_login_at: new Date().toISOString(),
    });
    const response = await request('/api/onboarding/tutorial', {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });
});
