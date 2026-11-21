import { createSignedToken, verifySignedToken } from '../utils/crypto';
import { RETENTION_LINK_TTL_SECONDS, SIGNED_PDF_LINK_TTL_SECONDS } from '../config/constants';
import type { Bindings } from '../types';

/**
 * Short-lived, tamper-evident links for private documents.
 *
 * Signed PDFs and retention copies are never served just because someone has
 * the public contract URL. Each link is an HMAC over the document identity,
 * an expiry and the intended audience, so it can be checked without a
 * database round-trip and cannot be edited to point at another document.
 */

export type LinkPurpose = 'signed_pdf' | 'retention_copy';

interface LinkPayload {
  p: LinkPurpose;
  t: string; // document type
  id: string; // document id
  v?: string; // contract version id
  a?: string; // audience: freelancer | client | owner | public
  exp: number;
}

export class LinkSecretError extends Error {}

export function linkSecret(env: Bindings): string {
  const secret = env.SIGNING_LINK_SECRET?.trim() || env.USER_JWT_KEY;
  if (!secret || secret.length < 16) {
    throw new LinkSecretError('SIGNING_LINK_SECRET is not configured (or too short).');
  }
  if (!env.SIGNING_LINK_SECRET) {
    console.warn('SIGNING_LINK_SECRET_MISSING: falling back to USER_JWT_KEY. Configure a dedicated secret.');
  }
  return secret;
}

export async function createDocumentLink(
  env: Bindings,
  input: { purpose: LinkPurpose; documentType: string; documentId: string; versionId?: string; audience?: string; ttlSeconds?: number }
): Promise<{ token: string; expiresAt: string; expiresIn: number }> {
  const ttl =
    input.ttlSeconds ??
    (input.purpose === 'signed_pdf' ? SIGNED_PDF_LINK_TTL_SECONDS : RETENTION_LINK_TTL_SECONDS);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload: LinkPayload = {
    p: input.purpose,
    t: input.documentType,
    id: input.documentId,
    v: input.versionId,
    a: input.audience,
    exp,
  };
  const token = await createSignedToken(linkSecret(env), payload as unknown as Record<string, unknown>);
  return { token, expiresAt: new Date(exp * 1000).toISOString(), expiresIn: ttl };
}

export type LinkVerification =
  | { ok: true; payload: LinkPayload }
  | { ok: false; reason: 'malformed' | 'invalid_signature' | 'expired' | 'wrong_document' | 'wrong_purpose' };

export async function verifyDocumentLink(
  env: Bindings,
  token: string,
  expected: { purpose: LinkPurpose; documentType?: string; documentId?: string }
): Promise<LinkVerification> {
  const result = await verifySignedToken<LinkPayload>(linkSecret(env), token);
  if (!result.ok) return { ok: false, reason: result.reason };
  const payload = result.payload;
  if (payload.p !== expected.purpose) return { ok: false, reason: 'wrong_purpose' };
  if (expected.documentType && payload.t !== expected.documentType) return { ok: false, reason: 'wrong_document' };
  if (expected.documentId && payload.id !== expected.documentId) return { ok: false, reason: 'wrong_document' };
  return { ok: true, payload };
}

export function documentLinkUrl(
  env: Bindings,
  path: string,
  token: string
): string {
  const base = (env.APP_URL || env.FRONTEND_ORIGIN || 'https://revercue.co.uk').replace(/\/$/, '');
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}
