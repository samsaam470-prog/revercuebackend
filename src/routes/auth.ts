import { Hono } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import { generateOTP, hashOTP, verifyOTP, otpExpiryISO, cooldownISO } from '../utils/otp';
import { sendFormSubmitEmail } from '../services/email';
import { OTP_EXPIRY_MINUTES, OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_SECONDS } from '../config/constants';
import type { Bindings } from '../types';

const auth = new Hono<{ Bindings: Bindings }>();

function simpleHash(p: string): string {
  const data = new TextEncoder().encode(p);
  return Array.from(data).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function issueUserToken(userId: string, email: string, plan: string, key: string, exp = '12h'): Promise<string> {
  return await new SignJWT({ sub: userId, email, plan }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(exp).sign(new TextEncoder().encode(key));
}

async function issuePreAuth(userId: string, email: string, purpose: string, key: string): Promise<string> {
  return await new SignJWT({ sub: userId, email, purpose, pre_auth: true }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('15m').sign(new TextEncoder().encode(key));
}

auth.post('/signup', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email || !password || password.length < 8 || body.tos_accepted !== true) {
    return c.json({ error: 'invalid_payload' }, 400);
  }
  const exists = await tursoQuery(c.env, `SELECT id FROM users WHERE email = ?`, [email]);
  if (exists.rows.length > 0) return c.json({ error: 'conflict' }, 409);

  const userId = generateId('usr');
  const now = new Date().toISOString();
  await tursoExecute(c.env, `INSERT INTO users (id, email, password_hash, plan, newsletter_opt_in, newsletter_opt_in_date, onboarding_step, created_at, updated_at) VALUES (?, ?, ?, 'free', ?, ?, 1, ?, ?)`, [userId, email, simpleHash(password), body.newsletter_opt_in ? 1 : 0, body.newsletter_opt_in ? now : null, now, now]);

  const code = generateOTP();
  const codeHash = await hashOTP(code, c.env.USER_JWT_KEY);
  await tursoExecute(c.env, `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at) VALUES (?, ?, ?, ?, 'signup', 0, ?, ?, ?)`, [generateId('otp'), userId, email, codeHash, otpExpiryISO(OTP_EXPIRY_MINUTES), now, now]);
  await sendFormSubmitEmail(c.env, email, 'Your Revercue verification code', { 'Verification code': code, 'Expires in': '5 minutes', 'Note': 'Activate the FormSubmit link first if you have not.' });

  return c.json({ success: true, token: await issuePreAuth(userId, email, 'signup', c.env.USER_JWT_KEY), user: { id: userId, email, plan: 'free', onboarding_step: 1, email_verified: false } }, 201);
});

auth.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const result = await tursoQuery(c.env, `SELECT * FROM users WHERE email = ?`, [email]);
  if (result.rows.length === 0) return c.json({ error: 'invalid_credentials' }, 401);
  const user = result.rows[0];
  if (user.password_hash !== simpleHash(password)) return c.json({ error: 'invalid_credentials' }, 401);
  if (user.two_factor_enabled) {
    const code = generateOTP();
    await tursoExecute(c.env, `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at) VALUES (?, ?, ?, ?, '2fa', 0, ?, ?, ?)`, [generateId('otp'), user.id, user.email, await hashOTP(code, c.env.USER_JWT_KEY), otpExpiryISO(OTP_EXPIRY_MINUTES), new Date().toISOString(), new Date().toISOString()]);
    await sendFormSubmitEmail(c.env, user.email, 'Your Revercue 2FA code', { 'Verification code': code, 'Expires in': '5 minutes' });
    return c.json({ success: true, requires_2fa: true, pre_2fa_token: await issuePreAuth(user.id, user.email, '2fa', c.env.USER_JWT_KEY) });
  }
  await tursoExecute(c.env, `UPDATE users SET last_login_at = ? WHERE id = ?`, [new Date().toISOString(), user.id]);
  return c.json({ success: true, token: await issueUserToken(user.id, user.email, user.plan, c.env.USER_JWT_KEY), user: { id: user.id, email: user.email, plan: user.plan, onboarding_step: user.onboarding_step } });
});

auth.post('/verify-email', async (c) => {
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  let userId: string, email: string;
  try {
    const { payload } = await jwtVerify(header.slice(7).trim(), new TextEncoder().encode(c.env.USER_JWT_KEY));
    userId = payload.sub as string; email = payload.email as string;
  } catch { return c.json({ error: 'unauthorized' }, 401); }
  const row = await tursoQuery(c.env, `SELECT * FROM otp_codes WHERE user_id = ? AND purpose = 'signup' ORDER BY created_at DESC LIMIT 1`, [userId]);
  if (row.rows.length === 0) return c.json({ error: 'code_expired' }, 400);
  const otp = row.rows[0];
  if (new Date(otp.expires_at).getTime() < Date.now()) return c.json({ error: 'code_expired' }, 400);
  if (Number(otp.attempts) >= OTP_MAX_ATTEMPTS) return c.json({ error: 'too_many_attempts' }, 429);
  if (!(await verifyOTP(String(body.code ?? ''), otp.code_hash, c.env.USER_JWT_KEY))) {
    await tursoExecute(c.env, `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [otp.id]);
    return c.json({ error: 'invalid_code' }, 400);
  }
  await tursoExecute(c.env, `UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`, [new Date().toISOString(), userId]);
  await tursoExecute(c.env, `DELETE FROM otp_codes WHERE id = ?`, [otp.id]);
  const user = await tursoQuery(c.env, `SELECT plan, onboarding_step FROM users WHERE id = ?`, [userId]);
  return c.json({ success: true, email_verified: true, token: await issueUserToken(userId, email, user.rows[0]?.plan ?? 'free', c.env.USER_JWT_KEY) });
});

auth.post('/resend-verification', async (c) => {
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  let userId: string, email: string;
  try {
    const { payload } = await jwtVerify(header.slice(7).trim(), new TextEncoder().encode(c.env.USER_JWT_KEY));
    userId = payload.sub as string; email = payload.email as string;
  } catch { return c.json({ error: 'unauthorized' }, 401); }
  const last = await tursoQuery(c.env, `SELECT last_requested_at FROM otp_codes WHERE user_id = ? AND purpose = 'signup' ORDER BY created_at DESC LIMIT 1`, [userId]);
  if (last.rows.length > 0) {
    const elapsed = (Date.now() - new Date(last.rows[0].last_requested_at).getTime()) / 1000;
    if (elapsed < OTP_RESEND_COOLDOWN_SECONDS) return c.json({ error: 'cooldown_active', retry_after: Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - elapsed) }, 429);
  }
  const code = generateOTP();
  await tursoExecute(c.env, `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at) VALUES (?, ?, ?, ?, 'signup', 0, ?, ?, ?)`, [generateId('otp'), userId, email, await hashOTP(code, c.env.USER_JWT_KEY), otpExpiryISO(OTP_EXPIRY_MINUTES), new Date().toISOString(), new Date().toISOString()]);
  await sendFormSubmitEmail(c.env, email, 'Your Revercue verification code', { 'Verification code': code, 'Expires in': '5 minutes' });
  return c.json({ success: true });
});

auth.post('/2fa/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let userId: string, email: string;
  try {
    const { payload } = await jwtVerify(String(body.pre_2fa_token ?? ''), new TextEncoder().encode(c.env.USER_JWT_KEY));
    userId = payload.sub as string; email = payload.email as string;
    if (payload.purpose !== '2fa') return c.json({ error: 'unauthorized' }, 401);
  } catch { return c.json({ error: 'unauthorized' }, 401); }
  const row = await tursoQuery(c.env, `SELECT * FROM otp_codes WHERE user_id = ? AND purpose = '2fa' ORDER BY created_at DESC LIMIT 1`, [userId]);
  if (row.rows.length === 0) return c.json({ error: 'code_expired' }, 400);
  const otp = row.rows[0];
  if (new Date(otp.expires_at).getTime() < Date.now()) return c.json({ error: 'code_expired' }, 400);
  if (!(await verifyOTP(String(body.code ?? ''), otp.code_hash, c.env.USER_JWT_KEY))) {
    await tursoExecute(c.env, `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [otp.id]);
    return c.json({ error: 'invalid_code' }, 400);
  }
  await tursoExecute(c.env, `DELETE FROM otp_codes WHERE id = ?`, [otp.id]);
  const user = await tursoQuery(c.env, `SELECT plan, onboarding_step FROM users WHERE id = ?`, [userId]);
  await tursoExecute(c.env, `UPDATE users SET last_login_at = ? WHERE id = ?`, [new Date().toISOString(), userId]);
  return c.json({ success: true, token: await issueUserToken(userId, email, user.rows[0]?.plan ?? 'free', c.env.USER_JWT_KEY), user: { id: userId, email, plan: user.rows[0]?.plan ?? 'free', onboarding_step: user.rows[0]?.onboarding_step ?? 6 } });
});

auth.post('/password-reset/request', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const user = await tursoQuery(c.env, `SELECT id FROM users WHERE email = ?`, [email]);
  if (user.rows.length === 0) return c.json({ success: true });
  const code = generateOTP();
  await tursoExecute(c.env, `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at) VALUES (?, ?, ?, ?, 'password_reset', 0, ?, ?, ?)`, [generateId('otp'), user.rows[0].id, email, await hashOTP(code, c.env.USER_JWT_KEY), otpExpiryISO(OTP_EXPIRY_MINUTES), new Date().toISOString(), new Date().toISOString()]);
  await sendFormSubmitEmail(c.env, email, 'Reset your Revercue password', { 'Reset code': code, 'Expires in': '5 minutes' });
  return c.json({ success: true });
});

auth.post('/password-reset/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const row = await tursoQuery(c.env, `SELECT * FROM otp_codes WHERE email = ? AND purpose = 'password_reset' ORDER BY created_at DESC LIMIT 1`, [email]);
  if (row.rows.length === 0) return c.json({ error: 'code_expired' }, 400);
  const otp = row.rows[0];
  if (new Date(otp.expires_at).getTime() < Date.now()) return c.json({ error: 'code_expired' }, 400);
  if (!(await verifyOTP(String(body.code ?? ''), otp.code_hash, c.env.USER_JWT_KEY))) return c.json({ error: 'invalid_code' }, 400);
  await tursoExecute(c.env, `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, [simpleHash(String(body.new_password ?? '')), new Date().toISOString(), otp.user_id]);
  await tursoExecute(c.env, `DELETE FROM otp_codes WHERE id = ?`, [otp.id]);
  return c.json({ success: true });
});

auth.get('/me', async (c) => {
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  try {
    const { payload } = await jwtVerify(header.slice(7).trim(), new TextEncoder().encode(c.env.USER_JWT_KEY));
    const result = await tursoQuery(c.env, `SELECT * FROM users WHERE id = ?`, [payload.sub as string]);
    if (result.rows.length === 0) return c.json({ error: 'unauthorized' }, 401);
    const u = result.rows[0];
    return c.json({ user: { id: u.id, email: u.email, name: u.name, plan: u.plan, onboarding_step: u.onboarding_step, formsubmit_activated: u.formsubmit_activated, tutorial_completed: u.tutorial_completed, email_verified: u.email_verified } });
  } catch { return c.json({ error: 'unauthorized' }, 401); }
});

auth.post('/logout', async (c) => c.json({ success: true }));

export default auth;
