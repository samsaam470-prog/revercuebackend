import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { Bindings } from '../src/types';

const env = {
  FRONTEND_ORIGIN: 'https://revercue.co.uk',
  ALLOWED_ORIGINS:
    'https://revercue.co.uk,https://revercue.pages.dev,https://www.revercue.co.uk',
  API_BASE_URL: 'https://api.revercue.co.uk',
  AUTHACTION_ISSUER: 'https://revercue.in.authaction.com',
  AUTHACTION_AUDIENCE: 'revercue-api.samsaam470.workers.dev',
  ALLOW_LEGACY_AUTH: 'false',
  DB: {} as D1Database,
} as unknown as Bindings;

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

function call(path: string, init: RequestInit = {}) {
  return (worker as any).fetch(new Request(`https://api.revercue.co.uk${path}`, init), env, ctx);
}

describe('canonical API hostname and CORS', () => {
  it('serves health on https://api.revercue.co.uk', async () => {
    const response = await call('/api/health', {
      headers: { Origin: 'https://revercue.co.uk' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.api_base_url).toBe('https://api.revercue.co.uk');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://revercue.co.uk');
  });

  it('allows preflight from revercue.co.uk with authorization', async () => {
    const response = await call('/api/auth/me', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://revercue.co.uk',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect([200, 204]).toContain(response.status);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://revercue.co.uk');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
  });

  it('allows preflight from revercue.pages.dev', async () => {
    const response = await call('/api/auth/me', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://revercue.pages.dev',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization',
      },
    });
    expect([200, 204]).toContain(response.status);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://revercue.pages.dev');
  });

  it('routes authenticated API requests through the custom hostname', async () => {
    const response = await call('/api/auth/me', {
      headers: { Origin: 'https://revercue.co.uk' },
    });
    expect(response.status).toBe(401);
  });

  it('does not grant CORS to an unknown origin', async () => {
    const response = await call('/api/health', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
