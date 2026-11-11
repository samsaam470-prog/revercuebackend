import { tursoQuery } from '../utils/turso';
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

export async function loadPairings(env: Bindings, plan: string): Promise<any[]> {
  const result = await tursoQuery(
    env,
    `SELECT p.*, i.body as instruction_body, i.action as instruction_action, i.name as instruction_name, pt.rule as pattern_rule
     FROM pairings p
     JOIN instructions i ON i.id = p.instruction_id
     JOIN patterns pt ON pt.id = p.pattern_id
     WHERE p.status = 'active' AND (p.plan = ? OR p.plan = 'all')
     ORDER BY p.priority ASC`,
    [plan]
  );
  return result.rows;
}

export function evaluatePattern(rule: any[], context: any): boolean {
  if (!Array.isArray(rule) || rule.length === 0) return false;
  for (const cond of rule) {
    if (!evaluateCondition(cond, context)) return false;
  }
  return true;
}

function evaluateCondition(cond: any, context: any): boolean {
  const value = context[cond.field];
  switch (cond.op) {
    case 'eq': return value === cond.value;
    case 'neq': return value !== cond.value;
    case 'gt': return Number(value) > Number(cond.value);
    case 'gte': return Number(value) >= Number(cond.value);
    case 'lt': return Number(value) < Number(cond.value);
    case 'lte': return Number(value) <= Number(cond.value);
    case 'in': return Array.isArray(cond.value) && cond.value.includes(value);
    case 'exists': return value !== undefined && value !== null;
    default: return false;
  }
}
