import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * The test-account service talks to two stores: Turso for the user/session
 * records and D1 for product data. These fakes implement only the statements
 * the feature uses, so the routes, the real auth middleware and the plan
 * switching can be exercised together without credentials.
 */
const turso = vi.hoisted(() => {
  const state = {
    users: [] as any[],
    sessions: [] as any[],
    notifications: [] as any[],
    statements: [] as string[],
  };
  const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

  const query = async (_env: unknown, sql: string, args: any[] = []) => {
    const statement = normalize(sql);
    if (statement.includes('FROM sessions WHERE jwt_id = ?')) {
      const row = state.sessions.find((session) => session.jwt_id === args[0]);
      return {
        rows: row ? [{ revoked_at: null, expires_at: row.expires_at }] : [],
        columns: ['revoked_at', 'expires_at'],
      };
    }
    if (statement.includes('FROM users WHERE id = ?')) {
      const user = state.users.find((candidate) => candidate.id === args[0]);
      if (!user) return { rows: [], columns: [] };
      if (statement.startsWith('SELECT plan')) return { rows: [{ plan: user.plan }], columns: ['plan'] };
      return { rows: [{ ...user }], columns: [] };
    }
    return { rows: [], columns: [] };
  };

  const execute = async (_env: unknown, sql: string, args: any[] = []) => {
    const statement = normalize(sql);
    state.statements.push(statement);

    if (statement.startsWith('INSERT INTO users')) {
      const [id, email, plan, name, businessName] = args;
      const existing = state.users.find((user) => user.id === id);
      if (existing) {
        Object.assign(existing, { email, plan, name, business_name: businessName });
      } else {
        state.users.push({
          id,
          email,
          plan,
          name,
          business_name: businessName,
          onboarding_step: 6,
          email_verified: 1,
          account_type: 'agency',
        });
      }
      return;
    }
    if (statement.startsWith('INSERT INTO sessions')) {
      const [id, userId, jwtId, , , , , , , expiresAt] = args;
      state.sessions.push({ id, user_id: userId, jwt_id: jwtId, expires_at: expiresAt });
      return;
    }
    if (statement.startsWith('INSERT INTO notifications')) {
      state.notifications.push(args);
      return;
    }
    if (statement.startsWith('DELETE FROM users')) {
      state.users = state.users.filter((user) => user.id !== args[0]);
      return;
    }
    if (statement.startsWith('DELETE FROM sessions')) {
      state.sessions = state.sessions.filter((session) => session.user_id !== args[0]);
    }
  };

  return { state, query, execute };
});

const d1 = vi.hoisted(() => {
  const state = { statements: [] as { sql: string; args: any[] }[], counts: {} as Record<string, number> };
  const prepare = (sql: string) => {
    let args: any[] = [];
    const statement = {
      bind(...values: any[]) {
        args = values;
        return statement;
      },
      async all() {
        return { results: [] };
      },
      async first() {
        const match = /COUNT\(\*\) as c FROM ([a-z_]+)/.exec(sql);
        if (match) return { c: state.counts[match[1]] ?? 0 };
        return null;
      },
      async run() {
        state.statements.push({ sql, args });
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement;
  };
  return { state, db: { prepare, batch: async () => [] } };
});

vi.mock('../src/utils/turso', () => ({
  tursoQuery: turso.query,
  tursoExecute: turso.execute,
}));

import testAccountRouter from '../src/routes/test-account';
import authRouter from '../src/routes/auth';
import type { Bindings } from '../src/types';

const app = new Hono<{ Bindings: Bindings }>();
app.route('/api/test-account', testAccountRouter);
app.route('/api/auth', authRouter);

const env = {
  DB: d1.db,
  USER_JWT_KEY: 'test-user-key',
  ALLOW_LEGACY_AUTH: 'true',
  TEST_ACCOUNT_ENABLED: 'true',
  FRONTEND_ORIGIN: 'http://localhost:3000',
} as unknown as Bindings;

function request(path: string, init: RequestInit = {}, requestEnv: Bindings = env) {
  return app.request(
    path,
    {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    },
    requestEnv
  );
}

async function signup(email = 'agent@revercue.test', plan = 'growth') {
  const response = await request('/api/test-account/signup', {
    method: 'POST',
    body: JSON.stringify({ email, plan }),
  });
  return { response, body: (await response.json()) as any };
}

beforeEach(() => {
  turso.state.users = [];
  turso.state.sessions = [];
  turso.state.notifications = [];
  turso.state.statements = [];
  d1.state.statements = [];
  d1.state.counts = {};
});

describe('GET /api/test-account', () => {
  it('reports the sample credentials and plans', async () => {
    const response = await request('/api/test-account');
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body).toMatchObject({
      enabled: true,
      registered: false,
      email: 'agent@revercue.test',
      password: 'ReviewAgent2026!',
      page: '/testaccountforyou',
    });
    expect(body.plans).toEqual(['free', 'starter', 'growth', 'scale', 'teams']);
  });

  it('is removed when TEST_ACCOUNT_ENABLED is false', async () => {
    const response = await request('/api/test-account', {}, {
      ...env,
      TEST_ACCOUNT_ENABLED: 'false',
    } as unknown as Bindings);
    expect(response.status).toBe(404);
    expect(((await response.json()) as any).error).toBe('test_account_disabled');
  });
});

describe('signup and login', () => {
  it('creates the account, seeds the environment and returns a working token', async () => {
    const { response, body } = await signup('agent@revercue.test', 'scale');
    expect(response.status).toBe(201);
    expect(body.credentials).toEqual({
      email: 'agent@revercue.test',
      password: 'ReviewAgent2026!',
    });
    expect(body.user).toMatchObject({
      id: 'usr_testagent0001',
      email: 'agent@revercue.test',
      plan: 'scale',
      onboarding_step: 6,
    });
    expect(body.environment).toMatchObject({
      skipped: false,
      clients: 4,
      proposals: 3,
      contracts: 2,
      forms: 2,
      invoices: 2,
    });

    const sql = d1.state.statements.map((entry) => entry.sql).join('\n');
    expect(sql).toContain('INSERT INTO clients');
    expect(sql).toContain('INSERT INTO proposals');
    expect(sql).toContain('INSERT INTO contracts');
    expect(sql).toContain('INSERT INTO forms');
    expect(sql).toContain('INSERT INTO invoices');

    // The issued token is a real Revercue token: the shared middleware accepts
    // it and `/me` reports the test account's plan and completed onboarding.
    const me = await request('/api/auth/me', {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as any;
    expect(meBody.authenticated).toBe(true);
    expect(meBody.user.id).toBe('usr_testagent0001');
    expect(meBody.user.plan).toBe('scale');
    expect(meBody.user.onboarding_step).toBe(6);
    expect(meBody.onboarding).toMatchObject({ required: false, complete: true });
  });

  it('logs in with the hard-coded password and rejects a wrong one', async () => {
    await signup();

    const good = await request('/api/test-account/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'agent@revercue.test', password: 'ReviewAgent2026!' }),
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({
      success: true,
      credentials: { email: 'agent@revercue.test', password: 'ReviewAgent2026!' },
    });

    const bad = await request('/api/test-account/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'agent@revercue.test', password: 'not-the-password' }),
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as any).error).toBe('invalid_credentials');
  });

  it('provisions the account on first login so the documented credentials always work', async () => {
    const response = await request('/api/test-account/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'agent@revercue.test', password: 'ReviewAgent2026!' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.user).toMatchObject({ id: 'usr_testagent0001', plan: 'growth' });
    expect(turso.state.users).toHaveLength(1);
  });
});

describe('plan switching', () => {
  it('updates the account plan for the signed-in test account', async () => {
    const { body } = await signup('agent@revercue.test', 'free');

    const response = await request('/api/test-account/plan', {
      method: 'POST',
      headers: { Authorization: `Bearer ${body.token}` },
      body: JSON.stringify({ plan: 'teams' }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as any;
    expect(result.plan).toBe('teams');
    expect(turso.state.users[0].plan).toBe('teams');
    expect(
      d1.state.statements.some((entry) => entry.sql.includes('INSERT INTO subscriptions'))
    ).toBe(true);

    const me = await request('/api/auth/me', {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(((await me.json()) as any).user.plan).toBe('teams');
  });

  it('rejects an unknown plan and another account', async () => {
    const { body } = await signup();
    const invalid = await request('/api/test-account/plan', {
      method: 'POST',
      headers: { Authorization: `Bearer ${body.token}` },
      body: JSON.stringify({ plan: 'platinum' }),
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as any).error).toBe('invalid_plan');

    const unauthorized = await request('/api/test-account/plan', {
      method: 'POST',
      body: JSON.stringify({ plan: 'growth' }),
    });
    expect(unauthorized.status).toBe(401);
  });
});

describe('deleting the test account', () => {
  it('deletes the user and every product table it owns', async () => {
    const { body } = await signup();
    const response = await request('/api/test-account', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as any;
    expect(result).toMatchObject({ success: true, deleted: true });
    expect(turso.state.users).toHaveLength(0);

    const deletedTables = d1.state.statements
      .filter((entry) => entry.sql.startsWith('DELETE FROM'))
      .map((entry) => entry.sql);
    for (const table of ['proposals', 'contracts', 'forms', 'invoices', 'clients', 'subscriptions']) {
      expect(deletedTables.some((sql) => sql.includes(`DELETE FROM ${table} `))).toBe(true);
    }

    const info = await request('/api/test-account');
    expect(((await info.json()) as any).registered).toBe(false);
  });
});
