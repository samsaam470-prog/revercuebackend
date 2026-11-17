import { describe, expect, it } from 'vitest';
import {
  autoDeleteTypes,
  computeDraftExpiry,
  isExpired,
  isWithinWarningWindow,
  shouldDelete,
  warningIdempotencyKey,
} from '../src/services/retention';
import type { Bindings } from '../src/types';

const DAY = 86400000;
const now = new Date('2026-11-17T09:00:00.000Z');

describe('retention policy', () => {
  it('warns exactly ten days before expiry', () => {
    expect(isWithinWarningWindow(new Date(now.getTime() + 10 * DAY).toISOString(), now, 10)).toBe(true);
    expect(isWithinWarningWindow(new Date(now.getTime() + 9.5 * DAY).toISOString(), now, 10)).toBe(true);
    expect(isWithinWarningWindow(new Date(now.getTime() + 11 * DAY).toISOString(), now, 10)).toBe(false);
    expect(isWithinWarningWindow(new Date(now.getTime() - DAY).toISOString(), now, 10)).toBe(false);
    expect(isWithinWarningWindow('not-a-date', now, 10)).toBe(false);
  });

  it('treats the expiry instant as expired', () => {
    expect(isExpired(now.toISOString(), now)).toBe(true);
    expect(isExpired(new Date(now.getTime() + DAY).toISOString(), now)).toBe(false);
  });

  it('builds a stable idempotency key per document, expiry and window', () => {
    const key = warningIdempotencyKey('proposal', 'p1', '2026-11-27T09:00:00.000Z', 10);
    expect(key).toBe('proposal:p1:2026-11-27:10');
    // Same expiry at a different time of day must not produce a second warning.
    expect(warningIdempotencyKey('proposal', 'p1', '2026-11-27T23:00:00.000Z', 10)).toBe(key);
    expect(warningIdempotencyKey('contract', 'p1', '2026-11-27T09:00:00.000Z', 10)).not.toBe(key);
  });

  it('computes draft expiry only from a valid creation time and retention window', () => {
    expect(computeDraftExpiry('2026-11-01T00:00:00.000Z', 30)).toBe('2026-12-01T00:00:00.000Z');
    expect(computeDraftExpiry('2026-11-01T00:00:00.000Z', 0)).toBeNull();
    expect(computeDraftExpiry(null, 30)).toBeNull();
    expect(computeDraftExpiry('garbage', 30)).toBeNull();
  });

  it('defaults to deleting only proposals and contracts', () => {
    const env = { RETENTION_AUTO_DELETE_TYPES: '' } as unknown as Bindings;
    expect(autoDeleteTypes(env).sort()).toEqual(['contract', 'proposal']);
  });

  it('never auto-deletes invoices or forms, even when configured', () => {
    const env = { RETENTION_AUTO_DELETE_TYPES: 'proposal,contract,invoice,form' } as unknown as Bindings;
    const types = autoDeleteTypes(env);
    expect(types).toContain('proposal');
    expect(types).toContain('contract');
    expect(shouldDelete('invoice', types)).toBe(false);
    expect(shouldDelete('form', types)).toBe(false);
  });

  it('honours a restricted configuration', () => {
    const env = { RETENTION_AUTO_DELETE_TYPES: 'contract' } as unknown as Bindings;
    const types = autoDeleteTypes(env);
    expect(types).toEqual(['contract']);
    expect(shouldDelete('proposal', types)).toBe(false);
  });
});
