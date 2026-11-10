// OTP generation, hashing, and verification.
// Security emails (signup OTP, password reset, 2FA) are sent via FormSubmit
// to the user's email. The activation wall is a one-time consent step.

const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 5;
const MAX_ATTEMPTS = 3;
const RESEND_COOLDOWN_SECONDS = 90;

export function generateOTP(): string {
  const digits = '0123456789';
  const bytes = new Uint8Array(OTP_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < OTP_LENGTH; i++) {
    out += digits[bytes[i] % 10];
  }
  return out;
}

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

export async function verifyOTP(
  input: string,
  storedHash: string,
  secret: string
): Promise<boolean> {
  const inputHash = await hashOTP(input, secret);
  return inputHash === storedHash;
}

export function otpExpiryISO(): string {
  return new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();
}

export function cooldownISO(): string {
  return new Date(Date.now() - RESEND_COOLDOWN_SECONDS * 1000).toISOString();
}

export { OTP_EXPIRY_MINUTES, MAX_ATTEMPTS, RESEND_COOLDOWN_SECONDS };
