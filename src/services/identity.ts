import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import { generateOTP, hashOTP, otpExpiryISO, verifyOTP } from '../utils/otp';
import { checkRateLimit } from './rate-limit';
import type { Bindings } from '../types';

/**
 * Revercue-side identity mapping for AuthAction subjects.
 *
 * Revercue stays the source of truth for plans, payments, roles and business
 * records. AuthAction is the source of truth for *authentication*. The two are
 * joined through `user_identities`, keyed on the stable AuthAction `sub`.
 *
 * Accounts are never merged on an email match alone: linking an existing
 * Revercue user requires proving control of the mailbox with a one-time code
 * sent to the address. That is what prevents account takeover by an attacker
 * who registers the same email at a different identity provider.
 */

const PROVIDER = 'authaction';
const LINK_CODE_MAX_ATTEMPTS = 3;
const LINK_CODE_EXPIRY_MINUTES = 10;
const LINK_CODE_COOLDOWN_SECONDS = 60;

export function otpSecret(env: Bindings): string {
  return env.OTP_HASH_KEY || env.USER_JWT_KEY;
}

export interface RevercueUser {
  id: string;
  email: string;
  plan: string;
}

export interface UserIdentityRow {
  id: string;
  user_id: string;
  provider: string;
  subject: string;
  email_at_link: string | null;
}

export async function findIdentity(
  env: Bindings,
  subject: string
): Promise<UserIdentityRow | null> {
  const result = await tursoQuery(
    env,
    `SELECT id, user_id, provider, subject, email_at_link FROM user_identities WHERE provider = ? AND subject = ? LIMIT 1`,
    [PROVIDER, subject]
  );
  return (result.rows[0] as UserIdentityRow) ?? null;
}

export async function getUserById(env: Bindings, userId: string): Promise<RevercueUser | null> {
  const result = await tursoQuery(env, `SELECT id, email, plan FROM users WHERE id = ? LIMIT 1`, [userId]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { id: String(row.id), email: String(row.email ?? ''), plan: String(row.plan ?? 'free') };
}

export async function findUserByEmail(env: Bindings, email: string): Promise<RevercueUser | null> {
  const result = await tursoQuery(env, `SELECT id, email, plan FROM users WHERE lower(email) = ? LIMIT 1`, [
    email.trim().toLowerCase(),
  ]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { id: String(row.id), email: String(row.email ?? ''), plan: String(row.plan ?? 'free') };
}

/**
 * Creates a Revercue user for a brand-new AuthAction subject.
 * Deliberately minimal: only columns that exist on the current users table.
 */
export async function createRevercueUser(
  env: Bindings,
  input: { email: string; emailVerified: boolean }
): Promise<string> {
  const userId = generateId('usr');
  const now = new Date().toISOString();
  await tursoExecute(
    env,
    `INSERT INTO users (id, email, plan, email_verified, onboarding_step, created_at, updated_at) VALUES (?, ?, 'free', ?, 1, ?, ?)`,
    [userId, input.email.trim().toLowerCase(), input.emailVerified ? 1 : 0, now, now]
  );
  return userId;
}

export async function linkIdentity(
  env: Bindings,
  input: { userId: string; subject: string; email: string | null }
): Promise<'linked' | 'already_linked'> {
  const now = new Date().toISOString();
  try {
    await tursoExecute(
      env,
      `INSERT INTO user_identities (id, user_id, provider, subject, email_at_link, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [generateId('idn'), input.userId, PROVIDER, input.subject, input.email, now, now]
    );
    return 'linked';
  } catch (error: any) {
    const existing = await findIdentity(env, input.subject);
    if (existing) return existing.user_id === input.userId ? 'already_linked' : 'already_linked';
    throw error;
  }
}

export async function touchIdentityLogin(env: Bindings, subject: string): Promise<void> {
  await tursoExecute(
    env,
    `UPDATE user_identities SET last_login_at = ? WHERE provider = ? AND subject = ?`,
    [new Date().toISOString(), PROVIDER, subject]
  ).catch((error) => console.error('IDENTITY_TOUCH_FAILED', error));
}

export interface LinkCodeStart {
  ok: boolean;
  retryAfter?: number;
  code?: string;
  email?: string;
}

/**
 * Starts an account-link challenge. The code is always emailed to the address
 * being linked, so possession of the mailbox is the proof.
 */
export async function startLinkChallenge(
  env: Bindings,
  input: { subject: string; email: string; ip: string }
): Promise<LinkCodeStart> {
  const email = input.email.trim().toLowerCase();
  const secret = otpSecret(env);

  const limit = await checkRateLimit(env, `link:${input.subject}:${input.ip}`, 3, 3600);
  if (!limit.allowed) return { ok: false, retryAfter: limit.retryAfter };

  const recent = await tursoQuery(
    env,
    `SELECT created_at FROM auth_link_codes WHERE subject = ? AND lower(email) = ? ORDER BY created_at DESC LIMIT 1`,
    [input.subject, email]
  );
  if (recent.rows.length > 0) {
    const elapsed = (Date.now() - new Date(String(recent.rows[0].created_at)).getTime()) / 1000;
    if (elapsed < LINK_CODE_COOLDOWN_SECONDS) {
      return { ok: false, retryAfter: Math.ceil(LINK_CODE_COOLDOWN_SECONDS - elapsed) };
    }
  }

  const code = generateOTP();
  const now = new Date().toISOString();
  await tursoExecute(
    env,
    `INSERT INTO auth_link_codes (id, subject, email, code_hash, attempts, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, 0, ?, NULL, ?)`,
    [generateId('lnk'), input.subject, email, await hashOTP(code, secret), otpExpiryISO(LINK_CODE_EXPIRY_MINUTES), now]
  );
  return { ok: true, code, email };
}

export type LinkConfirmResult =
  | { ok: true; userId: string; created: boolean }
  | { ok: false; reason: 'no_code' | 'expired' | 'too_many_attempts' | 'invalid_code' };

export async function confirmLinkChallenge(
  env: Bindings,
  input: { subject: string; email: string; code: string }
): Promise<LinkConfirmResult> {
  const email = input.email.trim().toLowerCase();
  const result = await tursoQuery(
    env,
    `SELECT * FROM auth_link_codes WHERE subject = ? AND lower(email) = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [input.subject, email]
  );
  if (result.rows.length === 0) return { ok: false, reason: 'no_code' };
  const row = result.rows[0];
  if (new Date(String(row.expires_at)).getTime() < Date.now()) {
    await tursoExecute(env, `DELETE FROM auth_link_codes WHERE id = ?`, [row.id]);
    return { ok: false, reason: 'expired' };
  }
  if (Number(row.attempts) >= LINK_CODE_MAX_ATTEMPTS) {
    return { ok: false, reason: 'too_many_attempts' };
  }
  const valid = await verifyOTP(input.code, String(row.code_hash), otpSecret(env));
  if (!valid) {
    await tursoExecute(env, `UPDATE auth_link_codes SET attempts = attempts + 1 WHERE id = ?`, [row.id]);
    return { ok: false, reason: 'invalid_code' };
  }
  await tursoExecute(env, `UPDATE auth_link_codes SET consumed_at = ? WHERE id = ?`, [
    new Date().toISOString(),
    row.id,
  ]);

  const existingUser = await findUserByEmail(env, email);
  let userId: string;
  let created = false;
  if (existingUser) {
    userId = existingUser.id;
  } else {
    userId = await createRevercueUser(env, { email, emailVerified: true });
    created = true;
  }

  const link = await linkIdentity(env, { userId, subject: input.subject, email });
  if (link === 'already_linked') {
    const identity = await findIdentity(env, input.subject);
    if (identity && identity.user_id !== userId) {
      // Race: another request linked first. Use the winner's mapping.
      return { ok: true, userId: identity.user_id, created: false };
    }
  }
  return { ok: true, userId, created };
}

/** Resolves an AuthAction subject to a Revercue user without creating one. */
export async function resolveSubject(
  env: Bindings,
  subject: string
): Promise<RevercueUser | null> {
  const identity = await findIdentity(env, subject);
  if (!identity) return null;
  return getUserById(env, identity.user_id);
}
