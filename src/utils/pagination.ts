import type { Context } from 'hono';

export interface PaginationInput {
  page: number;
  limit: number;
  offset: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

/**
 * The frontend's `Paginated<T>` contract is `{ data, pagination }`, so every
 * list endpoint must return this envelope. Query parameters are clamped so a
 * client cannot request unbounded result sets.
 */
export function parsePagination(c: Context, defaultLimit = 25, maxLimit = 100): PaginationInput {
  const rawPage = Number(c.req.query('page') ?? 1);
  const rawLimit = Number(c.req.query('limit') ?? defaultLimit);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(maxLimit, Math.max(1, Math.floor(rawLimit)))
    : defaultLimit;
  return { page, limit, offset: (page - 1) * limit };
}

export function paginationMeta(total: number, input: { page: number; limit: number }): PaginationMeta {
  return {
    page: input.page,
    limit: input.limit,
    total,
    total_pages: Math.max(1, Math.ceil(total / input.limit)),
  };
}

export function paginated<T>(data: T[], total: number, input: { page: number; limit: number }) {
  return { data, pagination: paginationMeta(total, input) };
}

/** Validates and normalises an `?status=` filter against an allowlist. */
export function statusFilter(raw: string | undefined, allowed: readonly string[]): string | null {
  if (!raw) return null;
  return allowed.includes(raw) ? raw : null;
}
