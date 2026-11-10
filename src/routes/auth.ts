import { Hono } from 'hono';
import { z } from 'zod';
import { SignJWT, jwtVerify } from 'jose';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import { generateOTP, hashOTP, verifyOTP, otpExpiryISO, cooldownISO, MAX_ATTEMPTS, RESEND_COOLDOWN_SECONDS } from '../utils/otp';
import { sendFormSubmitEmail } from '../services/email';
import type { Bindings } from '../types';

const auth = new Hono<{ Bindings: Bindings }>();

function simpleHash(password: string): string {
  // Placeholder hash for MVP. Replace with Argon2/bcrypt in production.
  const data = new TextEncoder().encode(password);
  return Array.from(data).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function issueUserToken(
  userId: string,
  email: string,
  plan: string,
  jwtKey: string,
  expiresIn = '12h'
): Promise<string> {
  const secret = new TextEncoder().encode(jwtKey);
  return await new SignJWT({ sub: userId, email, plan })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

async function issuePreAuthToken(
  userId: string,
  email: string,
  purpose: 'signup' | '2fa' | 'password_reset',
  jwtKey: string
): Promise<string> {
  const secret = new TextEncoder().encode(jwtKey);
  return await new SignJWT({ sub: userId, email, purpose, pre_auth: true })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret);
}

// ---------------------------------------------------------------
// SIGNUP — real OTP, sent via FormSubmit to the user's email.
// The first send triggers the FormSubmit activation email.
// The pending OTP is held by FormSubmit until the user activates.
// ---------------------------------------------------------------
const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  tos_accepted: z.literal(true),
  newsletter_opt_in: z.boolean().default(false),
});

auth.post('/signup', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_payload', details: parsed.error.format() }, 400);
  }
  const { email, password, newsletter_opt_in } = parsed.data;
  const normalized = email.trim().toLowerCase();

  const existing = await tursoQuery(c.env, `SELECT id FROM users WHERE email = ?`, [normalized]);
  if (existing.rows.length > 0) {
    return c.json({ error: 'conflict', message: 'Email already registered.' }, 409);
  }

  const userId = generateId('usr');
  const now = new Date().toISOString();
  await tursoExecute(
    c.env,
    `INSERT INTO users (id, email, password_hash, plan, newsletter_opt_in, newsletter_opt_in_date, onboarding_step, created_at, updated_at)
     VALUES (?, ?, ?, 'free', ?, ?, 1, ?, ?)`,
    [userId, normalized, simpleHash(password), newsletter_opt_in ? 1 : 0, newsletter_opt_in ? now : null, now, now]
  );

  // Real OTP
  const code = generateOTP();
  const codeHash = await hashOTP(code, c.env.USER_JWT_KEY);
  const otpId = generateId('otp');
  const nowIso = new Date().toISOString();
  await tursoExecute(
    c.env,
    `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at)
     VALUES (?, ?, ?, ?, 'signup', 0, ?, ?, ?)`,
    [otpId, userId, normalized, codeHash, otpExpiryISO(), nowIso, nowIso]
  );

  // Send via FormSubmit to the USER's email.
  // First send → FormSubmit sends the activation email to the user.
  // User clicks activation → FormSubmit delivers this OTP.
  await sendFormSubmitEmail(c.env, normalized, 'Your Revercue verification code', {
    'Verification code': code,
    'Expires in': '5 minutes',
    'Note': 'If you have not activated FormSubmit yet, click the activation link first. Then this code will arrive.',
  });

  const preAuthToken = await issuePreAuthToken(userId, normalized, 'signup', c.env.USER_JWT_KEY);
  return c.json({
    success: true,
    token: preAuthToken,
    user: { id: userId, email: normalized, plan: 'free', onboarding_step: 1, email_verified: false },
  }, 201);
});

// ---------------------------------------------------------------
// VERIFY EMAIL — validates the signup OTP.
// ---------------------------------------------------------------
const verifySchema = z.object({ code: z.string().length(6) });

auth.post('/verify-email', async (c) => {
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = header.slice(7).trim();

  let userId: string;
  let email: string;
  try {
    const secret = new TextEncoder().encode(c.env.USER_JWT_KEY);
    const { payload } = await jwtVerify(token, secret);
    userId = payload.sub as string;
    email = payload.email as string;
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_payload' }, 400);

  const row = await tursoQuery(
    c.env,
    `SELECT * FROM otp_codes WHERE user_id = ? AND purpose = 'signup' ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (row.rows.length === 0) return c.json({ error: 'code_expired' }, 400);
  const otp = row.rows[0];

  if (new Date(otp.expires_at).getTime() < Date.now()) {
    await tursoExecute(c.env, `DELETE FROM otp_codes WHERE id = ?`, [otp.id]);
    return c.json({ error: 'code_expired' }, 400);
  }
  if (Number(otp.attempts) >= MAX_ATTEMPTS) {
    return c.json({ error: 'too_many_attempts' }, 429);
  }

  const ok = await verifyOTP(parsed.data.code, otp.code_hash, c.env.USER_JWT_KEY);
  if (!ok) {
    await tursoExecute(c.env, `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [otp.id]);
    return c.json({ error: 'invalid_code', attempts_remaining: MAX_ATTEMPTS - Number(otp.attempts) - 1 }, 400);
  }

  await tursoExecute(c.env, `UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`, [new Date().toISOString(), userId]);
  await tursoExecute(c.env, `DELETE FROM otp_codes WHERE id = ?`, [otp.id]);

  const user = await tursoQuery(c.env, `SELECT plan, onboarding_step FROM users WHERE id = ?`, [userId]);
  const fullToken = await issueUserToken(userId, email, user.rows[0]?.plan ?? 'free', c.env.USER_JWT_KEY);

  return c.json({ success: true, email_verified: true, token: fullToken });
});

// ---------------------------------------------------------------
// RESEND VERIFICATION — 90-second cooldown, real OTP.
// ---------------------------------------------------------------
auth.post('/resend-verification', async (c) => {
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = header.slice(7).trim();

  let userId: string;
  let email: string;
  try {
    const secret = new TextEncoder().encode(c.env.USER_JWT_KEY);
    const { payload } = await jwtVerify(token, secret);
    userId = payload.sub as string;
    email = payload.email as string;
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const last = await tursoQuery(
    c.env,
    `SELECT last_requested_at FROM otp_codes WHERE user_id = ? AND purpose = 'signup' ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (last.rows.length > 0) {
    const lastAt = new Date(last.rows[0].last_requested_at).getTime();
    const elapsed = (Date.now() - lastAt) / 1000;
    if (elapsed < RESEND_COOLDOWN_SECONDS) {
      return c.json({ error: 'cooldown_active', retry_after: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed) }, 429);
    }
  }

  const code = generateOTP();
  const codeHash = await hashOTP(code, c.env.USER_JWT_KEY);
  const otpId = generateId('otp');
  const nowIso = new Date().toISOString();
  await tursoExecute(
    c.env,
    `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at)
     VALUES (?, ?, ?, ?, 'signup', 0, ?, ?, ?)`,
    [otpId, userId, email, codeHash, otpExpiryISO(), nowIso, nowIso]
  );

  await sendFormSubmitEmail(c.env, email, 'Your Revercue verification code', {
    'Verification code': code,
    'Expires in': '5 minutes',
  });

  return c.json({ success: true, cooldown_seconds: RESEND_COOLDOWN_SECONDS });
});

// ---------------------------------------------------------------
// LOGIN — returns requires_2fa if 2FA is on.
// ---------------------------------------------------------------
auth.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email || !password) return c.json({ error: 'invalid_payload' }, 400);

  const result = await tursoQuery(c.env, `SELECT * FROM users WHERE email = ?`, [email]);
  if (result.rows.length === 0) return c.json({ error: 'invalid_credentials' }, 401);
  const user = result.rows[0];
  if (user.password_hash !== simpleHash(password)) return c.json({ error: 'invalid_credentials' }, 401);

  if (user.two_factor_enabled) {
    const code = generateOTP();
    const codeHash = await hashOTP(code, c.env.USER_JWT_KEY);
    const otpId = generateId('otp');
    const nowIso = new Date().toISOString();
    await tursoExecute(
      c.env,
      `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at)
       VALUES (?, ?, ?, ?, '2fa', 0, ?, ?, ?)`,
      [otpId, user.id, user.email, codeHash, otpExpiryISO(), nowIso, nowIso]
    );
    await sendFormSubmitEmail(c.env, user.email, 'Your Revercue 2FA code', {
      'Verification code': code,
      'Expires in': '5 minutes',
      'Note': 'If you have not activated FormSubmit yet, check your inbox for the activation email.',
    });
    const preAuthToken = await issuePreAuthToken(user.id, user.email, '2fa', c.env.USER_JWT_KEY);
    return c.json({ success: true, requires_2fa: true, pre_2fa_token: preAuthToken });
  }

  const token = await issueUserToken(user.id, user.email, user.plan, c.env.USER_JWT_KEY);
  await tursoExecute(c.env, `UPDATE users SET last_login_at = ? WHERE id = ?`, [new Date().toISOString(), user.id]);
  return c.json({
    success: true,
    token,
    user: { id: user.id, email: user.email, plan: user.plan, onboarding_step: user.onboarding_step, two_factor_enabled: false },
  });
});

// ---------------------------------------------------------------
// 2FA VERIFY — real OTP.
// ---------------------------------------------------------------
auth.post('/2fa/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const preAuth = String(body.pre_2fa_token ?? '');
  const code = String(body.code ?? '');
  if (!preAuth || code.length !== 6) return c.json({ error: 'invalid_payload' }, 400);

  let userId: string;
  let email: string;
  try {
    const secret = new TextEncoder().encode(c.env.USER_JWT_KEY);
    const { payload } = await jwtVerify(preAuth, secret);
    userId = payload.sub as string;
    email = payload.email as string;
    if (payload.purpose !== '2fa') return c.json({ error: 'unauthorized' }, 401);
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const row = await tursoQuery(
    c.env,
    `SELECT * FROM otp_codes WHERE user_id = ? AND purpose = '2fa' ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (row.rows.length === 0) return c.json({ error: 'code_expired' }, 400);
  const otp = row.rows[0];
  if (new Date(otp.expires_at).getTime() < Date.now()) return c.json({ error: 'code_expired' }, 400);
  if (Number(otp.attempts) >= MAX_ATTEMPTS) return c.json({ error: 'too_many_attempts' }, 429);

  const ok = await verifyOTP(code, otp.code_hash, c.env.USER_JWT_KEY);
  if (!ok) {
    await tursoExecute(c.env, `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [otp.id]);
    return c.json({ error: 'invalid_code', attempts_remaining: MAX_ATTEMPTS - Number(otp.attempts) - 1 }, 400);
  }

  await tursoExecute(c.env, `DELETE FROM otp_codes WHERE id = ?`, [otp.id]);
  const user = await tursoQuery(c.env, `SELECT plan, onboarding_step FROM users WHERE id = ?`, [userId]);
  const token = await issueUserToken(userId, email, user.rows[0]?.plan ?? 'free', c.env.USER_JWT_KEY);
  await tursoExecute(c.env, `UPDATE users SET last_login_at = ? WHERE id = ?`, [new Date().toISOString(), userId]);
  return c.json({ success: true, token, user: { id: userId, email, plan: user.rows[0]?.plan ?? 'free', onboarding_step: user.rows[0]?.onboarding_step ?? 6 } });
});

// ---------------------------------------------------------------
// 2FA RESEND
// ---------------------------------------------------------------
auth.post('/2fa/resend', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const preAuth = String(body.pre_2fa_token ?? '');
  if (!preAuth) return c.json({ error: 'invalid_payload' }, 400);

  let userId: string;
  let email: string;
  try {
    const secret = new TextEncoder().encode(c.env.USER_JWT_KEY);
    const { payload } = await jwtVerify(preAuth, secret);
    userId = payload.sub as string;
    email = payload.email as string;
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const last = await tursoQuery(
    c.env,
    `SELECT last_requested_at FROM otp_codes WHERE user_id = ? AND purpose = '2fa' ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (last.rows.length > 0) {
    const elapsed = (Date.now() - new Date(last.rows[0].last_requested_at).getTime()) / 1000;
    if (elapsed < RESEND_COOLDOWN_SECONDS) {
      return c.json({ error: 'cooldown_active', retry_after: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed) }, 429);
    }
  }

  const code = generateOTP();
  const codeHash = await hashOTP(code, c.env.USER_JWT_KEY);
  const nowIso = new Date().toISOString();
  await tursoExecute(
    c.env,
    `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at)
     VALUES (?, ?, ?, ?, '2fa', 0, ?, ?, ?)`,
    [generateId('otp'), userId, email, codeHash, otpExpiryISO(), nowIso, nowIso]
  );
  await sendFormSubmitEmail(c.env, email, 'Your Revercue 2FA code', {
    'Verification code': code,
    'Expires in': '5 minutes',
  });
  return c.json({ success: true, cooldown_seconds: RESEND_COOLDOWN_SECONDS });
});

// ---------------------------------------------------------------
// PASSWORD RESET — request + verify (real OTP)
// ---------------------------------------------------------------
auth.post('/password-reset/request', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!email) return c.json({ error: 'invalid_payload' }, 400);

  const user = await tursoQuery(c.env, `SELECT id FROM users WHERE email = ?`, [email]);
  // Always return success (no email-existence leak).
  if (user.rows.length === 0) return c.json({ success: true });

  const userId = user.rows[0].id;
  const code = generateOTP();
  const codeHash = await hashOTP(code, c.env.USER_JWT_KEY);
  const nowIso = new Date().toISOString();
  await tursoExecute(
    c.env,
    `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at)
     VALUES (?, ?, ?, ?, 'password_reset', 0, ?, ?, ?)`,
    [generateId('otp'), userId, email, codeHash, otpExpiryISO(), nowIso, nowIso]
  );
  await sendFormSubmitEmail(c.env, email, 'Reset your Revercue password', {
    'Reset code': code,
    'Expires in': '5 minutes',
    'Note': 'If you have not activated FormSubmit yet, click the activation link first.',
  });
  return c.json({ success: true });
});

auth.post('/password-reset/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const code = String(body.code ?? '');
  const newPassword = String(body.new_password ?? '');
  if (!email || code.length !== 6 || newPassword.length < 8) {
    return c.json({ error: 'invalid_payload' }, 400);
  }

  const row = await tursoQuery(
    c.env,
    `SELECT o.*, u.id as uid FROM otp_codes o JOIN users u ON u.id = o.user_id WHERE o.email = ? AND o.purpose = 'password_reset' ORDER BY o.created_at DESC LIMIT 1`,
    [email]
  );
  if (row.rows.length === 0) return c.json({ error: 'code_expired' }, 400);
  const otp = row.rows[0];
  if (new Date(otp.expires_at).getTime() < Date.now()) return c.json({ error: 'code_expired' }, 400);
  if (Number(otp.attempts) >= MAX_ATTEMPTS) return c.json({ error: 'too_many_attempts' }, 429);

  const ok = await verifyOTP(code, otp.code_hash, c.env.USER_JWT_KEY);
  if (!ok) {
    await tursoExecute(c.env, `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [otp.id]);
    return c.json({ error: 'invalid_code', attempts_remaining: MAX_ATTEMPTS - Number(otp.attempts) - 1 }, 400);
  }

  await tursoExecute(c.env, `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, [simpleHash(newPassword), new Date().toISOString(), otp.user_id]);
  await tursoExecute(c.env, `DELETE FROM otp_codes WHERE id = ?`, [otp.id]);
  return c.json({ success: true });
});

// ---------------------------------------------------------------
// ME + LOGOUT
// ---------------------------------------------------------------
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
    return c.json({ user: { id: u.id, email: u.email, name: u.name, plan: u.plan, onboarding_step: u.onboarding_step, formsubmit_activated: u.formsubmit_activated, tutorial_completed: u.tutorial_completed, email_verified: u.email_verified } });
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }
});

auth.post('/logout', async (c) => {
  return c.json({ success: true });
});

export default auth;
