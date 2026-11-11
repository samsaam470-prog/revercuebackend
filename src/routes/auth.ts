import { Hono } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import { generateOTP, hashOTP, verifyOTP, otpExpiryISO } from '../utils/otp';
import { sendFormSubmitEmail } from '../services/email';
import { OTP_EXPIRY_MINUTES, OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_SECONDS } from '../config/constants';
import type { Bindings } from '../types';

const auth = new Hono<{ Bindings: Bindings }>();

async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, 10);
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, storedHash);
  } catch {
    return false;
  }
}

async function issueUserToken(userId: string, email: string, plan: string, key: string, exp = '12h'): Promise<string> {
  return await new SignJWT({ sub: userId, email, plan })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(key));
}

async function issuePreAuth(userId: string, email: string, purpose: string, key: string): Promise<string> {
  return await new SignJWT({ sub: userId, email, purpose, pre_auth: true })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(key));
}

async function createSession(env: Bindings, userId: string, jwtId: string): Promise<void> {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
  await tursoExecute(env, `INSERT INTO sessions (id, user_id, jwt_id, created_at, last_active_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`, [generateId('sess'), userId, jwtId, now, now, expires]);
}

auth.post('/signup', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email || !password || password.length < 8 || body.tos_accepted !== true) return c.json({ error: 'invalid_payload' }, 400);
  const exists = await tursoQuery(c.env, `SELECT id FROM users WHERE email = ?`, [email]);
  if (exists.rows.length > 0) return c.json({ error: 'conflict' }, 409);
  const userId = generateId('usr');
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);
  await tursoExecute(c.env, `INSERT INTO users (id, email, password_hash, plan, newsletter_opt_in, newsletter_opt_in_date, onboarding_step, created_at, updated_at) VALUES (?, ?, ?, 'free', ?, ?, 1, ?, ?)`, [userId, email, passwordHash, body.newsletter_opt_in ? 1 : 0, body.newsletter_opt_in ? now : null, now, now]);
  const code = generateOTP();
  await tursoExecute(c.env, `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at) VALUES (?, ?, ?, ?, 'signup', 0, ?, ?, ?)`, [generateId('otp'), userId, email, await hashOTP(code, c.env.USER_JWT_KEY), otpExpiryISO(OTP_EXPIRY_MINUTES), now, now]);
  await sendFormSubmitEmail(c.env, email, 'Your Revercue verification code', { 'Verification code': code, 'Expires in': '5 minutes', 'Note': 'If you have not activated FormSubmit yet, click the activation link first. Then this code will arrive.' });
  return c.json({ success: true, token: await issuePreAuth(userId, email, 'signup', c.env.USER_JWT_KEY), user: { id: userId, email, plan: 'free', onboarding_step: 1, email_verified: false } }, 201);
});

auth.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email || !password) return c.json({ error: 'invalid_payload' }, 400);
  const result = await tursoQuery(c.env, `SELECT * FROM users WHERE email = ?`, [email]);
  if (result.rows.length === 0) return c.json({ error: 'invalid_credentials' }, 401);
  const user = result.rows[0];
  const ok = await verifyPassword(password, user.password_hash ?? '');
  if (!ok) return c.json({ error: 'invalid_credentials' }, 401);
  if (user.two_factor_enabled) {
    const code = generateOTP();
    await tursoExecute(c.env, `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at) VALUES (?, ?, ?, ?, '2fa', 0, ?, ?, ?)`, [generateId('otp'), user.id, user.email, await hashOTP(code, c.env.USER_JWT_KEY), otpExpiryISO(OTP_EXPIRY_MINUTES), new Date().toISOString(), new Date().toISOString()]);
    await sendFormSubmitEmail(c.env, user.email, 'Your Revercue 2FA code', { 'Verification code': code, 'Expires in': '5 minutes' });
    return c.json({ success: true, requires_2fa: true, pre_2fa_token: await issuePreAuth(user.id, user.email, '2fa', c.env.USER_JWT_KEY) });
  }
  const jwtId = generateId('jti');
  const token = await new SignJWT({ sub: user.id, email: user.email, plan: user.plan, jti: jwtId }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('12h').sign(new TextEncoder().encode(c.env.USER_JWT_KEY));
  await createSession(c.env, user.id, jwtId);
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
  const email = String(info.email).trim().toLowerCase();
  let user = (await tursoQuery(c.env, `SELECT * FROM users WHERE email = ?`, [email])).rows[0];
  const now = new Date().toISOString();
  if (!user) {
    const userId = generateId('usr');
    await tursoExecute(c.env, `INSERT INTO users (id, email, google_id, plan, email_verified, onboarding_step, created_at, updated_at) VALUES (?, ?, ?, 'free', 1, 1, ?, ?)`, [userId, email, info.sub ?? null, now, now]);
    await sendFormSubmitEmail(c.env, email, 'Welcome to Revercue', { 'Note': 'You signed up with Google. If you have not activated FormSubmit yet, click the activation link in your inbox.' });
    user = { id: userId, email, plan: 'free', onboarding_step: 1, two_factor_enabled: 0 };
  } else if (!user.google_id) {
    await tursoExecute(c.env, `UPDATE users SET google_id = ?, email_verified = 1, updated_at = ? WHERE id = ?`, [info.sub ?? null, now, user.id]);
  }
  const jwtId = generateId('jti');
  const token = await new SignJWT({ sub: user.id, email: user.email, plan: user.plan, jti: jwtId }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('12h').sign(new TextEncoder().encode(c.env.USER_JWT_KEY));
  await createSession(c.env, user.id, jwtId);
  await tursoExecute(c.env, `UPDATE users SET last_login_at = ? WHERE id = ?`, [now, user.id]);
  return c.json({ success: true, token, user: { id: user.id, email: user.email, plan: user.plan, onboarding_step: user.onboarding_step } });
});

auth.post('/verify-email', async (c) => {
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  let userId: string; let email: string;
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
  const user = await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ?`, [userId]);
  return c.json({ success: true, email_verified: true, token: await issueUserToken(userId, email, user.rows[0]?.plan ?? 'free', c.env.USER_JWT_KEY) });
});

auth.post('/resend-verification', async (c) => {
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  let userId: string; let email: string;
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
  return c.json({ success: true, cooldown_seconds: OTP_RESEND_COOLDOWN_SECONDS });
});

auth.post('/2fa/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let userId: string; let email: string;
  try {
    const { payload } = await jwtVerify(String(body.pre_2fa_token ?? ''), new TextEncoder().encode(c.env.USER_JWT_KEY));
    userId = payload.sub as string; email = payload.email as string;
    if (payload.purpose !== '2fa') return c.json({ error: 'unauthorized' }, 401);
  } catch { return c.json({ error: 'unauthorized' }, 401); }
  const row = await tursoQuery(c.env, `SELECT * FROM otp_codes WHERE user_id = ? AND purpose = '2fa' ORDER BY created_at DESC LIMIT 1`, [userId]);
  if (row.rows.length === 0) return c.json({ error: 'code_expired' }, 400);
  const otp = row.rows[0];
  if (new Date(otp.expires_at).getTime() < Date.now()) return c.json({ error: 'code_expired' }, 400);
  if (Number(otp.attempts) >= OTP_MAX_ATTEMPTS) return c.json({ error: 'too_many_attempts' }, 429);
  if (!(await verifyOTP(String(body.code ?? ''), otp.code_hash, c.env.USER_JWT_KEY))) {
    await tursoExecute(c.env, `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [otp.id]);
    return c.json({ error: 'invalid_code' }, 400);
  }
  await tursoExecute(c.env, `DELETE FROM otp_codes WHERE id = ?`, [otp.id]);
  const user = await tursoQuery(c.env, `SELECT plan, onboarding_step FROM users WHERE id = ?`, [userId]);
  const jwtId = generateId('jti');
  const token = await new SignJWT({ sub: userId, email, plan: user.rows[0]?.plan ?? 'free', jti: jwtId }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('12h').sign(new TextEncoder().encode(c.env.USER_JWT_KEY));
  await createSession(c.env, userId, jwtId);
  await tursoExecute(c.env, `UPDATE users SET last_login_at = ? WHERE id = ?`, [new Date().toISOString(), userId]);
  return c.json({ success: true, token, user: { id: userId, email, plan: user.rows[0]?.plan ?? 'free', onboarding_step: user.rows[0]?.onboarding_step ?? 6 } });
});

auth.post('/2fa/resend', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let userId: string; let email: string;
  try {
    const { payload } = await jwtVerify(String(body.pre_2fa_token ?? ''), new TextEncoder().encode(c.env.USER_JWT_KEY));
    userId = payload.sub as string; email = payload.email as string;
  } catch { return c.json({ error: 'unauthorized' }, 401); }
  const last = await tursoQuery(c.env, `SELECT last_requested_at FROM otp_codes WHERE user_id = ? AND purpose = '2fa' ORDER BY created_at DESC LIMIT 1`, [userId]);
  if (last.rows.length > 0) {
    const elapsed = (Date.now() - new Date(last.rows[0].last_requested_at).getTime()) / 1000;
    if (elapsed < OTP_RESEND_COOLDOWN_SECONDS) return c.json({ error: 'cooldown_active', retry_after: Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - elapsed) }, 429);
  }
  const code = generateOTP();
  await tursoExecute(c.env, `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at) VALUES (?, ?, ?, ?, '2fa', 0, ?, ?, ?)`, [generateId('otp'), userId, email, await hashOTP(code, c.env.USER_JWT_KEY), otpExpiryISO(OTP_EXPIRY_MINUTES), new Date().toISOString(), new Date().toISOString()]);
  await sendFormSubmitEmail(c.env, email, 'Your Revercue 2FA code', { 'Verification code': code, 'Expires in': '5 minutes' });
  return c.json({ success: true, cooldown_seconds: OTP_RESEND_COOLDOWN_SECONDS });
});

auth.post('/password-reset/request', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!email) return c.json({ error: 'invalid_payload' }, 400);
  const user = await tursoQuery(c.env, `SELECT id FROM users WHERE email = ?`, [email]);
  if (user.rows.length === 0) return c.json({ success: true });
  const code = generateOTP();
  await tursoExecute(c.env, `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at) VALUES (?, ?, ?, ?, 'password_reset', 0, ?, ?, ?)`, [generateId('otp'), user.rows[0].id, email, await hashOTP(code, c.env.USER_JWT_KEY), otpExpiryISO(OTP_EXPIRY_MINUTES), new Date().toISOString(), new Date().toISOString()]);
  await sendFormSubmitEmail(c.env, email, 'Reset your Revercue password', { 'Reset code': code, 'Expires in': '5 minutes', 'Note': 'If you have not activated FormSubmit yet, click the activation link first.' });
  return c.json({ success: true });
});

auth.post('/password-reset/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const code = String(body.code ?? '');
  const newPassword = String(body.new_password ?? '');
  if (!email || code.length !== 6 || newPassword.length < 8) return c.json({ error: 'invalid_payload' }, 400);
  const row = await tursoQuery(c.env, `SELECT * FROM otp_codes WHERE email = ? AND purpose = 'password_reset' ORDER BY created_at DESC LIMIT 1`, [email]);
  if (row.rows.length === 0) return c.json({ error: 'code_expired' }, 400);
  const otp = row.rows[0];
  if (new Date(otp.expires_at).getTime() < Date.now()) return c.json({ error: 'code_expired' }, 400);
  if (Number(otp.attempts) >= OTP_MAX_ATTEMPTS) return c.json({ error: 'too_many_attempts' }, 429);
  if (!(await verifyOTP(code, otp.code_hash, c.env.USER_JWT_KEY))) {
    await tursoExecute(c.env, `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [otp.id]);
    return c.json({ error: 'invalid_code' }, 400);
  }
  const passwordHash = await hashPassword(newPassword);
  await tursoExecute(c.env, `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, [passwordHash, new Date().toISOString(), otp.user_id]);
  await tursoExecute(c.env, `DELETE FROM otp_codes WHERE id = ?`, [otp.id]);
  await tursoExecute(c.env, `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [new Date().toISOString(), otp.user_id]);
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
    return c.json({ user: { id: u.id, email: u.email, name: u.name, plan: u.plan, onboarding_step: u.onboarding_step, formsubmit_activated: u.formsubmit_activated, tutorial_completed: u.tutorial_completed, email_verified: u.email_verified, two_factor_enabled: u.two_factor_enabled } });
  } catch { return c.json({ error: 'unauthorized' }, 401); }
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
