import { jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { Bindings } from '../types';

export interface UserPayload {
  sub: string;
  email: string;
  plan: string;
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
  c.set('user' as never, payload as never);
  await next();
};
