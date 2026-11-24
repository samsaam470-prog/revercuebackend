import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import { userAuthMiddleware, getAuth } from '../middleware/user-auth';
import { PLANS } from '../config/constants';
import {
  TEST_ACCOUNT_ID,
  TestAccountError,
  deleteTestAccount,
  ensureTestAccount,
  getTestAccount,
  isPlan,
  isTestAccountEnabled,
  seedTestEnvironment,
  testAccountLoginEmail,
  testAccountPassword,
  type TestAccountUser,
} from '../services/test-account';
import type { Bindings } from '../types';

/**
 * Review-environment account endpoints. Nothing here is part of AuthAction:
 * the account exists so an automated agent can enter the product, switch plans
 * and inspect seeded data without a hosted login.
 *
 * Mounted at /api/test-account. `TEST_ACCOUNT_ENABLED=false` removes it.
 */

const testAccount = new Hono<{ Bindings: Bindings }>();

testAccount.use('*', async (c, next) => {
  if (!isTestAccountEnabled(c.env)) {
    return c.json(
      {
        error: 'test_account_disabled',
        message: 'The test account is disabled on this deployment (TEST_ACCOUNT_ENABLED=false).',
      },
      404
    );
  }
  await next();
});

function sessionPayload(user: TestAccountUser) {
  return {
    id: user.id,
    email: user.email,
    plan: user.plan,
    name: user.name ?? null,
    business_name: user.business_name ?? null,
    onboarding_step: Number(user.onboarding_step ?? 6),
    onboarding_complete: Number(user.onboarding_step ?? 6) >= 6,
  };
}

async function issueToken(env: Bindings, user: TestAccountUser): Promise<string> {
  if (!env.USER_JWT_KEY) {
    throw new TestAccountError(503, 'config_error', 'USER_JWT_KEY is not configured.');
  }
  if (String(env.ALLOW_LEGACY_AUTH ?? 'true').toLowerCase() === 'false') {
    throw new TestAccountError(
      503,
      'legacy_auth_disabled',
      'The test account signs in with the legacy app token, which ALLOW_LEGACY_AUTH=false has disabled.'
    );
  }

  let jti: string | undefined = generateId('jti');
  const now = new Date();
  const expires = new Date(now.getTime() + 12 * 3600 * 1000).toISOString();
  try {
    await tursoExecute(
      env,
      `INSERT INTO sessions (id, user_id, jwt_id, device, browser, ip_hash, location, created_at, last_active_at, expires_at)
       VALUES (?, ?, ?, 'Desktop', 'Test Agent', NULL, 'Test account', ?, ?, ?)`,
      [generateId('sess'), user.id, jti, now.toISOString(), now.toISOString(), expires]
    );
  } catch (error) {
    // A session row is useful for the security page but not required to verify
    // the token. Keep sign-in working if the table is unavailable.
    console.error('TEST_ACCOUNT_SESSION_WRITE_FAILED', error);
    jti = undefined;
  }

  return await new SignJWT({
    sub: user.id,
    email: user.email,
    plan: user.plan,
    ...(jti ? { jti } : {}),
    test_account: true,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(new TextEncoder().encode(env.USER_JWT_KEY));
}

function errorResponse(c: any, error: unknown) {
  if (error instanceof TestAccountError) {
    return c.json({ error: error.code, message: error.message }, error.status);
  }
  console.error('TEST_ACCOUNT_ERROR', error);
  return c.json(
    { error: 'test_account_error', message: 'The test account request failed.' },
    500
  );
}

testAccount.get('/', async (c) => {
  const account = await getTestAccount(c.env);
  return c.json({
    enabled: true,
    registered: Boolean(account),
    page: '/testaccountforyou',
    email: account?.email ?? testAccountLoginEmail(c.env),
    login_email: testAccountLoginEmail(c.env),
    password: testAccountPassword(c.env),
    plan: account?.plan ?? 'growth',
    plans: PLANS,
    account: account ? sessionPayload(account) : null,
    note: 'Set TEST_ACCOUNT_ENABLED=false to remove this endpoint, or call DELETE /api/test-account to erase the account and all of its data.',
  });
});

testAccount.post('/signup', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const email = typeof body.email === 'string' ? body.email : undefined;
    const plan = body.plan === undefined ? 'growth' : body.plan;
    if (!isPlan(plan)) {
      return c.json({ error: 'invalid_plan', message: 'Choose one of the supported plans.' }, 400);
    }

    const user = await ensureTestAccount(c.env, { email, plan });
    const environment = await seedTestEnvironment(c.env);
    const token = await issueToken(c.env, user);

    return c.json(
      {
        success: true,
        token,
        user: sessionPayload(user),
        credentials: { email: user.email, password: testAccountPassword(c.env) },
        environment,
      },
      201
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

testAccount.post('/login', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');

    // The documented credentials must work on a fresh deployment, so the
    // first login provisions the account instead of failing.
    const account =
      (await getTestAccount(c.env)) ??
      (await ensureTestAccount(c.env, { email: testAccountLoginEmail(c.env), plan: 'growth' }));
    if (password !== testAccountPassword(c.env)) {
      throw new TestAccountError(401, 'invalid_credentials', 'The test account password is not correct.');
    }
    const acceptedEmails = [account.email.toLowerCase(), testAccountLoginEmail(c.env)];
    if (email && !acceptedEmails.includes(email)) {
      throw new TestAccountError(
        401,
        'invalid_credentials',
        `Use the test account email (${account.email}) with the sample password.`
      );
    }

    const environment = await seedTestEnvironment(c.env);
    const token = await issueToken(c.env, account);
    return c.json({
      success: true,
      token,
      user: sessionPayload(account),
      credentials: { email: account.email, password: testAccountPassword(c.env) },
      environment,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

testAccount.post('/plan', userAuthMiddleware, async (c) => {
  try {
    const auth = getAuth(c);
    if (auth.userId !== TEST_ACCOUNT_ID) {
      return c.json({ error: 'forbidden', message: 'Plan switching is only available to the test account.' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    if (!isPlan(body.plan)) {
      return c.json(
        { error: 'invalid_plan', message: `Choose one of: ${PLANS.join(', ')}.` },
        400
      );
    }
    const user = await ensureTestAccount(c.env, { email: auth.email, plan: body.plan });
    return c.json({
      success: true,
      user: sessionPayload(user),
      plan: user.plan,
      plans: PLANS,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

testAccount.post('/reset', userAuthMiddleware, async (c) => {
  try {
    if (getAuth(c).userId !== TEST_ACCOUNT_ID) {
      return c.json({ error: 'forbidden', message: 'Only the test account can reset its sample data.' }, 403);
    }
    const environment = await seedTestEnvironment(c.env, { force: true });
    return c.json({ success: true, environment });
  } catch (error) {
    return errorResponse(c, error);
  }
});

/**
 * Deletes the test account and every row it owns. This is the only endpoint
 * that removes data, and it is never called by signup, login or plan changes.
 */
testAccount.delete('/', userAuthMiddleware, async (c) => {
  try {
    if (getAuth(c).userId !== TEST_ACCOUNT_ID) {
      return c.json({ error: 'forbidden', message: 'Only the test account can delete itself.' }, 403);
    }
    const result = await deleteTestAccount(c.env);
    return c.json({
      success: true,
      deleted: result.deleted,
      message: result.deleted
        ? 'The test account and all of its data were deleted.'
        : 'Some data could not be deleted; review the warnings.',
      warnings: result.warnings,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

export default testAccount;
