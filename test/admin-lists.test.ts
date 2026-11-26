import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../src/types';

const db = vi.hoisted(() => ({
  waitlist: [] as any[],
}));

function normaliseSql(value: unknown): string {
  return String(value).replace(/\s+/g, ' ').trim();
}

vi.mock('../src/utils/turso', () => ({
  tursoQuery: vi.fn(async (_env: unknown, rawSql: unknown, args: any[] = []) => {
    const sql = normaliseSql(rawSql);
    if (sql.includes('FROM waitlist')) {
      const statused = sql.includes('WHERE status = ?');
      const status = statused ? String(args[0]) : null;
      const rows = db.waitlist.filter((row) => !status || row.status === status);
      if (sql.startsWith('SELECT COUNT(*)')) {
        return { rows: [{ c: rows.length }], columns: ['c'] };
      }
      const limit = Number(args[args.length - 2] ?? 20);
      const offset = Number(args[args.length - 1] ?? 0);
      return { rows: rows.slice(offset, offset + limit), columns: ['id', 'email', 'status', 'created_at'] };
    }
    return { rows: [], columns: [] };
  }),
  tursoExecute: vi.fn(async () => undefined),
}));

import admin from '../src/routes/admin';
import { createAdminToken } from '../src/middleware/admin-auth';

const env = { ADMIN_JWT_KEY: 'admin-test-secret' } as unknown as Bindings;

function app() {
  const router = new Hono<{ Bindings: Bindings }>();
  router.route('/api/admin', admin);
  return router;
}

async function list(query: string) {
  const token = await createAdminToken('admin', 'admin-test-secret');
  const response = await app().request(`/api/admin/waitlist${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, env);
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}

beforeEach(() => {
  db.waitlist = [
    { id: 'w1', email: 'one@example.com', status: 'pending', created_at: '2026-03-01T00:00:00.000Z' },
    { id: 'w2', email: 'two@example.com', status: 'invited', created_at: '2026-03-02T00:00:00.000Z' },
    { id: 'w3', email: 'three@example.com', status: 'invited', created_at: '2026-03-03T00:00:00.000Z' },
  ];
});

describe('admin queue lists', () => {
  it('filters the queue by an allowlisted status', async () => {
    const body = await list('?status=invited');
    expect(body.data.map((row: any) => row.id)).toEqual(['w2', 'w3']);
    expect(body.pagination.total).toBe(2);
  });

  it('ignores an unknown status instead of failing or leaking it into SQL', async () => {
    const body = await list('?status=not-a-status');
    expect(body.data).toHaveLength(3);
    expect(body.pagination.total).toBe(3);
  });

  it('paginates from page 1 and reports the contract the admin UI reads', async () => {
    const body = await list('?status=invited&page=2&limit=1');
    expect(body.data.map((row: any) => row.id)).toEqual(['w3']);
    expect(body.pagination).toMatchObject({
      page: 2,
      limit: 1,
      total: 2,
      total_pages: 2,
    });
  });
});
