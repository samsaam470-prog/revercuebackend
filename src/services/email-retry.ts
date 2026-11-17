import { EMAIL_BACKOFF_MINUTES } from '../config/constants';

/**
 * Pure retry policy, extracted so the behaviour is unit-testable without a
 * database or a provider.
 */

export function backoffMinutes(attempts: number): number {
  if (attempts <= 0) return EMAIL_BACKOFF_MINUTES[0];
  const index = Math.min(attempts - 1, EMAIL_BACKOFF_MINUTES.length - 1);
  return EMAIL_BACKOFF_MINUTES[index];
}

export function nextAttemptAt(attempts: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + backoffMinutes(attempts) * 60 * 1000);
}

export function shouldRetry(attempts: number, maxAttempts: number): boolean {
  return attempts < maxAttempts;
}

export type DeliveryStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'abandoned' | 'skipped';

export function isTerminalStatus(status: string): boolean {
  return status === 'sent' || status === 'abandoned' || status === 'skipped';
}
