import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { dbFirst } from '../utils/db';
import { userAuthMiddleware, getAuth } from '../middleware/user-auth';
import type { Bindings } from '../types';

const stagingAuth = new Hono<{ Bindings: Bindings }>();

stagingAuth.post('/session', async (c) => {
  if (c.env.ENVIRONMENT !== 'staging') return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!c.env.STAGING_LOGIN_EMAIL || !c.env.STAGING_LOGIN_PASSWORD || !c.env.STAGING_JWT_KEY ||
      email !== c.env.STAGING_LOGIN_EMAIL.toLowerCase() || password !== c.env.STAGING_LOGIN_PASSWORD) {
    return c.json({ error: 'invalid_credentials', message: 'The staging credentials were not accepted.' }, 401);
  }
  const user = await dbFirst<{ id: string; email: string; plan: string; name: string }>(
    c.env, 'SELECT id, email, plan, name FROM staging_users WHERE email = ? LIMIT 1', [email]
  );
  if (!user) return c.json({ error: 'staging_user_missing', message: 'The staging user has not been provisioned.' }, 503);
  const token = await new SignJWT({ email: user.email, plan: user.plan })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setExpirationTime('2h')
    .sign(new TextEncoder().encode(c.env.STAGING_JWT_KEY));
  return c.json({ success: true, token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan, onboarding_step: 5, onboarding_complete: true } });
});

stagingAuth.get('/me', userAuthMiddleware, async (c) => {
  const auth = getAuth(c);
  const user = await dbFirst<any>(c.env, 'SELECT id, email, name, plan FROM staging_users WHERE id = ? LIMIT 1', [auth.userId]);
  if (!user) return c.json({ error: 'not_found' }, 404);
  return c.json({ authenticated: true, user: { ...user, onboarding_step: 5, onboarding_required: false, onboarding_complete: true, tutorial_completed: true } });
});

export default stagingAuth;
