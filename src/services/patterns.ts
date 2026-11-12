import { dbQuery, dbFirst } from '../utils/db';
import { tursoQuery } from '../utils/turso';
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

async function medianFollowUpDays(env: Bindings, userId: string): Promise<number> {
  const rows = await dbQuery<{ days: number }>(
    env,
    `SELECT CAST((julianday(follow_up_date) - julianday(created_at)) AS INTEGER) as days
     FROM communication_log
     WHERE user_id = ? AND follow_up_date IS NOT NULL AND follow_up_done = 1
     ORDER BY created_at DESC LIMIT 20`,
    [userId]
  );
  if (rows.length === 0) return 2;
  const sorted = rows.map((r) => Number(r.days)).filter((d) => d >= 0 && d < 30).sort((a, b) => a - b);
  if (sorted.length === 0) return 2;
  return sorted[Math.floor(sorted.length / 2)];
}

export async function loadUserPatterns(env: Bindings, ctx: PatternContext): Promise<UserPatterns> {
  const toneRow = await dbFirst<{ tone: string; c: number }>(
    env,
    `SELECT tone, COUNT(*) as c FROM proposals WHERE user_id = ? GROUP BY tone ORDER BY c DESC LIMIT 1`,
    [ctx.user_id]
  );
  const usual_tone = toneRow?.tone ?? ctx.tone ?? 'formal';

  const usual_follow_up_days = await medianFollowUpDays(env, ctx.user_id);

  const pkgRow = await dbQuery<{ c: number }>(
    env,
    `SELECT COUNT(*) as c FROM saved_packages WHERE user_id = ?`,
    [ctx.user_id]
  );
  const usual_packages_count = Number(pkgRow[0]?.c ?? 3) > 0 ? 3 : 3;

  const templateRow = await dbFirst<{ template_id: string }>(
    env,
    `SELECT template_id FROM proposals WHERE user_id = ? AND status IN ('published','accepted') AND template_id IS NOT NULL GROUP BY template_id ORDER BY COUNT(*) DESC LIMIT 1`,
    [ctx.user_id]
  );

  const savedFaqs = await dbQuery<{ question: string; answer: string }>(
    env,
    `SELECT question, answer FROM saved_faqs WHERE user_id = ? ORDER BY last_used_at DESC NULLS LAST LIMIT 10`,
    [ctx.user_id]
  );

  const savedPackages = await dbQuery<any>(
    env,
    `SELECT name, price, currency, deliverables, description, is_recommended FROM saved_packages WHERE user_id = ? ORDER BY last_used_at DESC NULLS LAST LIMIT 10`,
    [ctx.user_id]
  );

  const winningFaqRows = await dbQuery<{ question: string }>(
    env,
    `SELECT question FROM saved_faqs WHERE user_id = ? GROUP BY question ORDER BY COUNT(*) DESC LIMIT 5`,
    [ctx.user_id]
  );

  return {
    usual_tone,
    usual_follow_up_days,
    usual_packages_count,
    usual_template: templateRow?.template_id ?? null,
    winning_faqs: winningFaqRows.map((r) => r.question),
    saved_faqs: savedFaqs,
    saved_packages: savedPackages,
  };
}

export async function fixWithPatterns(env: Bindings, ctx: PatternContext, layer2: any): Promise<any> {
  const patterns = await loadUserPatterns(env, ctx);
  const fixed = { ...layer2 };

  if (!fixed.tone) fixed.tone = patterns.usual_tone;

  if (Array.isArray(fixed.sections)) {
    fixed.sections = fixed.sections.map((s: any) => ({
      ...s,
      tone: s.tone ?? patterns.usual_tone,
    }));
  }

  if (patterns.saved_faqs.length > 0) {
    fixed.suggested_faqs = patterns.saved_faqs.slice(0, 5);
  }
  if (patterns.saved_packages.length > 0) {
    fixed.suggested_packages = patterns.saved_packages.slice(0, 3);
  }
  if (patterns.usual_template) fixed.suggested_template = patterns.usual_template;

  fixed.patterns_used = {
    tone: patterns.usual_tone,
    follow_up_days: patterns.usual_follow_up_days,
    packages_count: patterns.usual_packages_count,
  };

  fixed.missing = [];
  const required = ['introduction', 'scope', 'pricing'];
  for (const r of required) {
    if (!fixed.sections || !fixed.sections.some((s: any) => s.id === r)) {
      fixed.missing.push(r);
    }
  }

  return fixed;
}
