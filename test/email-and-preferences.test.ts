import { describe, expect, it } from 'vitest';
import { backoffMinutes, isTerminalStatus, nextAttemptAt, shouldRetry } from '../src/services/email-retry';
import {
  DEFAULT_PREFERENCES,
  allowsEmailForEvent,
  mergePreferences,
  parseStoredPreferences,
  preferenceFieldForEvent,
  serializePreferences,
} from '../src/services/notification-preferences';

describe('email retry policy', () => {
  it('grows the backoff and stops at the last configured step', () => {
    const first = backoffMinutes(1);
    const second = backoffMinutes(2);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThanOrEqual(first);
    expect(backoffMinutes(999)).toBe(backoffMinutes(50));
  });

  it('schedules the next attempt in the future', () => {
    const now = new Date('2026-11-17T00:00:00.000Z');
    expect(nextAttemptAt(1, now).getTime()).toBeGreaterThan(now.getTime());
  });

  it('stops retrying at the configured maximum', () => {
    expect(shouldRetry(4, 5)).toBe(true);
    expect(shouldRetry(5, 5)).toBe(false);
    expect(shouldRetry(6, 5)).toBe(false);
  });

  it('knows which statuses are final', () => {
    expect(isTerminalStatus('sent')).toBe(true);
    expect(isTerminalStatus('abandoned')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(false);
    expect(isTerminalStatus('queued')).toBe(false);
  });
});

describe('notification preferences', () => {
  it('maps legacy event keys onto canonical fields', () => {
    const prefs = parseStoredPreferences({
      notifications_enabled: 0,
      notification_events: JSON.stringify({ proposal_accepted: false, invoice_paid: false }),
    });
    expect(prefs.email_enabled).toBe(false);
    expect(prefs.proposal_answered).toBe(false);
    expect(prefs.invoice_paid).toBe(false);
    // Untouched preferences keep their defaults rather than becoming false.
    expect(prefs.form_submitted).toBe(true);
  });

  it('ignores corrupt stored JSON instead of disabling every email', () => {
    const prefs = parseStoredPreferences({ notifications_enabled: 1, notification_events: '{not json' });
    expect(prefs).toEqual(DEFAULT_PREFERENCES);
  });

  it('merges a PATCH body and ignores unknown keys', () => {
    const merged = mergePreferences(DEFAULT_PREFERENCES, {
      contract_action: false,
      unknown_key: true,
      invoice_paid: 'yes',
    });
    expect(merged.contract_action).toBe(false);
    expect(merged.invoice_paid).toBe(true);
    expect((merged as any).unknown_key).toBeUndefined();
  });

  it('round-trips through the stored column shape', () => {
    const merged = mergePreferences(DEFAULT_PREFERENCES, { proposal_opened: false, newsletter_opt_in: true });
    const stored = serializePreferences(merged);
    expect(stored.notifications_enabled).toBe(1);
    expect(stored.newsletter_opt_in).toBe(1);
    const reparsed = parseStoredPreferences(stored);
    expect(reparsed.proposal_opened).toBe(false);
    expect(reparsed.newsletter_opt_in).toBe(true);
  });

  it('gates emails per event and honours the master switch', () => {
    expect(preferenceFieldForEvent('contract_fully_signed')).toBe('contract_action');
    expect(preferenceFieldForEvent('something_unknown')).toBe('email_enabled');
    expect(allowsEmailForEvent(DEFAULT_PREFERENCES, 'proposal_opened')).toBe(true);
    const disabled = { ...DEFAULT_PREFERENCES, proposal_opened: false };
    expect(allowsEmailForEvent(disabled, 'proposal_opened')).toBe(false);
    expect(allowsEmailForEvent({ ...DEFAULT_PREFERENCES, email_enabled: false }, 'invoice_paid')).toBe(false);
  });
});
