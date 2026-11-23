import { Hono } from 'hono';
import { jsonError } from '../utils/api-errors';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
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
  // webhook-signature may contain multiple space-separated v1,<sig> entries
  return webhookSignature.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    return version === 'v1' && sig === expected;
  });
}

webhooks.post('/whop', async (c) => {
  const raw = await c.req.text();
  if (!(await verifySignature(c.env, raw, c.req.raw.headers))) return jsonError(c, 401, 'invalid_signature', 'Invalid webhook signature.');

  let event: any;
  try { event = JSON.parse(raw); } catch { return jsonError(c, 400, 'invalid_payload', 'Invalid JSON.'); }

  const eventId = String(event.id ?? event.event_id ?? generateId('whe'));
  const eventType = String(event.type ?? event.event_type ?? 'unknown');
  const objectId = String(event.data?.id ?? event.object_id ?? '');

  // idempotency
  const existing = await tursoQuery(c.env, `SELECT id FROM whop_webhook_events WHERE id = ? LIMIT 1`, [eventId]);
  if (existing.rows.length) return c.json({ received: true, duplicate: true });

  const now = new Date().toISOString();
  await tursoExecute(c.env, `INSERT INTO whop_webhook_events (id, event_type, provider_object_id, processing_status, received_at) VALUES (?,?,?,?,?)`,
    [eventId, eventType, objectId, 'received', now]);

  try {
    // Handle membership/payment events generically
    if (eventType.includes('membership')) {
      const membershipId = objectId;
      const status = String(event.data?.status ?? '').toLowerCase();
      const userId = event.data?.metadata?.user_id ?? null;
      if (userId && membershipId) {
        await tursoExecute(c.env, `UPDATE subscriptions SET whop_membership_id = ?, status = ?, updated_at = ? WHERE user_id = ? AND whop_membership_id IS NULL`,
          [membershipId, status || 'active', now, userId]);
      }
      if (membershipId) {
        await tursoExecute(c.env, `UPDATE subscriptions SET status = ?, updated_at = ? WHERE whop_membership_id = ?`, [status || 'active', now, membershipId]);
      }
    }
    if (eventType.includes('payment')) {
      const paymentId = objectId;
      const amount = Number(event.data?.amount ?? 0);
      const currency = String(event.data?.currency ?? 'usd').toUpperCase();
      const status = String(event.data?.status ?? 'succeeded').toLowerCase();
      const membershipId = event.data?.membership_id ?? null;
      const subRows = membershipId ? await tursoQuery(c.env, `SELECT id, user_id FROM subscriptions WHERE whop_membership_id = ? LIMIT 1`, [membershipId]) : { rows: [] };
      const sub = subRows.rows[0];
      await tursoExecute(c.env, `INSERT OR IGNORE INTO subscription_payments (id, user_id, subscription_id, whop_payment_id, amount, currency, status, paid_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [generateId('pay'), sub?.user_id ?? '', sub?.id ?? null, paymentId, amount, currency, status, now, now, now]);
      if (sub && status === 'succeeded') {
        await tursoExecute(c.env, `UPDATE users SET plan = (SELECT plan_key FROM subscriptions WHERE id = ?), updated_at = ? WHERE id = ?`, [sub.id, now, sub.user_id]);
      }
    }
    await tursoExecute(c.env, `UPDATE whop_webhook_events SET processing_status = 'processed', processed_at = ? WHERE id = ?`, [now, eventId]);
  } catch (e: any) {
    await tursoExecute(c.env, `UPDATE whop_webhook_events SET processing_status = 'failed', processed_at = ?, error = ? WHERE id = ?`, [now, String(e?.message ?? e), eventId]);
  }

  return c.json({ received: true });
});

export default webhooks;
