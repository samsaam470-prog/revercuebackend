import { tursoQuery } from '../utils/turso';
import type { Bindings } from '../types';

/**
 * Resolves the user ids an announcement or campaign is aimed at.
 *
 * Lives in a service rather than the admin router because the cron publishes
 * announcements without going through an admin request, and a router importing
 * itself would be a circular dependency.
 */
export async function resolveTargetUsers(env: Bindings, campaign: any): Promise<string[]> {
  const audience = campaign.target_audience ?? 'all';
  if (audience === 'specific' && campaign.target_user_ids) {
    try {
      return JSON.parse(campaign.target_user_ids);
    } catch {
      return [];
    }
  }
  let sql = `SELECT id FROM users`;
  const args: any[] = [];
  const conds: string[] = [];
  if (audience === 'free') {
    conds.push(`plan = 'free'`);
  } else if (audience === 'paid') {
    conds.push(`plan IN ('starter','growth','scale','teams')`);
  } else if (audience === 'active_subscribers') {
    conds.push(`plan IN ('starter','growth','scale','teams')`);
  }
  if (campaign.target_plans) {
    try {
      const plans = JSON.parse(campaign.target_plans);
      if (Array.isArray(plans) && plans.length) {
        conds.push(`plan IN (${plans.map(() => '?').join(',')})`);
        args.push(...plans);
      }
    } catch {}
  }
  if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
  const rows = await tursoQuery(env, sql, args);
  return rows.rows.map((r: any) => String(r.id));
}
