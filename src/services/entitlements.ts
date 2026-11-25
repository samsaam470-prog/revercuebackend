import { tursoQuery } from '../utils/turso';
import {
  ACTIVE_DOCUMENT_LIMIT,
  ADAPTIVE_FORM_LIMIT,
  ARCHIVE_COUNT_LIMIT,
  CUSTOM_TEMPLATE_LIMIT,
  PASSWORD_PROTECTED_LIMIT,
  SAVED_FAQ_LIMIT,
  SAVED_PACKAGE_LIMIT,
  STORAGE_MB,
  type Plan,
} from '../config/constants';
import { CAPACITY_OFFERS, type CapacityOfferKey } from '../config/billing';
import { getActiveTrial, trialDaysLeft } from './trials';
import { dbFirst, dbQuery } from '../utils/db';
import type { Bindings } from '../types';

/**
 * Plan entitlements as the customer actually experiences them.
 *
 * `users.plan` holds the *effective* plan (Scale during the Growth bonus), so
 * the purchased plan is read from the subscription row. Three additive layers
 * sit on top of the base plan:
 *
 *   1. the 14-day Scale bonus (no capacity is combined during it),
 *   2. a temporary combined window after a Scale purchase, which adds the
 *      Growth allowance until the original Growth period ends,
 *   3. capacity add-ons bought after the customer exceeded those limits.
 *
 * Everything is computed from UTC timestamps stored in Turso. The frontend only
 * renders what this module returns; it never decides an entitlement itself.
 */

export interface PlanLimits {
  active_documents: number;
  storage_mb: number;
  archive_count: number;
  password_protected: number;
  adaptive_forms: number;
  saved_faqs: number;
  custom_templates: number;
  saved_packages: number;
}

export type EntitlementStatus =
  | 'free'
  | 'plan'
  | 'scale_bonus'
  | 'combined_limits'
  | 'paused'
  | 'past_due'
  | 'canceled';

export interface EntitlementWindow {
  starts_at: string;
  ends_at: string;
  days_left: number;
  ending_soon: boolean;
}

export interface CombinedWindow extends EntitlementWindow {
  id: string;
  source_plan: string;
  extra: PlanLimits;
}

export interface ActiveAddon {
  id: string;
  offer_key: CapacityOfferKey | string;
  name: string;
  status: string;
  storage_gb: number;
  active_documents: number;
  billing_interval: string;
  amount_cents: number;
  currency: string;
  ends_at: string | null;
}

export interface OverLimit {
  any: boolean;
  active_documents: boolean;
  storage: boolean;
  over_by: { active_documents: number; storage_mb: number };
}

export interface EntitlementSnapshot {
  plan: string;
  purchased_plan: string;
  status: EntitlementStatus;
  limits: PlanLimits;
  base_limits: PlanLimits;
  /** Extra capacity on top of the base plan, itemised for the UI. */
  bonus_limits: Partial<PlanLimits> & { label?: string };
  bonus: EntitlementWindow | null;
  combined: CombinedWindow | null;
  addons: ActiveAddon[];
  usage: { active_documents: number; storage_mb: number };
  over_limit: OverLimit;
  /** True while the customer is inside the last 3 days of any bonus window. */
  ending_soon: boolean;
}

const DOCUMENT_TABLES = ['proposals', 'contracts', 'forms', 'invoices'] as const;

/** Active documents across every document type — one shared allowance. */
export async function countActiveDocuments(env: Bindings, userId: string): Promise<number> {
  const counts = await Promise.all(
    DOCUMENT_TABLES.map((table) =>
      dbFirst<{ c: number }>(
        env,
        `SELECT COUNT(*) as c FROM ${table} WHERE user_id = ? AND status = 'published'`,
        [userId]
      ).catch(() => ({ c: 0 }))
    )
  );
  return counts.reduce((total, row) => total + Number(row?.c ?? 0), 0);
}

const DAY_MS = 86_400_000;
/** A window counts as "ending soon" with three days or less left. */
export const ENDING_SOON_DAYS = 3;

function limitsFor(plan: string): PlanLimits {
  const key = plan as Plan;
  return {
    active_documents: ACTIVE_DOCUMENT_LIMIT[key] ?? 5,
    storage_mb: STORAGE_MB[key] ?? 50,
    archive_count: ARCHIVE_COUNT_LIMIT[key] ?? 5,
    password_protected: PASSWORD_PROTECTED_LIMIT[key] ?? 0,
    adaptive_forms: ADAPTIVE_FORM_LIMIT[key] ?? 0,
    saved_faqs: SAVED_FAQ_LIMIT[key] ?? 0,
    custom_templates: CUSTOM_TEMPLATE_LIMIT[key] ?? 0,
    saved_packages: SAVED_PACKAGE_LIMIT[key] ?? 0,
  };
}

export function basePlanLimits(plan: string): PlanLimits {
  return limitsFor(plan);
}

/** Additive combination; this is the ONE place combined capacity is calculated. */
export function combineLimits(base: PlanLimits, extra: Partial<PlanLimits>): PlanLimits {
  const out = { ...base };
  for (const key of Object.keys(out) as Array<keyof PlanLimits>) {
    out[key] = out[key] + Number(extra[key] ?? 0);
  }
  return out;
}

/** Whole days left, rounded up, never negative. UTC-based. */
export function windowDaysLeft(endsAt: string, nowMs = Date.now()): number {
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.ceil((end - nowMs) / DAY_MS));
}

export function isWindowOpen(startsAt: string | null | undefined, endsAt: string | null | undefined, nowMs = Date.now()): boolean {
  if (!endsAt) return false;
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(end) || end <= nowMs) return false;
  if (!startsAt) return true;
  const start = new Date(startsAt).getTime();
  return !Number.isFinite(start) || start <= nowMs;
}

export function toWindow(startsAt: string, endsAt: string, nowMs = Date.now()): EntitlementWindow {
  const days = windowDaysLeft(endsAt, nowMs);
  return { starts_at: startsAt, ends_at: endsAt, days_left: days, ending_soon: days <= ENDING_SOON_DAYS };
}

/**
 * The extra allowance granted by a combined window: exactly the Growth limits,
 * added to Scale. Growth 1 GB + Scale 5 GB = 6 GB, 100 + 300 documents.
 */
export const COMBINED_EXTRA_PLAN = 'growth';

async function readCombinedWindow(env: Bindings, userId: string): Promise<CombinedWindow | null> {
  try {
    const now = new Date().toISOString();
    const result = await tursoQuery(
      env,
      `SELECT * FROM combined_limit_windows
        WHERE user_id = ? AND status = 'active' AND ends_at > ? AND starts_at <= ?
        ORDER BY ends_at DESC LIMIT 1`,
      [userId, now, now]
    );
    const row = result.rows[0];
    if (!row) return null;
    const extra = limitsFor(String(row.source_plan ?? COMBINED_EXTRA_PLAN));
    return {
      id: String(row.id),
      ...toWindow(String(row.starts_at), String(row.ends_at)),
      source_plan: String(row.source_plan ?? COMBINED_EXTRA_PLAN),
      extra,
    };
  } catch (error) {
    console.error('COMBINED_WINDOW_READ_FAILED', error);
    return null;
  }
}

export async function readActiveAddons(env: Bindings, userId: string): Promise<ActiveAddon[]> {
  try {
    const now = new Date().toISOString();
    const result = await tursoQuery(
      env,
      `SELECT * FROM capacity_addons
        WHERE user_id = ? AND status = 'active' AND (ends_at IS NULL OR ends_at > ?)
        ORDER BY created_at DESC`,
      [userId, now]
    );
    return result.rows.map((row: any) => {
      const offer = CAPACITY_OFFERS[String(row.offer_key) as CapacityOfferKey];
      return {
        id: String(row.id),
        offer_key: String(row.offer_key),
        name: offer?.name ?? 'Capacity add-on',
        status: String(row.status),
        storage_gb: Number(row.storage_gb ?? 0),
        active_documents: Number(row.active_documents ?? 0),
        billing_interval: String(row.billing_interval ?? 'one_time'),
        amount_cents: Number(row.amount_cents ?? 0),
        currency: String(row.currency ?? 'USD'),
        ends_at: row.ends_at ? String(row.ends_at) : null,
      };
    });
  } catch (error) {
    console.error('CAPACITY_ADDON_READ_FAILED', error);
    return [];
  }
}

/** One row of purchased capacity that only exists to protect over-limit data. */
export async function hasProtectionAddon(env: Bindings, userId: string): Promise<boolean> {
  try {
    const result = await tursoQuery(
      env,
      `SELECT id FROM capacity_addons WHERE user_id = ? AND status = 'active' AND protected_documents > 0 LIMIT 1`,
      [userId]
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

/** Pure over-limit calculation, exported so the rules can be tested directly. */
export function computeOverLimit(
  usage: { active_documents: number; storage_mb: number },
  limits: PlanLimits
): OverLimit {
  const overDocs = Math.max(0, Math.ceil(usage.active_documents - limits.active_documents));
  const overStorage = Math.max(0, Math.ceil(usage.storage_mb - limits.storage_mb));
  return {
    any: overDocs > 0 || overStorage > 0,
    active_documents: overDocs > 0,
    storage: overStorage > 0,
    over_by: { active_documents: overDocs, storage_mb: overStorage },
  };
}

export async function readUsage(env: Bindings, userId: string, limits: PlanLimits) {
  const [activeDocs, storage] = await Promise.all([
    countActiveDocuments(env, userId).catch(() => 0),
    dbFirst<{ total: number }>(
      env,
      `SELECT COALESCE(SUM(size_bytes), 0) as total FROM file_uploads WHERE user_id = ?`,
      [userId]
    ).catch(() => ({ total: 0 })),
  ]);
  const storageMb = Number(storage?.total ?? 0) / (1024 * 1024);
  return {
    usage: { active_documents: activeDocs, storage_mb: Number(storageMb.toFixed(2)) },
    over_limit: computeOverLimit({ active_documents: activeDocs, storage_mb: storageMb }, limits),
  };
}

/**
 * The single source of truth for what a customer may use right now.
 * Never throws: a missing lifecycle table degrades to the base plan.
 */
export async function getEntitlementSnapshot(env: Bindings, userId: string): Promise<EntitlementSnapshot> {
  const userRow = await tursoQuery(env, `SELECT plan FROM users WHERE id = ? LIMIT 1`, [userId]).catch(() => ({ rows: [] as any[] }));
  const plan = String(userRow.rows[0]?.plan ?? 'free');

  const [trial, combined, addons, subRows, pauseRows] = await Promise.all([
    getActiveTrial(env, userId),
    readCombinedWindow(env, userId),
    readActiveAddons(env, userId),
    tursoQuery(
      env,
      `SELECT plan_key, status, cancel_at_period_end FROM subscriptions
        WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      [userId]
    ).catch(() => ({ rows: [] as any[] })),
    tursoQuery(env, `SELECT id FROM subscription_pauses WHERE user_id = ? AND status = 'paused' LIMIT 1`, [userId]).catch(
      () => ({ rows: [] as any[] })
    ),
  ]);

  const subscription = subRows.rows[0] ?? null;
  const purchasedPlan = String(subscription?.plan_key ?? (trial ? 'growth' : plan));
  const base = limitsFor(plan);

  let limits = base;
  let bonusLimits: Partial<PlanLimits> & { label?: string } = {};
  if (combined && plan === 'scale') {
    limits = combineLimits(base, combined.extra);
    bonusLimits = { ...combined.extra, label: 'Temporary combined Growth + Scale limits' };
  } else if (trial) {
    // The bonus is normal Scale limits only. Nothing is added here, by design.
    bonusLimits = { label: 'Normal Scale limits during the 14-day bonus' };
  }
  for (const addon of addons) {
    if (!addon.storage_gb && !addon.active_documents) continue;
    limits = combineLimits(limits, {
      storage_mb: addon.storage_gb * 1024,
      active_documents: addon.active_documents,
    });
    bonusLimits = {
      ...bonusLimits,
      label: bonusLimits.label ?? 'Active capacity add-on',
      storage_mb: Number(bonusLimits.storage_mb ?? 0) + addon.storage_gb * 1024,
      active_documents: Number(bonusLimits.active_documents ?? 0) + addon.active_documents,
    };
  }

  const { usage, over_limit } = await readUsage(env, userId, limits);
  const paused = pauseRows.rows.length > 0;
  const status: EntitlementStatus = paused
    ? 'paused'
    : trial && plan === 'scale'
      ? 'scale_bonus'
      : combined && plan === 'scale'
        ? 'combined_limits'
        : subscription && ['past_due', 'unpaid'].includes(String(subscription.status))
          ? 'past_due'
          : plan === 'free'
            ? 'free'
            : 'plan';

  return {
    plan,
    purchased_plan: purchasedPlan,
    status,
    limits,
    base_limits: base,
    bonus_limits: bonusLimits,
    bonus: trial
      ? {
          starts_at: trial.starts_at,
          ends_at: trial.ends_at,
          days_left: trial.days_left ?? trialDaysLeft(trial.ends_at),
          ending_soon: (trial.days_left ?? trialDaysLeft(trial.ends_at)) <= ENDING_SOON_DAYS,
        }
      : null,
    combined,
    addons,
    usage,
    over_limit,
    ending_soon: Boolean(trial && (trial.days_left ?? 0) <= ENDING_SOON_DAYS) || Boolean(combined?.ending_soon),
  };
}

/** Effective limits only — used by upload and publish enforcement. */
export async function getEffectiveLimits(env: Bindings, userId: string): Promise<PlanLimits> {
  const snapshot = await getEntitlementSnapshot(env, userId);
  return snapshot.limits;
}
