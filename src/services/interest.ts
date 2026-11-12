import { tursoQuery } from '../utils/turso';
import { dbQuery } from '../utils/db';
import type { Bindings } from '../types';

export interface InterestSignals {
  message_count: number;
  last_incoming: boolean;
  proposal_opened: boolean;
  proposal_answered: boolean;
  contract_approved: boolean;
  invoice_paid: boolean;
  days_since_last: number;
  marked_not_interested: boolean;
}

export function calculateInterestLevel(s: InterestSignals): number {
  let score = 50;
  score += Math.min(s.message_count * 5, 30);
  score += s.last_incoming ? 15 : -10;
  score += s.proposal_opened ? 10 : 0;
  score += s.proposal_answered ? 15 : 0;
  score += s.contract_approved ? 20 : 0;
  score += s.invoice_paid ? 25 : 0;
  score -= Math.min(s.days_since_last * 2, 30);
  score -= s.marked_not_interested ? 40 : 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export async function getInterestBreakdown(env: Bindings, userId: string, clientId: string): Promise<{ signals: InterestSignals; contributions: any[]; arithmetic: string }> {
  const msgs = await dbQuery<any>(env, `SELECT direction, created_at FROM communication_log WHERE user_id = ? AND client_id = ? ORDER BY created_at DESC LIMIT 50`, [userId, clientId]);
  const proposal = await dbQuery<any>(env, `SELECT COUNT(*) as c FROM proposals WHERE client_id = ? AND status IN ('published','accepted')`, [clientId]);
  const contract = await dbQuery<any>(env, `SELECT COUNT(*) as c FROM contracts WHERE client_id = ? AND status = 'approved'`, [clientId]);
  const invoice = await dbQuery<any>(env, `SELECT COUNT(*) as c FROM invoices WHERE client_id = ? AND status IN ('confirmed','verified')`, [clientId]);
  const client = await dbQuery<any>(env, `SELECT marked_not_interested_at FROM clients WHERE id = ?`, [clientId]);

  const lastDate = msgs[0]?.created_at ?? new Date().toISOString();
  const days = Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000);
  const signals: InterestSignals = {
    message_count: msgs.length,
    last_incoming: msgs[0]?.direction === 'incoming',
    proposal_opened: Number(proposal[0]?.c ?? 0) > 0,
    proposal_answered: false,
    contract_approved: Number(contract[0]?.c ?? 0) > 0,
    invoice_paid: Number(invoice[0]?.c ?? 0) > 0,
    days_since_last: days,
    marked_not_interested: !!client[0]?.marked_not_interested_at,
  };

  const contributions = [
    { signal: 'Base', value: '+50' },
    { signal: 'Messages', value: `+${Math.min(signals.message_count * 5, 30)} (${signals.message_count} msgs)` },
    { signal: 'Last message', value: signals.last_incoming ? '+15 (incoming)' : '-10 (outgoing)' },
    { signal: 'Proposal opened', value: signals.proposal_opened ? '+10' : '0' },
    { signal: 'Contract approved', value: signals.contract_approved ? '+20' : '0' },
    { signal: 'Invoice paid', value: signals.invoice_paid ? '+25' : '0' },
    { signal: 'Days since', value: `-${Math.min(signals.days_since_last * 2, 30)} (${signals.days_since_last} days)` },
    { signal: 'Marked not interested', value: signals.marked_not_interested ? '-40' : '0' },
  ];

  return { signals, contributions, arithmetic: 'Arithmetic, not AI. The score is the sum of the contributions.' };
}

export async function recomputeInterest(env: Bindings, userId: string, clientId: string): Promise<number> {
  const b = await getInterestBreakdown(env, userId, clientId);
  const level = calculateInterestLevel(b.signals);
  await dbQuery(env, `UPDATE clients SET interest_level = ? WHERE id = ?`, [level, clientId]);
  return level;
}
