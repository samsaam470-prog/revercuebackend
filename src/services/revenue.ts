import { tursoQuery, tursoExecute } from '../utils/turso';
import { dbQuery } from '../utils/db';
import { generateId } from '../utils/ids';
import type { Bindings } from '../types';

export async function getRevenueSummary(env: Bindings, userId: string) {
  // Every plan: what was sent, what is still pending, and what has been confirmed as paid.
  const sent = await dbQuery(
    env,
    `SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count FROM invoices WHERE user_id = ? AND status NOT IN ('draft', 'archived', 'deleted')`,
    [userId]
  );
  const earned = await dbQuery(
    env,
    `SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE user_id = ? AND status IN ('confirmed', 'paid')`,
    [userId]
  );
  const pending = await dbQuery(
    env,
    `SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count FROM invoices WHERE user_id = ? AND status IN ('published', 'proof_submitted', 'overdue')`,
    [userId]
  );
  // Growth and above: what the work cost, from the expenses the freelancer entered.
  const spent = await dbQuery(
    env,
    `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE user_id = ?`,
    [userId]
  );
  const earnedTotal = Number(earned[0]?.total ?? 0);
  const spentTotal = Number(spent[0]?.total ?? 0);
  return {
    sent_total: Number(sent[0]?.total ?? 0),
    sent_count: Number(sent[0]?.count ?? 0),
    earned_total: earnedTotal,
    pending_total: Number(pending[0]?.total ?? 0),
    pending_count: Number(pending[0]?.count ?? 0),
    remaining_pending: Number(pending[0]?.total ?? 0),
    spent_total: spentTotal,
    profit: earnedTotal - spentTotal,
    all_time_profit: earnedTotal - spentTotal,
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
