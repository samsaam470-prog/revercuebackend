import { Hono } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import { hashOTP } from '../utils/otp';
import { sendTransactionalEmail } from '../services/email';
import { checkRateLimit } from '../services/rate-limit';
import { userAuthMiddleware, getAuth } from '../middleware/user-auth';
import { getOnboardingState } from '../services/onboarding';
import { contactEmail } from '../utils/contact-email';
import { getActiveTrial } from '../services/trials';
import type { Bindings } from '../types';

/**
 * Authentication lifecycle belongs to AuthAction: sign-up, sign-in, email
 * verification, password reset and second factors all happen there.
 *
 * Revercue keeps only:
 *  - `GET /me` for an AuthAction access token (provisioning + onboarding state),
 *  - `POST /logout` while the legacy session transition is open,
 *  - `POST /login` for pre-existing Revercue password accounts.
 *
 * There is no Revercue signup, OTP, email-verification, 2FA-code or
 * password-reset endpoint. Forgot password is an AuthAction flow. A Revercue
 * user's email is contact data; it is never verified by Revercue.
 */

const auth = new Hono<{ Bindings: Bindings }>();

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try { return await bcrypt.compare(password, storedHash); } catch { return false; }
}

async function issueUserToken(userId: string, email: string, plan: string, key: string, jti?: string): Promise<string> {
  const builder = new SignJWT({ sub: userId, email, plan, ...(jti ? { jti } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('12h');
  return await builder.sign(new TextEncoder().encode(key));
}

async function createSession(env: Bindings, userId: string, jwtId: string, ua?: string | null, ip?: string | null, country?: string | null): Promise<void> {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
  const device = ua ? (ua.includes('Mobile') ? 'Mobile' : 'Desktop') : null;
  const browser = ua ? (ua.includes('Edg') ? 'Edge' : ua.includes('Chrome') ? 'Chrome' : ua.includes('Firefox') ? 'Firefox' : ua.includes('Safari') ? 'Safari' : 'Other') : null;
  const ipHash = ip ? await hashOTP(ip, env.USER_JWT_KEY) : null;
  await tursoExecute(env, `INSERT INTO sessions (id, user_id, jwt_id, device, browser, ip_hash, location, created_at, last_active_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [generateId('sess'), userId, jwtId, device, browser, ipHash, country ?? null, now, now, expires]);
}

auth.post('/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const rl = await checkRateLimit(c.env, `login:${ip}`, 5, 900);
  if (!rl.allowed) return c.json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429);

  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email || !password) return c.json({ error: 'invalid_payload' }, 400);

  // Transition path for Revercue accounts that predate AuthAction. It never
  // sends or checks an email code: unverified accounts are not blocked, and
  // AuthAction remains the only place a code or reset happens.
  const result = await tursoQuery(c.env, `SELECT * FROM users WHERE email = ?`, [email]);
  if (result.rows.length === 0) return c.json({ error: 'invalid_credentials' }, 401);
  const user = result.rows[0];
  if (!user.password_hash) return c.json({ error: 'invalid_credentials' }, 401);
  if (!(await verifyPassword(password, user.password_hash))) return c.json({ error: 'invalid_credentials' }, 401);

  const jti = generateId('jti');
  const token = await issueUserToken(user.id, user.email, user.plan, c.env.USER_JWT_KEY, jti);
  await createSession(c.env, user.id, jti, c.req.header('User-Agent'), c.req.header('CF-Connecting-IP'), c.req.header('CF-IPCountry'));
  await tursoExecute(c.env, `UPDATE users SET last_login_at = ? WHERE id = ?`, [new Date().toISOString(), user.id]);
  return c.json({ success: true, token, user: { id: user.id, email: user.email, plan: user.plan, onboarding_step: user.onboarding_step, two_factor_enabled: !!user.two_factor_enabled } });
});

auth.post('/google', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const idToken = String(body.id_token ?? '');
  if (!idToken) return c.json({ error: 'invalid_payload' }, 400);

  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!res.ok) return c.json({ error: 'invalid_google_token' }, 401);
  const info: any = await res.json();
  if (!info.email || info.email_verified !== 'true') return c.json({ error: 'invalid_google_token' }, 401);
  const googleClientId = (c.env as any).GOOGLE_CLIENT_ID;
  if (googleClientId && info.aud !== googleClientId) return c.json({ error: 'invalid_google_token', message: 'Audience mismatch.' }, 401);

  const email = String(info.email).trim().toLowerCase();
  let user = (await tursoQuery(c.env, `SELECT * FROM users WHERE email = ?`, [email])).rows[0];
  const now = new Date().toISOString();

  if (!user) {
    const userId = generateId('usr');
    await tursoExecute(c.env, `INSERT INTO users (id, email, google_id, plan, email_verified, onboarding_step, created_at, updated_at) VALUES (?, ?, ?, 'free', 1, 1, ?, ?)`, [userId, email, info.sub ?? null, now, now]);
    await sendTransactionalEmail(c.env, email, 'Welcome to Revercue', 'Welcome to Revercue. Your account is ready.', '<p>Welcome to Revercue. Your account is ready.</p>', { 'Note': 'You signed up with Google.' });
    user = { id: userId, email, plan: 'free', onboarding_step: 1, two_factor_enabled: 0, email_verified: 1 };
  } else if (!user.google_id) {
    await tursoExecute(c.env, `UPDATE users SET google_id = ?, email_verified = 1, updated_at = ? WHERE id = ?`, [info.sub ?? null, now, user.id]);
  }

  const jti = generateId('jti');
  const token = await issueUserToken(user.id, user.email, user.plan, c.env.USER_JWT_KEY, jti);
  await createSession(c.env, user.id, jti, c.req.header('User-Agent'), c.req.header('CF-Connecting-IP'), c.req.header('CF-IPCountry'));
  await tursoExecute(c.env, `UPDATE users SET last_login_at = ? WHERE id = ?`, [now, user.id]);
  return c.json({ success: true, token, user: { id: user.id, email: user.email, plan: user.plan, onboarding_step: user.onboarding_step } });
});

/**
 * Current user profile + subscription + onboarding state.
 *
 * Accepts an AuthAction access token (preferred) or a legacy Revercue session
 * token during the transition. For AuthAction callers the shared middleware
 * has already provisioned the Revercue user, so a valid token never produces a
 * generic 500 or an account-linking requirement.
 *
 * `email_missing` is true when AuthAction did not supply an email address. The
 * frontend asks for one during onboarding step 1; Revercue never verifies it.
 */
auth.get('/me', userAuthMiddleware, async (c) => {
  const authCtx = getAuth(c);
  const result = await tursoQuery(c.env, `SELECT * FROM users WHERE id = ? LIMIT 1`, [authCtx.userId]);
  if (result.rows.length === 0) {
    return c.json(
      {
        error: 'application_user_missing',
        message: 'The authenticated application user no longer exists.',
      },
      401
    );
  }
  const u = result.rows[0];
  const accountEmail = contactEmail(u.email);
  const onboarding = getOnboardingState(u);
  // Growth includes fourteen days of Scale access; the app shows the window.
  const trial = await getActiveTrial(c.env, authCtx.userId);
  return c.json({
    authenticated: true,
    user: {
      id: u.id,
      email: accountEmail,
      email_missing: !accountEmail,
      name: u.name,
      plan: u.plan,
      plan_expires_at: u.plan_expires_at ?? null,
      trial,
      onboarding_step: onboarding.step,
      onboarding_required: onboarding.required,
      onboarding_complete: onboarding.complete,
      tutorial_completed: u.tutorial_completed,
      tutorial_skipped: u.tutorial_skipped ?? null,
      email_verified: u.email_verified,
      two_factor_enabled: u.two_factor_enabled,
      account_type: u.account_type ?? null,
      business_name: u.business_name ?? null,
      deletion_requested_at: u.deletion_requested_at ?? null,
      auth: {
        provider: authCtx.via === 'authaction' ? 'authaction' : 'legacy',
      },
    },
    onboarding,
  });
});

auth.post('/logout', async (c) => {
  const header = c.req.header('Authorization') ?? '';
  if (header.startsWith('Bearer ')) {
    try {
      const { payload } = await jwtVerify(header.slice(7).trim(), new TextEncoder().encode(c.env.USER_JWT_KEY));
      const jti = payload.jti as string | undefined;
      if (jti) await tursoExecute(c.env, `UPDATE sessions SET revoked_at = ? WHERE jwt_id = ?`, [new Date().toISOString(), jti]);
    } catch {}
  }
  return c.json({ success: true });
});

export default auth;
