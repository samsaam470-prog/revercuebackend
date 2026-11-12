import { dbFirst, dbRun } from '../utils/db';
import type { Bindings } from '../types';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

export async function checkRateLimit(
  env: Bindings,
  key: string,
  max: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowEnd = new Date(now + windowSeconds * 1000).toISOString();

  const existing = await dbFirst<{ id: string; count: number; window_end: string }>(
    env,
    `SELECT id, count, window_end FROM rate_limits WHERE key = ? AND window_end > ? ORDER BY created_at DESC LIMIT 1`,
    [key, new Date(now).toISOString()]
  );

  if (!existing) {
    const id = `rl_${crypto.randomUUID()}`;
    await dbRun(
      env,
      `INSERT INTO rate_limits (id, key, count, window_start, window_end, created_at) VALUES (?, ?, 1, ?, ?, ?)`,
      [id, key, new Date(now).toISOString(), windowEnd, new Date(now).toISOString()]
    );
    return { allowed: true, remaining: max - 1, retryAfter: 0 };
  }

  if (existing.count >= max) {
    const retryAfter = Math.max(0, Math.ceil((new Date(existing.window_end).getTime() - now) / 1000));
    return { allowed: false, remaining: 0, retryAfter };
  }

  await dbRun(env, `UPDATE rate_limits SET count = count + 1 WHERE id = ?`, [existing.id]);
  return { allowed: true, remaining: max - existing.count - 1, retryAfter: 0 };
}

export async function cleanupRateLimits(env: Bindings): Promise<void> {
  await dbRun(env, `DELETE FROM rate_limits WHERE window_end < ?`, [new Date().toISOString()]);
}
