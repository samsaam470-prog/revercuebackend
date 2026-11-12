import { dbQuery } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import type { Bindings } from '../types';

export interface PriceSuggestion {
  client_id: string;
  spent_total: number;
  last_invoice_total: number | null;
  margin_percent: number;
  recommended_price: number | null;
  reason: string;
}

export async function getPriceSuggestion(env: Bindings, userId: string, clientId: string, marginPercent = 30): Promise<PriceSuggestion> {
  const spent = await dbQuery<{ total: number }>(
    env,
    `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE user_id = ? AND client_id = ?`,
    [userId, clientId]
  );
  const spent_total = Number(spent[0]?.total ?? 0);

  const lastInv = await dbQuery<{ total: number }>(
    env,
    `SELECT total FROM invoices WHERE user_id = ? AND client_id = ? AND status IN ('confirmed','published') ORDER BY created_at DESC LIMIT 1`,
    [userId, clientId]
  );
  const last_invoice_total = lastInv[0] ? Number(lastInv[0].total) : null;

  let recommended_price: number | null = null;
  let reason = '';
  if (spent_total > 0) {
    recommended_price = Math.round(spent_total * (1 + marginPercent / 100));
    reason = `You spent $${spent_total} on this client. At a ${marginPercent}% margin, charge $${recommended_price}.`;
  } else if (last_invoice_total) {
    recommended_price = last_invoice_total;
    reason = `Your last invoice for this client was $${last_invoice_total}. Consider a similar price.`;
  } else {
    reason = 'No expenses or invoices yet. Add an expense or send an invoice to get a suggestion.';
  }

  return { client_id: clientId, spent_total, last_invoice_total, margin_percent: marginPercent, recommended_price, reason };
}
