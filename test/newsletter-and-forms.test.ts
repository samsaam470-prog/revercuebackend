import { describe, expect, it } from 'vitest';
import {
  createNewsletterToken,
  isDuplicateSubscription,
  nextStatus,
  verifyNewsletterToken,
} from '../src/services/newsletter';
import { validateAnswers } from '../src/services/form-submissions';
import { parseTags } from '../src/routes/templates';
import type { Bindings } from '../src/types';

const env = { SIGNING_LINK_SECRET: 'unit-test-secret' } as unknown as Bindings;

describe('newsletter subscription state machine', () => {
  it('single opt-in: subscribe is active immediately', () => {
    expect(nextStatus(null, 'subscribe')).toBe('active');
    expect(nextStatus('pending', 'subscribe')).toBe('active');
    expect(nextStatus('active', 'subscribe')).toBe('active');
    // A deliberate resubscription is the only way an unsubscribe is reversed.
    expect(nextStatus('unsubscribed', 'subscribe')).toBe('active');
  });

  it('keeps the legacy confirm action active', () => {
    expect(nextStatus('pending', 'confirm')).toBe('active');
  });

  it('always allows unsubscribing', () => {
    expect(nextStatus('active', 'unsubscribe')).toBe('unsubscribed');
    expect(nextStatus('pending', 'unsubscribe')).toBe('unsubscribed');
  });

  it('treats every existing row as a duplicate row', () => {
    expect(isDuplicateSubscription('pending')).toBe(true);
    expect(isDuplicateSubscription('active')).toBe(true);
    expect(isDuplicateSubscription('unsubscribed')).toBe(true);
    expect(isDuplicateSubscription(null)).toBe(false);
  });

  it('signs and verifies confirm tokens', async () => {
    const token = await createNewsletterToken(env, 'Reader@Example.com', 'confirm');
    const result = await verifyNewsletterToken(env, token, 'confirm');
    expect(result).toEqual({ ok: true, email: 'reader@example.com' });
  });

  it('rejects a token used for the wrong action, tampered, or signed elsewhere', async () => {
    const token = await createNewsletterToken(env, 'reader@example.com', 'confirm');
    expect((await verifyNewsletterToken(env, token, 'unsubscribe')).ok).toBe(false);
    expect((await verifyNewsletterToken(env, `${token}x`, 'confirm')).ok).toBe(false);
    const otherEnv = { SIGNING_LINK_SECRET: 'different-secret' } as unknown as Bindings;
    expect((await verifyNewsletterToken(otherEnv, token, 'confirm')).ok).toBe(false);
  });
});

describe('form answer validation', () => {
  const questions = [
    { id: 'name', label: 'Your name', required: true },
    { id: 'goals', label: 'Goals', required: true },
    { id: 'notes', label: 'Notes', required: false },
  ];

  it('rejects a payload that is not an object', () => {
    expect(validateAnswers(questions, null).ok).toBe(false);
    expect(validateAnswers(questions, []).ok).toBe(false);
    expect(validateAnswers(questions, 'text').ok).toBe(false);
  });

  it('reports missing required answers', () => {
    const result = validateAnswers(questions, { name: 'Ada' });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('Goals');
  });

  it('treats an empty array as missing for a required question', () => {
    const result = validateAnswers([{ id: 'list', label: 'List', required: true }], { list: [] });
    expect(result.ok).toBe(false);
  });

  it('accepts a complete submission and keeps non-required empties', () => {
    const result = validateAnswers(questions, { name: 'Ada', goals: 'Grow', notes: null });
    expect(result.ok).toBe(true);
    expect(result.answers).toEqual({ name: 'Ada', goals: 'Grow', notes: '' });
  });

  it('rejects oversized answers instead of storing them', () => {
    const result = validateAnswers(questions, { name: 'Ada', goals: 'x'.repeat(6000) });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('too long');
  });
});

describe('template tag parsing', () => {
  it('parses comma separated, JSON and array input to trimmed string lists', () => {
    expect(parseTags('web design, SaaS ,, web design')).toEqual(['web design', 'SaaS', 'web design']);
    expect(parseTags(['a', 'b'])).toEqual(['a', 'b']);
    expect(parseTags('["x","y"]')).toEqual(['x', 'y']);
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags('   ')).toEqual([]);
  });
});
