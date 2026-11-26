import type { Bindings } from '../types';
import { organizeSections, normaliseSection } from './organizer';
import { resolveVisuals } from './visuals';
import { demoChat, demoModel, parseModelJson, DemoAiError } from './demo-ai';

/**
 * The public demo pipeline.
 *
 * The demo is a thin, anonymous surface over the same building blocks the
 * product uses: the deterministic organizer grounds the copy, the section
 * writer asks NaraRouter for the prose, and the existing visual resolver
 * supplies typed visuals. Nothing here invents figures: charts and diagrams
 * are only requested from numbers and milestones the visitor supplied.
 *
 * It returns document blocks in the exact shape the Revrecue builder renders,
 * so the Space reuses the real renderer instead of a separate one.
 */

export interface DemoPackage {
  name: string;
  price?: number;
  deliverables: string;
}

export interface DemoBrief {
  businessName: string;
  clientName: string;
  title: string;
  industry: string;
  service: string;
  problem: string;
  requirements: string;
  scope: string;
  deliverables: string;
  timeline: string;
  budget: string;
  paymentTerms: string;
  tone: string;
  sections: string[];
  packages: DemoPackage[];
  clientWebsite?: string;
  businessWebsite?: string;
  targetAudience?: string;
  additional?: string;
}

export type DemoBlockType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'pricing_table'
  | 'image'
  | 'icon'
  | 'chart'
  | 'diagram'
  | 'button';

export interface DemoBlock {
  id: string;
  type: DemoBlockType;
  text?: string;
  level?: 'h1' | 'h2' | 'h3';
  items?: { label: string; value?: string; price?: number }[];
  url?: string;
  alt?: string;
  caption?: string;
  chart?: { kind?: 'bar' | 'line'; title?: string; unit?: string; series: { label: string; value: number }[] };
  diagram?: { title?: string; steps: { title: string; detail?: string }[] };
  icon?: { name: string; label?: string; svg?: string };
  attribution?: string;
  source?: string;
  meta?: Record<string, string | number | boolean>;
}

export interface DemoDocument {
  title: string;
  blocks: DemoBlock[];
  meta: {
    model: string;
    sections: string[];
    visuals: number;
    warnings: string[];
    generatedAt: string;
  };
}

const MAX_SECTIONS = 10;
const MIN_TOTAL_WORDS = 320;
const DEFAULT_SECTIONS = [
  'Executive Summary',
  'Understanding Your Goals',
  'Proposed Approach',
  'Scope of Work',
  'Deliverables',
  'Timeline',
  'Investment',
  'Next Steps',
];

const SYSTEM = [
  'You are a senior proposal writer for an independent business.',
  'You write in plain, specific British English with no hype.',
  'Never invent facts, figures, client names, testimonials, statistics or timelines that are not in the supplied brief.',
  'If information is missing, write around it instead of making it up.',
  'Return only valid JSON. No markdown fences, no commentary.',
].join(' ');

interface SectionPlan {
  id: string;
  heading: string;
  purpose: string;
}

interface DraftedSection {
  id: string;
  paragraphs: string[];
  bullets: string[];
}

let counter = 0;
function blockId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `demo_${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

function sectionSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
}

function clean(value: string, max = 2000): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function briefFacts(brief: DemoBrief): string {
  const lines = [
    `Business: ${brief.businessName || 'the business'}`,
    `Client: ${brief.clientName || 'the client'}`,
    `Industry: ${brief.industry || 'not specified'}`,
    `Service being sold: ${brief.service || 'not specified'}`,
    `Client problem / objectives: ${brief.problem || 'not specified'}`,
    `Requirements: ${brief.requirements || 'not specified'}`,
    `Scope supplied by the user: ${brief.scope || 'not specified'}`,
    `Deliverables supplied by the user: ${brief.deliverables || 'not specified'}`,
    `Timeline supplied by the user: ${brief.timeline || 'not specified'}`,
    `Budget supplied by the user: ${brief.budget || 'not specified'}`,
    `Payment terms supplied by the user: ${brief.paymentTerms || 'not specified'}`,
    `Audience: ${brief.targetAudience || 'not specified'}`,
    `Additional context: ${brief.additional || 'not specified'}`,
  ];
  if (brief.packages.length) {
    lines.push(
      'Packages (only real prices may be used): ' +
        brief.packages
          .map((pkg) => `${pkg.name}${pkg.price !== undefined ? ` at ${pkg.price}` : ''}: ${pkg.deliverables}`)
          .join(' | ')
    );
  }
  return lines.join('\n');
}

function baselineCopy(brief: DemoBrief): Record<string, string> {
  return organizeSections({
    client_name: brief.clientName || 'the client',
    business_name: brief.businessName,
    business_website: brief.businessWebsite,
    business_description: brief.additional,
    industry: brief.industry,
    service: brief.service,
    tone: brief.tone || 'Formal',
    sections: brief.sections,
    notes: [],
    facts: {},
    problem: brief.problem,
    target_audience: brief.targetAudience,
    timeline: brief.timeline,
    cta: 'the next step',
    scope: brief.scope,
    packages: brief.packages,
  });
}

function words(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

async function planSections(env: Bindings, brief: DemoBrief, baseline: Record<string, string>): Promise<SectionPlan[]> {
  const requested = brief.sections.length ? brief.sections : DEFAULT_SECTIONS;
  const sections = [...new Set(requested.map((item) => clean(item, 80)).filter(Boolean))].slice(0, MAX_SECTIONS);
  const grounding = sections
    .map((section) => `- ${section}: ${baseline[normaliseSection(section)] ?? '(no baseline copy)'}`)
    .join('\n')
    .slice(0, 4000);

  const raw = await demoChat(
    env,
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `Plan a proposal for this engagement.\n\n${briefFacts(brief)}\n\n` +
          `Sections the visitor asked for: ${sections.join(', ')}\n\n` +
          `Baseline notes from our pattern library (grounding only, may be thin):\n${grounding}\n\n` +
          'Return JSON: {"sections":[{"id":"kebab-case-id","heading":"Section heading","purpose":"one sentence on what it must establish"}]}. ' +
          `Return exactly ${sections.length} sections in the requested order, using the requested section names. Do not add sections.`,
      },
    ],
    { maxTokens: 600, temperature: 0.3, timeoutMs: 22_000 }
  );

  const parsed = parseModelJson<{ sections?: unknown }>(raw);
  const plans: SectionPlan[] = [];
  if (parsed && Array.isArray(parsed.sections)) {
    for (const item of parsed.sections.slice(0, Math.max(sections.length, MAX_SECTIONS))) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const heading = clean(String(record.heading ?? ''), 90);
      if (!heading) continue;
      plans.push({
        id: clean(String(record.id ?? ''), 60) || sectionSlug(heading),
        heading,
        purpose: clean(String(record.purpose ?? ''), 240) || 'Support the proposal with specific, honest copy.',
      });
    }
  }

  if (plans.length >= 2) {
    // Keep the visitor's order: plans are matched back onto the requested list.
    const ordered: SectionPlan[] = [];
    for (const section of sections) {
      const match = plans.find((plan) => plan.heading.toLowerCase() === section.toLowerCase());
      ordered.push(match ?? { id: sectionSlug(section), heading: section, purpose: 'Cover this section concisely and honestly.' });
    }
    return ordered;
  }

  return sections.map((section) => ({
    id: sectionSlug(section),
    heading: section,
    purpose: 'Cover this section concisely and honestly.',
  }));
}

async function draftGroup(
  env: Bindings,
  brief: DemoBrief,
  baseline: Record<string, string>,
  plans: SectionPlan[]
): Promise<DraftedSection[]> {
  const outline = plans
    .map((plan) => `- ${plan.id} | ${plan.heading} | ${plan.purpose}`)
    .join('\n');

  const raw = await demoChat(
    env,
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `Write these proposal sections.\n\n${briefFacts(brief)}\n\n` +
          `Sections:\n${outline}\n\n` +
          'Rules: 2 to 3 paragraphs per section, each 45 to 90 words. Use second person ("you") for the client. ' +
          'Where a bullet list genuinely helps (scope, deliverables, next steps), add 3 to 5 short bullets. ' +
          'Never invent numbers, percentages, dates, client quotes or facts. If the brief lacks a detail, describe the approach without it. ' +
          'Pricing copy may only repeat package names and prices supplied above.' +
          '\n\nReturn JSON: {"sections":[{"id":"section id","paragraphs":["..."],"bullets":["..."]}]}',
      },
    ],
    { maxTokens: 1800, temperature: 0.45, timeoutMs: 40_000 }
  );

  const parsed = parseModelJson<{ sections?: unknown }>(raw);
  const drafts: DraftedSection[] = [];
  if (parsed && Array.isArray(parsed.sections)) {
    for (const item of parsed.sections) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const id = clean(String(record.id ?? ''), 60);
      const paragraphs = Array.isArray(record.paragraphs)
        ? record.paragraphs.map((value) => clean(String(value), 1400)).filter(Boolean).slice(0, 3)
        : [];
      const bullets = Array.isArray(record.bullets)
        ? record.bullets.map((value) => clean(String(value), 240)).filter(Boolean).slice(0, 6)
        : [];
      if (!id || (!paragraphs.length && !bullets.length)) continue;
      drafts.push({ id, paragraphs, bullets });
    }
  }
  return drafts;
}

function pricingBlocks(brief: DemoBrief): DemoBlock[] {
  if (!brief.packages.length) return [];
  const blocks: DemoBlock[] = [
    { id: blockId('price'), type: 'heading', text: 'Pricing', level: 'h2' },
    {
      id: blockId('price'),
      type: 'pricing_table',
      items: brief.packages.map((pkg) => ({
        label: pkg.name,
        value: pkg.deliverables,
        price: pkg.price,
      })),
    },
  ];
  if (brief.paymentTerms) {
    blocks.push({ id: blockId('price'), type: 'paragraph', text: `Payment terms: ${brief.paymentTerms}` });
  }
  return blocks;
}

interface PlannedVisual {
  sectionIndex: number;
  request: { type: 'image' | 'icon' | 'chart' | 'diagram'; query: string; afterBlockId: string; section_id: string; data?: unknown };
}

function planVisuals(brief: DemoBrief, blocks: DemoBlock[]): PlannedVisual[] {
  const planned: PlannedVisual[] = [];
  const usable = (index: number) => index >= 0 && index < blocks.length;

  // A chart is only honest when the visitor supplied at least two real prices.
  const priced = brief.packages.filter((pkg) => typeof pkg.price === 'number' && Number.isFinite(pkg.price));
  const pricingHeadingIndex = blocks.findIndex((block) => block.type === 'heading' && /pricing|investment/i.test(block.text ?? ''));
  if (priced.length >= 2 && usable(pricingHeadingIndex)) {
    planned.push({
      sectionIndex: pricingHeadingIndex,
      request: {
        type: 'chart',
        query: 'Package comparison',
        afterBlockId: blocks[pricingHeadingIndex].id,
        section_id: blocks[pricingHeadingIndex].id,
        data: {
          title: 'Package prices',
          unit: brief.budget.includes('£') ? '£' : undefined,
          labels: priced.map((pkg) => pkg.name.slice(0, 40)),
          values: priced.map((pkg) => pkg.price as number),
        },
      },
    });
  }

  // A diagram is only honest when the visitor supplied at least two milestones.
  const milestones = brief.timeline
    .split(/\r?\n|;|\u2022|,(?=\s*[A-Z])/)
    .map((item) => clean(item, 120))
    .filter(Boolean);
  const timelineHeadingIndex = blocks.findIndex((block) => block.type === 'heading' && /timeline|schedule|milestone/i.test(block.text ?? ''));
  if (milestones.length >= 2 && usable(timelineHeadingIndex)) {
    planned.push({
      sectionIndex: timelineHeadingIndex,
      request: {
        type: 'diagram',
        query: 'Delivery timeline',
        afterBlockId: blocks[timelineHeadingIndex].id,
        section_id: blocks[timelineHeadingIndex].id,
        data: {
          title: 'Delivery milestones',
          steps: milestones.slice(0, 6),
        },
      },
    });
  }

  // One icon for the approach, one photo for the introduction/context.
  const approachIndex = blocks.findIndex((block) => block.type === 'heading' && /approach|scope|solution|understand/i.test(block.text ?? ''));
  if (usable(approachIndex)) {
    planned.push({
      sectionIndex: approachIndex,
      request: {
        type: 'icon',
        query: clean(brief.service || brief.industry || 'consulting', 80),
        afterBlockId: blocks[approachIndex].id,
        section_id: blocks[approachIndex].id,
      },
    });
  }

  const introIndex = blocks.findIndex((block) => block.type === 'heading');
  if (usable(introIndex) && planned.every((item) => item.sectionIndex !== introIndex)) {
    planned.push({
      sectionIndex: introIndex,
      request: {
        type: 'image',
        query: clean(`${brief.industry || brief.service || 'business'} ${brief.clientName}`.trim(), 90),
        afterBlockId: blocks[introIndex].id,
        section_id: blocks[introIndex].id,
      },
    });
  }

  return planned.slice(0, 4);
}

function visualBlock(asset: any, request: PlannedVisual['request']): DemoBlock | null {
  if (!asset || typeof asset !== 'object') return null;
  const meta = { fromPipeline: request.query, visual: String(asset.type ?? request.type) };
  const attribution = typeof asset.attribution === 'string' ? asset.attribution : undefined;
  const source = typeof asset.source === 'string' ? asset.source : undefined;

  if (asset.type === 'image' && typeof asset.url === 'string' && /^https?:\/\//i.test(asset.url)) {
    return {
      id: blockId('img'),
      type: 'image',
      url: asset.url,
      alt: typeof asset.alt === 'string' ? asset.alt : request.query,
      caption: attribution ?? undefined,
      attribution,
      source,
      meta,
    };
  }

  if (asset.type === 'icon' && typeof asset.icon === 'string' && /^[a-z0-9-]+:[a-z0-9-]+$/i.test(asset.icon)) {
    return {
      id: blockId('icon'),
      type: 'icon',
      icon: {
        name: asset.icon,
        label: typeof asset.alt === 'string' ? asset.alt : request.query,
        svg: typeof asset.svg === 'string' ? asset.svg : undefined,
      },
      alt: request.query,
      meta,
    };
  }

  if (asset.type === 'chart' && asset.chart && Array.isArray(asset.chart.values) && Array.isArray(asset.chart.labels)) {
    const series = asset.chart.values
      .map((value: unknown, index: number) => ({
        label: String(asset.chart.labels[index] ?? ''),
        value: Number(value),
      }))
      .filter((point: { label: string; value: number }) => point.label && Number.isFinite(point.value));
    if (series.length < 2) return null;
    return {
      id: blockId('chart'),
      type: 'chart',
      chart: {
        kind: asset.chart.kind === 'line' ? 'line' : 'bar',
        title: typeof asset.chart.title === 'string' ? asset.chart.title : request.query,
        unit: typeof asset.chart.unit === 'string' ? asset.chart.unit : undefined,
        series,
      },
      alt: typeof asset.chart.title === 'string' ? asset.chart.title : request.query,
      meta,
    };
  }

  if (asset.type === 'diagram' && asset.diagram && Array.isArray(asset.diagram.steps)) {
    const steps = asset.diagram.steps
      .map((step: unknown) => {
        if (typeof step === 'string') return { title: step };
        if (step && typeof step === 'object') {
          const record = step as Record<string, unknown>;
          const title = typeof record.title === 'string' ? record.title : '';
          const detail = typeof record.detail === 'string' ? record.detail : undefined;
          return title ? { title, detail } : null;
        }
        return null;
      })
      .filter(Boolean) as { title: string; detail?: string }[];
    if (steps.length < 2) return null;
    return {
      id: blockId('diagram'),
      type: 'diagram',
      diagram: {
        title: typeof asset.diagram.title === 'string' ? asset.diagram.title : request.query,
        steps,
      },
      alt: typeof asset.diagram.title === 'string' ? asset.diagram.title : request.query,
      meta,
    };
  }

  return null;
}

export interface GenerateResult {
  document: DemoDocument;
  rejected: string[];
}

export async function generateDemoProposal(env: Bindings, brief: DemoBrief): Promise<GenerateResult> {
  const warnings: string[] = [];
  const baseline = baselineCopy(brief);
  const plans = await planSections(env, brief, baseline);

  // Two parallel writing calls keep the request inside a browser-safe wait
  // while still writing section by section rather than in one mega-prompt.
  const midpoint = Math.ceil(plans.length / 2);
  const groups = [plans.slice(0, midpoint), plans.slice(midpoint)].filter((group) => group.length > 0);
  const draftsByGroup = await Promise.all(
    groups.map((group) =>
      draftGroup(env, brief, baseline, group).catch((error) => {
        if (error instanceof DemoAiError && (error.code === 'ai_rate_limited' || error.code === 'ai_quota_exhausted')) {
          throw error;
        }
        console.error('DEMO_DRAFT_GROUP_FAILED', (error as Error)?.message ?? error);
        return [] as DraftedSection[];
      })
    )
  );
  const drafts = draftsByGroup.flat();

  const blocks: DemoBlock[] = [
    { id: blockId('head'), type: 'heading', text: brief.title || `${brief.clientName} — Proposal`, level: 'h1' },
    {
      id: blockId('meta'),
      type: 'paragraph',
      text: `Prepared for ${brief.clientName}${brief.businessName ? ` by ${brief.businessName}` : ''}.`,
    },
  ];

  let written = 0;
  plans.forEach((plan, index) => {
    const draft =
      drafts.find((item) => item.id === plan.id) ||
      drafts.find((item) => item.id.toLowerCase() === sectionSlug(plan.heading)) ||
      drafts.find((item) => item.id.toLowerCase() === plan.heading.toLowerCase());
    const paragraphs = draft?.paragraphs ?? [];
    const bullets = draft?.bullets ?? [];
    if (!paragraphs.length && !bullets.length) {
      // A silent empty section is worse than an honest placeholder.
      warnings.push(`"${plan.heading}" could not be written by the AI provider. You can add it in the editor.`);
      return;
    }
    written += 1;
    blocks.push({ id: blockId('h'), type: 'heading', text: plan.heading, level: 'h2' });
    for (const paragraph of paragraphs) {
      blocks.push({ id: blockId('p'), type: 'paragraph', text: paragraph });
    }
    if (bullets.length) {
      blocks.push({ id: blockId('l'), type: 'list', items: bullets.map((bullet) => ({ label: bullet })) });
    }
    const isPricing = /pricing|investment|cost|fee/i.test(plan.heading);
    if (isPricing) blocks.push(...pricingBlocks(brief));
  });

  if (brief.packages.length && !plans.some((plan) => /pricing|investment|cost|fee/i.test(plan.heading))) {
    blocks.push(...pricingBlocks(brief));
  }

  if (written === 0) {
    throw new DemoAiError('ai_bad_response', 'The AI provider did not return usable proposal copy. Please retry.', 502);
  }

  // Visuals come from the same resolver production uses. Failures are reported,
  // never replaced with invented charts.
  let visuals = 0;
  const rejected: string[] = [];
  try {
    const planned = planVisuals(brief, blocks);
    if (planned.length) {
      const result = await resolveVisuals(planned.map((item) => item.request));
      for (const rejection of result.rejected ?? []) {
        rejected.push(String(rejection.reason ?? 'unavailable').replace(/_/g, ' '));
      }
      for (const item of planned) {
        const asset =
          result.assets?.[item.request.afterBlockId] ??
          result.items?.find((candidate) => candidate.afterBlockId === item.request.afterBlockId);
        const block = visualBlock(asset, item.request);
        if (!block) continue;
        const at = blocks.findIndex((candidate) => candidate.id === item.request.afterBlockId);
        if (at < 0) continue;
        blocks.splice(at + 1, 0, block);
        visuals += 1;
      }
    }
  } catch (error) {
    console.error('DEMO_VISUALS_FAILED', (error as Error)?.message ?? error);
    warnings.push('Visual assets could not be fetched this time; the document is text-only.');
  }

  const totalWords = blocks
    .filter((block) => block.type === 'paragraph' || block.type === 'heading')
    .reduce((sum, block) => sum + words(block.text ?? ''), 0);
  if (totalWords < MIN_TOTAL_WORDS) {
    warnings.push('The draft is shorter than usual. Add your own detail before sending it to a client.');
  }
  if (rejected.length) {
    warnings.push(`Some visual requests had no usable asset (${rejected.slice(0, 2).join(', ')}).`);
  }

  return {
    document: {
      title: brief.title || `${brief.clientName} — Proposal`,
      blocks,
      meta: {
        model: demoModel(env),
        sections: plans.map((plan) => plan.heading),
        visuals,
        warnings,
        generatedAt: new Date().toISOString(),
      },
    },
    rejected,
  };
}

const REFINE_INSTRUCTIONS: Record<string, string> = {
  improve: 'Improve the clarity and flow without adding new facts.',
  professional: 'Rewrite in a more professional, measured register.',
  persuasive: 'Make it more persuasive by being more specific about value already described. Do not add claims.',
  simplify: 'Simplify the language and split long sentences.',
  expand: 'Expand with more useful detail that is already implied by the passage. Do not invent facts.',
  shorten: 'Shorten it by roughly a third while keeping every fact.',
  summary: 'Strengthen this as an executive summary: outcome, approach, and why it matters.',
  scope: 'Make this scope of work more precise and easy to check.',
  value: 'Sharpen the value proposition without inventing evidence.',
  pricing: 'Explain the pricing more clearly without changing any figure.',
};

/** Rewrites one passage. Never regenerates the whole document. */
export async function refineDemoText(
  env: Bindings,
  input: { text: string; action: string; instruction?: string; tone?: string; context?: string }
): Promise<{ text: string; model: string }> {
  const guidance = REFINE_INSTRUCTIONS[input.action] ?? 'Improve the passage.';
  const extra = input.instruction ? ` Extra instruction from the visitor: ${clean(input.instruction, 300)}.` : '';
  const raw = await demoChat(
    env,
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `${guidance}${extra}\nTone: ${clean(input.tone ?? 'professional', 40)}.\n` +
          `Keep every name, number, date and commitment exactly as written.\n` +
          `Document context: ${clean(input.context ?? '', 1200)}\n\n` +
          `Passage:\n${clean(input.text, 4000)}\n\n` +
          'Return only the rewritten passage as plain text. No quotes, labels or commentary.',
      },
    ],
    { maxTokens: 700, temperature: 0.5, timeoutMs: 25_000 }
  );
  const text = raw.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
  if (!text) throw new DemoAiError('ai_bad_response', 'The AI provider returned an empty edit. Please retry.', 502);
  return { text: text.slice(0, 6000), model: demoModel(env) };
}

/** One visual for the editor's replace/regenerate action. */
export async function generateDemoVisual(
  env: Bindings,
  input: { type: 'image' | 'icon' | 'chart' | 'diagram'; query: string; data?: unknown }
): Promise<{ block: DemoBlock | null; reason?: string }> {
  void env;
  const request = {
    type: input.type,
    query: clean(input.query, 200) || 'document visual',
    afterBlockId: 'demo',
    section_id: 'demo',
    data: input.data,
  };
  const result = await resolveVisuals([request]);
  const asset = result.items?.[0];
  const block = visualBlock(asset, request as PlannedVisual['request']);
  if (!block) {
    return { block: null, reason: String(result.rejected?.[0]?.reason ?? 'no_matching_asset').replace(/_/g, ' ') };
  }
  return { block };
}
