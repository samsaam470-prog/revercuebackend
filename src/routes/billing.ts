import { Hono } from 'hono';
import { getAuth } from '../middleware/user-auth';
import { jsonError } from '../utils/api-errors';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import { whopBase, whopHeaders, planIdFor, whopCreateCheckout, whopCancelMembership } from '../services/whop';
import {
  getActiveTrial,
  grantGrowthTrial,
  GROWTH_TRIAL_DAYS,
  GROWTH_TRIAL_ACCESS_PLAN,
} from '../services/trials';
import type { Bindings } from '../types';

const billing = new Hono<{ Bindings: Bindings }>();

/**
 * The 14 days of Scale access are part of Growth itself now, not a promo: the
 * only thing that stops a trial is having used it before.
 */
function growthTrialEligible(alreadyUsedTrial: boolean): boolean {
  return !alreadyUsedTrial;
}

billing.get('/subscription', async (c) => {
  const auth = getAuth(c);
  const rows = await tursoQuery(c.env, `SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [auth.userId]);
  const sub = rows.rows[0] ?? null;
  const payments = await tursoQuery(c.env, `SELECT * FROM subscription_payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, [auth.userId]);

  // If a membership webhook was missed, a trial subscription still gets the
  // access it paid for: the open window is rebuilt from the subscription row.
  let trial = await getActiveTrial(c.env, auth.userId);
  if (!trial && sub && sub.status === 'trialing' && sub.plan_key === 'growth') {
    const trialPlanId = (c.env as any).WHOP_PLAN_GROWTH_TRIAL;
    if (trialPlanId && sub.whop_plan_id === trialPlanId) {
      await grantGrowthTrial(c.env, {
        userId: auth.userId,
        subscriptionId: sub.id,
        endsAt: sub.current_period_end ?? undefined,
      });
      trial = await getActiveTrial(c.env, auth.userId);
    }
  }

  return c.json({ subscription: sub, payments: payments.rows, trial });
});

billing.post('/checkout', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  const planKey = String(body.plan ?? '');
  if (!['starter', 'growth', 'scale'].includes(planKey)) return jsonError(c, 400, 'invalid_payload', 'Unknown plan.');

  // Prevent duplicate active/trialing subscriptions. A stale `pending` row from an
  // abandoned checkout must not block a new attempt, so retire it first.
  const active = await tursoQuery(c.env, `SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing') LIMIT 1`, [auth.userId]);
  if (active.rows.length) return jsonError(c, 409, 'already_subscribed', 'You already have an active subscription.');
  const now0 = new Date().toISOString();
  await tursoExecute(c.env, `UPDATE subscriptions SET status = 'canceled', canceled_at = ?, updated_at = ? WHERE user_id = ? AND status = 'pending'`, [now0, now0, auth.userId]);

  // check prior trial usage for growth
  const priorTrial = await tursoQuery(c.env, `SELECT id FROM subscriptions WHERE user_id = ? AND plan_key = 'growth' AND whop_plan_id = ? LIMIT 1`, [auth.userId, (c.env as any).WHOP_PLAN_GROWTH_TRIAL]);
  const trial = planKey === 'growth' && growthTrialEligible(priorTrial.rows.length > 0);

  const whopPlanId = planIdFor(c.env, planKey, trial);
  if (!whopPlanId) return jsonError(c, 500, 'misconfigured', 'Plan not configured.');

  const checkout = await whopCreateCheckout(c.env, whopPlanId, { user_id: auth.userId, plan: planKey });
  if (!checkout) return jsonError(c, 502, 'checkout_failed', 'Could not create checkout.');

  const now = new Date().toISOString();
  await tursoExecute(c.env, `INSERT INTO subscriptions (id, user_id, provider, whop_plan_id, plan_key, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    [generateId('sub'), auth.userId, 'whop', whopPlanId, planKey, 'pending', now, now]);

  return c.json({
    checkout_id: checkout.id,
    checkout_url: checkout.url,
    trial,
    trial_days: trial ? GROWTH_TRIAL_DAYS : 0,
    trial_access_plan: trial ? GROWTH_TRIAL_ACCESS_PLAN : null,
  });
});

billing.post('/cancel', async (c) => {
  const auth = getAuth(c);
  const rows = await tursoQuery(c.env, `SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing') ORDER BY created_at DESC LIMIT 1`, [auth.userId]);
  const sub = rows.rows[0];
  if (!sub) return jsonError(c, 404, 'not_found', 'No active subscription.');
  if (sub.whop_membership_id) await whopCancelMembership(c.env, String(sub.whop_membership_id));
  const now = new Date().toISOString();
  await tursoExecute(c.env, `UPDATE subscriptions SET cancel_at_period_end = 1, canceled_at = ?, updated_at = ? WHERE id = ?`, [now, now, sub.id]);
  return c.json({ success: true, cancel_at_period_end: true });
});

billing.post('/reactivate', async (c) => {
  const auth = getAuth(c);
  const rows = await tursoQuery(c.env, `SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [auth.userId]);
  const sub = rows.rows[0];
  if (!sub) return jsonError(c, 404, 'not_found', 'No subscription.');
  const now = new Date().toISOString();
  await tursoExecute(c.env, `UPDATE subscriptions SET cancel_at_period_end = 0, canceled_at = NULL, updated_at = ? WHERE id = ?`, [now, sub.id]);
  return c.json({ success: true });
});

billing.post('/change-plan', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  const toPlan = String(body.plan ?? '');
  if (!['starter', 'growth', 'scale'].includes(toPlan)) return jsonError(c, 400, 'invalid_payload', 'Unknown plan.');
  const rows = await tursoQuery(c.env, `SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [auth.userId]);
  const sub = rows.rows[0];
  if (!sub) return jsonError(c, 404, 'not_found', 'No subscription.');
  const now = new Date().toISOString();
  await tursoExecute(c.env, `INSERT INTO subscription_change_requests (id, user_id, subscription_id, from_plan, to_plan, change_type, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?, ?,?)`,
    [generateId('scr'), auth.userId, sub.id, String(sub.plan_key), toPlan, 'upgrade', 'pending', now, now]);
  return c.json({ success: true, scheduled: true });
});

billing.get('/payments', async (c) => {
  const auth = getAuth(c);
  const rows = await tursoQuery(c.env, `SELECT * FROM subscription_payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [auth.userId]);
  return c.json({ payments: rows.rows });
});

export default billing;
