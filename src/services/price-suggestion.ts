import { dbQuery } from '../utils/db';
import type { Bindings } from '../types';

export interface PriceSuggestion {
  client_id: string;
  earned_total: number;
  spent_total: number;
  profit: number | null;
  last_invoice_total: number | null;
  margin_percent: number;
  recommended_price: number | null;
  reason: string;
}

// Target profit on cost, used for the "charge this to get a better profit" suggestion.
export const TARGET_PROFIT_PERCENT = 30;

// Scale and above only. Built from the client's own history: what was earned, what it cost,
// and the last confirmed invoice. The wording states the figures it is based on.
export async function getPriceSuggestion(
  env: Bindings,
  userId: string,
  clientId: string,
  marginPercent = TARGET_PROFIT_PERCENT
): Promise<PriceSuggestion> {
  const spent = await dbQuery<{ total: number }>(
    env,
    `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE user_id = ? AND client_id = ?`,
    [userId, clientId]
  );
  const spent_total = Number(spent[0]?.total ?? 0);

  const earned = await dbQuery<{ total: number }>(
    env,
    `SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE user_id = ? AND client_id = ? AND status IN ('confirmed','paid')`,
    [userId, clientId]
  );
  const earned_total = Number(earned[0]?.total ?? 0);

  const lastInv = await dbQuery<{ total: number }>(
    env,
    `SELECT total FROM invoices WHERE user_id = ? AND client_id = ? AND status IN ('confirmed','paid','published') ORDER BY created_at DESC LIMIT 1`,
    [userId, clientId]
  );
  const last_invoice_total = lastInv[0] ? Number(lastInv[0].total) : null;

  const profit = earned_total > 0 || spent_total > 0 ? earned_total - spent_total : null;
  let recommended_price: number | null = null;
  let reason: string;

  if (spent_total > 0 && earned_total > 0) {
    const cost_price = Math.ceil(spent_total * (1 + marginPercent / 100));
    const outcome = (profit ?? 0) >= 0 ? `a profit of $${(profit ?? 0).toFixed(0)}` : `a loss of $${Math.abs(profit ?? 0).toFixed(0)}`;
    const base = `Previously, you spent $${spent_total.toFixed(0)} on this client and earned $${earned_total.toFixed(0)}, ${outcome}.`;
    if (earned_total >= cost_price) {
      recommended_price = Math.round(earned_total);
      reason = `${base} Keep charging at least $${recommended_price}, which is above the $${cost_price} needed for a ${marginPercent}% profit on your costs.`;
    } else {
      recommended_price = cost_price;
      reason = `${base} Charge $${recommended_price} next time to get a ${marginPercent}% profit on your costs.`;
    }
  } else if (spent_total > 0) {
    recommended_price = Math.ceil(spent_total * (1 + marginPercent / 100));
    reason =
      `You have spent $${spent_total.toFixed(0)} on this client and no invoice is confirmed yet. ` +
      `Charge at least $${recommended_price} to get a ${marginPercent}% profit on your costs.`;
  } else if (earned_total > 0) {
    recommended_price = Math.round(earned_total);
    reason =
      `This client has earned you $${earned_total.toFixed(0)}, and no costs are recorded. ` +
      `Keep the price at $${recommended_price} or higher, and record your costs to see the profit.`;
  } else if (last_invoice_total) {
    recommended_price = last_invoice_total;
    reason = `Your last invoice for this client was $${last_invoice_total.toFixed(0)}. Keep a similar price.`;
  } else {
    reason = 'No costs, payments or invoices for this client yet. Record an expense or confirm a payment to get a suggestion.';
  }

  return {
    client_id: clientId,
    earned_total,
    spent_total,
    profit,
    last_invoice_total,
    margin_percent: marginPercent,
    recommended_price,
    reason,
  };
}
