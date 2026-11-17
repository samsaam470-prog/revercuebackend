import type { Context } from 'hono';
import { hashOTP } from './otp';

/** Trusted client IP as seen by Cloudflare. Falls back to a stable placeholder. */
export function clientIp(c: Context): string {
  return (
    c.req.header('CF-Connecting-IP') ??
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
    ''
  );
}

export function clientUserAgent(c: Context): string {
  return (c.req.header('User-Agent') ?? '').slice(0, 512);
}

/**
 * IPs are personal data. They are stored hashed for locking-out, rate limiting
 * and audit, and only in full on signing evidence (required for e-signature
 * audit trails). The hash uses the OTP secret so it cannot be reversed by
 * rainbow tables.
 */
export async function hashIp(ip: string, secret: string): Promise<string | null> {
  if (!ip) return null;
  return hashOTP(ip, secret);
}

/** Minimal, reliable device label derived from the user agent. */
export function describeUserAgent(ua: string): { device: string | null; browser: string | null; os: string | null } {
  if (!ua) return { device: null, browser: null, os: null };
  const device = /Mobile|Android|iPhone|iPad/i.test(ua) ? 'Mobile' : 'Desktop';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Other';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iOS/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return { device, browser, os };
}

export function requestOrigin(c: Context): string {
  return c.req.header('Origin') ?? '';
}

export function newReferenceCode(prefix = 'ERR'): string {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}
