import { tursoQuery, tursoExecute } from '../utils/turso';
import { dbQuery } from '../utils/db';
import { generateId } from '../utils/ids';
import type { Bindings } from '../types';

export async function getRevenueSummary(env: Bindings, userId: string) {
  const earned = await tursoQuery(
    env,
    `SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE user_id = ? AND status = 'paid'`,
    [userId]
  );
  const pending = await dbQuery(
    env,
    `SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count FROM invoices WHERE user_id = ? AND status IN ('published', 'proof_submitted', 'overdue')`,
    [userId]
  );
  const spent = await dbQuery(
    env,
    `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE user_id = ?`,
    [userId]
  );
  return {
    earned_total: Number(earned.rows[0]?.total ?? 0),
    pending_total: Number(pending[0]?.total ?? 0),
    pending_count: Number(pending[0]?.count ?? 0),
    spent_total: Number(spent[0]?.total ?? 0),
    profit: Number(earned.rows[0]?.total ?? 0) - Number(spent[0]?.total ?? 0),
  };
}

export async function addExpense(env: Bindings, userId: string, input: any): Promise<string> {
  const id = generateId('exp');
  await dbQuery(
    env,
    `INSERT INTO expenses (id, user_id, client_id, amount, currency, category, platform, date, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, input.client_id ?? null, input.amount, input.currency ?? 'USD', input.category, input.platform ?? null, input.date, input.note ?? null, new Date().toISOString()]
  );
  return id;
}
