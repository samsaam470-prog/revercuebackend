import { Hono } from 'hono';
import { jsonError } from '../utils/api-errors';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import { planKeyFromWhopId } from '../services/whop';
import { grantGrowthTrial, endGrowthTrial } from '../services/trials';
import { completeTransition } from '../services/subscription-lifecycle';
import type { Bindings } from '../types';

/**
 * True when this subscription is still the one that decides the user's plan.
 * An old membership (for example the cancelled Growth one after a Scale
 * purchase) must never write over newer state.
 */
async function isCurrentSubscription(env: Bindings, userId: string, subscriptionId: string | null): Promise<boolean> {
  if (!subscriptionId) return true;
  const rows = await tursoQuery(
    env,
    `SELECT id FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing') ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  const currentId = rows.rows[0]?.id ? String(rows.rows[0].id) : null;
  return !currentId || currentId === subscriptionId;
}

/**
 * A Growth purchase includes fourteen days of Scale access. Whop's trial only
 * discounts the plan that was bought, so `users.plan` holds the effective plan:
 * Scale while the Growth trial is open, Growth once it converts or ends.
 */
async function syncPlanForMembership(
  env: Bindings,
  input: {
    userId: string;
    subscriptionId: string | null;
    planKey: string;
    status: string;
    whopPlanId: string | null;
    periodEnd: string | null;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const trialPlanId = (env as any).WHOP_PLAN_GROWTH_TRIAL ?? null;
  const isGrowthTrial =
    input.planKey === 'growth' && Boolean(trialPlanId) && input.whopPlanId === trialPlanId;

  if (!(await isCurrentSubscription(env, input.userId, input.subscriptionId))) {
    // Old membership: record the row but never touch the user's plan.
    return;
  }

  if (input.status === 'trialing') {
    if (isGrowthTrial) {
      await grantGrowthTrial(env, {
        userId: input.userId,
        subscriptionId: input.subscriptionId,
        endsAt: input.periodEnd ?? undefined,
      });
      return;
    }
    await tursoExecute(env, `UPDATE users SET plan = ?, updated_at = ? WHERE id = ?`, [
      input.planKey,
      now,
      input.userId,
    ]);
    return;
  }

  if (['active', 'completed'].includes(input.status)) {
    if (isGrowthTrial) await endGrowthTrial(env, input.userId, 'converted', input.planKey);
    await tursoExecute(env, `UPDATE users SET plan = ?, updated_at = ? WHERE id = ?`, [
      input.planKey,
      now,
      input.userId,
    ]);
    return;
  }

  if (input.status === 'past_due' || input.status === 'unresolved') {
    // A failed charge is not a cancellation: keep the plan while Whop retries.
    await tursoExecute(env, `UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE id = ?`, [
      now,
      input.subscriptionId,
    ]).catch(() => undefined);
    return;
  }

  if (['canceled', 'expired'].includes(input.status)) {
    if (isGrowthTrial) await endGrowthTrial(env, input.userId, 'canceled', input.planKey);
    // The paid period is over: no other active membership means the account
    // settles on Free. Documents are untouched (they are archived, never
    // deleted, and nothing here writes to a document table).
    const other = await tursoQuery(
      env,
      `SELECT id FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing') AND id != ? LIMIT 1`,
      [input.userId, input.subscriptionId]
    ).catch(() => ({ rows: [] as any[] }));
    if (!other.rows.length) {
      await tursoExecute(env, `UPDATE users SET plan = 'free', plan_expires_at = NULL, updated_at = ? WHERE id = ?`, [
        now,
        input.userId,
      ]);
    }
  }
}

const webhooks = new Hono<{ Bindings: Bindings }>();

async function verifySignature(env: Bindings, raw: string, headers: Headers): Promise<boolean> {
  const secret = (env as any).WHOP_WEBHOOK_SECRET;
  if (!secret) return true; // allow if not configured (dev)
  const webhookId = headers.get('webhook-id');
  const webhookTimestamp = headers.get('webhook-timestamp');
  const webhookSignature = headers.get('webhook-signature');
  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;
  const signedContent = `${webhookId}.${webhookTimestamp}.${raw}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(signedContent));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return webhookSignature.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    return version === 'v1' && sig === expected;
  });
}

function extractUserId(data: any): string | null {
  return data?.metadata?.user_id ?? data?.user_id ?? data?.user?.id ?? null;
}

function extractPlanId(data: any): string | null {
  return data?.variant_id ?? data?.plan?.id ?? data?.plan_id ?? null;
}

function extractPeriodEnd(data: any): string | null {
  return data?.current_period_end ?? data?.renewal_period_end ?? data?.expires_at ?? null;
}

webhooks.post('/whop', async (c) => {
  const raw = await c.req.text();
  if (!(await verifySignature(c.env, raw, c.req.raw.headers))) return jsonError(c, 401, 'invalid_signature', 'Invalid webhook signature.');

  let event: any;
  try { event = JSON.parse(raw); } catch { return jsonError(c, 400, 'invalid_payload', 'Invalid JSON.'); }

  const eventId = String(event.id ?? event.event_id ?? generateId('whe'));
  const eventType = String(event.type ?? event.event_type ?? 'unknown');
  const objectId = String(event.data?.id ?? event.object_id ?? '');

  const existing = await tursoQuery(c.env, `SELECT id FROM whop_webhook_events WHERE id = ? LIMIT 1`, [eventId]);
  if (existing.rows.length) return c.json({ received: true, duplicate: true });

  const now = new Date().toISOString();
  await tursoExecute(c.env, `INSERT INTO whop_webhook_events (id, event_type, provider_object_id, processing_status, received_at) VALUES (?,?,?,?,?)`,
    [eventId, eventType, objectId, 'received', now]);

  try {
    const data = event.data ?? {};

    if (eventType.includes('membership')) {
      const membershipId = objectId;
      const status = String(data.status ?? '').toLowerCase() || 'active';
      const userId = extractUserId(data);
      const whopPlanId = extractPlanId(data);
      const periodEnd = extractPeriodEnd(data);
      const metadataPlan = data?.metadata?.plan ?? null;

      // Find existing subscription row: by membership id first, then by user.
      let sub: any = null;
      if (membershipId) {
        const r = await tursoQuery(c.env, `SELECT * FROM subscriptions WHERE whop_membership_id = ? LIMIT 1`, [membershipId]);
        sub = r.rows[0] ?? null;
      }
      if (!sub && userId) {
        const r = await tursoQuery(c.env, `SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [userId]);
        sub = r.rows[0] ?? null;
      }

      const metadata = (data.metadata && typeof data.metadata === 'object' ? data.metadata : {}) as Record<string, string>;

      // A membership created from one of our checkouts completes the pending
      // transition only from this verified Whop data — never from a redirect.
      if (metadata.transition_id) {
        await completeTransition(c.env, String(metadata.transition_id), membershipId || null, status, periodEnd).catch((e) =>
          console.error('TRANSITION_COMPLETE_FAILED', e)
        );
      }

      if (sub) {
        const planKey = sub.plan_key;
        await tursoExecute(c.env,
          `UPDATE subscriptions SET whop_membership_id = COALESCE(whop_membership_id, ?), whop_plan_id = COALESCE(whop_plan_id, ?), status = ?, cancel_at_period_end = ?, current_period_end = COALESCE(?, current_period_end), updated_at = ? WHERE id = ?`,
          [membershipId, whopPlanId, status, data.cancel_at_period_end ? 1 : 0, periodEnd, now, sub.id]);
        await syncPlanForMembership(c.env, {
          userId: sub.user_id,
          subscriptionId: sub.id,
          planKey,
          status,
          whopPlanId: whopPlanId ?? sub.whop_plan_id ?? null,
          periodEnd,
        });

        // Pausing is not cancelling. Access follows the pause, and the plan is
        // restored only by an explicit resume.
        const paused = status === 'paused' || Boolean(data.paused_at) || data.most_recent_action === 'paused';
        if (paused) {
          const existingPause = await tursoQuery(
            c.env,
            `SELECT id FROM subscription_pauses WHERE user_id = ? AND status = 'paused' LIMIT 1`,
            [sub.user_id]
          );
          if (!existingPause.rows.length) {
            await tursoExecute(
              c.env,
              `INSERT INTO subscription_pauses (id, user_id, subscription_id, whop_membership_id, prior_plan, status, paused_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
              [generateId('pau'), sub.user_id, sub.id, membershipId, planKey, 'paused', now, now, now]
            ).catch(() => undefined);
          }
          await tursoExecute(c.env, `UPDATE subscriptions SET status = 'paused', updated_at = ? WHERE id = ?`, [now, sub.id]).catch(() => undefined);
          await tursoExecute(c.env, `UPDATE users SET plan = 'free', updated_at = ? WHERE id = ?`, [now, sub.user_id]).catch(() => undefined);
        }
      } else if (userId) {
        // No subscription row yet; create one if we can resolve a plan key.
        let planKey = metadataPlan ?? planKeyFromWhopId(c.env, whopPlanId ?? '');
        if (planKey) {
          const subId = generateId('sub');
          await tursoExecute(c.env,
            `INSERT INTO subscriptions (id, user_id, provider, whop_membership_id, whop_plan_id, plan_key, status, current_period_end, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [subId, userId, 'whop', membershipId, whopPlanId, planKey, status, periodEnd, now, now]);
          await syncPlanForMembership(c.env, {
            userId,
            subscriptionId: subId,
            planKey,
            status,
            whopPlanId: whopPlanId ?? null,
            periodEnd,
          });
        }
      }

      // Update any pending rows for this user to link membership id.
      if (userId && membershipId) {
        await tursoExecute(c.env,
          `UPDATE subscriptions SET whop_membership_id = ?, status = ?, updated_at = ? WHERE user_id = ? AND whop_membership_id IS NULL`,
          [membershipId, status, now, userId]);
      }
    }

    if (eventType.includes('payment')) {
      const paymentId = objectId;
      const amount = Number(data.amount ?? data.total ?? 0);
      const currency = String(data.currency ?? 'usd').toUpperCase();
      const status = String(data.status ?? 'succeeded').toLowerCase();
      const membershipId = data.membership_id ?? data.membership?.id ?? null;
      const subRows = membershipId
        ? await tursoQuery(c.env, `SELECT id, user_id, plan_key FROM subscriptions WHERE whop_membership_id = ? LIMIT 1`, [membershipId])
        : { rows: [] };
      let sub: any = subRows.rows[0] ?? null;
      if (!sub && membershipId) {
        // try by pending rows with same plan? fallback: latest subscription for any user? skip
      }
      // If no sub found by membership, try to resolve via metadata user_id from payment
      if (!sub) {
        const uid = extractUserId(data);
        if (uid) {
          const r = await tursoQuery(c.env, `SELECT id, user_id, plan_key FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [uid]);
          sub = r.rows[0] ?? null;
        }
      }
      await tursoExecute(c.env,
        `INSERT OR IGNORE INTO subscription_payments (id, user_id, subscription_id, whop_payment_id, amount, currency, status, paid_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [generateId('pay'), sub?.user_id ?? extractUserId(data) ?? '', sub?.id ?? null, paymentId, amount, currency, status, now, now, now]);
      const paymentMetadata = (data.metadata && typeof data.metadata === 'object' ? data.metadata : {}) as Record<string, string>;

      if (status === 'succeeded' && paymentMetadata.transition_id) {
        // Payment is confirmed by Whop, but activation still needs the
        // membership; completeTransition is a no-op for a non-active one.
        await completeTransition(
          c.env,
          String(paymentMetadata.transition_id),
          membershipId ? String(membershipId) : null,
          'active',
          null
        ).catch((e) => console.error('TRANSITION_COMPLETE_FAILED', e));
      }

      if (sub && status === 'succeeded') {
        await tursoExecute(c.env, `UPDATE subscriptions SET status = 'active', updated_at = ? WHERE id = ?`, [now, sub.id]);
        // A paid conversion ends the Scale window and settles on the bought plan.
        await endGrowthTrial(c.env, sub.user_id, 'converted', sub.plan_key);
        await tursoExecute(c.env, `UPDATE users SET plan = ?, updated_at = ? WHERE id = ?`, [sub.plan_key, now, sub.user_id]);
      }

      if (sub && ['failed', 'canceled'].includes(status)) {
        // Do not revoke access on a failed renewal: Whop retries, and the plan
        // is only settled when the membership itself is cancelled or expired.
        await tursoExecute(c.env, `UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE id = ?`, [now, sub.id]).catch(() => undefined);
      }
    }

    await tursoExecute(c.env, `UPDATE whop_webhook_events SET processing_status = 'processed', processed_at = ? WHERE id = ?`, [now, eventId]);
  } catch (e: any) {
    await tursoExecute(c.env, `UPDATE whop_webhook_events SET processing_status = 'failed', processed_at = ?, error = ? WHERE id = ?`, [now, String(e?.message ?? e), eventId]);
  }

  return c.json({ received: true });
});

export default webhooks;
