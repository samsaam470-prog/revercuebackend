import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { userAuthMiddleware } from '../src/middleware/user-auth';
import { adminAuthMiddleware } from '../src/middleware/admin-auth';
import type { Bindings } from '../src/types';

const env = {
  USER_JWT_KEY: 'unit-test-user-key',
  ADMIN_JWT_KEY: 'unit-test-admin-key',
  ADMIN_USER: 'admin',
  ADMIN_PASS: 'secret',
  AUTHACTION_ISSUER: 'https://revercue.in.authaction.com',
  AUTHACTION_AUDIENCE: 'revercue-api.samsaam470.workers.dev',
} as unknown as Bindings;

function appWith(middleware: any) {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use('*', middleware);
  app.get('/', (c) => c.json({ ok: true }));
  return app;
}

async function request(app: Hono<{ Bindings: Bindings }>, headers: Record<string, string> = {}) {
  return app.request('/', { headers }, env as any);
}

describe('user authentication middleware', () => {
  it('rejects a request without a bearer token', async () => {
    const response = await request(appWith(userAuthMiddleware));
    expect(response.status).toBe(401);
  });

  it('rejects a malformed bearer token', async () => {
    const response = await request(appWith(userAuthMiddleware), { Authorization: 'Bearer garbage' });
    expect(response.status).toBe(401);
  });

  it('rejects an unsigned JWT (alg=none style payload)', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'user-1', plan: 'teams' })).toString('base64url');
    const token = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${payload}.`;
    const response = await request(appWith(userAuthMiddleware), { Authorization: `Bearer ${token}` });
    expect(response.status).toBe(401);
  });
});

describe('admin authorization middleware', () => {
  it('rejects a request without an admin token', async () => {
    const response = await request(appWith(adminAuthMiddleware));
    expect(response.status).toBe(401);
  });

  it('rejects a user token presented as an admin token', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url');
    const token = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${payload}.signature`;
    const response = await request(appWith(adminAuthMiddleware), { Authorization: `Bearer ${token}` });
    expect(response.status).toBe(401);
  });
});
