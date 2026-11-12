import { jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import { tursoQuery } from '../utils/turso';
import type { Bindings } from '../types';

export interface UserPayload {
  sub: string;
  email: string;
  plan: string;
  jti?: string;
}

export async function verifyUserToken(token: string, jwtKey: string): Promise<UserPayload | null> {
  try {
    const secret = new TextEncoder().encode(jwtKey);
    const { payload } = await jwtVerify(token, secret);
    if (typeof payload.sub !== 'string') return null;
    return {
      sub: payload.sub,
      email: (payload.email as string) ?? '',
      plan: (payload.plan as string) ?? 'free',
      jti: typeof payload.jti === 'string' ? payload.jti : undefined,
    };
  } catch {
    return null;
  }
}

export const userAuthMiddleware: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const jwtKey = c.env.USER_JWT_KEY;
  if (!jwtKey) {
    return c.json({ error: 'config_error', message: 'USER_JWT_KEY not configured.' }, 500);
  }
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) {
    return c.json({ error: 'unauthorized', message: 'Missing bearer token.' }, 401);
  }
  const token = header.slice(7).trim();
  const payload = await verifyUserToken(token, jwtKey);
  if (!payload) {
    return c.json({ error: 'unauthorized', message: 'Invalid or expired token.' }, 401);
  }

  if (payload.jti) {
    const session = await tursoQuery(
      c.env,
      `SELECT revoked_at, expires_at FROM sessions WHERE jwt_id = ? LIMIT 1`,
      [payload.jti]
    );
    if (session.rows.length === 0) {
      return c.json({ error: 'unauthorized', message: 'Session not found.' }, 401);
    }
    const s = session.rows[0];
    if (s.revoked_at) {
      return c.json({ error: 'unauthorized', message: 'Session revoked.' }, 401);
    }
    if (new Date(s.expires_at).getTime() < Date.now()) {
      return c.json({ error: 'unauthorized', message: 'Session expired.' }, 401);
    }
  }

  c.set('user' as never, payload as never);
  await next();
};
