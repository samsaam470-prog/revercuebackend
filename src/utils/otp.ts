/**
 * Revercue no longer issues or verifies one-time codes: AuthAction owns
 * sign-up, sign-in, email verification, password reset and second factors.
 * What remains is the keyed HMAC helper used to hash IP addresses in `sessions`.
 */

export async function hashOTP(code: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(code));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
