import type { Bindings } from '../types';

/**
 * Whop REST client.
 *
 * Only the operations Revercue actually uses live here: checkout configuration
 * creation, membership read, cancel (at period end), reversal of a pending
 * cancellation, pause, resume and payment-status verification. Plan-drift is
 * deliberately absent — Whop does not document changing a membership's variant,
 * so a plan change is always "new checkout, then cancel the old membership"
 * (see services/subscription-lifecycle.ts).
 *
 * Credentials come from the Worker environment. Nothing in this module logs a
 * key, a payment amount tied to a card or any customer payment data.
 */

export function isSandbox(env: Bindings): boolean {
  return String((env as any).WHOP_SANDBOX ?? 'true') === 'true';
}

export function whopBase(env: Bindings): string {
  return isSandbox(env) ? 'https://sandbox-api.whop.com/api/v1' : 'https://api.whop.com/api/v1';
}

export function whopApiKey(env: Bindings): string {
  if (isSandbox(env)) {
    return String((env as any).WHOP_API ?? (env as any).WHOP_SANDBOX_API ?? '');
  }
  return String((env as any).WHOP_PRODUCTION_API ?? (env as any).WHOP_API ?? '');
}

export function whopHeaders(env: Bindings, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${whopApiKey(env)}`,
    'Content-Type': 'application/json',
    ...(extra ?? {}),
  };
}

export interface WhopResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

async function whopRequest<T>(
  env: Bindings,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {}
): Promise<WhopResult<T>> {
  const method = init.method ?? 'GET';
  try {
    const res = await fetch(`${whopBase(env)}${path}`, {
      method,
      headers: whopHeaders(env, init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey.slice(0, 255) } : undefined),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Status and a short, non-sensitive message only.
      console.error('WHOP_REQUEST_FAILED', method, path.replace(/memberships\/[^/]+/, 'memberships/:id'), res.status, text.slice(0, 300));
      return { ok: false, status: res.status, data: null, error: `whop_${res.status}` };
    }
    const data = (await res.json().catch(() => null)) as T | null;
    return { ok: true, status: res.status, data };
  } catch (error) {
    console.error('WHOP_REQUEST_ERROR', method, error instanceof Error ? error.message : 'unknown');
    return { ok: false, status: 0, data: null, error: 'whop_unreachable' };
  }
}

export function planIdFor(env: Bindings, planKey: string, growthTrial: boolean): string | null {
  const map: Record<string, string | undefined> = {
    starter: (env as any).WHOP_PLAN_STARTER,
    growth_trial: (env as any).WHOP_PLAN_GROWTH_TRIAL,
    growth_standard: (env as any).WHOP_PLAN_GROWTH_STANDARD,
    scale: (env as any).WHOP_PLAN_SCALE,
  };
  if (planKey === 'growth') return growthTrial ? map.growth_trial ?? null : map.growth_standard ?? null;
  return map[planKey] ?? null;
}

/**
 * A Scale variant that carries a short Whop trial, used when an upgrade happens
 * in the last few days of a Growth period. Whop trials are a property of the
 * variant, not of the checkout, so a per-customer day count needs a configured
 * variant; when it is absent the upgrade falls back to an immediate charge.
 */
export function shortCycleScalePlanId(env: Bindings): string | null {
  const value = String((env as any).WHOP_PLAN_SCALE_TRIAL ?? '').trim();
  return value || null;
}

export function planKeyFromWhopId(env: Bindings, whopPlanId: string): string | null {
  if (!whopPlanId) return null;
  const entries: Array<[string | undefined, string]> = [
    [(env as any).WHOP_PLAN_STARTER, 'starter'],
    [(env as any).WHOP_PLAN_GROWTH_TRIAL, 'growth'],
    [(env as any).WHOP_PLAN_GROWTH_STANDARD, 'growth'],
    [(env as any).WHOP_PLAN_SCALE, 'scale'],
    [String((env as any).WHOP_PLAN_SCALE_TRIAL ?? '') || undefined, 'scale'],
    [(env as any).WHOP_PLAN_CAPACITY_PROTECT, 'capacity:protect'],
    [(env as any).WHOP_PLAN_CAPACITY_PROTECT_PLUS, 'capacity:protect_plus'],
  ];
  for (const [id, key] of entries) {
    if (id && id === whopPlanId) return key;
  }
  return null;
}

export async function whopCreateCheckout(
  env: Bindings,
  whopPlanId: string,
  metadata: Record<string, string>,
  options: { idempotencyKey?: string; redirectUrl?: string } = {}
): Promise<{ id: string; url: string } | null> {
  const result = await whopRequest<any>(env, '/checkout_configurations', {
    method: 'POST',
    idempotencyKey: options.idempotencyKey,
    body: {
      variant_id: whopPlanId,
      metadata,
      ...(options.redirectUrl ? { redirect_url: options.redirectUrl } : {}),
    },
  });
  if (!result.ok || !result.data) return null;
  return { id: String(result.data.id ?? ''), url: String(result.data.purchase_url ?? result.data.url ?? '') };
}

export interface WhopMembership {
  id: string;
  status: string;
  plan_id: string | null;
  membership_id?: string;
  user_id?: string | null;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  metadata: Record<string, string>;
}

export function normalizeMembership(data: any): WhopMembership | null {
  if (!data || !data.id) return null;
  return {
    id: String(data.id),
    status: String(data.status ?? '').toLowerCase(),
    plan_id: String(data.variant_id ?? data.plan_id ?? data.plan?.id ?? '') || null,
    user_id: String(data.user_id ?? data.user?.id ?? '') || null,
    cancel_at_period_end: Boolean(data.cancel_at_period_end),
    current_period_end: String(data.current_period_end ?? data.renewal_period_end ?? data.expires_at ?? '') || null,
    metadata: (data.metadata && typeof data.metadata === 'object' ? data.metadata : {}) as Record<string, string>,
  };
}

export async function whopGetMembership(env: Bindings, membershipId: string): Promise<WhopMembership | null> {
  const result = await whopRequest<any>(env, `/memberships/${encodeURIComponent(membershipId)}`);
  if (!result.ok) return null;
  return normalizeMembership(result.data);
}

/** Cancels at period end by default: access already paid for is never removed. */
export async function whopCancelMembership(
  env: Bindings,
  membershipId: string,
  options: { atPeriodEnd?: boolean; reason?: string } = {}
): Promise<boolean> {
  const result = await whopRequest<any>(env, `/memberships/${encodeURIComponent(membershipId)}/cancel`, {
    method: 'POST',
    body: { cancel_at_period_end: options.atPeriodEnd !== false, cancellation_reason: options.reason ?? 'customer_request' },
  });
  return result.ok;
}

/** Reverses a scheduled cancellation (the `cancel_at_period_end` flag). */
export async function whopReverseCancellation(env: Bindings, membershipId: string): Promise<boolean> {
  const result = await whopRequest<any>(env, `/memberships/${encodeURIComponent(membershipId)}`, {
    method: 'PATCH',
    body: { cancel_at_period_end: false },
  });
  return result.ok;
}

/**
 * Pauses collection. `until` is optional: without it the pause is indefinite and
 * only an explicit resume restarts billing.
 */
export async function whopPauseMembership(
  env: Bindings,
  membershipId: string,
  options: { until?: string } = {}
): Promise<WhopMembership | null> {
  const result = await whopRequest<any>(env, `/memberships/${encodeURIComponent(membershipId)}/pause`, {
    method: 'POST',
    body: options.until ? { until: options.until } : {},
  });
  if (!result.ok) return null;
  return normalizeMembership(result.data) ?? { ...emptyMembership(membershipId), status: 'paused' };
}

export async function whopResumeMembership(env: Bindings, membershipId: string): Promise<WhopMembership | null> {
  const result = await whopRequest<any>(env, `/memberships/${encodeURIComponent(membershipId)}/resume`, {
    method: 'POST',
    body: {},
  });
  if (!result.ok) return null;
  return normalizeMembership(result.data) ?? { ...emptyMembership(membershipId), status: 'active' };
}

function emptyMembership(id: string): WhopMembership {
  return {
    id,
    status: '',
    plan_id: null,
    cancel_at_period_end: false,
    current_period_end: null,
    metadata: {},
  };
}

/** Server-side payment truth. Never trust a redirect for this. */
export async function whopPaymentStatus(
  env: Bindings,
  paymentId: string
): Promise<{ status: string; succeeded: boolean } | null> {
  const result = await whopRequest<any>(env, `/payments/${encodeURIComponent(paymentId)}/status`);
  if (!result.ok) return null;
  const status = String(result.data?.status ?? '').toLowerCase();
  return { status, succeeded: status === 'succeeded' };
}

export async function whopGetPayment(env: Bindings, paymentId: string): Promise<any | null> {
  const result = await whopRequest<any>(env, `/payments/${encodeURIComponent(paymentId)}`);
  return result.ok ? result.data : null;
}
