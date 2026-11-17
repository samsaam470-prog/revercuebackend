import { createSignedToken, verifySignedToken } from '../utils/crypto';
import type { Bindings } from '../types';

/**
 * Newsletter subscription state machine.
 *
 * Double opt-in: a subscription is `pending` until the address confirms, which
 * also prevents using this endpoint to sign someone else up silently. The
 * confirm/unsubscribe links are HMAC tokens, so they cannot be forged and no
 * per-subscriber token column is required.
 */

export type SubscriberStatus = 'pending' | 'active' | 'unsubscribed';
export type NewsletterAction = 'confirm' | 'unsubscribe';

export interface NewsletterToken {
  email: string;
  action: NewsletterAction;
  exp: number;
}

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export function nextStatus(
  current: SubscriberStatus | null,
  action: 'subscribe' | NewsletterAction
): SubscriberStatus {
  if (action === 'unsubscribe') return 'unsubscribed';
  if (action === 'confirm') return 'active';
  if (current === 'active') return 'active';
  return 'pending';
}

/** True when the request should not create a second row. */
export function isDuplicateSubscription(current: SubscriberStatus | null): boolean {
  return current === 'active' || current === 'pending';
}

export async function createNewsletterToken(
  env: Bindings,
  email: string,
  action: NewsletterAction
): Promise<string> {
  return createSignedToken(env.SIGNING_LINK_SECRET || env.USER_JWT_KEY, {
    email,
    action,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  });
}

export async function verifyNewsletterToken(
  env: Bindings,
  token: string,
  expectedAction: NewsletterAction
): Promise<{ ok: true; email: string } | { ok: false; reason: string }> {
  const result = await verifySignedToken<NewsletterToken>(
    env.SIGNING_LINK_SECRET || env.USER_JWT_KEY,
    token
  );
  if (!result.ok) return { ok: false, reason: result.reason };
  if (result.payload.action !== expectedAction) return { ok: false, reason: 'wrong_action' };
  if (typeof result.payload.email !== 'string' || !result.payload.email.includes('@')) {
    return { ok: false, reason: 'invalid_payload' };
  }
  return { ok: true, email: result.payload.email.toLowerCase() };
}
