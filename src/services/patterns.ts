import { dbQuery, dbFirst } from '../utils/db';
import { learnFromSamples } from './sample-learning';
import type { Bindings } from '../types';

export interface PatternContext {
  user_id: string;
  client_id: string | null;
  industry: string;
  service: string;
  tone: string;
  sections: string[];
}

export interface UserPatterns {
  usual_tone: string;
  usual_follow_up_days: number;
  usual_packages_count: number;
  usual_template: string | null;
  winning_faqs: string[];
  saved_faqs: { question: string; answer: string }[];
  saved_packages: any[];
}

function parseJson(value: unknown): any {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * Optional context, never a requirement.
 *
 * Every pattern comes from a table the product may not have populated yet, and
 * a schema mismatch here used to fail the whole organize call: the route
 * answered 500 and every draft silently fell back to ungrounded copy. Each
 * query now degrades to its default instead of taking the request down.
 */
async function optional<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    console.error('PATTERN_QUERY_FAILED', (error as Error)?.message ?? error);
    return fallback;
  }
}

async function medianFollowUpDays(env: Bindings, userId: string): Promise<number> {
  const rows = await optional(
    dbQuery<{ days: number }>(
      env,
      `SELECT CAST((julianday(follow_up_date) - julianday(created_at)) AS INTEGER) as days FROM communication_log WHERE user_id = ? AND follow_up_date IS NOT NULL AND follow_up_done = 1 ORDER BY created_at DESC LIMIT 20`,
      [userId]
    ),
    [] as { days: number }[]
  );
  if (rows.length === 0) return 2;
  const sorted = rows.map((r) => Number(r.days)).filter((d) => d >= 0 && d < 30).sort((a, b) => a - b);
  return sorted.length === 0 ? 2 : sorted[Math.floor(sorted.length / 2)];
}

/** The brief's tone and template live inside the proposal content JSON. */
async function latestProposalContent(env: Bindings, userId: string): Promise<any> {
  const row = await optional(
    dbFirst<{ content: string }>(
      env,
      `SELECT content FROM proposals WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      [userId]
    ),
    null
  );
  return parseJson(row?.content);
}

async function usualTemplate(env: Bindings, userId: string): Promise<string | null> {
  const rows = await optional(
    dbQuery<{ content: string }>(
      env,
      `SELECT content FROM proposals WHERE user_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT 20`,
      [userId]
    ),
    [] as { content: string }[]
  );
  for (const row of rows) {
    const template = parseJson(row.content)?.template_id;
    if (typeof template === 'string' && template) return template;
  }
  return null;
}

export async function loadUserPatterns(env: Bindings, ctx: PatternContext): Promise<UserPatterns> {
  const latest = await latestProposalContent(env, ctx.user_id);
  const usual_tone = (typeof latest?.tone === 'string' && latest.tone) || ctx.tone || 'formal';
  const usual_follow_up_days = await medianFollowUpDays(env, ctx.user_id);
  const pkgRow = await optional(
    dbQuery<{ c: number }>(env, `SELECT COUNT(*) as c FROM saved_packages WHERE user_id = ?`, [ctx.user_id]),
    [] as { c: number }[]
  );
  const usual_packages_count = Math.max(Number(pkgRow[0]?.c ?? 0), 3);
  const savedFaqs = await optional(
    dbQuery<{ question: string; answer: string }>(
      env,
      `SELECT question, answer FROM saved_faqs WHERE user_id = ? ORDER BY last_used_at DESC LIMIT 10`,
      [ctx.user_id]
    ),
    [] as { question: string; answer: string }[]
  );
  const savedPackages = await optional(
    dbQuery<any>(
      env,
      `SELECT name, price, currency, deliverables, description, is_recommended FROM saved_packages WHERE user_id = ? ORDER BY last_used_at DESC LIMIT 10`,
      [ctx.user_id]
    ),
    [] as any[]
  );
  return {
    usual_tone,
    usual_follow_up_days,
    usual_packages_count,
    usual_template: await usualTemplate(env, ctx.user_id),
    winning_faqs: savedFaqs.slice(0, 5).map((faq) => faq.question),
    saved_faqs: savedFaqs,
    saved_packages: savedPackages,
  };
}

export async function fixWithPatterns(env: Bindings, ctx: PatternContext, layer2: any): Promise<any> {
  const patterns = await loadUserPatterns(env, ctx);
  const fixed = { ...layer2 };

  if (!fixed.tone) fixed.tone = patterns.usual_tone;
  if (Array.isArray(fixed.sections)) fixed.sections = fixed.sections.map((s: any) => ({ ...s, tone: s.tone ?? patterns.usual_tone }));
  if (patterns.saved_faqs.length > 0) fixed.suggested_faqs = patterns.saved_faqs.slice(0, 5);
  if (patterns.saved_packages.length > 0) fixed.suggested_packages = patterns.saved_packages.slice(0, 3);
  if (patterns.usual_template) fixed.suggested_template = patterns.usual_template;

  fixed.patterns_used = { tone: patterns.usual_tone, follow_up_days: patterns.usual_follow_up_days, packages_count: patterns.usual_packages_count };

  if (Array.isArray(layer2.samples) && layer2.samples.length > 0) {
    try {
      const structure = await learnFromSamples(env, layer2.samples);
      fixed.learned_structure = structure;
      if (structure.sections.length > 0 && (!fixed.sections || fixed.sections.length === 0)) {
        fixed.sections = structure.sections.map((s) => ({ id: s, tone: patterns.usual_tone }));
      }
      if (structure.tone_hints.length > 0 && !fixed.tone) fixed.tone = structure.tone_hints[0];
    } catch (err) { console.error('SAMPLE_LEARNING_ERROR', err); }
  }

  fixed.missing = [];
  const required = ['introduction', 'scope', 'pricing'];
  for (const r of required) {
    if (!fixed.sections || !fixed.sections.some((s: any) => s.id === r)) fixed.missing.push(r);
  }
  return fixed;
}
