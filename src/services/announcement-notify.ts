import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import { resolveTargetUsers } from './audience';
import type { Bindings } from '../types';

/**
 * Types of announcement that also create an in-app notification. A general
 * announcement stays a banner; a feature or maintenance message is something
 * the user needs to be told about even if they never open the dashboard.
 */
const NOTIFY_TYPES = ['feature', 'maintenance', 'important'];

/**
 * Users per INSERT. Every round trip is a subrequest, and a Worker that runs
 * out of subrequests stops mid-loop, so batching keeps the whole audience in
 * reach instead of silently stopping at the request limit.
 */
const INSERT_CHUNK = 25;

export interface AnnouncementNotifyResult {
  /** Users the announcement is addressed to. */
  recipients: number;
  /** Notifications actually written. */
  inserted: number;
  /** Batches that failed; the remaining batches are still attempted. */
  failed_batches: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/**
 * Creates the notification for a published announcement, for every user in its
 * audience. Safe to call on a retry: it reports what happened instead of
 * guessing, and a failed batch is logged rather than swallowed.
 */
export async function notifyAnnouncementAudience(
  env: Bindings,
  announcementId: string
): Promise<AnnouncementNotifyResult> {
  const result: AnnouncementNotifyResult = { recipients: 0, inserted: 0, failed_batches: 0 };

  const rows = await tursoQuery(env, `SELECT * FROM announcements WHERE id = ? LIMIT 1`, [announcementId]);
  const ann: any = rows.rows[0];
  if (!ann || ann.status !== 'published') return result;

  const type = String(ann.type ?? 'general');
  if (!NOTIFY_TYPES.includes(type)) return result;

  const now = new Date().toISOString();
  if (ann.starts_at && String(ann.starts_at) > now) return result;
  if (ann.expires_at && String(ann.expires_at) < now) return result;

  const userIds = await resolveTargetUsers(env, {
    target_audience: ann.target_audience,
    target_plans: ann.target_plans,
  });
  result.recipients = userIds.length;
  if (userIds.length === 0) return result;

  const eventType = type === 'maintenance' ? 'maintenance' : 'feature_release';
  const title = String(ann.title).slice(0, 300);
  const body = ann.body ? String(ann.body) : null;

  for (const batch of chunk(userIds, INSERT_CHUNK)) {
    const placeholders = batch.map(() => '(?, ?, ?, NULL, NULL, ?, ?, 0, 0, ?)').join(', ');
    const args: any[] = [];
    for (const userId of batch) args.push(generateId('notif'), userId, eventType, title, body, now);
    try {
      await tursoExecute(
        env,
        `INSERT INTO notifications (id, user_id, event_type, client_id, document_id, title, body, read, dismissed, created_at) VALUES ${placeholders}`,
        args
      );
      result.inserted += batch.length;
    } catch (error) {
      result.failed_batches += 1;
      console.error('ANNOUNCEMENT_NOTIFY_BATCH_FAILED', announcementId, batch.length, error);
    }
  }

  if (result.inserted !== result.recipients) {
    console.error('ANNOUNCEMENT_NOTIFY_INCOMPLETE', announcementId, result);
  }
  return result;
}
