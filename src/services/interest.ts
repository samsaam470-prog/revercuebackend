import { tursoQuery } from '../utils/turso';
import type { Bindings } from '../types';

export interface InterestSignals {
  messageCount: number;
  lastMessageIncoming: boolean;
  proposalOpened: boolean;
  proposalAnswered: boolean;
  contractApproved: boolean;
  invoicePaid: boolean;
  daysSinceLastInteraction: number;
  markedNotInterested: boolean;
}

export function calculateInterestLevel(s: InterestSignals): number {
  let score = 50;
  score += Math.min(s.messageCount * 5, 30);
  score += s.lastMessageIncoming ? 15 : -10;
  score += s.proposalOpened ? 10 : 0;
  score += s.proposalAnswered ? 15 : 0;
  score += s.contractApproved ? 20 : 0;
  score += s.invoicePaid ? 25 : 0;
  score -= Math.min(s.daysSinceLastInteraction * 2, 30);
  score -= s.markedNotInterested ? 40 : 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export async function recomputeInterest(
  env: Bindings,
  userId: string,
  clientId: string
): Promise<number> {
  const client = await tursoQuery(
    env,
    `SELECT marked_not_interested_at FROM users WHERE id = ?`,
    [userId]
  );
  const messages = await tursoQuery(
    env,
    `SELECT direction, created_at FROM communication_log WHERE user_id = ? AND client_id = ? ORDER BY created_at DESC LIMIT 50`,
    [userId, clientId]
  );
  const messageCount = messages.rows.length;
  const lastDirection = messages.rows[0]?.direction ?? 'outgoing';
  const lastDate = messages.rows[0]?.created_at ?? new Date().toISOString();
  const daysSince = Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000);

  const signals: InterestSignals = {
    messageCount,
    lastMessageIncoming: lastDirection === 'incoming',
    proposalOpened: false,
    proposalAnswered: false,
    contractApproved: false,
    invoicePaid: false,
    daysSinceLastInteraction: daysSince,
    markedNotInterested: !!client.rows[0]?.marked_not_interested_at,
  };
  return calculateInterestLevel(signals);
}
