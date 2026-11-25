// Central commercial configuration for the subscription lifecycle.
//
// Every price, window length and capacity bundle lives here. Routes and
// services read from this module so a price change is one edit, and the
// customer-facing copy on the frontend mirrors the same numbers (see
// revercuefrontend/src/lib/constants.ts -> SCALE_BONUS).
//
// Whop remains the payment provider. Nothing here is a Whop product ID: the
// variant IDs stay in environment variables (WHOP_PLAN_*), and the Capacity
// offers only resolve a variant when the operator has configured one. A missing
// variant is reported to the customer as "not configured" instead of inventing
// a product.

import type { Bindings } from '../types';

/** The complimentary Scale window that starts with a Growth purchase. */
export const SCALE_BONUS_DAYS = 14;
/** The plan a Growth buyer uses during the bonus window. */
export const SCALE_BONUS_PLAN = 'scale';

/**
 * Upgrades inside the last few days of a billing period do not run the
 * combined-limit path. Above this threshold the customer is charged for the new
 * plan immediately and keeps Growth capacity until the old period ends.
 */
export const SHORT_CYCLE_THRESHOLD_DAYS = 5;

export type CapacityOfferKey = 'protect' | 'protect_plus';

export interface CapacityOffer {
  key: CapacityOfferKey;
  name: string;
  summary: string;
  /** Price in the smallest currency unit. */
  amountCents: number;
  currency: string;
  interval: 'one_time' | 'month';
  /** Extra storage granted while the offer is active. 0 = protection only. */
  storageGb: number;
  /** Extra active documents granted while the offer is active. */
  activeDocuments: number;
  /** Environment variable holding the Whop variant ID for this offer. */
  planEnvVar: 'WHOP_PLAN_CAPACITY_PROTECT' | 'WHOP_PLAN_CAPACITY_PROTECT_PLUS';
  /** Environment variable that can override the price for this offer. */
  priceEnvVar: 'CAPACITY_PROTECT_PRICE_CENTS' | 'CAPACITY_PROTECT_PLUS_PRICE_CENTS';
}

export const CAPACITY_OFFERS: Record<CapacityOfferKey, CapacityOffer> = {
  protect: {
    key: 'protect',
    name: 'Data protection',
    summary:
      'Keeps the documents and files you already created beyond the Scale allowance. '
      + 'One payment, no renewal, and no extra ongoing capacity.',
    amountCents: 500,
    currency: 'USD',
    interval: 'one_time',
    storageGb: 0,
    activeDocuments: 0,
    planEnvVar: 'WHOP_PLAN_CAPACITY_PROTECT',
    priceEnvVar: 'CAPACITY_PROTECT_PRICE_CENTS',
  },
  protect_plus: {
    key: 'protect_plus',
    name: 'Data protection + extra capacity',
    summary:
      'Keeps everything you already created and adds 2 GB of storage and 100 active documents '
      + 'on top of Scale. Billed monthly until you cancel.',
    amountCents: 1200,
    currency: 'USD',
    interval: 'month',
    storageGb: 2,
    activeDocuments: 100,
    planEnvVar: 'WHOP_PLAN_CAPACITY_PROTECT_PLUS',
    priceEnvVar: 'CAPACITY_PROTECT_PLUS_PRICE_CENTS',
  },
};

export const CAPACITY_OFFER_LIST: CapacityOffer[] = [CAPACITY_OFFERS.protect, CAPACITY_OFFERS.protect_plus];

/** Price configured centrally, overridable per environment without a code change. */
export function capacityOfferPriceCents(env: Bindings, offer: CapacityOffer): number {
  const override = Number((env as any)[offer.priceEnvVar]);
  return Number.isFinite(override) && override > 0 ? Math.round(override) : offer.amountCents;
}

/** Whop variant for the offer, or null when the operator has not configured one. */
export function capacityOfferPlanId(env: Bindings, offer: CapacityOffer): string | null {
  const value = String((env as any)[offer.planEnvVar] ?? '').trim();
  return value || null;
}

/**
 * What happens when a customer declines both capacity options. Kept next to the
 * prices so the customer-facing copy and the enforcement code cannot drift.
 */
export const CAPACITY_DECLINE_NOTICE =
  'If you decline both options, nothing is deleted. Your existing documents stay viewable and '
  + 'downloadable, but you cannot publish new documents or upload new files until your usage is '
  + 'back inside the normal Scale allowance. Archiving documents is always free.';

export const CAPACITY_DECLINE_BEHAVIOUR = {
  deletes_data: false,
  blocks_new_usage: true,
  keeps_read_and_download: true,
} as const;
