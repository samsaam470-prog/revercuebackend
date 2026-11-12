import type { Bindings } from '../types';

const USER_AGENT = 'Revercue/1.0 (samsaam470@gmail.com; https://revercue.pages.dev)';

export interface ExtractInput {
  client_name: string;
  client_email?: string;
  industry: string;
  service: string;
  client_website?: string;
  user_website?: string;
  location?: string;
}

export interface ExtractResult {
  business_name: string;
  industry: string;
  service: string;
  value_prop: string;
  key_points: string[];
  image_url: string | null;
  location: string | null;
  wiki_attribution: string;
  samples: { title: string; url: string; snippet: string }[];
}

async function safeFetch(url: string, init?: RequestInit): Promise<any | null> {
  try {
    const res = await fetch(url, { ...init, headers: { 'User-Agent': USER_AGENT, ...(init?.headers ?? {}) } });
    if (!res.ok) return null;
    return res;
  } catch { return null; }
}

async function fetchWikipedia(query: string): Promise<{ summary: string; image: string | null }> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts|pageimages&exintro=1&explaintext=1&piprop=original&titles=${encodeURIComponent(query)}&origin=*`;
  const res = await safeFetch(url);
  if (!res) return { summary: '', image: null };
  const data: any = await res.json();
  const pages = data.query?.pages ?? {};
  const page: any = Object.values(pages)[0] ?? {};
  const summary = String(page.extract ?? '').slice(0, 1200);
  const image = page.original?.source ?? null;
  return { summary, image };
}

async function fetchDuckDuckGo(query: string): Promise<string> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
  const res = await safeFetch(url);
  if (!res) return '';
  const data: any = await res.json();
  return String(data.AbstractText ?? data.Abstract ?? '');
}

async function fetchFreeSerp(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  const url = `https://freeserp.ai/api.php?index=web&q=${encodeURIComponent(query)}&size=10`;
  const res = await safeFetch(url);
  if (!res) return [];
  try {
    const data: any = await res.json();
    const items = data?.results ?? data?.data ?? data?.organic ?? [];
    return items.slice(0, 5).map((r: any) => ({
      title: String(r.title ?? r.name ?? ''),
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.snippet ?? r.description ?? '').slice(0, 300),
    }));
  } catch { return []; }
}

async function fetchClientMetadata(url: string): Promise<{ title: string; description: string; image: string | null; h2: string[] }> {
  const res = await safeFetch(url, { headers: { 'Accept': 'text/html' } });
  if (!res) return { title: '', description: '', image: null, h2: [] };
  const html = await res.text();
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) ?? [])[1] ?? '';
  const description = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ?? [])[1] ?? '';
  const ogImage = (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ?? [])[1] ?? null;
  const h2Matches = html.match(/<h2[^>]*>([^<]+)<\/h2>/gi) ?? [];
  const h2 = h2Matches.slice(0, 5).map((m: string) => m.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
  return { title: title.trim(), description: description.trim(), image: ogImage, h2 };
}

async function fetchOpenverseImage(query: string): Promise<string | null> {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=5&license_type=all-cc`;
  const res = await safeFetch(url);
  if (!res) return null;
  try {
    const data: any = await res.json();
    const first = data?.results?.[0];
    return first?.url ?? null;
  } catch { return null; }
}

async function fetchIcons(services: string[]): Promise<{ service: string; icon: string }[]> {
  const results: { service: string; icon: string }[] = [];
  for (const s of services.slice(0, 5)) {
    const url = `https://api.iconify.design/search?query=${encodeURIComponent(s)}&limit=1`;
    const res = await safeFetch(url);
    if (!res) continue;
    try {
      const data: any = await res.json();
      const icon = data?.icons?.[0];
      if (icon) results.push({ service: s, icon });
    } catch {}
  }
  return results;
}

export async function runLayer1(env: Bindings, input: ExtractInput): Promise<ExtractResult> {
  const wiki = await fetchWikipedia(input.industry);
  const ddg = await fetchDuckDuckGo(input.industry);
  const serp = await fetchFreeSerp(`${input.client_name} ${input.industry} ${input.location ?? ''}`.trim());

  let meta = { title: '', description: '', image: null as string | null, h2: [] as string[] };
  if (input.client_website) meta = await fetchClientMetadata(input.client_website);

  const imageQuery = meta.image ? input.industry : `${input.industry} ${input.service}`;
  const openverseImage = meta.image ?? (await fetchOpenverseImage(imageQuery));
  const wikiImage = wiki.image;

  const keyPoints: string[] = [...meta.h2];
  if (keyPoints.length === 0 && wiki.summary) {
    keyPoints.push(...wiki.summary.split('. ').slice(0, 3).map((s) => s.trim()).filter(Boolean));
  }

  const valueProp = meta.description || ddg || wiki.summary.split('. ')[0] || '';

  return {
    business_name: meta.title || input.client_name,
    industry: input.industry,
    service: input.service,
    value_prop: valueProp.slice(0, 300),
    key_points: keyPoints.slice(0, 5),
    image_url: openverseImage ?? wikiImage,
    location: input.location ?? null,
    wiki_attribution: wiki.summary ? 'Source: Wikipedia' : '',
    samples: serp,
  };
}

export async function fetchVisualAssets(env: Bindings, requests: { type: string; query: string }[]): Promise<any[]> {
  const out: any[] = [];
  for (const r of requests) {
    if (r.type === 'image') {
      const url = await fetchOpenverseImage(r.query);
      if (url) out.push({ type: 'image', query: r.query, url });
    } else if (r.type === 'icon') {
      const icons = await fetchIcons([r.query]);
      if (icons[0]) out.push({ type: 'icon', query: r.query, icon: icons[0].icon });
    } else if (r.type === 'chart') {
      out.push({ type: 'chart', query: r.query, url: `https://quickchart.io/chart?c=${encodeURIComponent(r.query)}` });
    }
  }
  return out;
}
