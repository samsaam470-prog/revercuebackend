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
  tokenError: null as null | { code: string; message: string },
}));

vi.mock('../src/services/authaction', () => {
  class AuthActionTokenError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    isAuthActionConfigured: () => true,
    looksLikeAuthActionToken: () => true,
    verifyAccessToken: async () => {
      if (authState.tokenError) {
        throw new AuthActionTokenError(authState.tokenError.code, authState.tokenError.message);
      }
      return authState.identity;
    },
    AuthActionTokenError,
    AuthActionConfigError: class AuthActionConfigError extends Error {},
  };
});

vi.mock('../src/utils/turso', async () => await import('./helpers/fake-turso'));
vi.mock('../src/services/rate-limit', () => ({
  checkRateLimit: async () => ({ allowed: true, remaining: 2, retryAfter: 0 }),
}));
vi.mock('../src/services/email', () => ({
  sendTransactionalEmail: vi.fn(async () => undefined),
}));

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
  authState.tokenError = null;
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
    expect(body.user.email_verified).toBe(1);
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

  it('provisions an unverified new user and allows onboarding', async () => {
    authState.identity.emailVerified = false;
    const { response, body } = await me();
    expect(response.status).toBe(200);
    expect(body.authenticated).toBe(true);
    expect(body.user.email_verified).toBe(0);
    expect(body.user.onboarding_step).toBe(1);
    expect(body.onboarding.destination).toBe('/onboarding/step-1');
    expect(body.error).toBeUndefined();
    expect(tursoState.identities).toHaveLength(1);
  });

  it('does not use an unverified email to claim an existing account', async () => {
    seedUser({ id: 'usr_existing', email: 'route@example.com' });
    authState.identity.emailVerified = false;
    const { response, body } = await me();
    expect(response.status).toBe(200);
    expect(body.user.id).not.toBe('usr_existing');
    expect(body.user.email_verified).toBe(0);
    expect(tursoState.users).toHaveLength(2);
    expect(tursoState.identities[0].user_id).toBe(body.user.id);
  });

  it('retrieves an existing mapped account for an unverified token', async () => {
    seedUser({ id: 'usr_mapped', email: 'route@example.com', email_verified: 0, onboarding_step: 4 });
    tursoState.identities.push({
      id: 'idn_mapped',
      user_id: 'usr_mapped',
      provider: 'authaction',
      subject: authState.identity.subject,
      email_at_link: 'route@example.com',
      created_at: new Date().toISOString(),
      last_login_at: new Date().toISOString(),
    });
    authState.identity.emailVerified = false;
    const { response, body } = await me();
    expect(response.status).toBe(200);
    expect(body.user.id).toBe('usr_mapped');
    expect(body.user.email_verified).toBe(0);
    expect(body.onboarding.step).toBe(4);
  });

  it('updates verification when AuthAction later returns email_verified: true', async () => {
    seedUser({ id: 'usr_mapped', email: 'route@example.com', email_verified: 0, onboarding_step: 2 });
    tursoState.identities.push({
      id: 'idn_mapped',
      user_id: 'usr_mapped',
      provider: 'authaction',
      subject: authState.identity.subject,
      email_at_link: 'route@example.com',
      created_at: new Date().toISOString(),
      last_login_at: new Date().toISOString(),
    });
    const { response, body } = await me();
    expect(response.status).toBe(200);
    expect(body.user.email_verified).toBe(1);
    expect(tursoState.users[0].email_verified).toBe(1);
  });

  it('rejects an invalid token', async () => {
    authState.tokenError = { code: 'bad_signature', message: 'The token signature could not be verified.' };
    const { response, body } = await me();
    expect(response.status).toBe(401);
    expect(body.error).toBe('unauthorized');
    expect(body.details.reason).toBe('bad_signature');
  });

  it('rejects an expired token', async () => {
    authState.tokenError = { code: 'expired', message: 'The access token has expired.' };
    const { response, body } = await me();
    expect(response.status).toBe(401);
    expect(body.error).toBe('unauthorized');
    expect(body.details.reason).toBe('expired');
  });

  it('returns a specific 503 when the identity store is unavailable', async () => {
    tursoState.failIdentityRead = true;
    const { response, body } = await me();
    expect(response.status).toBe(503);
    expect(body.error).toBe('identity_store_unavailable');
  });

  it('no longer exposes Revercue signup, email code, 2FA or password reset routes', async () => {
    // AuthAction owns sign-up, email verification, second factors and password
    // reset. Revercue must not issue its own codes or reset an account.
    const removed = [
      '/api/auth/signup',
      '/api/auth/verify-email',
      '/api/auth/resend-verification',
      '/api/auth/2fa/verify',
      '/api/auth/2fa/resend',
      '/api/auth/password-reset/request',
      '/api/auth/password-reset/verify',
    ];
    for (const path of removed) {
      const response = await app.request(
        path,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        env
      );
      expect(response.status, path).toBe(404);
    }
  });

  it('provisions a user with no email and asks for one during onboarding', async () => {
    authState.identity.email = null;
    authState.identity.emailVerified = false;

    const first = await me();
    expect(first.response.status).toBe(200);
    expect(first.body.user.email).toBe('');
    expect(first.body.user.email_missing).toBe(true);
    expect(first.body.onboarding.destination).toBe('/onboarding/step-1');

    const step = await request('/api/onboarding/step-1', {
      method: 'PATCH',
      body: JSON.stringify({ account_type: 'freelancer', email: 'added@example.com' }),
    });
    expect(step.status).toBe(200);
    expect(tursoState.users[0].email).toBe('added@example.com');
    // Revercue never verifies the address it was given.
    expect(tursoState.users[0].email_verified).toBe(0);

    const second = await me();
    expect(second.body.user.email).toBe('added@example.com');
    expect(second.body.user.email_missing).toBe(false);
  });

  it('does not let onboarding take an email that another account already uses', async () => {
    seedUser({ id: 'usr_taken', email: 'taken@example.com' });
    authState.identity.email = null;
    authState.identity.emailVerified = false;

    const { body } = await me();
    const step = await request('/api/onboarding/step-1', {
      method: 'PATCH',
      body: JSON.stringify({ account_type: 'agency', email: 'taken@example.com' }),
    });
    expect(step.status).toBe(409);
    expect((await step.json() as any).error).toBe('email_in_use');
    const own = tursoState.users.find((user) => user.id === body.user.id);
    expect(own?.email).toBe('');
  });

  it('will not overwrite the email AuthAction already provided', async () => {
    const { body } = await me();
    const step = await request('/api/onboarding/step-1', {
      method: 'PATCH',
      body: JSON.stringify({ account_type: 'freelancer', email: 'other@example.com' }),
    });
    expect(step.status).toBe(200);
    expect(tursoState.users.find((user) => user.id === body.user.id)?.email).toBe('route@example.com');
  });

  it('no longer exposes the account-linking OTP routes', async () => {
    const start = await request('/api/auth/link/start', { method: 'POST', body: '{}' });
    const confirm = await request('/api/auth/link/confirm', { method: 'POST', body: '{}' });
    expect(start.status).toBe(404);
    expect(confirm.status).toBe(404);
  });
});

describe('onboarding endpoints', () => {
  it('allows a newly provisioned unverified user to start onboarding', async () => {
    authState.identity.emailVerified = false;
    const response = await request('/api/onboarding/step-1', {
      method: 'PATCH',
      body: JSON.stringify({ account_type: 'freelancer' }),
    });
    expect(response.status).toBe(200);
    expect(tursoState.users).toHaveLength(1);
    expect(tursoState.users[0].email_verified).toBe(0);
    expect(tursoState.users[0].onboarding_step).toBe(2);
    expect(tursoState.identities).toHaveLength(1);
  });

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

  it('requires an email before joining the waitlist', async () => {
    authState.identity.email = null;
    authState.identity.emailVerified = false;
    const response = await request('/api/onboarding/step-5', {
      method: 'PATCH',
      body: JSON.stringify({ plan: 'waitlist', plan_requested: 'starter' }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as any).error).toBe('email_required');
    expect(tursoState.waitlist).toHaveLength(0);
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
