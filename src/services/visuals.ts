import { fetchVisualAssets } from './pipeline';
import type { Bindings } from '../types';

export interface VisualRequest {
  type: 'image' | 'icon' | 'chart' | 'diagram' | 'svg';
  query: string;
  section_id?: string;
  afterBlockId?: string;
  data?: any;
}

export interface VisualAsset {
  type: string;
  query: string;
  url?: string;
  icon?: string;
  mermaid?: string;
  echarts?: any;
  section_id?: string;
}

export function validateRequests(requests: any[]): { valid: VisualRequest[]; rejected: any[] } {
  const valid: VisualRequest[] = [];
  const rejected: any[] = [];
  for (const r of requests) {
    if (!r || typeof r !== 'object') { rejected.push(r); continue; }
    const type = r.type || r.kind;
    if (!['image', 'icon', 'chart', 'diagram', 'svg'].includes(type)) { rejected.push(r); continue; }
    if (!r.query || typeof r.query !== 'string') { rejected.push(r); continue; }
    valid.push({ type, query: String(r.query).slice(0, 200), section_id: r.section_id || r.afterBlockId, afterBlockId: r.afterBlockId || r.section_id, data: r.data });
  }
  return { valid, rejected };
}

export async function resolveVisuals(env: Bindings, requests: any[]): Promise<{ assets: Record<string, VisualAsset>; rejected: any[] }> {
  const { valid, rejected } = validateRequests(requests);
  const assets: Record<string, VisualAsset> = {};

  const apiRequests = valid.filter((r) => r.type === 'image' || r.type === 'icon' || r.type === 'chart');
  if (apiRequests.length > 0) {
    const resolved = await fetchVisualAssets(env, apiRequests.map((r) => ({ type: r.type, query: r.query })));
    // Map resolved assets back to their requests by index within apiRequests.
    let ri = 0;
    for (const r of apiRequests) {
      const a = resolved[ri++];
      if (!a) continue;
      const key = r.section_id || r.afterBlockId || String(ri);
      assets[key] = { type: a.type, query: a.query, url: a.url, icon: a.icon, section_id: r.section_id };
    }
  }

  for (const r of valid.filter((x) => x.type === 'diagram')) {
    const mermaid = buildMermaid(r.query, r.data);
    if (mermaid) {
      const key = r.section_id || r.afterBlockId || r.query;
      assets[key] = { type: 'diagram', query: r.query, mermaid, section_id: r.section_id };
    }
  }

  for (const r of valid.filter((x) => x.type === 'chart' && x.data)) {
    const key = r.section_id || r.afterBlockId || r.query;
    assets[key] = { type: 'chart', query: r.query, echarts: r.data, section_id: r.section_id };
  }

  return { assets, rejected };
}

function buildMermaid(query: string, data: any): string | null {
  const lines = String(query).split('\n').filter(Boolean);
  if (lines.length < 2) return null;
  const nodes = lines.map((l, i) => `  N${i}["${l.replace(/"/g, "'")}"]`).join('\n');
  const edges = lines.slice(1).map((_, i) => `  N${i} --> N${i + 1}`).join('\n');
  return `graph LR\n${nodes}\n${edges}`;
}