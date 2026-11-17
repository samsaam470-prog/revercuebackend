/**
 * Worker-safe cryptographic helpers shared by signed download links, content
 * hashing and signature integrity checks.
 */

const encoder = new TextEncoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decodes a data URL (`data:image/png;base64,...`) into bytes + mime type. */
export function decodeDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!match) return null;
  try {
    const binary = atob(match[2].replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { mime: match[1].toLowerCase(), bytes };
  } catch {
    return null;
  }
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}

export async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return new Uint8Array(signature);
}

/** Constant-time-ish comparison for hex/base64 strings of equal length. */
export function stringsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/**
 * Creates a stateless, tamper-evident token: `payload.signature`.
 * Used for short-lived signed-PDF and retention delivery links so no extra
 * table is needed and links cannot be guessed.
 */
export async function createSignedToken(
  secret: string,
  payload: Record<string, unknown>
): Promise<string> {
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = bytesToBase64Url(await hmacSha256(secret, body));
  return `${body}.${signature}`;
}

export type SignedTokenResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: 'malformed' | 'invalid_signature' | 'expired' };

export async function verifySignedToken<T extends { exp?: number }>(
  secret: string,
  token: string
): Promise<SignedTokenResult<T>> {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const expected = bytesToBase64Url(await hmacSha256(secret, parts[0]));
  if (!stringsEqual(expected, parts[1])) return { ok: false, reason: 'invalid_signature' };
  let payload: T;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0]))) as T;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
}
