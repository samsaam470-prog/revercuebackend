import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';

import {
  CAPACITY_OFFERS,
  CAPACITY_OFFER_LIST,
  capacityOfferPlanId,
  capacityOfferPriceCents,
  SHORT_CYCLE_THRESHOLD_DAYS,
  CAPACITY_DECLINE_NOTICE,
  CAPACITY_DECLINE_BEHAVIOUR,
} from '../config/billing';
import { whopCreateCheckout, whopCancelMembership, whopReverseCancellation, whopPauseMembership, whopResumeMembership, whopGetMembership, whopPaymentStatus } from './whop';
import { endGrowthTrial } from './trials';
import { getActiveTrial } from './trials';
import { getEntitlementSnapshot } from './entitlements';
import type { Bindings } from '../types';

const DAY_MS = 86_400_000;
const PLAN_ORDER = ['free', 'starter', 'growth', 'scale', 'teams'] as const;

function planRank(plan: string): number {
  const index = PLAN_ORDER.indexOf(plan as (typeof PLAN_ORDER)[number]);
  return index < 0 ? 0 : index;
}

export type LifecycleErrorStatus = 400 | 402 | 404 | 409 | 500 | 501 | 502;

export interface TransitionRow {
  id: string;
  user_id: string;
  kind: string;
  from_plan: string | null;
  to_plan: string;
  from_subscription_id: string | null;
  from_membership_id: string | null;
  offer_key: string | null;
  addon_id: string | null;
  status: string;
  whop_checkout_id: string | null;
  whop_checkout_url: string | null;
  whop_membership_id: string | null;
  whop_plan_id: string | null;
  trial_days: number;
  starts_at: string | null;
  combined_ends_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export function shortCycleTrialDays(currentPeriodEnd: string | null, nowMs = Date.now()): number {
  if (!currentPeriodEnd) return 0;
  const end = new Date(currentPeriodEnd).getTime();
  if (!Number.isFinite(end)) return 0;
  const remainingDays = (end - nowMs) / DAY_MS;
  // More than five days left: the combined-limits path applies instead.
  if (remainingDays > SHORT_CYCLE_THRESHOLD_DAYS) return 0;
  // Under a day left: charge immediately, since any trial would outlast the period.
  if (remainingDays < 1) return 0;
  // A Whop trial must be strictly shorter than five days so the first Scale
  // charge lands at the end of the old Growth period, never before it.
  return Math.min(Math.floor(remainingDays), SHORT_CYCLE_THRESHOLD_DAYS - 1);
}

export function combinedWindowEnd(currentPeriodEnd: string | null, nowMs = Date.now()): string | null {
  if (!currentPeriodEnd) return null;
  const end = new Date(currentPeriodEnd).getTime();
  if (!Number.isFinite(end) || end <= nowMs) return null;
  return currentPeriodEnd;
}

export async function listTransitions(env: Bindings, userId: string): Promise<TransitionRow[]> {
  try {
    const result = await tursoQuery(
      env,
      `SELECT * FROM subscription_transitions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );
    return result.rows as TransitionRow[];
  } catch {
    return [];
  }
}

export async function getTransition(env: Bindings, userId: string, id: string): Promise<TransitionRow | null> {
  const result = await tursoQuery(env, `SELECT * FROM subscription_transitions WHERE id = ? AND user_id = ? LIMIT 1`, [id, userId]);
  return (result.rows[0] as TransitionRow) ?? null;
}

async function latestSubscription(env: Bindings, userId: string): Promise<any> {
  const result = await tursoQuery(
    env,
    `SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

async function insertTransition(env: Bindings, row: Omit<TransitionRow, 'created_at' | 'updated_at' | 'completed_at'> & { created_at?: string }): Promise<void> {
  const now = new Date().toISOString();
  await tursoExecute(
    env,
    `INSERT INTO subscription_transitions
      (id, user_id, kind, from_plan, to_plan, from_subscription_id, from_membership_id, offer_key, addon_id, status, whop_checkout_id, whop_checkout_url, whop_membership_id, whop_plan_id, trial_days, starts_at, combined_ends_at, error, created_at, updated_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id,
      row.user_id,
      row.kind,
      row.from_plan ?? null,
      row.to_plan,
      row.from_subscription_id ?? null,
      row.from_membership_id ?? null,
      row.offer_key ?? null,
      row.addon_id ?? null,
      row.status,
      row.whop_checkout_id ?? null,
      row.whop_checkout_url ?? null,
      row.whop_membership_id ?? null,
      row.whop_plan_id ?? null,
      row.trial_days ?? 0,
      row.starts_at ?? null,
      row.combined_ends_at ?? null,
      row.error ?? null,
      row.created_at ?? now,
      now,
      null,
    ]
  );
}

export async function startUpgrade(
  env: Bindings,
  userId: string,
  toPlan: string,
  redirectUrl?: string
): Promise<
  | { ok: true; transition: TransitionRow; checkout_url: string; trial_days: number; mode: 'immediate' | 'short_cycle'; starts_at: string; combined_ends_at: string | null }
  | { ok: false; status: LifecycleErrorStatus; error: string; detail?: string }
> {
  if (!['starter', 'growth', 'scale'].includes(toPlan)) return { ok: false, status: 400, error: 'invalid_plan' };
  const sub = await latestSubscription(env, userId);
  if (!sub || !['active', 'trialing'].includes(String(sub.status))) {
    return { ok: false, status: 409, error: 'no_active_subscription', detail: 'Subscribe to a plan first.' };
  }
  const fromPlan = String(sub.plan_key ?? 'free');
  if (planRank(toPlan) <= planRank(fromPlan)) {
    return { ok: false, status: 400, error: 'not_an_upgrade', detail: 'Use the downgrade flow instead.' };
  }

  // Reuse a fresh pending transition for the same target so a double click does
  // not create two checkouts.
  const existing = await tursoQuery(
    env,
    `SELECT * FROM subscription_transitions WHERE user_id = ? AND kind = 'upgrade' AND to_plan = ? AND status = 'awaiting_payment' ORDER BY created_at DESC LIMIT 1`,
    [userId, toPlan]
  );
  const pending = existing.rows[0] as TransitionRow | undefined;
  if (pending && pending.whop_checkout_url) {
    const age = Date.now() - new Date(pending.created_at).getTime();
    if (age < 2 * 60 * 60 * 1000) {
      return {
        ok: true,
        transition: pending,
        checkout_url: pending.whop_checkout_url,
        trial_days: pending.trial_days,
        mode: pending.trial_days > 0 ? 'short_cycle' : 'immediate',
        starts_at: pending.starts_at ?? new Date().toISOString(),
        combined_ends_at: pending.combined_ends_at,
      };
    }
  }

  const remainingEnd = sub.current_period_end ? String(sub.current_period_end) : null;
  const trialDays = shortCycleTrialDays(remainingEnd);
  const useShortCycle = trialDays > 0;

  let variantId: string | null = null;
  if (useShortCycle) {
    // Whop trials are a variant property. Use a configured short-trial variant
    // when one exists, otherwise fall back to an immediate charge.
    const short = String((env as any).WHOP_PLAN_SCALE_TRIAL ?? '').trim();
    if (short) variantId = short;
  }
  if (!variantId) {
    variantId = String((env as any)[`WHOP_PLAN_${toPlan.toUpperCase()}`] ?? '');
    if (toPlan === 'growth') variantId = (env as any).WHOP_PLAN_GROWTH_STANDARD;
  }
  if (!variantId) {
    return { ok: false, status: 500, error: 'misconfigured', detail: `Plan ${toPlan} is not configured.` };
  }

  const id = generateId('tr');
  const combinedEnd = useShortCycle ? null : combinedWindowEnd(remainingEnd);
  const startsAt = new Date().toISOString();
  const checkout = await whopCreateCheckout(env, variantId, {
    user_id: userId,
    plan: toPlan,
    kind: 'upgrade',
    transition_id: id,
    from_plan: fromPlan,
    from_subscription_id: String(sub.id),
  }, { idempotencyKey: `upgrade-${id}`, redirectUrl });
  if (!checkout) return { ok: false, status: 502, error: 'checkout_failed' };

  const row = {
    id,
    user_id: userId,
    kind: 'upgrade',
    from_plan: fromPlan,
    to_plan: toPlan,
    from_subscription_id: String(sub.id),
    from_membership_id: sub.whop_membership_id ? String(sub.whop_membership_id) : null,
    offer_key: null,
    addon_id: null,
    status: 'awaiting_payment',
    whop_checkout_id: checkout.id,
    whop_checkout_url: checkout.url,
    whop_membership_id: null,
    whop_plan_id: variantId,
    trial_days: useShortCycle ? trialDays : 0,
    starts_at: startsAt,
    combined_ends_at: combinedEnd,
    error: null,
  } as const;
  await insertTransition(env, row);

  return {
    ok: true,
    transition: { ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: null } as TransitionRow,
    checkout_url: checkout.url,
    trial_days: row.trial_days,
    mode: useShortCycle ? 'short_cycle' : 'immediate',
    starts_at: startsAt,
    combined_ends_at: combinedEnd,
  };
}

export async function startDowngrade(
  env: Bindings,
  userId: string,
  toPlan: string,
  redirectUrl?: string
): Promise<
  | { ok: true; transition: TransitionRow; checkout_url: string; canceled_membership: boolean }
  | { ok: false; status: LifecycleErrorStatus; error: string; detail?: string }
> {
  if (!['free', 'starter', 'growth', 'scale'].includes(toPlan)) return { ok: false, status: 400, error: 'invalid_plan' };
  const sub = await latestSubscription(env, userId);
  if (!sub || !['active', 'trialing'].includes(String(sub.status))) {
    return { ok: false, status: 409, error: 'no_active_subscription' };
  }
  const fromPlan = String(sub.plan_key ?? 'free');
  if (planRank(toPlan) >= planRank(fromPlan)) {
    return { ok: false, status: 400, error: 'not_a_downgrade', detail: 'Use the upgrade flow instead.' };
  }

  const existing = await tursoQuery(
    env,
    `SELECT * FROM subscription_transitions WHERE user_id = ? AND kind = 'downgrade' AND to_plan = ? AND status = 'awaiting_payment' ORDER BY created_at DESC LIMIT 1`,
    [userId, toPlan]
  );
  const pending = existing.rows[0] as TransitionRow | undefined;
  if (pending && pending.whop_checkout_url) {
    const age = Date.now() - new Date(pending.created_at).getTime();
    if (age < 2 * 60 * 60 * 1000) {
      return { ok: true, transition: pending, checkout_url: pending.whop_checkout_url, canceled_membership: true };
    }
  }

  // Rule: cancel the higher-tier membership first, then show the new checkout.
  if (sub.whop_membership_id) {
    const ok = await whopCancelMembership(env, String(sub.whop_membership_id), { atPeriodEnd: true });
    if (!ok) return { ok: false, status: 502, error: 'cancel_failed', detail: 'Could not cancel the existing subscription. Try again.' };
    await tursoExecute(
      env,
      `UPDATE subscriptions SET cancel_at_period_end = 1, canceled_at = ?, updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), new Date().toISOString(), sub.id]
    );
  }

  const variantId = toPlan === 'free' ? null : String((env as any)[`WHOP_PLAN_${toPlan.toUpperCase()}`] ?? '');
  if (toPlan !== 'free' && !variantId) {
    return { ok: false, status: 500, error: 'misconfigured', detail: `Plan ${toPlan} is not configured.` };
  }

  const id = generateId('tr');
  let checkoutUrl = '';
  let checkoutId: string | null = null;
  if (toPlan !== 'free' && variantId) {
    const checkout = await whopCreateCheckout(env, variantId, {
      user_id: userId,
      plan: toPlan,
      kind: 'downgrade',
      transition_id: id,
      from_plan: fromPlan,
      from_subscription_id: String(sub.id),
    }, { idempotencyKey: `downgrade-${id}`, redirectUrl });
    if (!checkout) return { ok: false, status: 502, error: 'checkout_failed' };
    checkoutUrl = checkout.url;
    checkoutId = checkout.id;
  } else {
    // Downgrading to free: no checkout. Schedule the transition as completed at period end.
    checkoutUrl = '';
  }

  const row = {
    id,
    user_id: userId,
    kind: 'downgrade',
    from_plan: fromPlan,
    to_plan: toPlan,
    from_subscription_id: String(sub.id),
    from_membership_id: sub.whop_membership_id ? String(sub.whop_membership_id) : null,
    offer_key: null,
    addon_id: null,
    status: toPlan === 'free' ? 'completed' : 'awaiting_payment',
    whop_checkout_id: checkoutId,
    whop_checkout_url: checkoutUrl,
    whop_membership_id: null,
    whop_plan_id: toPlan === 'free' ? null : variantId,
    trial_days: 0,
    starts_at: new Date().toISOString(),
    combined_ends_at: null,
    error: null,
  } as const;
  await insertTransition(env, row);

  if (toPlan === 'free') {
    await tursoExecute(env, `UPDATE users SET plan = ?, updated_at = ? WHERE id = ?`, [toPlan, new Date().toISOString(), userId]);
  }

  return { ok: true, transition: { ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: toPlan === 'free' ? new Date().toISOString() : null } as TransitionRow, checkout_url: checkoutUrl, canceled_membership: true };
}

export async function startCapacityCheckout(
  env: Bindings,
  userId: string,
  offerKey: string,
  redirectUrl?: string
): Promise<
  | { ok: true; addon_id: string; transition_id: string; checkout_url: string; offer: typeof CAPACITY_OFFERS[keyof typeof CAPACITY_OFFERS] }
  | { ok: false; status: LifecycleErrorStatus; error: string; detail?: string }
> {
  const offer = CAPACITY_OFFERS[offerKey as keyof typeof CAPACITY_OFFERS];
  if (!offer) return { ok: false, status: 400, error: 'invalid_offer' };
  const variantId = capacityOfferPlanId(env, offer);
  if (!variantId) {
    return {
      ok: false,
      status: 501,
      error: 'not_configured',
      detail: `${offer.planEnvVar} is not set. Configure the Whop variant for this offer before enabling it.`,
    };
  }

  // Only offered to customers who are actually over the combined allowance.
  const snapshot = await getEntitlementSnapshot(env, userId);
  if (!snapshot.over_limit.any) {
    return { ok: false, status: 409, error: 'not_over_limit', detail: 'This offer is only available when usage exceeds the Scale allowance.' };
  }

  const addonId = generateId('add');
  const transitionId = generateId('tr');
  const priceCents = capacityOfferPriceCents(env, offer);
  const checkout = await whopCreateCheckout(env, variantId, {
    user_id: userId,
    plan: 'capacity',
    kind: 'capacity',
    transition_id: transitionId,
    addon_id: addonId,
    offer_key: offer.key,
  }, { idempotencyKey: `capacity-${addonId}`, redirectUrl });
  if (!checkout) return { ok: false, status: 502, error: 'checkout_failed' };

  const now = new Date().toISOString();
  await tursoExecute(
    env,
    `INSERT INTO capacity_addons (id, user_id, offer_key, status, whop_checkout_id, whop_plan_id, amount_cents, currency, billing_interval, storage_gb, active_documents, protected_documents, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      addonId,
      userId,
      offer.key,
      'pending',
      checkout.id,
      variantId,
      priceCents,
      offer.currency,
      offer.interval,
      offer.storageGb,
      offer.activeDocuments,
      offer.activeDocuments === 0 ? 1 : 0, // protection flag for protect-only
      now,
      now,
    ]
  );
  await insertTransition(env, {
    id: transitionId,
    user_id: userId,
    kind: 'capacity',
    from_plan: snapshot.plan,
    to_plan: offer.key,
    from_subscription_id: null,
    from_membership_id: null,
    offer_key: offer.key,
    addon_id: addonId,
    status: 'awaiting_payment',
    whop_checkout_id: checkout.id,
    whop_checkout_url: checkout.url,
    whop_membership_id: null,
    whop_plan_id: variantId,
    trial_days: 0,
    starts_at: now,
    combined_ends_at: null,
    error: null,
  });

  return { ok: true, addon_id: addonId, transition_id: transitionId, checkout_url: checkout.url, offer };
}

export async function cancelTransition(env: Bindings, userId: string, transitionId: string): Promise<{ ok: true; status: 200 } | { ok: false; status: LifecycleErrorStatus; error: string }> {
  const transition = await getTransition(env, userId, transitionId);
  if (!transition) return { ok: false, status: 404, error: 'not_found' };
  if (transition.status !== 'awaiting_payment') return { ok: false, status: 409, error: 'not_pending' };

  const now = new Date().toISOString();
  await tursoExecute(env, `UPDATE subscription_transitions SET status = 'canceled', updated_at = ? WHERE id = ?`, [now, transitionId]);

  // Reverse a downgrade's pending cancellation when the customer abandons it.
  if (transition.kind === 'downgrade' && transition.from_membership_id) {
    await whopReverseCancellation(env, transition.from_membership_id);
    await tursoExecute(
      env,
      `UPDATE subscriptions SET cancel_at_period_end = 0, canceled_at = NULL, updated_at = ? WHERE whop_membership_id = ?`,
      [now, transition.from_membership_id]
    );
  }
  if (transition.kind === 'capacity' && transition.addon_id) {
    await tursoExecute(env, `UPDATE capacity_addons SET status = 'canceled', updated_at = ? WHERE id = ?`, [now, transition.addon_id]);
  }
  return { ok: true, status: 200 };
}

export async function pauseSubscription(env: Bindings, userId: string, until?: string): Promise<{ ok: true; status: 200 } | { ok: false; status: LifecycleErrorStatus; error: string }> {
  const sub = await latestSubscription(env, userId);
  if (!sub || !['active', 'trialing'].includes(String(sub.status))) {
    return { ok: false, status: 409, error: 'no_active_subscription' };
  }
  if (!sub.whop_membership_id) return { ok: false, status: 409, error: 'no_membership' };

  const membership = await whopPauseMembership(env, String(sub.whop_membership_id), { until });
  if (!membership) return { ok: false, status: 502, error: 'pause_failed' };

  const now = new Date().toISOString();
  const resumeAt = until && Number.isFinite(new Date(until).getTime()) ? until : null;
  await tursoExecute(
    env,
    `INSERT INTO subscription_pauses (id, user_id, subscription_id, whop_membership_id, prior_plan, resume_at, status, paused_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [generateId('pau'), userId, String(sub.id), String(sub.whop_membership_id), String(sub.plan_key), resumeAt, 'paused', now, now, now]
  );
  await tursoExecute(env, `UPDATE subscriptions SET status = 'paused', updated_at = ? WHERE id = ?`, [now, sub.id]);
  // Revercue access follows the intended pause state even though Whop may keep
  // the membership readable during the pause.
  await tursoExecute(env, `UPDATE users SET plan = 'free', plan_expires_at = NULL, updated_at = ? WHERE id = ?`, [now, userId]);
  return { ok: true, status: 200 };
}

export async function resumeSubscription(env: Bindings, userId: string): Promise<{ ok: true; status: 200 } | { ok: false; status: LifecycleErrorStatus; error: string }> {
  const pause = await tursoQuery(
    env,
    `SELECT * FROM subscription_pauses WHERE user_id = ? AND status = 'paused' ORDER BY paused_at DESC LIMIT 1`,
    [userId]
  );
  const row = pause.rows[0];
  if (!row) return { ok: false, status: 409, error: 'not_paused' };
  const sub = await latestSubscription(env, userId);
  if (!sub?.whop_membership_id) return { ok: false, status: 409, error: 'no_membership' };

  const membership = await whopResumeMembership(env, String(sub.whop_membership_id));
  if (!membership) return { ok: false, status: 502, error: 'resume_failed' };

  const now = new Date().toISOString();
  const priorPlan = String(row.prior_plan ?? 'growth');
  await tursoExecute(env, `UPDATE subscription_pauses SET status = 'resumed', resumed_at = ?, updated_at = ? WHERE id = ?`, [now, now, row.id]);
  await tursoExecute(env, `UPDATE subscriptions SET status = 'active', updated_at = ? WHERE id = ?`, [now, sub.id]);
  await tursoExecute(env, `UPDATE users SET plan = ?, updated_at = ? WHERE id = ?`, [priorPlan, now, userId]);
  return { ok: true, status: 200 };
}

/**
 * Complete a transition from trusted Whop membership data. Idempotent: a
 * second call (replayed webhook) finds the transition already completed and
 * returns without changing anything.
 */
export async function completeTransition(
  env: Bindings,
  transitionId: string,
  membershipId: string | null,
  membershipStatus: string,
  periodEnd: string | null
): Promise<{ ok: boolean; already?: boolean }> {
  const result = await tursoQuery(env, `SELECT * FROM subscription_transitions WHERE id = ? LIMIT 1`, [transitionId]);
  const transition = result.rows[0] as TransitionRow | undefined;
  if (!transition) return { ok: false };
  if (transition.status === 'completed') return { ok: true, already: true };
  if (!['active', 'trialing', 'completed'].includes(membershipStatus)) return { ok: false };

  const now = new Date().toISOString();
  const userId = transition.user_id;
  const toPlan = transition.to_plan;

  // Capacity add-ons activate against their own table.
  if (transition.kind === 'capacity' && transition.addon_id) {
    await tursoExecute(
      env,
      `UPDATE capacity_addons SET status = 'active', whop_membership_id = COALESCE(?, whop_membership_id), starts_at = ?, updated_at = ? WHERE id = ?`,
      [membershipId, now, now, transition.addon_id]
    );
  }

  // Insert or update the subscription row for the new membership.
  let subId = transition.from_subscription_id;
  if (membershipId) {
    const existing = await tursoQuery(env, `SELECT id FROM subscriptions WHERE whop_membership_id = ? LIMIT 1`, [membershipId]);
    if (existing.rows.length) {
      subId = String(existing.rows[0].id);
      await tursoExecute(
        env,
        `UPDATE subscriptions SET plan_key = ?, status = 'active', current_period_end = COALESCE(?, current_period_end), updated_at = ? WHERE id = ?`,
        [toPlan === 'capacity' ? transition.from_plan ?? 'scale' : toPlan, periodEnd, now, subId]
      );
    } else {
      subId = generateId('sub');
      await tursoExecute(
        env,
        `INSERT INTO subscriptions (id, user_id, provider, whop_membership_id, whop_plan_id, plan_key, status, current_period_end, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [subId, userId, 'whop', membershipId, transition.whop_plan_id, toPlan === 'capacity' ? transition.from_plan ?? 'scale' : toPlan, 'active', periodEnd, now, now]
      );
    }
  }

  // Cancel the old membership only after the new one is active.
  if (transition.kind === 'upgrade' && transition.from_membership_id && transition.from_membership_id !== membershipId) {
    await whopCancelMembership(env, transition.from_membership_id, { atPeriodEnd: true });
    await tursoExecute(
      env,
      `UPDATE subscriptions SET cancel_at_period_end = 1, canceled_at = COALESCE(canceled_at, ?), updated_at = ? WHERE whop_membership_id = ?`,
      [now, now, transition.from_membership_id]
    );
  }

  // End the Growth trial window so it cannot later downgrade the customer.
  const trial = await getActiveTrial(env, userId);
  if (trial) await endGrowthTrial(env, userId, 'converted', toPlan === 'capacity' ? 'scale' : toPlan);

  await tursoExecute(
    env,
    `UPDATE users SET plan = ?, plan_expires_at = NULL, updated_at = ? WHERE id = ?`,
    [toPlan === 'capacity' ? 'scale' : toPlan, now, userId]
  );

  // Temporary combined window for an upgrade that happened with >5 days left.
  if (transition.kind === 'upgrade' && transition.combined_ends_at) {
    const existingWindow = await tursoQuery(
      env,
      `SELECT id FROM combined_limit_windows WHERE user_id = ? AND ends_at = ? AND status = 'active' LIMIT 1`,
      [userId, transition.combined_ends_at]
    );
    if (!existingWindow.rows.length) {
      await tursoExecute(
        env,
        `INSERT INTO combined_limit_windows (id, user_id, source_subscription_id, source_plan, starts_at, ends_at, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [generateId('cwin'), userId, subId, 'growth', transition.starts_at ?? now, transition.combined_ends_at, 'active', now, now]
      );
    }
  }

  await tursoExecute(
    env,
    `UPDATE subscription_transitions SET status = 'completed', whop_membership_id = COALESCE(?, whop_membership_id), completed_at = ?, updated_at = ? WHERE id = ?`,
    [membershipId, now, now, transitionId]
  );
  return { ok: true };
}

export async function verifyTransition(
  env: Bindings,
  userId: string,
  transitionId: string,
  membershipId?: string | null,
  paymentId?: string | null
): Promise<{ ok: true; status: 200 | 202; completed?: boolean; pending?: boolean; membership?: any } | { ok: false; status: LifecycleErrorStatus; error: string; pending?: boolean }> {
  const transition = await getTransition(env, userId, transitionId);
  if (!transition) return { ok: false, status: 404, error: 'not_found' };
  if (transition.status === 'completed') return { ok: true, status: 200, completed: true };

  // Optional payment confirmation: never sufficient alone, but useful to reject
  // an obviously unpaid attempt before asking Whop for the membership.
  if (paymentId) {
    const payment = await whopPaymentStatus(env, paymentId);
    if (payment && !payment.succeeded) {
      return { ok: false, status: 402, error: 'payment_not_succeeded', pending: true };
    }
  }

  const resolvedMembershipId = membershipId || transition.whop_membership_id;
  let membership: any = null;
  if (resolvedMembershipId) {
    membership = await whopGetMembership(env, resolvedMembershipId);
  }

  // Webhook may not have arrived yet. Trust only a Whop membership that names
  // this user and transition in its metadata.
  if (membership) {
    const meta = (membership.metadata ?? {}) as Record<string, string>;
    const metaUser = meta.user_id ?? meta.userId ?? null;
    const metaTransition = meta.transition_id ?? null;
    const userOk = !metaUser || metaUser === userId;
    const transitionOk = !metaTransition || metaTransition === transitionId;
    if (userOk && transitionOk && ['active', 'trialing', 'completed'].includes(String(membership.status))) {
      await completeTransition(env, transitionId, membership.id, String(membership.status), membership.current_period_end);
      return { ok: true, status: 200, completed: true, membership };
    }
  }

  return { ok: true, status: 202, pending: true, membership };
}

export async function expireEntitlementWindows(env: Bindings): Promise<void> {
  const now = new Date().toISOString();
  try {
    await tursoExecute(env, `UPDATE combined_limit_windows SET status = 'expired', updated_at = ? WHERE status = 'active' AND ends_at <= ?`, [now, now]);
  } catch (error) {
    console.error('COMBINED_WINDOW_EXPIRE_FAILED', error);
  }
  try {
    await tursoExecute(env, `UPDATE capacity_addons SET status = 'expired', updated_at = ? WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= ?`, [now, now]);
  } catch (error) {
    console.error('CAPACITY_ADDON_EXPIRE_FAILED', error);
  }
  // Do not touch users.plan here: combined windows only add capacity, they do
  // not change the plan itself.
}

export async function getCapacityOptions(env: Bindings, userId: string) {
  const snapshot = await getEntitlementSnapshot(env, userId);
  if (!snapshot.over_limit.any) {
    return { available: false, reason: 'not_over_limit', offers: [], decline_notice: null };
  }
  const offers = CAPACITY_OFFER_LIST.map((offer) => ({
    key: offer.key,
    name: offer.name,
    summary: offer.summary,
    amount_cents: capacityOfferPriceCents(env, offer),
    currency: offer.currency,
    interval: offer.interval,
    storage_gb: offer.storageGb,
    active_documents: offer.activeDocuments,
    configured: Boolean(capacityOfferPlanId(env, offer)),
  }));
  return {
    available: true,
    offers,
    decline_notice: CAPACITY_DECLINE_NOTICE,
    decline_behaviour: CAPACITY_DECLINE_BEHAVIOUR,
    over_by: snapshot.over_limit.over_by,
  };
}

