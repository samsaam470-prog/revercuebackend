import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../src/types';
import demo from '../src/routes/demo';

const env = {
  OPENROUTER_API_KEY: 'test-nara-key',
  BYNARA_API_ENDPOINT: 'https://router.bynara.id/v1',
  DEMO_AI_MODEL: 'deepseek-v4-flash',
  DEMO_GENERATIONS_PER_HOUR: '50',
  DEMO_EDITS_PER_HOUR: '50',
} as unknown as Bindings;

function app() {
  const router = new Hono<{ Bindings: Bindings }>();
  router.route('/api/demo', demo);
  return router;
}

const brief = {
  clientName: 'Northwind Studio',
  businessName: 'Aster & Co.',
  service: 'Web design',
  industry: 'E-commerce',
  problem: 'Their storefront looks dated and checkout drops off on mobile.',
  sections: ['Executive Summary', 'Scope of Work', 'Investment'],
  tone: 'Formal' as const,
  packages: [
    { name: 'Essential', price: 4000, deliverables: 'Five pages' },
    { name: 'Complete', price: 7500, deliverables: 'Ten pages' },
  ],
};

function chat(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockProvider(overrides?: (body: any) => Response | null) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('/chat/completions')) {
      // Visual resolvers (Openverse, Iconify) answer with no results.
      return new Response(JSON.stringify({ results: [], icons: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    const override = overrides?.(body);
    if (override) return override;

    const prompt = String(body.messages?.at(-1)?.content ?? '');
    if (prompt.includes('Plan a proposal')) {
      return chat(
        JSON.stringify({
          sections: [
            { id: 'summary', heading: 'Executive Summary', purpose: 'Frame the outcome.' },
            { id: 'scope', heading: 'Scope of Work', purpose: 'Describe the work.' },
            { id: 'investment', heading: 'Investment', purpose: 'Explain the packages.' },
          ],
        })
      );
    }
    if (prompt.includes('Write these proposal sections')) {
      return chat(
        JSON.stringify({
          sections: [
            { id: 'summary', paragraphs: ['Northwind needs a storefront that converts on mobile.'], bullets: [] },
            { id: 'scope', paragraphs: ['We will redesign the five core templates.'], bullets: ['Discovery workshop', 'Design system'] },
            { id: 'investment', paragraphs: ['Two packages are available for this engagement.'], bullets: [] },
          ],
        })
      );
    }
    return chat('A clearer sentence.');
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('public demo API', () => {
  it('reports the NaraRouter configuration without leaking the key', async () => {
    const response = await app().request('/api/demo/health', {}, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ configured: true, provider: 'nararouter', model: 'deepseek-v4-flash' });
    expect(JSON.stringify(body)).not.toContain('test-nara-key');
  });

  it('rejects an incomplete brief before calling the provider', async () => {
    const fetchSpy = mockProvider();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await app().request(
      '/api/demo/proposal',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientName: '', problem: 'short' }) },
      env
    );
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('builds an editable document through the staged pipeline', async () => {
    const fetchSpy = mockProvider();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await app().request(
      '/api/demo/proposal',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(brief) },
      env
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const types = body.document.blocks.map((block: any) => block.type);
    const headings = body.document.blocks
      .filter((block: any) => block.type === 'heading' && block.level !== 'h1')
      .map((block: any) => block.text);
    expect(types).toContain('heading');
    expect(types).toContain('paragraph');
    expect(types).toContain('pricing_table');
    expect(headings).toEqual(expect.arrayContaining(brief.sections));
    expect(body.document.meta.model).toBe('deepseek-v4-flash');
    // The chart uses only the two real prices supplied in the brief.
    const chart = body.document.blocks.find((block: any) => block.type === 'chart');
    expect(chart?.chart.series).toEqual([
      { label: 'Essential', value: 4000 },
      { label: 'Complete', value: 7500 },
    ]);
  });

  it('surfaces a provider rate limit as a retryable error with no fallback', async () => {
    const fetchSpy = mockProvider(() =>
      new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers: { 'retry-after': '20' } })
    );
    vi.stubGlobal('fetch', fetchSpy);
    const response = await app().request(
      '/api/demo/proposal',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(brief) },
      env
    );
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body).toMatchObject({ error: 'ai_rate_limited', retryable: true, retry_after: 20 });
    expect(fetchSpy.mock.calls.every(([input]) => String(input).includes('router.bynara.id'))).toBe(true);
  });

  it('rewrites one passage for the AI edit action', async () => {
    vi.stubGlobal('fetch', mockProvider(() => chat('Northwind needs a storefront that converts on every screen size.')));
    const response = await app().request(
      '/api/demo/refine',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Northwind needs a storefront that works on phones.', action: 'improve' }),
      },
      env
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.text).toContain('every screen size');
    expect(body.provider).toBe('nararouter');
  });
});
