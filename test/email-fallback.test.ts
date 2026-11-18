import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/types';

const store = vi.hoisted(() => ({ deliveries: [] as any[] }));

function sqlText(value: unknown): string {
  return String(value).replace(/\s+/g, ' ').trim();
}

vi.mock('../src/utils/turso', () => ({
  tursoQuery: vi.fn(async (_env: unknown, rawSql: unknown, args: any[] = []) => {
    const sql = sqlText(rawSql);
    if (sql.includes('WHERE idempotency_key = ?')) {
      const row = store.deliveries.find((item) => item.idempotency_key === args[0]);
      return { rows: row ? [{ id: row.id, status: row.status, attempts: row.attempts }] : [], columns: [] };
    }
    if (sql.includes('WHERE id = ?')) {
      const row = store.deliveries.find((item) => item.id === args[0]);
      return { rows: row ? [{ ...row }] : [], columns: [] };
    }
    if (sql.includes("WHERE status = 'failed' AND retryable = 1")) {
      return {
        rows: store.deliveries.filter((item) => item.status === 'failed' && item.retryable === 1 && item.payload),
        columns: [],
      };
    }
    return { rows: [], columns: [] };
  }),
  tursoExecute: vi.fn(async (_env: unknown, rawSql: unknown, args: any[] = []) => {
    const sql = sqlText(rawSql);
    if (sql.startsWith('INSERT INTO email_deliveries')) {
      store.deliveries.push({
        id: args[0],
        user_id: args[1],
        to_email: args[2],
        kind: args[3],
        subject: args[4],
        idempotency_key: args[5],
        retryable: args[6],
        payload: args[7],
        document_type: args[8],
        document_id: args[9],
        created_at: args[10],
        updated_at: args[11],
        status: 'sending',
        attempts: 1,
        provider: null,
        last_error: null,
        next_attempt_at: null,
      });
      return;
    }
    if (!sql.startsWith('UPDATE email_deliveries')) return;
    const id = args[args.length - 1];
    const row = store.deliveries.find((item) => item.id === id);
    if (!row) return;

    if (sql.includes("status = 'sent'")) {
      row.status = 'sent';
      row.provider = args[0] ?? null;
      row.next_attempt_at = null;
      row.last_error = null;
      if (sql.includes('attempts = ?')) row.attempts = args[1];
      return;
    }
    if (sql.includes("status = 'sending'")) {
      row.status = 'sending';
      if (sql.includes('attempts = ?')) row.attempts = args[0];
      return;
    }
    if (sql.includes('last_error = ?')) {
      row.status = args[0];
      if (sql.includes('attempts = ?')) {
        row.attempts = args[1];
        row.last_error = args[2];
        row.next_attempt_at = args[4] ?? null;
      } else {
        row.last_error = args[1];
        row.next_attempt_at = args[3] ?? null;
      }
    }
  }),
}));

import { sendEmail, retryFailedDeliveries } from '../src/services/email';

const env = {
  TURSO_URL: 'libsql://example.turso.io',
  TURSO_TOKEN: 'token',
  COOPER_API_KEY: 'cooper-key',
  COOPER_INBOX_ID: 'revercue@cooperemail.com',
  OPENMAIL_API_KEY: 'openmail-key',
  OPENMAIL_INBOX_ID: 'inbox-id',
  EMAIL_FROM: 'Revercue <revercue@cooperemail.com>',
} as unknown as Bindings;

let cooperStatus = 200;
let openmailStatus = 200;
let calls: { url: string; headers: Record<string, string>; body: any }[] = [];

beforeEach(() => {
  store.deliveries.length = 0;
  cooperStatus = 200;
  openmailStatus = 200;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const status = url.includes('cooperemail.com') ? cooperStatus : openmailStatus;
      return new Response(status < 300 ? '{"id":"provider-message"}' : '{"error":"rejected"}', {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const message = {
  to: 'reader@example.com',
  subject: 'A subject',
  text: 'A body',
  kind: 'transactional' as const,
};

describe('Cooper primary / OpenMail fallback', () => {
  it('does not call OpenMail when Cooper succeeds', async () => {
    const result = await sendEmail(env, message);
    expect(result).toMatchObject({ ok: true, status: 'sent', provider: 'cooper' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('cooperemail.com');
  });

  it('attempts OpenMail only after Cooper fails', async () => {
    cooperStatus = 500;
    const result = await sendEmail(env, message);
    expect(result).toMatchObject({ ok: true, status: 'sent', provider: 'openmail' });
    expect(calls.map((call) => (call.url.includes('cooperemail.com') ? 'cooper' : 'openmail'))).toEqual([
      'cooper',
      'openmail',
    ]);
  });

  it('reports a failure when both providers fail', async () => {
    cooperStatus = 503;
    openmailStatus = 502;
    const result = await sendEmail(env, message);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('http_502');
  });

  it('deduplicates a repeated send by idempotency key', async () => {
    const keyed = { ...message, idempotencyKey: 'contract-signed:con_1:v1' };
    const first = await sendEmail(env, keyed);
    const second = await sendEmail(env, keyed);
    expect(first.status).toBe('sent');
    expect(second.status).toBe('deduped');
    expect(calls).toHaveLength(1);
  });

  it('uses a stable provider idempotency key across cron retries', async () => {
    cooperStatus = 500;
    openmailStatus = 500;
    await sendEmail(env, { ...message, retryable: true });

    cooperStatus = 500;
    openmailStatus = 200;
    await retryFailedDeliveries(env);

    const keys = calls.map((call) => call.headers['Idempotency-Key']);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBeTruthy();
  });
});

describe('email retry policy', () => {
  it('retries a retryable delivery after both providers fail', async () => {
    cooperStatus = 500;
    openmailStatus = 500;
    const failed = await sendEmail(env, { ...message, retryable: true });
    expect(failed.ok).toBe(false);

    const delivery = store.deliveries[0];
    expect(delivery).toMatchObject({ status: 'failed', retryable: 1, attempts: 1 });
    expect(delivery.next_attempt_at).toBeTruthy();

    cooperStatus = 500;
    openmailStatus = 200;
    await expect(retryFailedDeliveries(env)).resolves.toMatchObject({ retried: 1, sent: 1 });
    expect(delivery).toMatchObject({ status: 'sent', provider: 'openmail', attempts: 2 });
  });

  it('does not put a non-retryable email into the retry loop', async () => {
    cooperStatus = 500;
    openmailStatus = 500;
    await sendEmail(env, { ...message, retryable: false });
    expect(store.deliveries[0]).toMatchObject({ status: 'failed', retryable: 0, payload: null });
    expect(store.deliveries[0].next_attempt_at).toBeNull();

    const before = calls.length;
    await expect(retryFailedDeliveries(env)).resolves.toMatchObject({ retried: 0, sent: 0 });
    expect(calls).toHaveLength(before);
  });

  it('does not restart an abandoned delivery automatically', async () => {
    store.deliveries.push({
      id: 'eml_abandoned',
      to_email: 'reader@example.com',
      kind: 'transactional',
      subject: 'A subject',
      status: 'abandoned',
      attempts: 5,
      retryable: 1,
      idempotency_key: 'abandoned-key',
      payload: JSON.stringify(message),
      next_attempt_at: null,
    });
    const result = await sendEmail(env, { ...message, idempotencyKey: 'abandoned-key', retryable: true });
    expect(result).toMatchObject({ ok: false, error: 'delivery_abandoned' });
    expect(calls).toHaveLength(0);
  });

  it('abandons a retryable delivery after the configured maximum', async () => {
    store.deliveries.push({
      id: 'eml_max',
      to_email: 'reader@example.com',
      kind: 'transactional',
      subject: 'A subject',
      status: 'failed',
      attempts: 4,
      retryable: 1,
      payload: JSON.stringify(message),
      next_attempt_at: '2020-01-01T00:00:00.000Z',
    });
    cooperStatus = 500;
    openmailStatus = 500;

    await expect(retryFailedDeliveries(env)).resolves.toMatchObject({ retried: 1, failed: 0, abandoned: 1 });
    expect(store.deliveries[0]).toMatchObject({ status: 'abandoned', attempts: 5, next_attempt_at: null });
  });
});
