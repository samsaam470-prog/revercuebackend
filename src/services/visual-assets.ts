import {
  fetchOpenverseImage,
  searchIcons,
  type ImageAttribution,
} from './pipeline';

/**
 * Typed visual assets.
 *
 * The previous implementation asked for a mixed batch and then read the
 * results back by array index. The resolver skips a request when a source has
 * nothing, so every later asset shifted one place and could be attached to the
 * wrong section (or dropped). This module resolves each request on its own,
 * keeps the asset's real type and structured data, and never turns a chart or
 * a diagram into a generic image URL.
 */

export type VisualAssetType = 'image' | 'icon' | 'chart' | 'diagram' | 'svg';

export const VISUAL_TYPES: VisualAssetType[] = ['image', 'icon', 'chart', 'diagram', 'svg'];

export interface VisualRequestInput {
  type: VisualAssetType;
  query: string;
  section_id?: string;
  afterBlockId?: string;
  data?: unknown;
}

export interface ChartSpec {
  kind: 'bar' | 'line';
  labels: string[];
  values: number[];
  unit?: string;
  title?: string;
}

export interface DiagramSpec {
  mermaid: string;
  steps: string[];
}

export interface ResolvedVisual {
  /** Stable per-request key. Two visuals in one section never collide. */
  id: string;
  type: VisualAssetType;
  query: string;
  section_id?: string;
  afterBlockId?: string;
  url?: string;
  alt?: string;
  caption?: string;
  license?: string | null;
  creator?: string | null;
  source?: string | null;
  attribution?: string | null;
  icon?: string;
  svg?: string;
  chart?: ChartSpec;
  diagram?: DiagramSpec;
}

export interface RejectedVisual {
  request: unknown;
  reason: string;
}

export interface ResolveVisualsResult {
  assets: Record<string, ResolvedVisual>;
  items: ResolvedVisual[];
  rejected: RejectedVisual[];
}

const MAX_REQUESTS = 8;
const MAX_QUERY = 200;
const ICON_ID = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/i;
const MERMAID_START = /^(graph|flowchart)\s+(LR|TD|TB|RL|BT)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function cleanText(value: unknown, max = MAX_QUERY): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Accepts `type` or the older `kind` alias, exactly as the callers send it. */
export function validateRequests(requests: unknown): { valid: VisualRequestInput[]; rejected: RejectedVisual[] } {
  const valid: VisualRequestInput[] = [];
  const rejected: RejectedVisual[] = [];
  if (!Array.isArray(requests)) return { valid, rejected: [{ request: requests, reason: 'requests_must_be_an_array' }] };

  for (const raw of requests.slice(0, MAX_REQUESTS)) {
    if (!isRecord(raw)) {
      rejected.push({ request: raw, reason: 'request_must_be_an_object' });
      continue;
    }
    const type = String(raw.type ?? raw.kind ?? '').toLowerCase() as VisualAssetType;
    if (!VISUAL_TYPES.includes(type)) {
      rejected.push({ request: raw, reason: 'unsupported_visual_type' });
      continue;
    }
    const query = cleanText(raw.query);
    if (!query) {
      rejected.push({ request: raw, reason: 'missing_query' });
      continue;
    }
    const afterBlockId = cleanText(raw.afterBlockId ?? raw.section_id, 120) || undefined;
    const sectionId = cleanText(raw.section_id ?? raw.afterBlockId, 120) || undefined;
    valid.push({ type, query, section_id: sectionId, afterBlockId, data: (raw as any).data });
  }
  return { valid, rejected };
}

/** Reads `{labels, values}` from the shapes the pipeline and callers use. */
export function readChartData(data: unknown): ChartSpec | null {
  if (!isRecord(data)) return null;
  const nested = isRecord(data.data) ? data.data : data;
  const labelsRaw = nested.labels ?? (isRecord(nested.chart) ? nested.chart.labels : undefined);
  const valuesRaw = nested.values ?? (isRecord(nested.chart) ? nested.chart.values : undefined);
  if (!Array.isArray(labelsRaw) || !Array.isArray(valuesRaw)) return null;
  if (labelsRaw.length < 2 || labelsRaw.length > 12 || labelsRaw.length !== valuesRaw.length) return null;
  const labels = labelsRaw.map((label) => cleanText(label, 40));
  const values = valuesRaw.map((value) => Number(value));
  if (labels.some((label) => !label)) return null;
  if (values.some((value) => !Number.isFinite(value))) return null;
  const kind = String(nested.kind ?? '').toLowerCase() === 'line' ? 'line' : 'bar';
  return {
    kind,
    labels,
    values,
    unit: cleanText(nested.unit, 12) || undefined,
    title: cleanText(nested.title, 120) || undefined,
  };
}

function stepsFromData(data: unknown): string[] {
  if (Array.isArray(data)) return data.map((step) => cleanText(step, 80)).filter(Boolean);
  if (!isRecord(data)) return [];
  const raw = Array.isArray(data.steps) ? data.steps : Array.isArray(data.nodes) ? data.nodes : [];
  return raw
    .map((step) => (isRecord(step) ? cleanText(step.label ?? step.text, 80) : cleanText(step, 80)))
    .filter(Boolean);
}

export function buildDiagram(query: string, data: unknown): DiagramSpec | null {
  if (isRecord(data) && typeof data.mermaid === 'string' && MERMAID_START.test(data.mermaid.trim())) {
    const mermaid = data.mermaid.trim().slice(0, 4000);
    const steps = stepsFromData(data);
    return { mermaid, steps: steps.length ? steps : stepsFromMermaid(mermaid) };
  }
  let steps = stepsFromData(data);
  if (!steps.length) {
    const lines = query.split(/\n|;|\|/).map((line) => cleanText(line, 80)).filter(Boolean);
    if (lines.length >= 2) steps = lines;
  }
  steps = Array.from(new Set(steps)).slice(0, 8);
  if (steps.length < 2) return null;
  const nodes = steps.map((step, index) => `  N${index}["${step.replace(/"/g, "'")}"]`).join('\n');
  const edges = steps.slice(1).map((_, index) => `  N${index} --> N${index + 1}`).join('\n');
  return { mermaid: `graph LR\n${nodes}\n${edges}`, steps };
}

export function stepsFromMermaid(mermaid: string): string[] {
  const steps: string[] = [];
  for (const match of mermaid.matchAll(/\["([^"]+)"\]/g)) {
    if (!steps.includes(match[1])) steps.push(match[1]);
  }
  return steps;
}

/** Inline SVG is rendered inside an <img>, but strip active content anyway. */
export function sanitiseSvg(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const svg = value.trim();
  if (!/^<svg[\s>]/i.test(svg) || svg.length > 20000) return null;
  const safe = svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
  return safe;
}

function iconNameMatches(query: string, icon: string): boolean {
  const words = query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  if (!words.length) return false;
  const name = icon.split(':')[1]?.toLowerCase() ?? '';
  return words.some((word) => name.includes(word));
}

function attributionOf(image: ImageAttribution): string | null {
  const parts = [image.creator, image.license, image.source].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(' · ') : null;
}

async function resolveOne(request: VisualRequestInput): Promise<ResolvedVisual | null> {
  const base = { query: request.query, section_id: request.section_id, afterBlockId: request.afterBlockId };

  if (request.type === 'image') {
    const provided = isRecord(request.data) ? request.data.url : undefined;
    if (isHttpUrl(provided)) {
      return {
        ...base,
        id: '',
        type: 'image',
        url: provided,
        alt: cleanText(isRecord(request.data) ? request.data.alt : undefined, 160) || request.query,
        source: cleanText(isRecord(request.data) ? request.data.source : undefined, 120) || 'provided',
      };
    }
    const image = await fetchOpenverseImage(request.query);
    if (!image || !isHttpUrl(image.url)) return null;
    return {
      ...base,
      id: '',
      type: 'image',
      url: image.url,
      alt: request.query,
      license: image.license,
      creator: image.creator,
      source: image.source,
      attribution: attributionOf(image),
    };
  }

  if (request.type === 'icon') {
    const explicit = isRecord(request.data) ? request.data.icon : undefined;
    if (typeof explicit === 'string' && ICON_ID.test(explicit)) {
      return { ...base, id: '', type: 'icon', icon: explicit, source: 'provided', alt: request.query };
    }
    const candidates = await searchIcons(request.query);
    const icon = candidates.find((candidate) => iconNameMatches(request.query, candidate)) ?? null;
    if (!icon) return null;
    return { ...base, id: '', type: 'icon', icon, source: 'Iconify', alt: request.query };
  }

  if (request.type === 'chart') {
    const chart = readChartData(request.data);
    if (!chart) return null;
    return {
      ...base,
      id: '',
      type: 'chart',
      chart,
      caption: chart.title || request.query,
      source: 'document data',
    };
  }

  if (request.type === 'diagram') {
    const diagram = buildDiagram(request.query, request.data);
    if (!diagram) return null;
    return {
      ...base,
      id: '',
      type: 'diagram',
      diagram,
      caption: request.query,
      source: 'document structure',
    };
  }

  // svg
  const svg = sanitiseSvg(isRecord(request.data) ? request.data.svg : request.data);
  if (svg) return { ...base, id: '', type: 'svg', svg, alt: request.query };
  if (isRecord(request.data) && isHttpUrl(request.data.url) && String(request.data.url).toLowerCase().includes('.svg')) {
    return { ...base, id: '', type: 'svg', url: String(request.data.url), alt: request.query };
  }
  return null;
}

function identityOf(asset: ResolvedVisual): string {
  return [
    asset.type,
    asset.url ?? '',
    asset.icon ?? '',
    asset.svg ? asset.svg.slice(0, 80) : '',
    asset.chart ? JSON.stringify(asset.chart) : '',
    asset.diagram ? asset.diagram.mermaid : '',
  ].join('|');
}

export async function resolveVisuals(requests: unknown): Promise<ResolveVisualsResult> {
  const { valid, rejected } = validateRequests(requests);
  const assets: Record<string, ResolvedVisual> = {};
  const items: ResolvedVisual[] = [];
  const seenIdentity = new Set<string>();
  const perAnchor = new Map<string, number>();

  for (const request of valid) {
    const anchor = request.afterBlockId || request.section_id || 'document';
    const ordinal = perAnchor.get(anchor) ?? 0;
    perAnchor.set(anchor, ordinal + 1);
    const id = `${anchor}#${ordinal}`;

    let resolved: ResolvedVisual | null = null;
    try {
      resolved = await resolveOne(request);
    } catch (error) {
      rejected.push({ request, reason: `resolver_error:${(error as Error)?.message ?? 'unknown'}`.slice(0, 200) });
      continue;
    }
    if (!resolved) {
      const reason =
        request.type === 'chart'
          ? 'chart_requires_real_data'
          : request.type === 'diagram'
            ? 'diagram_requires_steps'
            : request.type === 'svg'
              ? 'invalid_svg'
              : 'no_matching_asset';
      rejected.push({ request, reason });
      continue;
    }

    const identity = identityOf(resolved);
    if (seenIdentity.has(identity)) {
      rejected.push({ request, reason: 'duplicate_asset' });
      continue;
    }
    seenIdentity.add(identity);

    const item: ResolvedVisual = { ...resolved, id };
    items.push(item);
    assets[id] = item;
    // Backwards compatibility for callers that read `assets[afterBlockId]`.
    const legacyKey = request.afterBlockId || request.section_id;
    if (legacyKey && !assets[legacyKey]) assets[legacyKey] = item;
  }

  return { assets, items, rejected };
}

/**
 * The legacy array API used by `/api/extract/visuals`. Kept as a thin wrapper
 * so existing callers keep working, but charts now need real data and never
 * become a QuickChart image.
 */
export async function fetchVisualAssets(
  _env: unknown,
  requests: { type: string; query: string; data?: unknown }[],
): Promise<ResolvedVisual[]> {
  const { items } = await resolveVisuals(requests);
  return items;
}
