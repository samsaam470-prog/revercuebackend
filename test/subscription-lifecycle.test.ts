import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  basePlanLimits,
  combineLimits,
  computeOverLimit,
  isWindowOpen,
  toWindow,
  windowDaysLeft,
} from '../src/services/entitlements';
import {
  combinedWindowEnd,
  shortCycleTrialDays,
} from '../src/services/subscription-lifecycle';
import {
  CAPACITY_OFFERS,
  capacityOfferPriceCents,
  capacityOfferPlanId,
} from '../src/config/billing';
import { whopCancelMembership, whopPauseMembership, whopResumeMembership, whopCreateCheckout } from '../src/services/whop';
import type { Bindings } from '../src/types';

const DAY = 86_400_000;
const ENV = { WHOP_SANDBOX: 'false', WHOP_PRODUCTION_API: 'test_key', WHOP_PLAN_CAPACITY_PROTECT: 'plan_protect' } as unknown as Bindings;

describe('combined limits', () => {
  it('adds Growth capacity to Scale: 1 GB + 5 GB = 6 GB', () => {
    const scale = basePlanLimits('scale');
    const growth = basePlanLimits('growth');
    const combined = combineLimits(scale, growth);
    expect(scale.storage_mb).toBe(5120);
    expect(growth.storage_mb).toBe(1024);
    expect(combined.storage_mb).toBe(6144);
    expect(combined.active_documents).toBe(400);
  });

  it('never mutates the base limits', () => {
    const scale = basePlanLimits('scale');
    combineLimits(scale, { storage_mb: 99999 });
    expect(scale.storage_mb).toBe(5120);
  });

  it('does not combine during the 14-day bonus (scale limits only)', () => {
    // The bonus window only swaps the plan to Scale; no additive layer runs.
    const snapshotLimits = basePlanLimits('scale');
    expect(snapshotLimits.storage_mb).toBe(5120);
    expect(snapshotLimits.active_documents).toBe(300);
  });

  it('adds a capacity add-on on top of combined limits', () => {
    const combined = combineLimits(basePlanLimits('scale'), basePlanLimits('growth'));
    const withAddon = combineLimits(combined, { storage_mb: 2 * 1024, active_documents: 100 });
    expect(withAddon.storage_mb).toBe(8192);
    expect(withAddon.active_documents).toBe(500);
  });
});

describe('UTC window boundaries', () => {
  const start = '2026-11-01T00:00:00.000Z';
  const end = '2026-11-15T00:00:00.000Z';

  it('reports whole days left and zero at the exact end', () => {
    const justBefore = new Date(end).getTime() - 1;
    expect(windowDaysLeft(end, justBefore)).toBe(1);
    expect(windowDaysLeft(end, new Date(end).getTime())).toBe(0);
    expect(windowDaysLeft(end, new Date(end).getTime() + 1000)).toBe(0);
  });

  it('is not open before it starts or at the closing instant', () => {
    const beforeStart = new Date(start).getTime() - 1;
    expect(isWindowOpen(start, end, beforeStart)).toBe(false);
    expect(isWindowOpen(start, end, new Date(start).getTime())).toBe(true);
    expect(isWindowOpen(start, end, new Date(end).getTime())).toBe(false);
  });

  it('is unaffected by a local daylight-saving change (24h of UTC is one day)', () => {
    // Europe/London springs forward on 2026-03-29; the UTC delta is 24 hours.
    expect(windowDaysLeft('2026-03-30T00:00:00.000Z', new Date('2026-03-29T00:00:00.000Z').getTime())).toBe(1);
  });

  it('marks a window ending in three days or less as ending soon', () => {
    const twoDays = new Date(Date.now() + 2 * DAY).toISOString();
    expect(toWindow(new Date().toISOString(), twoDays).ending_soon).toBe(true);
    const tenDays = new Date(Date.now() + 10 * DAY).toISOString();
    expect(toWindow(new Date().toISOString(), tenDays).ending_soon).toBe(false);
  });

  it('keeps the 14-day bonus ends_at exactly 14 UTC days after the start', () => {
    const bonusStart = new Date('2026-11-01T12:00:00.000Z');
    const ends = new Date(bonusStart.getTime() + 14 * DAY).toISOString();
    expect(ends).toBe('2026-11-15T12:00:00.000Z');
  });
});

describe('short-cycle upgrade rule', () => {
  const now = new Date('2026-11-01T00:00:00.000Z').getTime();

  it('uses the combined-limits path with more than five days left', () => {
    const end = new Date(now + 16 * DAY).toISOString();
    expect(shortCycleTrialDays(end, now)).toBe(0);
  });

  it('uses a trial strictly shorter than five days in the last five days', () => {
    expect(shortCycleTrialDays(new Date(now + 5 * DAY).toISOString(), now)).toBe(4);
    expect(shortCycleTrialDays(new Date(now + 4.9 * DAY).toISOString(), now)).toBe(4);
    expect(shortCycleTrialDays(new Date(now + 3.2 * DAY).toISOString(), now)).toBe(3);
    expect(shortCycleTrialDays(new Date(now + 1.1 * DAY).toISOString(), now)).toBe(1);
  });

  it('charges immediately when less than a day is left', () => {
    expect(shortCycleTrialDays(new Date(now + 0.5 * DAY).toISOString(), now)).toBe(0);
    expect(shortCycleTrialDays(new Date(now - DAY).toISOString(), now)).toBe(0);
    expect(shortCycleTrialDays(null, now)).toBe(0);
  });

  it('ends the combined window at the original Growth period end, never later', () => {
    const end = new Date(now + 16 * DAY).toISOString();
    expect(combinedWindowEnd(end, now)).toBe(end);
    expect(combinedWindowEnd(new Date(now - DAY).toISOString(), now)).toBeNull();
  });
});

describe('over-limit handling', () => {
  const limits = basePlanLimits('scale');

  it('flags the exact overage without deleting anything', () => {
    const result = computeOverLimit({ active_documents: 350, storage_mb: 5500 }, limits);
    expect(result.any).toBe(true);
    expect(result.over_by.active_documents).toBe(50);
    expect(result.over_by.storage_mb).toBe(380);
  });

  it('is not over limit at or under the allowance', () => {
    expect(computeOverLimit({ active_documents: 300, storage_mb: 5120 }, limits).any).toBe(false);
    expect(computeOverLimit({ active_documents: 10, storage_mb: 1 }, limits).any).toBe(false);
  });
});

describe('capacity offers are central and configurable', () => {
  it('ships the agreed starting prices', () => {
    expect(CAPACITY_OFFERS.protect.amountCents).toBe(500);
    expect(CAPACITY_OFFERS.protect.interval).toBe('one_time');
    expect(CAPACITY_OFFERS.protect_plus.amountCents).toBe(1200);
    expect(CAPACITY_OFFERS.protect_plus.interval).toBe('month');
    expect(CAPACITY_OFFERS.protect_plus.storageGb).toBe(2);
    expect(CAPACITY_OFFERS.protect_plus.activeDocuments).toBe(100);
  });

  it('lets an environment override the price without a code change', () => {
    const env = { CAPACITY_PROTECT_PRICE_CENTS: '700' } as unknown as Bindings;
    expect(capacityOfferPriceCents(env, CAPACITY_OFFERS.protect)).toBe(700);
    expect(capacityOfferPriceCents({} as Bindings, CAPACITY_OFFERS.protect)).toBe(500);
  });

  it('reports a missing Whop variant instead of inventing one', () => {
    expect(capacityOfferPlanId(ENV, CAPACITY_OFFERS.protect)).toBe('plan_protect');
    expect(capacityOfferPlanId(ENV, CAPACITY_OFFERS.protect_plus)).toBeNull();
  });
});

describe('Whop calls keep paid access and never send secrets in the body', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 'mem_1', status: 'active', purchase_url: 'https://whop.test/x' }), { status: 200 });
    });
    return calls;
  }

  it('cancels at period end by default', async () => {
    const calls = stubFetch();
    await whopCancelMembership(ENV, 'mem_1');
    const body = JSON.parse(calls[0].init.body);
    expect(calls[0].url).toContain('/memberships/mem_1/cancel');
    expect(body.cancel_at_period_end).toBe(true);
    expect(JSON.stringify(body)).not.toContain('test_key');
  });

  it('pauses without a resume date when none is given, and with `until` when provided', async () => {
    const calls = stubFetch();
    await whopPauseMembership(ENV, 'mem_1');
    expect(JSON.parse(calls[0].init.body)).toEqual({});
    await whopPauseMembership(ENV, 'mem_1', { until: '2026-12-01T00:00:00.000Z' });
    expect(JSON.parse(calls[1].init.body)).toEqual({ until: '2026-12-01T00:00:00.000Z' });
  });

  it('resumes a paused membership', async () => {
    const calls = stubFetch();
    await whopResumeMembership(ENV, 'mem_1');
    expect(calls[0].url).toContain('/memberships/mem_1/resume');
  });

  it('sends an idempotency key for checkout creation', async () => {
    const calls = stubFetch();
    const result = await whopCreateCheckout(ENV, 'plan_scale', { user_id: 'u1' }, { idempotencyKey: 'upgrade-tr1' });
    expect(result?.url).toBe('https://whop.test/x');
    expect(calls[0].init.headers['Idempotency-Key']).toBe('upgrade-tr1');
    expect(JSON.parse(calls[0].init.body).variant_id).toBe('plan_scale');
  });
});
