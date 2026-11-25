import { tursoQuery, tursoExecute } from '../utils/turso';
import { createNotification } from '../services/notifications';
import { notifyAnnouncementAudience } from '../services/announcement-notify';
import { deliverCampaign } from '../routes/admin';
import { expireOverdueTrials } from '../services/trials';
import { expireEntitlementWindows } from '../services/subscription-lifecycle';
import type { Bindings } from '../types';

async function publishScheduledAnnouncements(env: Bindings): Promise<void> {
  const now = new Date().toISOString();
  const rows = await tursoQuery(
    env,
    `SELECT id FROM announcements WHERE status = 'scheduled' AND starts_at IS NOT NULL AND starts_at <= ?`,
    [now]
  );
  for (const r of rows.rows) {
    await tursoExecute(
      env,
      `UPDATE announcements SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, r.id]
    );
    /* A scheduled publish is the same event as an admin one: the audience is
       told, and a partial delivery is logged rather than left silent. */
    await notifyAnnouncementAudience(env, String(r.id)).catch((e) =>
      console.error('ANNOUNCEMENT_NOTIFY_FAILED', r.id, e)
    );
  }
}

async function publishScheduledCampaigns(env: Bindings): Promise<void> {
  const now = new Date().toISOString();
  const rows = await tursoQuery(
    env,
    `SELECT id FROM admin_notification_campaigns WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`,
    [now]
  );
  for (const r of rows.rows) {
    await deliverCampaign(env, r.id);
  }
}

async function sendExpiryReminders(env: Bindings): Promise<void> {
  const now = new Date();
  const soon = new Date(now.getTime() + 3 * 86400000).toISOString();
  const rows = await tursoQuery(
    env,
    `SELECT id, plan, plan_expires_at FROM users WHERE plan IN ('starter','growth','scale','teams') AND plan_expires_at IS NOT NULL AND plan_expires_at <= ? AND plan_expires_at >= ?`,
    [soon, now.toISOString()]
  );
  for (const r of rows.rows) {
    createNotification(env, {
      userId: r.id,
      eventType: 'subscription_expiring',
      title: 'Subscription expiring soon',
      body: `Your ${r.plan} plan expires on ${r.plan_expires_at}. Renew to keep access.`,
    }).catch(() => undefined);
  }
}

export async function runPublishCron(env: Bindings): Promise<void> {
  await publishScheduledAnnouncements(env).catch((e) => console.error('PUBLISH_ANNOUNCEMENTS_FAILED', e));
  await publishScheduledCampaigns(env).catch((e) => console.error('PUBLISH_CAMPAIGNS_FAILED', e));
  await sendExpiryReminders(env).catch((e) => console.error('EXPIRY_REMINDERS_FAILED', e));
  // The 14 days of Scale included with Growth end even if a webhook is missed.
  await expireOverdueTrials(env).catch((e) => console.error('TRIAL_EXPIRY_FAILED', e));
  // Combined-limit windows and time-limited add-ons end on their UTC date, not
  // when a webhook happens to arrive. Expiring them changes capacity only: no
  // document is ever deleted here.
  await expireEntitlementWindows(env).catch((e) => console.error('ENTITLEMENT_EXPIRY_FAILED', e));
}