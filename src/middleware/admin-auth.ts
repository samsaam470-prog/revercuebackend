import { SignJWT, jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { Bindings } from '../types';

export async function createAdminToken(username: string, jwtKey: string): Promise<string> {
  const secret = new TextEncoder().encode(jwtKey);
  return await new SignJWT({ sub: username, role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(secret);
}

export async function verifyAdminToken(token: string, jwtKey: string): Promise<string | null> {
  try {
    const secret = new TextEncoder().encode(jwtKey);
    const { payload } = await jwtVerify(token, secret);
    if (payload.role !== 'admin') return null;
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export const adminAuthMiddleware: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const jwtKey = c.env.ADMIN_JWT_KEY;
  if (!jwtKey) {
    return c.json({ error: 'config_error', message: 'ADMIN_JWT_KEY not configured.' }, 500);
  }
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) {
    return c.json({ error: 'unauthorized', message: 'Missing bearer token.' }, 401);
  }
  const token = header.slice(7).trim();
  const user = await verifyAdminToken(token, jwtKey);
  if (!user) {
    return c.json({ error: 'unauthorized', message: 'Invalid or expired admin token.' }, 401);
  }
  c.set('admin' as never, user as never);
  await next();
};
