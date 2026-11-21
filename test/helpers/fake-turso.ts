/**
 * Small in-memory stand-in for the Turso HTTP pipeline. It implements only the
 * statements used by identity provisioning and the onboarding routes, including
 * the unique `(provider, subject)` identity constraint. Tests use it to verify
 * idempotency and concurrency without a database or credentials.
 */

export interface FakeUserRow {
  id: string;
  email: string;
  plan: string;
  email_verified: number;
  onboarding_step: number;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface FakeIdentityRow {
  id: string;
  user_id: string;
  provider: string;
  subject: string;
  email_at_link: string;
  created_at: string;
  last_login_at: string;
}

export interface FakeWaitlistRow {
  id: string;
  email: string;
  plan_requested: string;
  source: string;
  status: string;
  created_at: string;
}

export const tursoState = {
  users: [] as FakeUserRow[],
  identities: [] as FakeIdentityRow[],
  waitlist: [] as FakeWaitlistRow[],
  failIdentityRead: false,
  enforceUniqueEmail: false,
  delayMs: 0,
};

export function resetFakeTurso(): void {
  tursoState.users = [];
  tursoState.identities = [];
  tursoState.waitlist = [];
  tursoState.failIdentityRead = false;
  tursoState.enforceUniqueEmail = false;
  tursoState.delayMs = 0;
}

export function seedUser(overrides: Partial<FakeUserRow> = {}): FakeUserRow {
  const now = new Date().toISOString();
  const row: FakeUserRow = {
    id: 'usr_existing',
    email: 'existing@example.com',
    plan: 'free',
    email_verified: 1,
    onboarding_step: 6,
    created_at: now,
    updated_at: now,
    name: null,
    business_name: null,
    ...overrides,
  };
  tursoState.users.push(row);
  return row;
}

function result(rows: Record<string, unknown>[]) {
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { rows, columns };
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

async function wait(): Promise<void> {
  if (tursoState.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, tursoState.delayMs));
  }
}

export async function tursoQuery(
  _env: unknown,
  sql: string,
  args: unknown[] = []
): Promise<{ rows: any[]; columns: string[] }> {
  await wait();
  const statement = normalize(sql);

  if (tursoState.failIdentityRead && statement.includes('user_identities')) {
    throw new Error('SQLite error: no such table: user_identities');
  }

  if (statement.startsWith('SELECT id, user_id, provider, subject, email_at_link FROM user_identities')) {
    const [provider, subject] = args;
    const row = tursoState.identities.find(
      (identity) => identity.provider === provider && identity.subject === subject
    );
    return result(row ? [row as unknown as Record<string, unknown>] : []);
  }

  if (statement.startsWith('SELECT id, email, plan FROM users WHERE lower(email) = ?')) {
    const email = String(args[0] ?? '').toLowerCase();
    return result(
      tursoState.users
        .filter((user) => user.email.toLowerCase() === email)
        .slice(0, 5)
        .map(({ id, email: userEmail, plan }) => ({ id, email: userEmail, plan }))
    );
  }

  if (statement.startsWith('SELECT id, email, plan FROM users WHERE id = ?')) {
    const row = tursoState.users.find((user) => user.id === args[0]);
    return result(row ? [{ id: row.id, email: row.email, plan: row.plan }] : []);
  }

  if (statement.startsWith('SELECT * FROM users WHERE id = ?')) {
    const row = tursoState.users.find((user) => user.id === args[0]);
    return result(row ? [row as unknown as Record<string, unknown>] : []);
  }

  if (statement.startsWith('INSERT INTO users ')) {
    const [id, email, createdAt, updatedAt] = args.map(String);
    if (tursoState.users.some((user) => user.id === id)) return result([]);
    if (
      tursoState.enforceUniqueEmail &&
      tursoState.users.some((user) => user.email.toLowerCase() === email.toLowerCase())
    ) {
      throw new Error('UNIQUE constraint failed: users.email');
    }
    tursoState.users.push({
      id,
      email,
      plan: 'free',
      email_verified: 1,
      onboarding_step: 1,
      created_at: createdAt,
      updated_at: updatedAt,
      name: null,
      business_name: null,
    });
    return result([{ id }]);
  }

  if (statement.startsWith('INSERT INTO user_identities ')) {
    const [id, userId, provider, subject, email] = args.map(String);
    if (
      tursoState.identities.some(
        (identity) => identity.provider === provider && identity.subject === subject
      )
    ) {
      return result([]);
    }
    tursoState.identities.push({
      id,
      user_id: userId,
      provider,
      subject,
      email_at_link: email,
      created_at: new Date().toISOString(),
      last_login_at: new Date().toISOString(),
    });
    return result([{ id }]);
  }

  if (statement.startsWith('UPDATE user_identities SET last_login_at')) {
    const [lastLoginAt, provider, subject] = args.map(String);
    const row = tursoState.identities.find(
      (identity) => identity.provider === provider && identity.subject === subject
    );
    if (row) row.last_login_at = lastLoginAt;
    return result([]);
  }

  if (statement.startsWith('UPDATE users SET email_verified = 1')) {
    const userId = String(args[args.length - 1]);
    const row = tursoState.users.find((user) => user.id === userId);
    if (row) row.email_verified = 1;
    return result([]);
  }

  if (statement.startsWith('UPDATE users SET account_type')) {
    const [accountType, updatedAt, userId] = args.map(String);
    const row = tursoState.users.find((user) => user.id === userId);
    if (row) {
      row.account_type = accountType;
      row.onboarding_step = 2;
      row.updated_at = updatedAt;
    }
    return result([]);
  }

  if (statement.startsWith('UPDATE users SET name = ?')) {
    const values = args.map((value) => String(value ?? ''));
    const userId = values[values.length - 1];
    const row = tursoState.users.find((user) => user.id === userId);
    if (row) {
      row.name = values[0];
      row.business_name = values[1];
      row.onboarding_step = 3;
      row.updated_at = values[values.length - 2];
    }
    return result([]);
  }

  if (statement.startsWith('UPDATE users SET newsletter_opt_in')) {
    const values = args.map((value) => String(value ?? ''));
    const userId = values[values.length - 1];
    const row = tursoState.users.find((user) => user.id === userId);
    if (row) {
      row.newsletter_opt_in = values[0];
      row.onboarding_step = 5;
      row.updated_at = values[values.length - 2];
    }
    return result([]);
  }

  if (statement.startsWith('UPDATE users SET onboarding_step = 6')) {
    const [updatedAt, userId] = args.map(String);
    const row = tursoState.users.find((user) => user.id === userId);
    if (row) {
      row.onboarding_step = 6;
      row.updated_at = updatedAt;
    }
    return result([]);
  }

  if (statement.startsWith('UPDATE users SET tutorial_completed')) {
    const [updatedAt, userId] = args.map(String);
    const row = tursoState.users.find((user) => user.id === userId);
    if (row) {
      row.tutorial_completed = 1;
      row.updated_at = updatedAt;
    }
    return result([]);
  }

  if (statement.startsWith('UPDATE users SET tutorial_skipped')) {
    const [updatedAt, userId] = args.map(String);
    const row = tursoState.users.find((user) => user.id === userId);
    if (row) {
      row.tutorial_skipped = 1;
      row.updated_at = updatedAt;
    }
    return result([]);
  }

  if (statement.startsWith('SELECT id FROM waitlist')) {
    const email = String(args[0] ?? '').toLowerCase();
    const row = tursoState.waitlist.find(
      (entry) => entry.email.toLowerCase() === email && entry.status === 'pending'
    );
    return result(row ? [{ id: row.id }] : []);
  }

  if (statement.startsWith('INSERT INTO waitlist')) {
    const [id, email, planRequested, createdAt] = args.map(String);
    tursoState.waitlist.push({
      id,
      email,
      plan_requested: planRequested,
      source: 'onboarding',
      status: 'pending',
      created_at: createdAt,
    });
    return result([{ id }]);
  }

  throw new Error(`FAKE_TURSO_UNHANDLED: ${statement}`);
}

export async function tursoExecute(
  env: unknown,
  sql: string,
  args: unknown[] = []
): Promise<void> {
  await tursoQuery(env, sql, args);
}
