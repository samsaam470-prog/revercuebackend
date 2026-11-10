import { Hono } from 'hono';
import { z } from 'zod';
import { SignJWT, jwtVerify } from 'jose';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import { sendFormSubmitEmail } from '../services/email';
import type { Bindings } from '../types';

const auth = new Hono<{ Bindings: Bindings }>();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  tos_accepted: z.literal(true),
  newsletter_opt_in: z.boolean().default(false),
});

function hashPassword(password: string): string {
  const data = new TextEncoder().encode(password);
  return Array.from(data).map((b) => b.toString(16).padStart(2, '0')).join('');
}

auth.post('/signup', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_payload', details: parsed.error.format() }, 400);
  }
  const { email, password, newsletter_opt_in } = parsed.data;

  const existing = await tursoQuery(c.env, `SELECT id FROM users WHERE email = ?`, [email]);
  if (existing.rows.length > 0) {
    return c.json({ error: 'conflict', message: 'Email already registered.' }, 409);
  }

  const id = generateId('usr');
  const now = new Date().toISOString();
  await tursoExecute(
    c.env,
    `INSERT INTO users (id, email, password_hash, plan, newsletter_opt_in, newsletter_opt_in_date, onboarding_step, created_at, updated_at)
     VALUES (?, ?, ?, 'free', ?, ?, 1, ?, ?)`,
    [id, email, hashPassword(password), newsletter_opt_in ? 1 : 0, newsletter_opt_in ? now : null, now, now]
  );

  const secret = new TextEncoder().encode(c.env.USER_JWT_KEY);
  const token = await new SignJWT({ sub: id, email, plan: 'free' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(secret);

  await sendFormSubmitEmail(c.env, email, 'Verify your Revercue account', {
    'Verification code': '123456',
    'Note': 'Activate FormSubmit first if you have not. This is a test code.',
  });

  return c.json({ success: true, token, user: { id, email, plan: 'free', onboarding_step: 1 } }, 201);
});

auth.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email || !password) {
    return c.json({ error: 'invalid_payload' }, 400);
  }
  const result = await tursoQuery(c.env, `SELECT * FROM users WHERE email = ?`, [email]);
  if (result.rows.length === 0) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  const user = result.rows[0];
  if (user.password_hash !== hashPassword(password)) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  const secret = new TextEncoder().encode(c.env.USER_JWT_KEY);
  const token = await new SignJWT({ sub: user.id, email: user.email, plan: user.plan })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(secret);

  await tursoExecute(c.env, `UPDATE users SET last_login_at = ? WHERE id = ?`, [new Date().toISOString(), user.id]);

  return c.json({ success: true, token, user: { id: user.id, email: user.email, plan: user.plan, onboarding_step: user.onboarding_step, two_factor_enabled: user.two_factor_enabled } });
});

auth.get('/me', async (c) => {
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = header.slice(7).trim();
  try {
    const secret = new TextEncoder().encode(c.env.USER_JWT_KEY);
    const { payload } = await jwtVerify(token, secret);
    const userId = payload.sub as string;
    const result = await tursoQuery(c.env, `SELECT * FROM users WHERE id = ?`, [userId]);
    if (result.rows.length === 0) return c.json({ error: 'unauthorized' }, 401);
    const u = result.rows[0];
    return c.json({ user: { id: u.id, email: u.email, name: u.name, plan: u.plan, onboarding_step: u.onboarding_step, formsubmit_activated: u.formsubmit_activated, tutorial_completed: u.tutorial_completed } });
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }
});

auth.post('/logout', async (c) => {
  return c.json({ success: true });
});

export default auth;
