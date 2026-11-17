import { jwtVerify } from 'jose';
import type { Context, MiddlewareHandler } from 'hono';
import { tursoQuery } from '../utils/turso';
import type { AuthContext, Bindings } from '../types';
import {
  AuthActionConfigError,
  AuthActionTokenError,
  isAuthActionConfigured,
  looksLikeAuthActionToken,
  verifyAccessToken,
} from '../services/authaction';
import { getUserById, resolveSubject, touchIdentityLogin } from '../services/identity';

/** Legacy app token payload. Retained for the AuthAction transition window. */
export interface UserPayload {
  sub: string;
  email: string;
  plan: string;
  jti?: string;
}

export async function verifyUserToken(token: string, jwtKey: string): Promise<UserPayload | null> {
  try {
    const secret = new TextEncoder().encode(jwtKey);
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string') return null;
    return {
      sub: payload.sub,
      email: (payload.email as string) ?? '',
      plan: (payload.plan as string) ?? 'free',
      jti: typeof payload.jti === 'string' ? payload.jti : undefined,
    };
  } catch {
    return null;
  }
}

export function getAuth(c: Context): AuthContext {
  const auth = c.get('auth' as never) as unknown as AuthContext | undefined;
  if (!auth) throw new Error('getAuth() used on a route without authentication middleware.');
  return auth;
}

export interface AuthFailure {
  status: 401 | 403 | 500;
  body: Record<string, unknown>;
}

function legacyEnabled(env: Bindings): boolean {
  return (env.ALLOW_LEGACY_AUTH ?? 'true').toLowerCase() !== 'false';
}

/**
 * Resolves the caller from either an AuthAction access token (preferred) or a
 * legacy Revercue session token (transition only).
 *
 * The plan is always re-read from the database rather than trusted from the
 * token, because Revercue is the source of truth for plans and feature access.
 */
export async function authenticateRequest(
  c: Context<{ Bindings: Bindings }>
): Promise<{ auth: AuthContext } | { failure: AuthFailure }> {
  const env = c.env;
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) {
    return { failure: { status: 401, body: { error: 'unauthorized', message: 'Missing bearer token.' } } };
  }
  const token = header.slice(7).trim();
  if (!token) {
    return { failure: { status: 401, body: { error: 'unauthorized', message: 'Missing bearer token.' } } };
  }

  const authActionToken = looksLikeAuthActionToken(token);

  if (authActionToken) {
    if (!isAuthActionConfigured(env)) {
      return {
        failure: {
          status: 500,
          body: {
            error: 'config_error',
            message: 'AuthAction is not configured on this deployment (AUTHACTION_ISSUER / AUTHACTION_AUDIENCE).',
          },
        },
      };
    }
    let identity;
    try {
      identity = await verifyAccessToken(env, token);
    } catch (error) {
      if (error instanceof AuthActionTokenError) {
        return {
          failure: {
            status: 401,
            body: { error: 'unauthorized', message: error.message, details: { reason: error.code } },
          },
        };
      }
      if (error instanceof AuthActionConfigError) {
        console.error('AUTHACTION_CONFIG_ERROR', error.message);
        return {
          failure: {
            status: 500,
            body: { error: 'config_error', message: 'Authentication is temporarily unavailable.' },
          },
        };
      }
      console.error('AUTHACTION_VERIFY_ERROR', error);
      return {
        failure: { status: 401, body: { error: 'unauthorized', message: 'The access token could not be verified.' } },
      };
    }

    const user = await resolveSubject(env, identity.subject);
    if (!user) {
      return {
        failure: {
          status: 401,
          body: {
            error: 'account_link_required',
            message:
              'This AuthAction identity is not linked to a Revercue account yet. Complete the account link flow.',
            details: {
              link_required: true,
              email: identity.email,
              email_verified: identity.emailVerified,
            },
          },
        },
      };
    }
    await touchIdentityLogin(env, identity.subject);
    return {
      auth: {
        userId: user.id,
        email: user.email,
        plan: user.plan,
        role: 'user',
        via: 'authaction',
        subject: identity.subject,
      },
    };
  }

  if (!legacyEnabled(env)) {
    return {
      failure: {
        status: 401,
        body: {
          error: 'unauthorized',
          message: 'Legacy sessions are disabled. Sign in through AuthAction.',
          details: { reason: 'legacy_auth_disabled' },
        },
      },
    };
  }

  const jwtKey = env.USER_JWT_KEY;
  if (!jwtKey) {
    return {
      failure: {
        status: 500,
        body: { error: 'config_error', message: 'USER_JWT_KEY not configured.' },
      },
    };
  }
  const payload = await verifyUserToken(token, jwtKey);
  if (!payload) {
    return {
      failure: { status: 401, body: { error: 'unauthorized', message: 'Invalid or expired token.' } },
    };
  }

  if (payload.jti) {
    const session = await tursoQuery(
      env,
      `SELECT revoked_at, expires_at FROM sessions WHERE jwt_id = ? LIMIT 1`,
      [payload.jti]
    );
    if (session.rows.length === 0) {
      return { failure: { status: 401, body: { error: 'unauthorized', message: 'Session not found.' } } };
    }
    const s = session.rows[0];
    if (s.revoked_at) {
      return { failure: { status: 401, body: { error: 'unauthorized', message: 'Session revoked.' } } };
    }
    if (new Date(String(s.expires_at)).getTime() < Date.now()) {
      return { failure: { status: 401, body: { error: 'unauthorized', message: 'Session expired.' } } };
    }
  }

  const user = await getUserById(env, payload.sub);
  if (!user) {
    return { failure: { status: 401, body: { error: 'unauthorized', message: 'Account not found.' } } };
  }

  return {
    auth: {
      userId: user.id,
      email: user.email || payload.email,
      plan: user.plan,
      role: 'user',
      via: 'legacy',
      sessionId: payload.jti,
    },
  };
}

/** Auth-required middleware used by every protected route. */
export const userAuthMiddleware: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const result = await authenticateRequest(c);
  if ('failure' in result) {
    return c.json(result.failure.body, result.failure.status);
  }
  c.set('auth' as never, result.auth as never);
  // Backwards compatibility: existing handlers read `user.sub`.
  c.set(
    'user' as never,
    {
      sub: result.auth.userId,
      email: result.auth.email,
      plan: result.auth.plan,
      jti: result.auth.sessionId,
    } as never
  );
  await next();
};

/**
 * For endpoints that behave differently when signed in but must stay public
 * (public document pages). Never rejects the request.
 */
export const optionalUserAuth: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  if (header.startsWith('Bearer ')) {
    const result = await authenticateRequest(c);
    if ('auth' in result) {
      c.set('auth' as never, result.auth as never);
      c.set(
        'user' as never,
        { sub: result.auth.userId, email: result.auth.email, plan: result.auth.plan } as never
      );
    }
  }
  await next();
};
