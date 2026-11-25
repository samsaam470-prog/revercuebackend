import type { Context } from 'hono';
import { SigningError } from '../services/contract-state';
import { LinkSecretError } from '../services/document-links';

/**
 * Central error → JSON mapping. Routes return the same shape the frontend's
 * ApiError expects: `{ error, message, details? }`.
 */
export function jsonError(
  c: Context,
  status: 400 | 401 | 402 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500 | 501 | 502 | 503,
  error: string,
  message: string,
  details?: Record<string, unknown>
): Response {
  return c.json({ error, message, ...(details ? { details } : {}) }, status);
}

export function handleRouteError(c: Context, error: unknown): Response | null {
  if (error instanceof SigningError) {
    return jsonError(c, error.status, error.code, error.message);
  }
  if (error instanceof LinkSecretError) {
    console.error('LINK_SECRET_ERROR', error.message);
    return jsonError(c, 500, 'config_error', 'Secure download links are not configured.');
  }
  return null;
}
