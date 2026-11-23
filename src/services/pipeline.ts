import type { Bindings } from '../types';
import { dbFirst, dbRun } from '../utils/db';
import { safeFetchPublic } from '../utils/url-safety';

/**
 * Extract API (Layer 1) and Visual Assets API (Layer 4).
 *
 * All outbound requests go through `safeFetchPublic`, which blocks loopback,
 * private ranges and cloud metadata endpoints, enforces HTTPS, caps response
 * size and applies a timeout. Previously these calls used bare `fetch`, which
 * made the endpoint an SSRF primitive.
 */

const WIKI_CACHE_HOURS = 24;
const FETCH_TIMEOUT_MS = 6000;
const MAX_RESPONSE_BYTES = 1_500_000;

export interface ExtractInput {
  client_name: string;
  client_email?: string;
  industry: string;
  service: string;
  client_website?: string;
  user_website?: string;
  business_name?: string;
  location?: string;
}

export interface ImageAttribution {
  url: string;
  license: string | null;
  creator: string | null;
  source: string | null;
}

export interface ExtractResult {
  business_name: string;
  industry: string;
  service: string;
  value_prop: string;
  key_points: string[];
  image_url: string | null;
  image_attribution: ImageAttribution | null;
  location: string | null;
  wiki_attribution: string;
  samples: { title: string; url: string; snippet: string }[];
  notes: { title: string; body: string; source?: string; kind?: 'client' | 'web' | 'background' }[];
  images: string[];
  author_business_name?: string;
  author_description?: string;
  author_website?: string;
}

interface FetchOutcome {
  ok: boolean;
  body: string;
  status: number;
  contentType: string;
}

async function safeGet(url: string): Promise<FetchOutcome | null> {
  const result = await safeFetchPublic(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
    headers: { Accept: 'application/json,text/html;q=0.9,*/*;q=0.5' },
  });
  if (!result.ok && !result.body) {
    if (result.reason) console.warn('EXTRACT_FETCH_BLOCKED_OR_FAILED', result.reason, url);
    return null;
  }
  return { ok: result.ok, body: result.body, status: result.status, contentType: result.contentType };
}

function parseJsonBody(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// --- Wikipedia (24 hour cache) ---------------------------------------------
async function fetchWikipedia(
  env: Bindings,
  query: string
): Promise<{ summary: string; image: string | null }> {
  const cacheKey = `wiki:${query.toLowerCase().trim()}`;
  const cached = await dbFirst<{ summary: string; image: string; cached_at: string }>(
    env,
    `SELECT summary, image, cached_at FROM wiki_cache WHERE cache_key = ? LIMIT 1`,
    [cacheKey]
  );
  if (cached) {
    const ageHours = (Date.now() - new Date(cached.cached_at).getTime()) / 3600000;
    if (ageHours < WIKI_CACHE_HOURS) return { summary: cached.summary ?? '', image: cached.image ?? null };
  }

  const url =
    'https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts|pageimages&exintro=1&explaintext=1&piprop=original&titles=' +
    encodeURIComponent(query) +
    '&origin=*';
  const response = await safeGet(url);
  if (!response) return { summary: '', image: null };
  const data = parseJsonBody(response.body);
  if (!data) return { summary: '', image: null };

  const pages = data.query?.pages ?? {};
  const page: any = Object.values(pages)[0] ?? {};
  const summary = String(page.extract ?? '').slice(0, 1200);
  const image = page.original?.source ?? null;
  await dbRun(
    env,
    `INSERT INTO wiki_cache (cache_key, summary, image, cached_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET summary = excluded.summary, image = excluded.image, cached_at = excluded.cached_at`,
    [cacheKey, summary, image, new Date().toISOString()]
  ).catch((error) => console.error('WIKI_CACHE_WRITE_FAILED', error));
  return { summary, image };
}

// --- DuckDuckGo Instant Answers --------------------------------------------
async function fetchDuckDuckGo(query: string): Promise<string> {
  const response = await safeGet(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`
  );
  if (!response) return '';
  const data = parseJsonBody(response.body);
  return String(data?.AbstractText ?? data?.Abstract ?? '');
}

// --- FreeSerp samples ------------------------------------------------------
async function fetchFreeSerp(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  const response = await safeGet(`https://freeserp.ai/api.php?index=web&q=${encodeURIComponent(query)}&size=10`);
  if (!response) return [];
  const data = parseJsonBody(response.body);
  if (!data) return [];
  const items = data?.results ?? data?.data ?? data?.organic ?? data?.items ?? [];
  if (!Array.isArray(items)) return [];
  return items.slice(0, 5).map((item: any) => ({
    title: String(item.title ?? item.name ?? '').slice(0, 200),
    url: String(item.url ?? item.link ?? ''),
    snippet: String(item.snippet ?? item.description ?? item.text ?? '').slice(0, 300),
  }));
}

// --- Client website metadata -----------------------------------------------
async function fetchClientMetadata(
  url: string
): Promise<{ title: string; description: string; image: string | null; h2: string[] }> {
  const response = await safeGet(url);
  if (!response) return { title: '', description: '', image: null, h2: [] };
  const html = response.body;
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) ?? [])[1] ?? '';
  const description =
    (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ?? [])[1] ?? '';
  const ogImage =
    (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ?? [])[1] ?? null;
  const h2Matches = html.match(/<h2[^>]*>([^<]+)<\/h2>/gi) ?? [];
  const h2 = h2Matches
    .slice(0, 5)
    .map((match) => match.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);
  return { title: title.trim().slice(0, 200), description: description.trim().slice(0, 400), image: ogImage, h2 };
}

// --- OpenStreetMap ---------------------------------------------------------
async function fetchNominatim(location: string): Promise<string | null> {
  if (!location) return null;
  const response = await safeGet(
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location)}`
  );
  if (!response) return null;
  const data = parseJsonBody(response.body);
  if (!Array.isArray(data) || data.length === 0) return null;
  return String(data[0].display_name ?? '');
}

// --- Openverse images (with attribution + licence) -------------------------
async function fetchOpenverseImage(query: string): Promise<ImageAttribution | null> {
  const response = await safeGet(
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=10&license_type=all-cc`
  );
  if (!response) return null;
  const data = parseJsonBody(response.body);
  const results = data?.results;
  if (!Array.isArray(results)) return null;
  const allowed = ['cc0', 'by', 'pdm'];
  for (const item of results) {
    const license = String(item.license ?? '').toLowerCase();
    if (!allowed.includes(license)) continue;
    const url = item.url ?? null;
    if (!url) continue;
    return {
      url: String(url),
      license,
      creator: item.creator ? String(item.creator) : null,
      source: item.foreign_landing_url ? String(item.foreign_landing_url) : 'Openverse',
    };
  }
  return null;
}

// --- Iconify icons ---------------------------------------------------------
async function fetchIcons(services: string[]): Promise<{ service: string; icon: string }[]> {
  const results: { service: string; icon: string }[] = [];
  for (const service of services.slice(0, 5)) {
    const response = await safeGet(
      `https://api.iconify.design/search?query=${encodeURIComponent(service)}&limit=1`
    );
    if (!response) continue;
    const data = parseJsonBody(response.body);
    const icon = data?.icons?.[0];
    if (icon) results.push({ service, icon });
  }
  return results;
}

// --- Layer 1 ---------------------------------------------------------------

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * A web search for a small client name matches unrelated businesses with the
 * same words. Only results that actually mention the client (by name or by
 * domain) are research about that client; the rest is noise that made drafts
 * read as filler.
 */
function relevantSamples(
  samples: { title: string; url: string; snippet: string }[],
  clientName: string,
  clientWebsite?: string
): { title: string; url: string; snippet: string }[] {
  const name = clientName.trim().toLowerCase();
  const host = hostOf(clientWebsite);
  if (!name) return [];
  return samples.filter((sample) => {
    const haystack = `${sample.title} ${sample.snippet} ${sample.url}`.toLowerCase();
    if (host && haystack.includes(host)) return true;
    return haystack.includes(name);
  });
}

export async function runLayer1(env: Bindings, input: ExtractInput): Promise<ExtractResult> {
  const wiki = await fetchWikipedia(env, input.industry);
  const ddg = await fetchDuckDuckGo(input.industry);
  const location = input.location ? await fetchNominatim(input.location) : null;
  const searchResults = await fetchFreeSerp(
    `${input.client_name} ${input.industry} ${input.location ?? ''}`.trim()
  );
  const serp = relevantSamples(searchResults, input.client_name, input.client_website);

  const emptyMeta = { title: '', description: '', image: null as string | null, h2: [] as string[] };
  const [meta, userMeta] = await Promise.all([
    input.client_website ? fetchClientMetadata(input.client_website) : Promise.resolve(emptyMeta),
    input.user_website ? fetchClientMetadata(input.user_website) : Promise.resolve(emptyMeta),
  ]);

  const openverse =
    (await fetchOpenverseImage(`${input.industry} ${input.service}`)) ??
    (meta.image ? { url: meta.image, license: null, creator: null, source: 'client website' } : null);

  // Key points describe this client. An encyclopedia definition of the
  // industry is not a client fact, so it is kept only as background.
  const keyPoints: string[] = [...meta.h2];

  const clientHost = hostOf(input.client_website);
  const clientSamples = serp.filter((sample) => clientHost && hostOf(sample.url) === clientHost);
  const valueProp = meta.description || clientSamples[0]?.snippet || '';
  const notes: { title: string; body: string; source?: string; kind?: 'client' | 'web' | 'background' }[] = [];
  if (meta.description) {
    notes.push({
      title: `${meta.title || input.client_name} positioning`,
      body: meta.description,
      source: input.client_website,
      kind: 'client',
    });
  }
  for (const sample of clientSamples) {
    notes.push({ title: sample.title, body: sample.snippet, source: sample.url, kind: 'client' });
  }
  // Other sites that mention the client are context, not the client's story.
  for (const sample of serp.filter((item) => !clientSamples.includes(item))) {
    notes.push({ title: sample.title, body: sample.snippet, source: sample.url, kind: 'web' });
  }
  // Background only: the organizer never uses these as the client's story.
  if (wiki.summary) {
    notes.push({ title: `About ${input.industry}`, body: wiki.summary, source: 'Wikipedia', kind: 'background' });
  }
  if (ddg) {
    notes.push({ title: 'Definition', body: ddg, source: 'DuckDuckGo', kind: 'background' });
  }

  return {
    business_name: meta.title || input.client_name,
    industry: input.industry,
    service: input.service,
    value_prop: valueProp.slice(0, 300),
    key_points: keyPoints.slice(0, 5),
    image_url: openverse?.url ?? null,
    image_attribution: openverse,
    location: location ?? input.location ?? null,
    wiki_attribution: wiki.summary ? 'Source: Wikipedia (CC BY-SA)' : '',
    samples: serp,
    notes: notes.slice(0, 8),
    images: openverse?.url ? [openverse.url] : [],
    author_business_name: input.business_name || userMeta.title || undefined,
    author_description: userMeta.description || undefined,
    author_website: input.user_website || undefined,
  };
}

export interface VisualAsset {
  type: string;
  query: string;
  url?: string;
  icon?: string;
  license?: string | null;
  creator?: string | null;
  source?: string | null;
  attribution?: string | null;
}

// --- Layer 4 ---------------------------------------------------------------
export async function fetchVisualAssets(
  env: Bindings,
  requests: { type: string; query: string }[]
): Promise<VisualAsset[]> {
  const out: VisualAsset[] = [];
  for (const request of requests.slice(0, 12)) {
    if (request.type === 'image') {
      const image = await fetchOpenverseImage(request.query);
      if (image) {
        out.push({
          type: 'image',
          query: request.query,
          url: image.url,
          license: image.license,
          creator: image.creator,
          source: image.source,
          attribution: [image.creator, image.license, image.source].filter(Boolean).join(' · ') || null,
        });
      }
    } else if (request.type === 'icon') {
      const icons = await fetchIcons([request.query]);
      if (icons[0]) out.push({ type: 'icon', query: request.query, icon: icons[0].icon, source: 'Iconify' });
    } else if (request.type === 'chart') {
      out.push({
        type: 'chart',
        query: request.query,
        url: `https://quickchart.io/chart?c=${encodeURIComponent(request.query)}`,
        source: 'QuickChart',
      });
    }
  }
  return out;
}
