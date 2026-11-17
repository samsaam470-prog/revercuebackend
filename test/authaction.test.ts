import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import {
  verifyAccessToken,
  AuthActionTokenError,
  resetAuthActionCaches,
} from '../src/services/authaction';
import type { Bindings } from '../src/types';

const ISSUER = 'https://revercue.in.authaction.com';
const AUDIENCE = 'revercue-api.samsaam470.workers.dev';
const CLIENT_ID = '6afa55be765d68ab52b7acee';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

let privateKey: any;
let keySet: JWTVerifyGetKey;

const env = {
  AUTHACTION_ISSUER: ISSUER,
  AUTHACTION_AUDIENCE: AUDIENCE,
  AUTHACTION_JWKS_URL: JWKS_URL,
  AUTHACTION_CLIENT_ID: CLIENT_ID,
} as unknown as Bindings;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  keySet = createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
});

function verify(token: string) {
  resetAuthActionCaches();
  return verifyAccessToken(env, token, undefined, keySet);
}

async function signToken(
  overrides: {
    issuer?: string;
    audience?: string;
    subject?: string | null;
    expiresAt?: string | number;
    extra?: Record<string, unknown>;
    alg?: string;
    kid?: string;
    key?: any;
  } = {}
): Promise<string> {
  const builder = new SignJWT({
    email: 'freelancer@example.com',
    email_verified: true,
    ...(overrides.extra ?? {}),
  })
    .setProtectedHeader({ alg: overrides.alg ?? 'RS256', kid: overrides.kid ?? 'test-key' })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresAt ?? '5m');
  if (overrides.subject !== null) builder.setSubject(overrides.subject ?? 'authaction|user-1');
  return builder.sign(overrides.key ?? privateKey);
}

describe('AuthAction access token verification', () => {
  it('accepts a valid RS256 access token and extracts the subject', async () => {
    const token = await signToken();
    const identity = await verify(token);
    expect(identity.subject).toBe('authaction|user-1');
    expect(identity.email).toBe('freelancer@example.com');
    expect(identity.emailVerified).toBe(true);
  });

  it('accepts the issuer with or without a trailing slash', async () => {
    const token = await signToken({ issuer: `${ISSUER}/` });
    const identity = await verify(token);
    expect(identity.subject).toBe('authaction|user-1');
  });

  it('rejects a token signed with a different key', async () => {
    const other = await generateKeyPair('RS256');
    const token = await signToken({ key: other.privateKey });
    await expect(verify(token)).rejects.toMatchObject({ code: 'bad_signature' });
  });

  it('rejects the wrong audience', async () => {
    const token = await signToken({ audience: 'some-other-api' });
    await expect(verify(token)).rejects.toMatchObject({ code: 'wrong_audience' });
  });

  it('rejects the wrong issuer', async () => {
    const token = await signToken({ issuer: 'https://evil.authaction.com' });
    await expect(verify(token)).rejects.toMatchObject({ code: 'wrong_issuer' });
  });

  it('rejects an expired token', async () => {
    const expired = Math.floor(Date.now() / 1000) - 3600;
    const token = await signToken({ expiresAt: expired });
    await expect(verify(token)).rejects.toMatchObject({ code: 'expired' });
  });

  it('rejects an HS256 token (algorithm confusion)', async () => {
    const token = await new SignJWT({ email_verified: true })
      .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('authaction|user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('shared-secret'));
    await expect(verify(token)).rejects.toMatchObject({ code: 'bad_algorithm' });
  });

  it('rejects an ID token used as an API access token', async () => {
    // Normal configuration: the ID token's audience is the frontend client id,
    // so it already fails the audience check.
    const idToken = await signToken({ audience: CLIENT_ID, extra: { nonce: 'n-1' } });
    await expect(verify(idToken)).rejects.toMatchObject({ code: 'wrong_audience' });

    // Misconfiguration guard: even if the API audience were set to the client
    // id, ID-token markers must still be rejected.
    const misconfigured = { ...env, AUTHACTION_AUDIENCE: CLIENT_ID } as unknown as Bindings;
    await expect(
      verifyAccessToken(misconfigured, idToken, undefined, keySet)
    ).rejects.toMatchObject({ code: 'id_token_rejected' });
  });

  it('rejects a malformed token before any network call', async () => {
    await expect(verifyAccessToken(env, 'not-a-jwt')).rejects.toBeInstanceOf(AuthActionTokenError);
  });

  it('rejects a token without a subject', async () => {
    const token = await signToken({ subject: null });
    await expect(verify(token)).rejects.toBeInstanceOf(AuthActionTokenError);
  });
});
