import { tursoQuery, tursoExecute } from '../utils/turso';
import { sha256Hex } from '../utils/crypto';
import { contactEmail, PLACEHOLDER_EMAIL_LIKE, placeholderEmailFor } from '../utils/contact-email';
import type { Bindings } from '../types';

/**
 * Revercue-side identity mapping for AuthAction subjects.
 *
 * AuthAction is the source of truth for authentication. Revercue remains the
 * source of truth for plans, payments, roles and business records. The two are
 * joined through `user_identities`, keyed on the stable AuthAction `sub`.
 *
 * Provisioning is just-in-time and idempotent:
 *  - an existing `(provider, subject)` mapping always wins;
 *  - a brand-new subject gets one deterministic Revercue user id, so concurrent
 *    requests cannot create duplicate users;
 *  - a valid token is enough to create the Revercue user and start onboarding,
 *    whether or not AuthAction has verified the email yet;
 *  - email verification is stored honestly. An unverified email never claims an
 *    existing Revercue account; only a verified AuthAction email may adopt one.
 */

const PROVIDER = 'authaction';

export class IdentityStoreError extends Error {
  constructor(message = 'The identity store is unavailable.') {
    super(message);
    this.name = 'IdentityStoreError';
  }
}

export interface RevercueUser {
  id: string;
  email: string;
  plan: string;
  emailVerified: boolean;
}

export interface UserIdentityRow {
  id: string;
  user_id: string;
  provider: string;
  subject: string;
  email_at_link: string | null;
}

export type ProvisionFailureCode = 'account_conflict' | 'identity_orphaned';

export type ProvisionResult =
  | {
      ok: true;
      user: RevercueUser;
      created: boolean;
      linked_existing: boolean;
    }
  | {
      ok: false;
      code: ProvisionFailureCode;
      message: string;
    };

export interface AuthActionIdentityInput {
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

async function identityQuery(env: Bindings, sql: string, args: unknown[] = []) {
  try {
    return await tursoQuery(env, sql, args as any[]);
  } catch (error: any) {
    console.error('IDENTITY_STORE_QUERY_FAILED', error?.message ?? error);
    throw new IdentityStoreError();
  }
}

async function identityExecute(env: Bindings, sql: string, args: unknown[] = []) {
  try {
    await tursoExecute(env, sql, args as any[]);
  } catch (error: any) {
    console.error('IDENTITY_STORE_WRITE_FAILED', error?.message ?? error);
    throw new IdentityStoreError();
  }
}

function mapUser(row: any): RevercueUser {
  return {
    id: String(row.id),
    email: contactEmail(row.email),
    plan: String(row.plan ?? 'free'),
    emailVerified: Number(row.email_verified) === 1 || row.email_verified === true,
  };
}

export async function findIdentity(
  env: Bindings,
  subject: string
): Promise<UserIdentityRow | null> {
  const result = await identityQuery(
    env,
    `SELECT id, user_id, provider, subject, email_at_link FROM user_identities WHERE provider = ? AND subject = ? LIMIT 1`,
    [PROVIDER, subject]
  );
  return (result.rows[0] as UserIdentityRow) ?? null;
}

export async function getUserById(env: Bindings, userId: string): Promise<RevercueUser | null> {
  const result = await identityQuery(
    env,
    `SELECT id, email, plan, email_verified FROM users WHERE id = ? LIMIT 1`,
    [userId]
  );
  if (result.rows.length === 0) return null;
  return mapUser(result.rows[0]);
}

/**
 * Returns every Revercue user with this email, case-insensitively. This is used
 * only as a verified-email adoption fallback for accounts created before
 * AuthAction identity mapping existed. More than one match is a data ambiguity
 * that must not be resolved by guessing.
 */
export async function findUsersByEmail(env: Bindings, email: string): Promise<RevercueUser[]> {
  const normalized = email.trim().toLowerCase();
  const result = await identityQuery(
    env,
    `SELECT id, email, plan, email_verified FROM users WHERE lower(email) = ? LIMIT 5`,
    [normalized]
  );
  return result.rows.map(mapUser);
}

async function authActionUserId(subject: string): Promise<string> {
  // Deterministic on purpose: concurrent first requests for the same subject
  // target the same primary key, so the users table cannot gain duplicates.
  return `usr_${await sha256Hex(`authaction:${subject}`)}`;
}

async function insertUserIfAbsent(
  env: Bindings,
  input: { id: string; email: string; emailVerified: boolean }
): Promise<boolean> {
  const now = new Date().toISOString();
  // AuthAction does not always release an email, and `users.email` is UNIQUE
  // NOT NULL. Without an email a reserved, non-deliverable placeholder derived
  // from this user's id is stored instead: unique per user, never shown and
  // never emailed. Storing the same empty string for every account would make
  // the second account without an email fail the unique constraint.
  const storedEmail = input.email || placeholderEmailFor(input.id);
  const result = await identityQuery(
    env,
    `INSERT INTO users (id, email, plan, email_verified, onboarding_step, created_at, updated_at)
     VALUES (?, ?, 'free', ?, 1, ?, ?)
     ON CONFLICT(id) DO NOTHING
     RETURNING id`,
    [input.id, storedEmail, input.emailVerified ? 1 : 0, now, now]
  );
  return result.rows.length > 0;
}

async function insertIdentityIfAbsent(
  env: Bindings,
  input: { userId: string; subject: string; email: string | null }
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await identityQuery(
    env,
    `INSERT INTO user_identities (id, user_id, provider, subject, email_at_link, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, subject) DO NOTHING
     RETURNING id`,
    [
      `idn_${await sha256Hex(`authaction:${input.subject}:${input.userId}`)}`,
      input.userId,
      PROVIDER,
      input.subject,
      input.email,
      now,
      now,
    ]
  );
  return result.rows.length > 0;
}

/**
 * Records AuthAction's verification state. This is monotonic: a verified email
 * stays verified, and a missing/false claim never downgrades the stored value.
 */
async function markEmailVerified(env: Bindings, userId: string): Promise<void> {
  await identityExecute(
    env,
    `UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ? AND COALESCE(email_verified, 0) = 0`,
    [new Date().toISOString(), userId]
  );
}

/**
 * Replaces a placeholder address once AuthAction asserts a verified email. It
 * never overwrites an address the user already supplied and never takes over an
 * address another account holds. Failure is non-fatal: the sign-in still
 * succeeds with "no email" and onboarding can collect one.
 */
async function adoptVerifiedEmail(env: Bindings, userId: string, email: string): Promise<void> {
  try {
    await tursoExecute(
      env,
      `UPDATE users SET email = ?, updated_at = ? WHERE id = ? AND (email IS NULL OR trim(email) = '' OR email LIKE ?)`,
      [email, new Date().toISOString(), userId, PLACEHOLDER_EMAIL_LIKE]
    );
  } catch (error) {
    console.error('IDENTITY_EMAIL_ADOPT_FAILED', error);
  }
}

export async function touchIdentityLogin(env: Bindings, subject: string): Promise<void> {
  await tursoExecute(
    env,
    `UPDATE user_identities SET last_login_at = ? WHERE provider = ? AND subject = ?`,
    [new Date().toISOString(), PROVIDER, subject]
  ).catch((error) => console.error('IDENTITY_TOUCH_FAILED', error));
}

/**
 * Establishes or retrieves the Revercue application user for an authenticated
 * AuthAction identity. Safe to call on every authenticated request.
 *
 * Authentication and application identity are keyed on the verified `sub`.
 * Email is contact data, not an authentication key. It is used only to adopt a
 * pre-existing Revercue account when AuthAction explicitly asserts that the
 * email is verified.
 */
export async function resolveOrProvisionUser(
  env: Bindings,
  identity: AuthActionIdentityInput
): Promise<ProvisionResult> {
  const subject = identity.subject.trim();
  if (!subject) {
    return {
      ok: false,
      code: 'identity_orphaned',
      message: 'The authenticated identity has no usable subject.',
    };
  }

  const email = identity.email?.trim().toLowerCase() || null;
  const emailVerified = identity.emailVerified === true && Boolean(email);

  const existingIdentity = await findIdentity(env, subject);
  if (existingIdentity) {
    if (emailVerified) await markEmailVerified(env, existingIdentity.user_id);
    let user = await getUserById(env, existingIdentity.user_id);
    if (!user) {
      return {
        ok: false,
        code: 'identity_orphaned',
        message: 'This sign-in is attached to an application account that no longer exists.',
      };
    }
    if (emailVerified && email && !user.email) {
      await adoptVerifiedEmail(env, user.id, email);
      user = { ...user, email, emailVerified: true };
    }
    return { ok: true, user, created: false, linked_existing: false };
  }

  // Only a claim that AuthAction has verified may be used to match an existing
  // Revercue account. A client-supplied or unverified email is never enough.
  let existingUser: RevercueUser | null = null;
  if (emailVerified && email) {
    const matches = await findUsersByEmail(env, email);
    if (matches.length > 1) {
      return {
        ok: false,
        code: 'account_conflict',
        message:
          'More than one Revercue account uses this email address. Contact support so the accounts can be resolved safely.',
      };
    }
    existingUser = matches[0] ?? null;
  }

  let user: RevercueUser | null = existingUser;
  let created = false;
  let linkedExisting = Boolean(existingUser);

  if (user) {
    await markEmailVerified(env, user.id);
    user = { ...user, emailVerified: true };
  } else {
    const userId = await authActionUserId(subject);
    try {
      created = await insertUserIfAbsent(env, {
        id: userId,
        email: email ?? '',
        emailVerified,
      });
      user = await getUserById(env, userId);
    } catch (error) {
      if (!(error instanceof IdentityStoreError)) throw error;
      // A unique email index can reject a second account for the same address.
      // Adoption is only safe when AuthAction verified that email; an
      // unverified address must never take over another account.
      if (!emailVerified || !email) throw error;
      const raced = await findUsersByEmail(env, email);
      if (raced.length === 1) {
        user = raced[0];
        linkedExisting = true;
        created = false;
      } else if (raced.length > 1) {
        return {
          ok: false,
          code: 'account_conflict',
          message:
            'More than one Revercue account uses this email address. Contact support so the accounts can be resolved safely.',
        };
      } else {
        throw error;
      }
    }
    if (!user) {
      // The deterministic id may already exist because a concurrent request for
      // this same subject won the insert.
      user = await getUserById(env, userId);
    }
    if (!user) {
      const raced = emailVerified && email ? await findUsersByEmail(env, email) : [];
      if (raced.length === 1) {
        user = raced[0];
        linkedExisting = true;
        created = false;
      } else if (raced.length > 1) {
        return {
          ok: false,
          code: 'account_conflict',
          message:
            'More than one Revercue account uses this email address. Contact support so the accounts can be resolved safely.',
        };
      } else {
        throw new IdentityStoreError('The application account could not be created.');
      }
    }
    if (emailVerified) await markEmailVerified(env, user.id);
  }

  const inserted = await insertIdentityIfAbsent(env, {
    userId: user.id,
    subject,
    email,
  });

  // The unique (provider, subject) index is the final concurrency guard. If
  // another request won the race, use that request's mapping.
  const winner = await findIdentity(env, subject);
  if (!winner) throw new IdentityStoreError('The identity mapping could not be read.');
  if (winner.user_id !== user.id) {
    let winnerUser = await getUserById(env, winner.user_id);
    if (!winnerUser) {
      return {
        ok: false,
        code: 'identity_orphaned',
        message: 'This sign-in is attached to an application account that no longer exists.',
      };
    }
    if (emailVerified) await markEmailVerified(env, winnerUser.id);
    if (emailVerified && email && !winnerUser.email) {
      await adoptVerifiedEmail(env, winnerUser.id, email);
      winnerUser = { ...winnerUser, email, emailVerified: true };
    }
    return { ok: true, user: winnerUser, created: false, linked_existing: false };
  }

  return {
    ok: true,
    user,
    created: created && inserted,
    linked_existing: linkedExisting,
  };
}
