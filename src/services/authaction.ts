import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';
import type { Bindings } from '../types';

/**
 * AuthAction access-token verification.
 *
 * AuthAction owns authentication (password, passkeys, WhatsApp OTP, Google).
 * Revercue only verifies the resulting *access token* and maps its stable
 * `sub` claim onto a Revercue user. Nothing here trusts an unverified payload,
 * and an ID token can never be used in place of an API access token.
 */

export class AuthActionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthActionConfigError';
  }
}

export class AuthActionTokenError extends Error {
  code:
    | 'malformed'
    | 'bad_algorithm'
    | 'bad_signature'
    | 'wrong_issuer'
    | 'wrong_audience'
    | 'expired'
    | 'id_token_rejected'
    | 'missing_subject'
    | 'verification_failed';
  constructor(code: AuthActionTokenError['code'], message: string) {
    super(message);
    this.name = 'AuthActionTokenError';
    this.code = code;
  }
}

export interface AuthActionConfig {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  discoveryUrl: string;
  clientId?: string;
  algorithms: string[];
  emailClaim: string;
  verifiedClaim: string;
}

export interface VerifiedIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  claims: JWTPayload;
}

const DEFAULT_ALGORITHMS = ['RS256'];
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour
const DISCOVERY_TIMEOUT_MS = 5000;

interface DiscoveryCacheEntry {
  jwksUri: string;
  issuer: string;
  fetchedAt: number;
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function isAuthActionConfigured(env: Bindings): boolean {
  return Boolean(env.AUTHACTION_ISSUER && env.AUTHACTION_AUDIENCE);
}

export function getAuthActionConfig(env: Bindings): AuthActionConfig {
  const issuer = (env.AUTHACTION_ISSUER ?? '').trim().replace(/\/$/, '');
  const audience = (env.AUTHACTION_AUDIENCE ?? '').trim();
  if (!issuer) throw new AuthActionConfigError('AUTHACTION_ISSUER is not configured.');
  if (!audience) throw new AuthActionConfigError('AUTHACTION_AUDIENCE is not configured.');
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new AuthActionConfigError('AUTHACTION_ISSUER must be an absolute https URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new AuthActionConfigError('AUTHACTION_ISSUER must use https.');
  }
  const algorithms = (env.AUTHACTION_REQUIRED_ALGS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    issuer,
    audience,
    jwksUrl: env.AUTHACTION_JWKS_URL?.trim() || undefined,
    discoveryUrl:
      env.AUTHACTION_DISCOVERY_URL?.trim() ||
      `${issuer}/.well-known/openid-configuration`,
    clientId: env.AUTHACTION_CLIENT_ID?.trim() || undefined,
    algorithms: algorithms.length > 0 ? algorithms : DEFAULT_ALGORITHMS,
    emailClaim: env.AUTHACTION_EMAIL_CLAIM?.trim() || 'email',
    verifiedClaim: env.AUTHACTION_VERIFIED_CLAIM?.trim() || 'email_verified',
  };
}

/** True when the token uses an asymmetric algorithm (i.e. not a legacy HS256 app token). */
export function looksLikeAuthActionToken(token: string): boolean {
  try {
    const header = decodeProtectedHeader(token);
    return header.alg !== 'HS256' && header.alg !== 'HS384' && header.alg !== 'HS512';
  } catch {
    return false;
  }
}

export async function resolveJwksUrl(config: AuthActionConfig): Promise<string> {
  if (config.jwksUrl) return config.jwksUrl;
  const cached = discoveryCache.get(config.discoveryUrl);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.jwksUri;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(config.discoveryUrl, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new AuthActionConfigError(
        `AuthAction OIDC discovery failed (${response.status}).`
      );
    }
    const document = (await response.json()) as { issuer?: string; jwks_uri?: string };
    if (!document.jwks_uri) {
      throw new AuthActionConfigError('AuthAction discovery document has no jwks_uri.');
    }
    if (document.issuer && document.issuer.replace(/\/$/, '') !== config.issuer) {
      throw new AuthActionConfigError(
        `AuthAction discovery issuer mismatch (document: ${document.issuer}, configured: ${config.issuer}).`
      );
    }
    const jwksUrl = new URL(document.jwks_uri);
    if (jwksUrl.protocol !== 'https:') {
      throw new AuthActionConfigError('AuthAction jwks_uri must use https.');
    }
    discoveryCache.set(config.discoveryUrl, {
      jwksUri: jwksUrl.toString(),
      issuer: config.issuer,
      fetchedAt: Date.now(),
    });
    return jwksUrl.toString();
  } catch (error: any) {
    if (error instanceof AuthActionConfigError) throw error;
    const reason = error?.name === 'AbortError' ? 'timeout' : error?.message ?? 'unknown';
    throw new AuthActionConfigError(`AuthAction OIDC discovery failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `createRemoteJWKSet` handles fetching, caching and key rotation (it refreshes
 * when it sees an unknown `kid`, with a cooldown). The instance is cached per
 * isolate so warm requests do not refetch.
 */
function getJwks(jwksUrl: string) {
  const existing = jwksCache.get(jwksUrl);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(jwksUrl), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
    timeoutDuration: 5000,
  });
  jwksCache.set(jwksUrl, created);
  return created;
}

function mapVerifyError(error: any): AuthActionTokenError {
  const code = String(error?.code ?? '');
  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return new AuthActionTokenError('expired', 'The access token has expired.');
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
      const claim = String(error?.claim ?? '');
      if (claim === 'iss') return new AuthActionTokenError('wrong_issuer', 'The token issuer is not AuthAction for this tenant.');
      if (claim === 'aud') return new AuthActionTokenError('wrong_audience', 'The token audience does not match the Revercue API.');
      return new AuthActionTokenError('verification_failed', 'The token claims are invalid.');
    }
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
      return new AuthActionTokenError('bad_signature', 'The token signature could not be verified.');
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return new AuthActionTokenError('bad_algorithm', 'The token signing algorithm is not allowed.');
    default:
      return new AuthActionTokenError('verification_failed', 'The token could not be verified.');
  }
}

export async function verifyAccessToken(
  env: Bindings,
  token: string,
  configOverride?: AuthActionConfig,
  keySetOverride?: JWTVerifyGetKey
): Promise<VerifiedIdentity> {
  if (!token || token.split('.').length !== 3) {
    throw new AuthActionTokenError('malformed', 'The access token is malformed.');
  }
  const config = configOverride ?? getAuthActionConfig(env);
  // The override exists so tests can verify tokens against a local key set;
  // production always resolves AuthAction's remote JWKS.
  const keySet = keySetOverride ?? getJwks(await resolveJwksUrl(config));

  let header: { alg?: string; typ?: string };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new AuthActionTokenError('malformed', 'The access token header is malformed.');
  }
  if (!header.alg || !config.algorithms.includes(header.alg)) {
    throw new AuthActionTokenError('bad_algorithm', 'The token signing algorithm is not allowed.');
  }

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, keySet, {
      audience: config.audience,
      algorithms: config.algorithms,
      clockTolerance: 30,
      requiredClaims: ['sub', 'iss', 'aud', 'exp'],
    });
    payload = verified.payload;
  } catch (error: any) {
    throw mapVerifyError(error);
  }

  // Issuer is compared after signature verification. AuthAction's discovery
  // document publishes `https://<tenant>/` while the tenant URL may be written
  // without the trailing slash, so both sides are normalised rather than
  // relying on a literal string comparison inside jose.
  const tokenIssuer = typeof payload.iss === 'string' ? payload.iss.trim().replace(/\/$/, '') : '';
  if (!tokenIssuer || tokenIssuer !== config.issuer) {
    throw new AuthActionTokenError('wrong_issuer', 'The token issuer is not AuthAction for this tenant.');
  }

  // Access-token vs ID-token separation. An ID token is issued for the
  // frontend client id; this API only accepts tokens minted for its own
  // audience. Explicit ID-token markers are rejected even if an operator
  // misconfigures the audience to the client id.
  const tokenUse = String((payload as any).token_use ?? '').toLowerCase();
  const hasIdTokenMarkers = Boolean((payload as any).at_hash || (payload as any).nonce || (payload as any).c_hash);
  if (
    tokenUse === 'id' ||
    hasIdTokenMarkers ||
    header.typ === 'JWT+ID' ||
    (config.clientId && payload.aud === config.clientId && payload.aud !== config.audience)
  ) {
    throw new AuthActionTokenError('id_token_rejected', 'An ID token was supplied where an API access token is required.');
  }

  const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  if (!subject) {
    throw new AuthActionTokenError('missing_subject', 'The access token has no subject claim.');
  }

  const rawEmail = (payload as Record<string, unknown>)[config.emailClaim];
  const email = typeof rawEmail === 'string' && rawEmail.includes('@') ? rawEmail.trim().toLowerCase() : null;
  const rawVerified = (payload as Record<string, unknown>)[config.verifiedClaim];
  const emailVerified = rawVerified === true || rawVerified === 'true' || rawVerified === 1;

  return { subject, email, emailVerified: emailVerified && Boolean(email), claims: payload };
}

/** Exposed for tests and diagnostics: clears the isolate caches. */
export function resetAuthActionCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}
