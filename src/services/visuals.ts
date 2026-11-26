import { z } from 'zod';
import { fetchVisualAssets } from './pipeline';
import type { Bindings } from '../types';

/**
 * Layer 4 — visual resolution.
 *
 * The previous version treated every visual as a URL: it asked for an asset
 * array, mapped results back by their position in the array of *successes*
 * (so one miss shifted every later asset onto the wrong section), and dropped
 * the licence, the icon identifier, the chart data and the diagram source.
 * This module owns the contract instead:
 *
 *   request  → validated, typed, carries its own id and optional data
 *   asset    → the same id, the same type, and the structure needed to edit it
 *
 * Nothing is invented. A chart without numeric data is rejected rather than
 * drawn, a diagram without steps is rejected rather than guessed, and an asset
 * that cannot be fetched is reported as rejected for that request only.
 */

export const VISUAL_TYPES = ['image', 'icon', 'chart', 'diagram', 'svg'] as const;
export type VisualType = (typeof VISUAL_TYPES)[number];

/** A document needs a handful of visuals, not one per block. */
const MAX_REQUESTS = 12;

const chartPointSchema = z.object({
  label: z.string().trim().min(1).max(80),
  value: z.number().finite(),
});

export const chartDataSchema = z.object({
  kind: z.enum(['bar', 'line']).optional(),
  title: z.string().trim().max(120).optional(),
  unit: z.string().trim().max(24).optional(),
  source: z.string().trim().max(200).optional(),
  // A single bar is not a chart: two points is the smallest honest series.
  series: z.array(chartPointSchema).min(2).max(24),
});

export const diagramStepSchema = z.object({
  title: z.string().trim().min(1).max(120),
  detail: z.string().trim().max(240).optional(),
});

export const diagramDataSchema = z.object({
  title: z.string().trim().max(120).optional(),
  source: z.string().trim().max(200).optional(),
  steps: z.array(diagramStepSchema).min(2).max(12),
});

export const visualRequestSchema = z
  .object({
    /** The caller's id for this request. The asset is returned under it. */
    id: z.string().trim().min(1).max(120).optional(),
    afterBlockId: z.string().trim().max(120).optional(),
    section_id: z.string().trim().max(120).optional(),
    type: z.enum(VISUAL_TYPES).optional(),
    kind: z.enum(VISUAL_TYPES).optional(),
    query: z.string().trim().min(1).max(200),
    /** Chart series, diagram steps or SVG markup for the non-search types. */
    data: z.unknown().optional(),
  })
  .refine((value) => Boolean(value.type || value.kind), {
    message: 'type is required',
  });

export type VisualRequestInput = z.infer<typeof visualRequestSchema>;

export interface VisualAsset {
  /** The id of the request this asset answers. */
  id: string;
  type: VisualType;
  query: string;
  afterBlockId?: string;
  section_id?: string;
  /** Photographs: the licensed original. */
  url?: string;
  /** Icons: the Iconify identifier, e.g. `mdi:calendar-check`. */
  icon?: string;
  /** Icons, graphics: the SVG markup, kept so the asset renders offline. */
  svg?: string;
  /** Diagrams: the structured flow, plus portable Mermaid source. */
  diagram?: z.infer<typeof diagramDataSchema>;
  mermaid?: string;
  /** Charts: the data and configuration, never a flattened picture. */
  chart?: z.infer<typeof chartDataSchema>;
  license?: string | null;
  creator?: string | null;
  source?: string | null;
  attribution?: string | null;
}

export interface RejectedVisual {
  id: string;
  type: string | null;
  query: string | null;
  reason: string;
}

export interface ResolvedVisuals {
  /** Keyed by request id, which is also the asset's own id. */
  assets: Record<string, VisualAsset>;
  rejected: RejectedVisual[];
  warnings: string[];
}

function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

/** Validates requests without resolving them. Kept for existing callers. */
export function validateRequests(requests: unknown): { valid: VisualRequestInput[]; rejected: unknown[] } {
  const valid: VisualRequestInput[] = [];
  const rejected: unknown[] = [];
  if (!Array.isArray(requests)) return { valid, rejected };
  for (const raw of requests.slice(0, MAX_REQUESTS)) {
    const parsed = visualRequestSchema.safeParse(raw);
    if (parsed.success) valid.push(parsed.data);
    else rejected.push({ request: raw, reason: describe(parsed.error) });
  }
  return { valid, rejected };
}

/** Confirms the markup is a standalone SVG and removes executable content. */
export function sanitiseSvg(markup: string): string | null {
  const source = String(markup ?? '').trim();
  if (!source || source.length > 20000) return null;
  if (!/^<svg[\s>]/i.test(source)) return null;
  if (!/<\/svg>\s*$/i.test(source)) return null;
  const cleaned = source
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("|')javascript:[^"']*\2/gi, '');
  return cleaned.length > 10 ? cleaned : null;
}

function mermaidFor(diagram: z.infer<typeof diagramDataSchema>): string {
  const id = (index: number) => `S${index}`;
  const nodes = diagram.steps.map((step, index) => `  ${id(index)}["${step.title.replace(/"/g, "'")}"]`);
  const edges = diagram.steps.slice(1).map((_, index) => `  ${id(index)} --> ${id(index + 1)}`);
  return `graph LR\n${nodes.join('\n')}\n${edges.join('\n')}`;
}

/** The stable identity of an asset, for de-duplication across sections. */
export function visualIdentity(asset: VisualAsset): string {
  if (asset.type === 'image') return `image:${asset.url ?? ''}`;
  if (asset.type === 'icon') return `icon:${asset.icon ?? asset.svg ?? ''}`;
  if (asset.type === 'svg') return `svg:${(asset.svg ?? '').length}:${(asset.svg ?? '').slice(0, 64)}`;
  if (asset.type === 'chart') return `chart:${JSON.stringify(asset.chart?.series ?? [])}`;
  if (asset.type === 'diagram') return `diagram:${JSON.stringify(asset.diagram?.steps ?? [])}`;
  return `${asset.type}:${asset.query}`;
}

function chartFromRequest(request: VisualRequestInput): VisualAsset['chart'] | null {
  const raw = request.data;
  const candidate =
    raw && typeof raw === 'object' && 'chart' in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>).chart
      : raw && typeof raw === 'object' && 'series' in (raw as Record<string, unknown>)
        ? raw
        : null;
  const parsed = chartDataSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function diagramFromRequest(request: VisualRequestInput): z.infer<typeof diagramDataSchema> | null {
  const raw = request.data;
  const candidate =
    raw && typeof raw === 'object' && 'diagram' in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>).diagram
      : raw && typeof raw === 'object' && 'steps' in (raw as Record<string, unknown>)
        ? raw
        : null;
  const parsed = diagramDataSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function svgFromRequest(request: VisualRequestInput): string | null {
  const raw = request.data;
  const candidate =
    raw && typeof raw === 'object' && 'svg' in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>).svg
      : typeof raw === 'string'
        ? raw
        : null;
  return typeof candidate === 'string' ? sanitiseSvg(candidate) : null;
}

/** The id an asset is returned under. Always traceable to one request. */
function requestId(request: VisualRequestInput, index: number): string {
  return request.id || request.afterBlockId || request.section_id || `visual_${index}`;
}

async function resolveSearched(
  env: Bindings,
  requests: { request: VisualRequestInput; id: string }[],
): Promise<Map<string, VisualAsset>> {
  const out = new Map<string, VisualAsset>();
  if (requests.length === 0) return out;
  const fetched = await fetchVisualAssets(
    env,
    requests.map(({ request }) => ({ type: request.type ?? request.kind ?? 'image', query: request.query })),
  );
  requests.forEach(({ request, id }, index) => {
    const asset = fetched[index];
    if (!asset) return;
    out.set(id, {
      id,
      type: (request.type ?? request.kind ?? asset.type) as VisualType,
      query: request.query,
      afterBlockId: request.afterBlockId,
      section_id: request.section_id || request.afterBlockId,
      url: asset.url,
      icon: asset.icon,
      svg: asset.svg,
      license: asset.license ?? null,
      creator: asset.creator ?? null,
      source: asset.source ?? null,
      attribution: asset.attribution || [asset.creator, asset.license, asset.source].filter(Boolean).join(' · ') || null,
    });
  });
  return out;
}

/**
 * Resolves every request independently: one failed asset never blocks the
 * others, and each asset keeps the type and structure it was requested with.
 */
export async function resolveVisuals(env: Bindings, rawRequests: unknown): Promise<ResolvedVisuals> {
  const assets: Record<string, VisualAsset> = {};
  const rejected: RejectedVisual[] = [];
  const warnings: string[] = [];

  const list = Array.isArray(rawRequests) ? rawRequests : [];
  if (list.length > MAX_REQUESTS) {
    warnings.push(`Only the first ${MAX_REQUESTS} visual requests were processed.`);
  }

  const valid: { request: VisualRequestInput; id: string }[] = [];
  list.slice(0, MAX_REQUESTS).forEach((raw, index) => {
    const parsed = visualRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      rejected.push({
        id: typeof record.id === 'string' ? record.id : `visual_${index}`,
        type: typeof record.type === 'string' ? record.type : typeof record.kind === 'string' ? record.kind : null,
        query: typeof record.query === 'string' ? record.query : null,
        reason: `invalid_request: ${describe(parsed.error)}`,
      });
      return;
    }
    valid.push({ request: parsed.data, id: requestId(parsed.data, index) });
  });

  // Search-backed types are fetched once per distinct query, then shared by
  // the requests that asked for them (the duplicate filter below removes the
  // repeats, so one photograph is never used twice in the same document).
  const searched = valid.filter(({ request }) => {
    const type = request.type ?? request.kind;
    return type === 'image' || type === 'icon';
  });
  const uniqueQueries = new Map<string, { request: VisualRequestInput; id: string }[]>();
  for (const item of searched) {
    const type = item.request.type ?? item.request.kind ?? 'image';
    const key = `${type}:${item.request.query.toLowerCase()}`;
    uniqueQueries.set(key, [...(uniqueQueries.get(key) ?? []), item]);
  }

  const resolved = new Map<string, VisualAsset>();
  for (const group of uniqueQueries.values()) {
    const [head, ...rest] = group;
    try {
      const fetched = await resolveSearched(env, [head]);
      const asset = fetched.get(head.id);
      if (asset) resolved.set(head.id, asset);
      for (const duplicate of rest) {
        if (asset) resolved.set(duplicate.id, { ...asset, id: duplicate.id, afterBlockId: duplicate.request.afterBlockId, section_id: duplicate.request.section_id || duplicate.request.afterBlockId });
      }
    } catch (error) {
      console.error('VISUAL_RESOLVE_FAILED', head.request.type, error);
      for (const item of group) {
        rejected.push({
          id: item.id,
          type: item.request.type ?? item.request.kind ?? null,
          query: item.request.query,
          reason: 'resolve_failed',
        });
      }
    }
  }

  const seen = new Set<string>();
  for (const { request, id } of valid) {
    const type = (request.type ?? request.kind) as VisualType;
    let asset: VisualAsset | null = null;

    try {
      if (type === 'image' || type === 'icon') {
        const found = resolved.get(id);
        if (found) asset = found;
        else rejected.push({ id, type, query: request.query, reason: type === 'image' ? 'no_licensed_image' : 'no_icon_match' });
      } else if (type === 'chart') {
        const chart = chartFromRequest(request);
        if (chart) asset = { id, type, query: request.query, afterBlockId: request.afterBlockId, section_id: request.section_id || request.afterBlockId, chart, source: chart.source ?? null };
        else rejected.push({ id, type, query: request.query, reason: 'chart_requires_numeric_data' });
      } else if (type === 'diagram') {
        const diagram = diagramFromRequest(request);
        if (diagram) {
          asset = { id, type, query: request.query, afterBlockId: request.afterBlockId, section_id: request.section_id || request.afterBlockId, diagram, mermaid: mermaidFor(diagram), source: diagram.source ?? null };
        } else {
          rejected.push({ id, type, query: request.query, reason: 'diagram_requires_steps' });
        }
      } else if (type === 'svg') {
        const svg = svgFromRequest(request);
        if (svg) asset = { id, type, query: request.query, afterBlockId: request.afterBlockId, section_id: request.section_id || request.afterBlockId, svg, source: 'supplied' };
        else rejected.push({ id, type, query: request.query, reason: 'svg_requires_valid_markup' });
      } else {
        rejected.push({ id, type, query: request.query, reason: 'unsupported_visual_type' });
      }
    } catch (error) {
      console.error('VISUAL_ASSET_FAILED', type, error);
      rejected.push({ id, type, query: request.query, reason: 'asset_failed' });
    }

    if (!asset) continue;
    const identity = visualIdentity(asset);
    if (!identity.replace(/^[a-z]+:/, '')) {
      rejected.push({ id, type, query: request.query, reason: 'empty_asset' });
      continue;
    }
    if (seen.has(identity)) {
      rejected.push({ id, type, query: request.query, reason: 'duplicate_asset' });
      continue;
    }
    seen.add(identity);
    assets[id] = asset;
  }

  return { assets, rejected, warnings };
}
