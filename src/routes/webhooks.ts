import { Hono } from 'hono';
import { jsonError } from '../utils/api-errors';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import { planKeyFromWhopId } from '../services/whop';
import type { Bindings } from '../types';

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

      if (sub) {
        const planKey = sub.plan_key;
        await tursoExecute(c.env,
          `UPDATE subscriptions SET whop_membership_id = COALESCE(whop_membership_id, ?), whop_plan_id = COALESCE(whop_plan_id, ?), status = ?, current_period_end = COALESCE(?, current_period_end), updated_at = ? WHERE id = ?`,
          [membershipId, whopPlanId, status, periodEnd, now, sub.id]);
        if (['active', 'trialing'].includes(status)) {
          await tursoExecute(c.env, `UPDATE users SET plan = ?, updated_at = ? WHERE id = ?`, [planKey, now, sub.user_id]);
        }
      } else if (userId) {
        // No subscription row yet; create one if we can resolve a plan key.
        let planKey = metadataPlan ?? planKeyFromWhopId(c.env, whopPlanId ?? '');
        if (planKey) {
          const subId = generateId('sub');
          await tursoExecute(c.env,
            `INSERT INTO subscriptions (id, user_id, provider, whop_membership_id, whop_plan_id, plan_key, status, current_period_end, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [subId, userId, 'whop', membershipId, whopPlanId, planKey, status, periodEnd, now, now]);
          if (['active', 'trialing'].includes(status)) {
            await tursoExecute(c.env, `UPDATE users SET plan = ?, updated_at = ? WHERE id = ?`, [planKey, now, userId]);
          }
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
      if (sub && status === 'succeeded') {
        await tursoExecute(c.env, `UPDATE users SET plan = ?, updated_at = ? WHERE id = ?`, [sub.plan_key, now, sub.user_id]);
        await tursoExecute(c.env, `UPDATE subscriptions SET status = 'active', updated_at = ? WHERE id = ?`, [now, sub.id]);
      }
    }

    await tursoExecute(c.env, `UPDATE whop_webhook_events SET processing_status = 'processed', processed_at = ? WHERE id = ?`, [now, eventId]);
  } catch (e: any) {
    await tursoExecute(c.env, `UPDATE whop_webhook_events SET processing_status = 'failed', processed_at = ?, error = ? WHERE id = ?`, [now, String(e?.message ?? e), eventId]);
  }

  return c.json({ received: true });
});

export default webhooks;
