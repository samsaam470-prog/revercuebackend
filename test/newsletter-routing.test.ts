import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../src/types';

const db = vi.hoisted(() => ({ subscribers: [] as any[] }));
const mail = vi.hoisted(() => ({ sendEmail: vi.fn() }));

function normaliseSql(value: unknown): string {
  return String(value).replace(/\s+/g, ' ').trim();
}

vi.mock('../src/utils/turso', () => ({
  tursoQuery: vi.fn(async (_env: unknown, rawSql: unknown, args: any[] = []) => {
    const sql = normaliseSql(rawSql);
    if (sql.includes('SELECT id, status FROM newsletter_subscribers WHERE email = ?')) {
      const email = String(args[0] ?? '').toLowerCase();
      const row = db.subscribers.find((item) => item.email === email);
      return { rows: row ? [{ id: row.id, status: row.status }] : [], columns: ['id', 'status'] };
    }
    if (sql.includes('SELECT COUNT(*) as c FROM newsletter_subscribers')) {
      const status = args.find((arg) => ['pending', 'active', 'unsubscribed'].includes(String(arg)));
      return {
        rows: [{ c: db.subscribers.filter((item) => !status || item.status === status).length }],
        columns: ['c'],
      };
    }
    if (sql.includes('FROM newsletter_subscribers') && sql.includes('ORDER BY created_at DESC')) {
      const status = args.find((arg) => ['pending', 'active', 'unsubscribed'].includes(String(arg)));
      return {
        rows: db.subscribers.filter((item) => !status || item.status === status),
        columns: ['id', 'email', 'status', 'consent_source', 'consent_at', 'confirmed_at', 'unsubscribed_at', 'created_at'],
      };
    }
    return { rows: [], columns: [] };
  }),
  tursoExecute: vi.fn(async (_env: unknown, rawSql: unknown, args: any[] = []) => {
    const sql = normaliseSql(rawSql);
    if (sql.startsWith('INSERT INTO newsletter_subscribers')) {
      db.subscribers.push({
        id: args[0],
        email: args[1],
        status: args[2],
        consent_source: 'website',
        consent_at: args[3],
        confirmed_at: args[4],
        unsubscribed_at: null,
        user_id: null,
        ip_hash: args[5] ?? null,
        created_at: args[6],
        updated_at: args[7],
      });
      return;
    }
    if (sql.startsWith('UPDATE newsletter_subscribers')) {
      const email = String(args[args.length - 1] ?? '').toLowerCase();
      const row = db.subscribers.find((item) => item.email === email);
      if (!row) return;
      row.status = args[0];
      row.consent_source = row.consent_source ?? args[1];
      row.consent_at = row.consent_at ?? args[2];
      row.confirmed_at = row.confirmed_at ?? args[3];
      row.updated_at = args[4];
      // unsubscribed_at is intentionally preserved for history.
    }
  }),
}));

vi.mock('../src/services/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 10, retryAfter: 0 })),
}));

vi.mock('../src/services/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/email')>();
  return { ...actual, sendEmail: mail.sendEmail };
});

import marketing from '../src/routes/marketing';
import admin from '../src/routes/admin';
import { createAdminToken } from '../src/middleware/admin-auth';

const env = {
  USER_JWT_KEY: 'newsletter-test-secret',
  ADMIN_JWT_KEY: 'admin-test-secret',
  ADMIN_NOTIFICATION_EMAIL: 'admin@example.com',
  FRONTEND_ORIGIN: 'https://revercue.test',
} as unknown as Bindings;

function app() {
  const router = new Hono<{ Bindings: Bindings }>();
  router.route('/api', marketing);
  router.route('/api/admin', admin);
  return router;
}

function subscribe(email: string) {
  return app().request(
    '/api/newsletter',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
      body: JSON.stringify({ email }),
    },
    env
  );
}

beforeEach(() => {
  db.subscribers.length = 0;
  mail.sendEmail.mockReset();
  mail.sendEmail.mockResolvedValue({ ok: true, status: 'sent', provider: 'cooper' });
});

describe('newsletter subscription endpoint', () => {
  it('stores a new subscriber as active immediately without sending email', async () => {
    const response = await subscribe('Reader@Example.com');
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      success: true,
      status: 'active',
      email_sent: false,
    });

    expect(db.subscribers).toHaveLength(1);
    expect(db.subscribers[0]).toMatchObject({
      email: 'reader@example.com',
      status: 'active',
      unsubscribed_at: null,
    });
    expect(db.subscribers[0].confirmed_at).toBeTruthy();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it('handles a repeated active subscription without duplicates or email', async () => {
    await subscribe('reader@example.com');
    const response = await subscribe('READER@example.com');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      status: 'active',
      already_subscribed: true,
      email_sent: false,
    });
    expect(db.subscribers).toHaveLength(1);
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it('reactivates only on a deliberate resubmit and preserves the opt-out history', async () => {
    db.subscribers.push({
      id: 'nl_old',
      email: 'reader@example.com',
      status: 'unsubscribed',
      consent_source: 'website',
      consent_at: '2026-01-01T00:00:00.000Z',
      confirmed_at: '2026-01-01T00:00:00.000Z',
      unsubscribed_at: '2026-02-01T00:00:00.000Z',
      user_id: null,
      ip_hash: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-02-01T00:00:00.000Z',
    });

    const response = await subscribe('reader@example.com');
    expect(response.status).toBe(201);
    expect(db.subscribers).toHaveLength(1);
    expect(db.subscribers[0].status).toBe('active');
    expect(db.subscribers[0].unsubscribed_at).toBe('2026-02-01T00:00:00.000Z');
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });
});

describe('existing newsletter admin endpoints', () => {
  beforeEach(() => {
    db.subscribers.push(
      {
        id: 'nl_active',
        email: 'active@example.com',
        status: 'active',
        consent_source: 'website',
        consent_at: '2026-03-01T00:00:00.000Z',
        confirmed_at: '2026-03-01T00:00:00.000Z',
        unsubscribed_at: null,
        created_at: '2026-03-01T00:00:00.000Z',
      },
      {
        id: 'nl_unsub',
        email: 'gone@example.com',
        status: 'unsubscribed',
        consent_source: 'website',
        consent_at: '2026-03-01T00:00:00.000Z',
        confirmed_at: '2026-03-01T00:00:00.000Z',
        unsubscribed_at: '2026-03-02T00:00:00.000Z',
        created_at: '2026-03-01T00:00:00.000Z',
      }
    );
  });

  it('lists only active subscribers when filtered', async () => {
    const token = await createAdminToken('admin', 'admin-test-secret');
    const response = await app().request(
      '/api/admin/newsletter?status=active',
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.pagination.total).toBe(1);
    expect(body.data.map((row: any) => row.email)).toEqual(['active@example.com']);
  });

  it('exports subscribers as CSV', async () => {
    const token = await createAdminToken('admin', 'admin-test-secret');
    const response = await app().request(
      '/api/admin/newsletter/export',
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    const csv = await response.text();
    expect(csv).toContain('active@example.com');
    expect(csv).toContain('gone@example.com');
  });
});
