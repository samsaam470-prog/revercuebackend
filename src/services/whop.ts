import type { Bindings } from '../types';

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

export function whopHeaders(env: Bindings): Record<string, string> {
  return {
    Authorization: `Bearer ${whopApiKey(env)}`,
    'Content-Type': 'application/json',
  };
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

export function planKeyFromWhopId(env: Bindings, whopPlanId: string): string | null {
  if (!whopPlanId) return null;
  const entries: Array<[string | undefined, string]> = [
    [(env as any).WHOP_PLAN_STARTER, 'starter'],
    [(env as any).WHOP_PLAN_GROWTH_TRIAL, 'growth'],
    [(env as any).WHOP_PLAN_GROWTH_STANDARD, 'growth'],
    [(env as any).WHOP_PLAN_SCALE, 'scale'],
  ];
  for (const [id, key] of entries) {
    if (id && id === whopPlanId) return key;
  }
  return null;
}

export async function whopCreateCheckout(env: Bindings, whopPlanId: string, metadata: Record<string, string>): Promise<{ id: string; url: string } | null> {
  try {
    const res = await fetch(`${whopBase(env)}/checkout_configurations`, {
      method: 'POST',
      headers: whopHeaders(env),
      body: JSON.stringify({
        variant_id: whopPlanId,
        metadata,
      }),
    });
    if (!res.ok) {
      console.error('WHOP_CHECKOUT_FAILED', res.status, await res.text());
      return null;
    }
    const data: any = await res.json();
    return { id: data.id, url: data.purchase_url ?? data.url ?? '' };
  } catch (e) {
    console.error('WHOP_CHECKOUT_ERROR', e);
    return null;
  }
}

export async function whopCancelMembership(env: Bindings, membershipId: string): Promise<boolean> {
  try {
    const res = await fetch(`${whopBase(env)}/memberships/${membershipId}/cancel`, {
      method: 'POST',
      headers: whopHeaders(env),
      body: JSON.stringify({}),
    });
    return res.ok;
  } catch {
    return false;
  }
}
