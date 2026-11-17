import { Hono } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import { generateOTP, hashOTP, verifyOTP, otpExpiryISO } from '../utils/otp';
import { sendTransactionalEmail } from '../services/email';
import { checkRateLimit } from '../services/rate-limit';
import { OTP_EXPIRY_MINUTES, OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_SECONDS } from '../config/constants';
import { userAuthMiddleware, getAuth } from '../middleware/user-auth';
import { verifyAccessToken, AuthActionTokenError, AuthActionConfigError, isAuthActionConfigured } from '../services/authaction';
import {
  confirmLinkChallenge,
  findIdentity,
  findUserByEmail,
  getUserById,
  startLinkChallenge,
} from '../services/identity';
import { linkCodeEmail } from '../services/email-templates';
import { jsonError } from '../utils/api-errors';
import { clientIp } from '../utils/http';
import type { Bindings } from '../types';

const auth = new Hono<{ Bindings: Bindings }>();

function otpEmailHtml(code: string, contactUrl: string): string {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="margin:0;padding:0;background:#0A0A0A;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;padding:48px 24px;"><tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#141414;border:1px solid #2A2A2A;border-radius:8px;padding:40px;"><tr><td align="center" style="padding-bottom:32px;"><span style="font-family:Georgia,serif;font-size:26px;color:#FFFFFF;">[<span style="color:#C9A961;">R</span>] Revercue</span></td></tr><tr><td align="center" style="padding-bottom:8px;"><span style="font-size:12px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:#C9A961;">YOUR VERIFICATION CODE</span></td></tr><tr><td align="center" style="padding-bottom:24px;"><h1 style="font-family:Georgia,serif;font-size:30px;font-weight:400;color:#FFFFFF;margin:0;line-height:1.2;">Here is your code.</h1></td></tr><tr><td align="center" style="padding-bottom:8px;"><div style="font-family:monospace;font-size:42px;font-weight:600;color:#C9A961;letter-spacing:10px;background:#0A0A0A;border:1px solid #2A2A2A;border-radius:6px;padding:20px 28px;display:inline-block;">' + code + '</div></td></tr><tr><td align="center" style="padding-bottom:32px;"><a href="#" onclick="navigator.clipboard.writeText(\'' + code + '\');return false;" style="display:inline-block;background:#C9A961;color:#0A0A0A;font-size:14px;font-weight:600;padding:10px 24px;border-radius:6px;text-decoration:none;">Copy code</a></td></tr><tr><td align="left" style="padding-bottom:20px;"><p style="font-size:15px;color:#A0A0A0;line-height:1.6;margin:0;">This code is for your Revercue account. It verifies that this email address is yours. Enter it on the page where you requested it.</p></td></tr><tr><td align="left" style="padding-bottom:20px;"><p style="font-size:15px;color:#A0A0A0;line-height:1.6;margin:0;"><strong style="color:#FFFFFF;">This code expires in 5 minutes.</strong> If it expires, you can request a new one.</p></td></tr><tr><td align="left" style="padding-bottom:20px;"><p style="font-size:15px;color:#A0A0A0;line-height:1.6;margin:0;"><strong style="color:#FFFFFF;">This code can only be used once.</strong> After it is used, it is no longer valid.</p></td></tr><tr><td align="left" style="padding-bottom:24px;"><p style="font-size:15px;color:#A0A0A0;line-height:1.6;margin:0;">If you did not request this code, check your account. Someone may be trying to access it. If you did not sign up for Revercue, ignore this email. Your account is safe.</p></td></tr><tr><td align="center" style="padding-bottom:16px;"><a href="' + contactUrl + '" style="display:inline-block;background:transparent;color:#C9A961;font-size:14px;font-weight:600;padding:10px 24px;border:1px solid #C9A961;border-radius:6px;text-decoration:none;">Contact Revercue</a></td></tr><tr><td align="left" style="padding-bottom:24px;"><p style="font-size:14px;color:#A0A0A0;line-height:1.6;margin:0;">If your email provider is blocking the code, contact the provider help team (Google, Outlook, or your provider). The code is not from them, but they can help with the delivery.</p></td></tr><tr><td align="center" style="border-top:1px solid #2A2A2A;padding-top:24px;"><p style="font-size:12px;color:#6B6B6B;margin:0;">Revercue - Your work should speak, not you.</p></td></tr></table></td></tr></table></body></html>';
}

function otpEmailText(code: string, contactUrl: string): string {
  return 'Here is your Revercue verification code: ' + code + '\n\n' +
    'This code is for your Revercue account. It verifies that this email address is yours. Enter it on the page where you requested it.\n\n' +
    'This code expires in 5 minutes. If it expires, you can request a new one.\n\n' +
    'This code can only be used once. After it is used, it is no longer valid.\n\n' +
    'If you did not request this code, check your account. Someone may be trying to access it. If you did not sign up for Revercue, ignore this email. Your account is safe.\n\n' +
    'If you need help, contact Revercue: ' + contactUrl + '\n\n' +
    'If your email provider is blocking the code, contact the provider help team (Google, Outlook, or your provider). The code is not from them, but they can help with the delivery.\n\n' +
    'Revercue - Your work should speak, not you.';
}

async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, 10);
}

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

async function issuePreAuth(userId: string, email: string, purpose: string, key: string): Promise<string> {
  return await new SignJWT({ sub: userId, email, purpose, pre_auth: true })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(key));
}

function otpKey(env: Bindings): string {
  return (env as any).OTP_HASH_KEY || env.USER_JWT_KEY;
}

function contactUrl(env: Bindings): string {
  return (env as any).VITE_CONTACT_URL || 'https://revercue.pages.dev/contact';
}

async function createSession(env: Bindings, userId: string, jwtId: string, ua?: string | null, ip?: string | null, country?: string | null): Promise<void> {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
  const device = ua ? (ua.includes('Mobile') ? 'Mobile' : 'Desktop') : null;
  const browser = ua ? (ua.includes('Edg') ? 'Edge' : ua.includes('Chrome') ? 'Chrome' : ua.includes('Firefox') ? 'Firefox' : ua.includes('Safari') ? 'Safari' : 'Other') : null;
  const ipHash = ip ? await hashOTP(ip, env.USER_JWT_KEY) : null;
  await tursoExecute(env, `INSERT INTO sessions (id, user_id, jwt_id, device, browser, ip_hash, location, created_at, last_active_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [generateId('sess'), userId, jwtId, device, browser, ipHash, country ?? null, now, now, expires]);
}

auth.post('/signup', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const rl = await checkRateLimit(c.env, `signup:${ip}`, 5, 3600);
  if (!rl.allowed) return c.json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429);

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
  const codeHash = await hashOTP(code, otpKey(c.env));
  await tursoExecute(c.env, `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at) VALUES (?, ?, ?, ?, 'signup', 0, ?, ?, ?)`, [generateId('otp'), userId, email, codeHash, otpExpiryISO(OTP_EXPIRY_MINUTES), now, now]);

  const url = contactUrl(c.env);
  await sendTransactionalEmail(c.env, email, 'Your Revercue verification code', otpEmailText(code, url), otpEmailHtml(code, url), { 'Verification code': code, 'Expires in': '5 minutes' });

  return c.json({ success: true, token: await issuePreAuth(userId, email, 'signup', c.env.USER_JWT_KEY), user: { id: userId, email, plan: 'free', onboarding_step: 1, email_verified: false } }, 201);
});

auth.post('/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const rl = await checkRateLimit(c.env, `login:${ip}`, 5, 900);
  if (!rl.allowed) return c.json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429);

  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email || !password) return c.json({ error: 'invalid_payload' }, 400);

  const result = await tursoQuery(c.env, `SELECT * FROM users WHERE email = ?`, [email]);
  if (result.rows.length === 0) return c.json({ error: 'invalid_credentials' }, 401);
  const user = result.rows[0];
  if (!user.password_hash) return c.json({ error: 'invalid_credentials' }, 401);
  if (!(await verifyPassword(password, user.password_hash))) return c.json({ error: 'invalid_credentials' }, 401);

  if (user.email_verified === 0) {
    const code = generateOTP();
    await tursoExecute(c.env, `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at) VALUES (?, ?, ?, ?, 'signup', 0, ?, ?, ?)`, [generateId('otp'), user.id, user.email, await hashOTP(code, otpKey(c.env)), otpExpiryISO(OTP_EXPIRY_MINUTES), new Date().toISOString(), new Date().toISOString()]);
    const url = contactUrl(c.env);
    await sendTransactionalEmail(c.env, user.email, 'Your Revercue verification code', otpEmailText(code, url), otpEmailHtml(code, url), { 'Verification code': code, 'Expires in': '5 minutes' });
    return c.json({ success: true, requires_verification: true, token: await issuePreAuth(user.id, user.email, 'signup', c.env.USER_JWT_KEY) });
  }

  if (user.two_factor_enabled) {
    const code = generateOTP();
    await tursoExecute(c.env, `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at) VALUES (?, ?, ?, ?, '2fa', 0, ?, ?, ?)`, [generateId('otp'), user.id, user.email, await hashOTP(code, otpKey(c.env)), otpExpiryISO(OTP_EXPIRY_MINUTES), new Date().toISOString(), new Date().toISOString()]);
    const url = contactUrl(c.env);
    await sendTransactionalEmail(c.env, user.email, 'Your Revercue 2FA code', otpEmailText(code, url), otpEmailHtml(code, url), { 'Verification code': code, 'Expires in': '5 minutes' });
    return c.json({ success: true, requires_2fa: true, pre_2fa_token: await issuePreAuth(user.id, user.email, '2fa', c.env.USER_JWT_KEY) });
  }

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
  if (new Date(otp.expires_at).getTime() < Date.now()) { await tursoExecute(c.env, `DELETE FROM otp_codes WHERE id = ?`, [otp.id]); return c.json({ error: 'code_expired' }, 400); }
  if (Number(otp.attempts) >= OTP_MAX_ATTEMPTS) return c.json({ error: 'too_many_attempts' }, 429);
  if (!(await verifyOTP(String(body.code ?? ''), otp.code_hash, otpKey(c.env)))) {
    await tursoExecute(c.env, `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [otp.id]);
    return c.json({ error: 'invalid_code', attempts_remaining: OTP_MAX_ATTEMPTS - Number(otp.attempts) - 1 }, 400);
  }
  await tursoExecute(c.env, `UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`, [new Date().toISOString(), userId]);
  await tursoExecute(c.env, `DELETE FROM otp_codes WHERE id = ?`, [otp.id]);

  const user = await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ?`, [userId]);
  const jti = generateId('jti');
  const token = await issueUserToken(userId, email, user.rows[0]?.plan ?? 'free', c.env.USER_JWT_KEY, jti);
  await createSession(c.env, userId, jti, c.req.header('User-Agent'), c.req.header('CF-Connecting-IP'), c.req.header('CF-IPCountry'));
  return c.json({ success: true, email_verified: true, token });
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
  await tursoExecute(c.env, `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at) VALUES (?, ?, ?, ?, 'signup', 0, ?, ?, ?)`, [generateId('otp'), userId, email, await hashOTP(code, otpKey(c.env)), otpExpiryISO(OTP_EXPIRY_MINUTES), new Date().toISOString(), new Date().toISOString()]);
  const url = contactUrl(c.env);
  await sendTransactionalEmail(c.env, email, 'Your Revercue verification code', otpEmailText(code, url), otpEmailHtml(code, url), { 'Verification code': code, 'Expires in': '5 minutes' });
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
  if (new Date(otp.expires_at).getTime() < Date.now()) { await tursoExecute(c.env, `DELETE FROM otp_codes WHERE id = ?`, [otp.id]); return c.json({ error: 'code_expired' }, 400); }
  if (Number(otp.attempts) >= OTP_MAX_ATTEMPTS) return c.json({ error: 'too_many_attempts' }, 429);
  if (!(await verifyOTP(String(body.code ?? ''), otp.code_hash, otpKey(c.env)))) {
    await tursoExecute(c.env, `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [otp.id]);
    return c.json({ error: 'invalid_code', attempts_remaining: OTP_MAX_ATTEMPTS - Number(otp.attempts) - 1 }, 400);
  }
  await tursoExecute(c.env, `DELETE FROM otp_codes WHERE id = ?`, [otp.id]);
  const user = await tursoQuery(c.env, `SELECT plan, onboarding_step FROM users WHERE id = ?`, [userId]);
  const jti = generateId('jti');
  const token = await issueUserToken(userId, email, user.rows[0]?.plan ?? 'free', c.env.USER_JWT_KEY, jti);
  await createSession(c.env, userId, jti, c.req.header('User-Agent'), c.req.header('CF-Connecting-IP'), c.req.header('CF-IPCountry'));
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
  await tursoExecute(c.env, `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at) VALUES (?, ?, ?, ?, '2fa', 0, ?, ?, ?)`, [generateId('otp'), userId, email, await hashOTP(code, otpKey(c.env)), otpExpiryISO(OTP_EXPIRY_MINUTES), new Date().toISOString(), new Date().toISOString()]);
  const url = contactUrl(c.env);
  await sendTransactionalEmail(c.env, email, 'Your Revercue 2FA code', otpEmailText(code, url), otpEmailHtml(code, url), { 'Verification code': code, 'Expires in': '5 minutes' });
  return c.json({ success: true, cooldown_seconds: OTP_RESEND_COOLDOWN_SECONDS });
});

auth.post('/password-reset/request', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const rl = await checkRateLimit(c.env, `pwreset:${ip}`, 3, 3600);
  if (!rl.allowed) return c.json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429);

  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!email) return c.json({ error: 'invalid_payload' }, 400);
  const user = await tursoQuery(c.env, `SELECT id FROM users WHERE email = ?`, [email]);
  if (user.rows.length === 0) return c.json({ success: true });

  const code = generateOTP();
  await tursoExecute(c.env, `INSERT INTO otp_codes (id, user_id, email, code_hash, purpose, attempts, expires_at, last_requested_at, created_at) VALUES (?, ?, ?, ?, 'password_reset', 0, ?, ?, ?)`, [generateId('otp'), user.rows[0].id, email, await hashOTP(code, otpKey(c.env)), otpExpiryISO(OTP_EXPIRY_MINUTES), new Date().toISOString(), new Date().toISOString()]);
  const url = contactUrl(c.env);
  await sendTransactionalEmail(c.env, email, 'Reset your Revercue password', otpEmailText(code, url), otpEmailHtml(code, url), { 'Reset code': code, 'Expires in': '5 minutes' });
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
  if (new Date(otp.expires_at).getTime() < Date.now()) { await tursoExecute(c.env, `DELETE FROM otp_codes WHERE id = ?`, [otp.id]); return c.json({ error: 'code_expired' }, 400); }
  if (Number(otp.attempts) >= OTP_MAX_ATTEMPTS) return c.json({ error: 'too_many_attempts' }, 429);
  if (!(await verifyOTP(code, otp.code_hash, otpKey(c.env)))) {
    await tursoExecute(c.env, `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [otp.id]);
    return c.json({ error: 'invalid_code', attempts_remaining: OTP_MAX_ATTEMPTS - Number(otp.attempts) - 1 }, 400);
  }
  const passwordHash = await hashPassword(newPassword);
  await tursoExecute(c.env, `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, [passwordHash, new Date().toISOString(), otp.user_id]);
  await tursoExecute(c.env, `DELETE FROM otp_codes WHERE id = ?`, [otp.id]);
  await tursoExecute(c.env, `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [new Date().toISOString(), otp.user_id]);
  return c.json({ success: true });
});

/**
 * Current user profile + subscription. Accepts an AuthAction access token
 * (preferred) or a legacy Revercue session token during the transition.
 * If the AuthAction identity is not linked yet the shared middleware answers
 * 401 `account_link_required`, which drives the linking flow below.
 */
auth.get('/me', userAuthMiddleware, async (c) => {
  const authCtx = getAuth(c);
  const result = await tursoQuery(c.env, `SELECT * FROM users WHERE id = ? LIMIT 1`, [authCtx.userId]);
  if (result.rows.length === 0) return c.json({ error: 'unauthorized' }, 401);
  const u = result.rows[0];
  const identity = authCtx.subject ? await findIdentity(c.env, authCtx.subject).catch(() => null) : null;
  return c.json({
    user: {
      id: u.id,
      email: u.email,
      name: u.name,
      plan: u.plan,
      plan_expires_at: u.plan_expires_at ?? null,
      onboarding_step: u.onboarding_step,
      tutorial_completed: u.tutorial_completed,
      tutorial_skipped: u.tutorial_skipped ?? null,
      email_verified: u.email_verified,
      two_factor_enabled: u.two_factor_enabled,
      account_type: u.account_type ?? null,
      business_name: u.business_name ?? null,
      deletion_requested_at: u.deletion_requested_at ?? null,
      auth: {
        provider: authCtx.via === 'authaction' ? 'authaction' : 'legacy',
        linked: authCtx.via === 'authaction' ? Boolean(identity) : Boolean(identity),
      },
    },
  });
});

/**
 * Account linking step 1: email a one-time code to the address being linked.
 * A matching email in Revercue is never enough on its own — the code proves
 * control of the mailbox, so an attacker cannot merge into an existing account
 * by registering the same address at AuthAction.
 */
auth.post('/link/start', async (c) => {
  if (!isAuthActionConfigured(c.env)) {
    return jsonError(c, 500, 'config_error', 'AuthAction is not configured on this deployment.');
  }
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return jsonError(c, 401, 'unauthorized', 'Missing bearer token.');

  let identity;
  try {
    identity = await verifyAccessToken(c.env, header.slice(7).trim());
  } catch (error) {
    if (error instanceof AuthActionTokenError) {
      return jsonError(c, 401, 'unauthorized', error.message, { reason: error.code });
    }
    if (error instanceof AuthActionConfigError) {
      console.error('AUTHACTION_CONFIG_ERROR', error.message);
      return jsonError(c, 500, 'config_error', 'Authentication is temporarily unavailable.');
    }
    throw error;
  }

  const existing = await findIdentity(c.env, identity.subject);
  if (existing) {
    return jsonError(c, 409, 'already_linked', 'This sign-in is already linked to a Revercue account.');
  }

  const body = await c.req.json().catch(() => ({}));
  const requestedEmail = String(body.email ?? identity.email ?? '').trim().toLowerCase();
  if (!requestedEmail) {
    return jsonError(c, 400, 'invalid_payload', 'An email address is required to link the account.');
  }
  if (identity.email && requestedEmail !== identity.email) {
    return jsonError(
      c,
      400,
      'email_mismatch',
      'The email must match the verified address on your AuthAction account.'
    );
  }
  if (identity.email && !identity.emailVerified) {
    return jsonError(
      c,
      403,
      'email_not_verified',
      'Verify your email with AuthAction before linking it to a Revercue account.'
    );
  }

  const challenge = await startLinkChallenge(c.env, {
    subject: identity.subject,
    email: requestedEmail,
    ip: clientIp(c),
  });
  if (!challenge.ok || !challenge.code) {
    return jsonError(c, 429, 'rate_limited', 'A code was sent recently. Try again shortly.', {
      retry_after: challenge.retryAfter ?? 60,
    });
  }

  const rendered = linkCodeEmail({ code: challenge.code, email: requestedEmail });
  const sent = await sendTransactionalEmail(c.env, requestedEmail, rendered.subject, rendered.text, rendered.html);
  const masked = requestedEmail.replace(/^(.)(.*)(@.*)$/, (_m, first, middle, domain) => `${first}${'*'.repeat(Math.min(String(middle).length, 4))}${domain}`);
  return c.json({
    success: true,
    email: masked,
    expires_in: 600,
    email_sent: sent,
    message: sent
      ? 'A confirmation code was sent to that address.'
      : 'The code could not be emailed right now. Try again shortly.',
  });
});

/**
 * Account linking step 2: verify the code and create/link the Revercue user.
 * A brand new address creates a new Revercue account; an existing address is
 * linked only after the code proves ownership.
 */
auth.post('/link/confirm', async (c) => {
  if (!isAuthActionConfigured(c.env)) {
    return jsonError(c, 500, 'config_error', 'AuthAction is not configured on this deployment.');
  }
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return jsonError(c, 401, 'unauthorized', 'Missing bearer token.');

  let identity;
  try {
    identity = await verifyAccessToken(c.env, header.slice(7).trim());
  } catch (error) {
    if (error instanceof AuthActionTokenError) {
      return jsonError(c, 401, 'unauthorized', error.message, { reason: error.code });
    }
    throw error;
  }

  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? identity.email ?? '').trim().toLowerCase();
  const code = String(body.code ?? '').trim();
  if (!email || !/^\d{6}$/.test(code)) {
    return jsonError(c, 400, 'invalid_payload', 'An email address and the 6 digit code are required.');
  }

  const result = await confirmLinkChallenge(c.env, { subject: identity.subject, email, code });
  if (!result.ok) {
    const map: Record<string, [400 | 429, string, string]> = {
      no_code: [400, 'code_expired', 'Request a new code.'],
      expired: [400, 'code_expired', 'That code expired. Request a new one.'],
      too_many_attempts: [429, 'too_many_attempts', 'Too many attempts. Request a new code later.'],
      invalid_code: [400, 'invalid_code', 'That code is not correct.'],
    };
    const [status, error, message] = map[result.reason] ?? [400, 'invalid_code', 'That code is not correct.'];
    return jsonError(c, status, error, message);
  }

  const user = await getUserById(c.env, result.userId);
  return c.json({
    success: true,
    created: result.created,
    user: user ? { id: user.id, email: user.email, plan: user.plan } : null,
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
