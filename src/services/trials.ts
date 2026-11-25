import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import type { Bindings } from '../types';

/**
 * Growth includes fourteen days of Scale access.
 *
 * Whop can only run a trial on the plan that was bought, so the discount is a
 * Whop trial on the Growth plan and the upgrade to Scale is applied here: a
 * `subscription_trials` row records the window, and `users.plan` holds the
 * effective plan while it is open. When the window closes the user settles on
 * the plan they actually bought.
 */
export const GROWTH_TRIAL_DAYS = 14;
export const GROWTH_TRIAL_ACCESS_PLAN = 'scale';

export interface GrowthTrial {
  id: string;
  user_id: string;
  subscription_id: string | null;
  plan_key: string;
  access_plan: string;
  starts_at: string;
  ends_at: string;
  status: string;
  days_left: number;
}

export function trialDaysLeft(endsAt: string): number {
  const remaining = new Date(endsAt).getTime() - Date.now();
  if (!Number.isFinite(remaining)) return 0;
  return Math.max(0, Math.ceil(remaining / 86_400_000));
}

/** The trial a user is inside right now, or null. */
export async function getActiveTrial(env: Bindings, userId: string): Promise<GrowthTrial | null> {
  try {
    const result = await tursoQuery(
      env,
      `SELECT * FROM subscription_trials WHERE user_id = ? AND status = 'active' ORDER BY ends_at DESC LIMIT 1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { ...row, days_left: trialDaysLeft(String(row.ends_at)) } as GrowthTrial;
  } catch (error) {
    // The table ships with migration 0004, so the app keeps serving requests in
    // the seconds between the code deploy and the migration being applied.
    console.error('TRIAL_READ_FAILED', error);
    return null;
  }
}

/** Start the Scale window. `endsAt` comes from Whop's trial end when it has one. */
export async function grantGrowthTrial(
  env: Bindings,
  input: { userId: string; subscriptionId?: string | null; startsAt?: string; endsAt?: string }
): Promise<{ starts_at: string; ends_at: string } | null> {
  const now = new Date().toISOString();
  const startsAt = input.startsAt ?? now;
  const endsAt =
    input.endsAt ?? new Date(Date.now() + GROWTH_TRIAL_DAYS * 86_400_000).toISOString();
  try {
    // One open window per user; a retried webhook must not stack them.
    await tursoExecute(
      env,
      `UPDATE subscription_trials SET status = 'expired', updated_at = ? WHERE user_id = ? AND status = 'active'`,
      [now, input.userId]
    );
    await tursoExecute(
      env,
      `INSERT INTO subscription_trials (id, user_id, subscription_id, plan_key, access_plan, starts_at, ends_at, status, created_at, updated_at)
       VALUES (?, ?, ?, 'growth', ?, ?, ?, 'active', ?, ?)`,
      [
        generateId('trial'),
        input.userId,
        input.subscriptionId ?? null,
        GROWTH_TRIAL_ACCESS_PLAN,
        startsAt,
        endsAt,
        now,
        now,
      ]
    );
    await tursoExecute(
      env,
      `UPDATE users SET plan = ?, plan_expires_at = NULL, updated_at = ? WHERE id = ?`,
      [GROWTH_TRIAL_ACCESS_PLAN, now, input.userId]
    );
    return { starts_at: startsAt, ends_at: endsAt };
  } catch (error) {
    console.error('TRIAL_GRANT_FAILED', error);
    return null;
  }
}

/**
 * Close the open trial. The plan only moves back when the user is still on the
 * trial's access plan, so a later manual upgrade or downgrade is never undone.
 */
export async function endGrowthTrial(
  env: Bindings,
  userId: string,
  status: 'converted' | 'expired' | 'canceled',
  fallbackPlan = 'growth'
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await tursoExecute(
      env,
      `UPDATE subscription_trials SET status = ?, updated_at = ? WHERE user_id = ? AND status = 'active'`,
      [status, now, userId]
    );
    const user = await tursoQuery(env, `SELECT plan FROM users WHERE id = ? LIMIT 1`, [userId]);
    if (String(user.rows[0]?.plan ?? '') === GROWTH_TRIAL_ACCESS_PLAN) {
      await tursoExecute(env, `UPDATE users SET plan = ?, updated_at = ? WHERE id = ?`, [
        fallbackPlan,
        now,
        userId,
      ]);
    }
  } catch (error) {
    console.error('TRIAL_END_FAILED', error);
  }
}

/** Hourly safety net for a missed conversion webhook. */
export async function expireOverdueTrials(env: Bindings): Promise<void> {
  try {
    const now = new Date().toISOString();
    const rows = await tursoQuery(
      env,
      `SELECT user_id, plan_key FROM subscription_trials WHERE status = 'active' AND ends_at <= ?`,
      [now]
    );
    for (const row of rows.rows) {
      await endGrowthTrial(env, String(row.user_id), 'expired', String(row.plan_key || 'growth'));
    }
  } catch (error) {
    console.error('TRIAL_EXPIRY_FAILED', error);
  }
}
