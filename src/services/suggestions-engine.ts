import { tursoQuery } from '../utils/turso';
import { dbQuery } from '../utils/db';
import type { Bindings } from '../types';

export interface Suggestion {
  id: string;
  type: string;
  client_id: string | null;
  document_id: string | null;
  title: string;
  body: string;
  action_url: string;
}

async function loadActivePairings(env: Bindings, plan: string): Promise<any[]> {
  const result = await tursoQuery(
    env,
    `SELECT p.id, p.plan, p.priority, i.id as instruction_id, i.name as instruction_name, i.body as instruction_body, i.action as instruction_action, pt.rule as pattern_rule
     FROM pairings p
     JOIN instructions i ON i.id = p.instruction_id
     JOIN patterns pt ON pt.id = p.pattern_id
     WHERE p.status = 'active' AND (p.plan = ? OR p.plan = 'all')
     ORDER BY p.priority ASC`,
    [plan]
  );
  return result.rows;
}

function evaluateCondition(cond: any, ctx: any): boolean {
  const v = ctx[cond.field];
  switch (cond.op) {
    case 'eq': return v === cond.value;
    case 'neq': return v !== cond.value;
    case 'gt': return Number(v) > Number(cond.value);
    case 'gte': return Number(v) >= Number(cond.value);
    case 'lt': return Number(v) < Number(cond.value);
    case 'lte': return Number(v) <= Number(cond.value);
    case 'in': return Array.isArray(cond.value) && cond.value.includes(v);
    case 'exists': return v !== undefined && v !== null;
    default: return false;
  }
}

function evaluatePattern(rule: any[], ctx: any): boolean {
  if (!Array.isArray(rule) || rule.length === 0) return false;
  for (const c of rule) if (!evaluateCondition(c, ctx)) return false;
  return true;
}

export async function generateSuggestions(env: Bindings, userId: string, plan: string): Promise<Suggestion[]> {
  if (plan === 'free' || plan === 'starter') return [];

  const pairings = await loadActivePairings(env, plan);
  if (pairings.length === 0) {
    return await fallbackFollowUps(env, userId);
  }

  const recentClients = await dbQuery<any>(
    env,
    `SELECT c.id, c.name, c.industry, c.status,
       (SELECT COUNT(*) FROM proposals WHERE client_id = c.id AND status = 'published') as proposal_count,
       (SELECT COUNT(*) FROM contracts WHERE client_id = c.id AND status = 'approved') as contract_count,
       (SELECT COUNT(*) FROM invoices WHERE client_id = c.id AND status = 'confirmed') as invoice_count,
       (SELECT MAX(created_at) FROM communication_log WHERE client_id = c.id) as last_message
     FROM clients c WHERE c.user_id = ? ORDER BY c.last_message_at DESC LIMIT 20`,
    [userId]
  );

  const suggestions: Suggestion[] = [];
  for (const pairing of pairings) {
    let rule: any[] = [];
    try { rule = JSON.parse(pairing.pattern_rule ?? '[]'); } catch { continue; }
    for (const client of recentClients) {
      const ctx = {
        industry: client.industry,
        status: client.status,
        proposal_count: client.proposal_count,
        contract_count: client.contract_count,
        invoice_count: client.invoice_count,
        last_message: client.last_message,
      };
      if (evaluatePattern(rule, ctx)) {
        suggestions.push({
          id: `sug_${pairing.id}_${client.id}`,
          type: pairing.instruction_action ?? 'follow_up',
          client_id: client.id,
          document_id: null,
          title: `${pairing.instruction_name} — ${client.name}`,
          body: String(pairing.instruction_body ?? '').slice(0, 200),
          action_url: `/crm/${client.id}`,
        });
        if (suggestions.length >= 5) break;
      }
    }
    if (suggestions.length >= 5) break;
  }
  return suggestions.length > 0 ? suggestions : await fallbackFollowUps(env, userId);
}

async function fallbackFollowUps(env: Bindings, userId: string): Promise<Suggestion[]> {
  const rows = await dbQuery<any>(
    env,
    `SELECT p.id as document_id, p.client_id, p.published_at, c.name as client_name
     FROM proposals p JOIN clients c ON p.client_id = c.id
     WHERE p.user_id = ? AND p.status = 'published' AND p.published_at < ?
     LIMIT 5`,
    [userId, new Date(Date.now() - 2 * 86400000).toISOString()]
  );
  return rows.map((r) => ({
    id: `sug_follow_${r.document_id}`,
    type: 'follow_up',
    client_id: r.client_id,
    document_id: r.document_id,
    title: `Follow up with ${r.client_name}`,
    body: 'Proposal sent 2+ days ago, no response.',
    action_url: `/crm/${r.client_id}`,
  }));
}
