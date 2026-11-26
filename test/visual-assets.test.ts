import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDiagram,
  readChartData,
  resolveVisuals,
  sanitiseSvg,
  validateRequests,
} from '../src/services/visual-assets';
import { blockSections, contractSections, proposalSections } from '../src/services/pdf';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function stubSources(handlers: { openverse?: () => Response; iconify?: () => Response }) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: any) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('openverse.org')) {
      return handlers.openverse ? handlers.openverse() : json({ results: [] });
    }
    if (url.includes('iconify.design')) {
      return handlers.iconify ? handlers.iconify() : json({ icons: [] });
    }
    return new Response('', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('visual request validation', () => {
  it('accepts type or kind and rejects unsupported types without throwing', () => {
    const { valid, rejected } = validateRequests([
      { type: 'image', query: 'studio', afterBlockId: 'b1' },
      { kind: 'icon', query: 'onboarding', afterBlockId: 'b2' },
      { type: 'video', query: 'clip' },
      { type: 'image', query: '   ' },
    ]);
    expect(valid).toHaveLength(2);
    expect(valid[1].type).toBe('icon');
    expect(rejected.map((entry) => entry.reason)).toEqual([
      'unsupported_visual_type',
      'missing_query',
    ]);
  });

  it('rejects a non-array payload rather than crashing the route', () => {
    const result = validateRequests({ type: 'image' });
    expect(result.valid).toHaveLength(0);
    expect(result.rejected[0].reason).toBe('requests_must_be_an_array');
  });
});

describe('chart data', () => {
  it('requires real, matching labels and values', () => {
    expect(readChartData(undefined)).toBeNull();
    expect(readChartData({ labels: ['One'], values: [1] })).toBeNull();
    expect(readChartData({ labels: ['One', 'Two'], values: [1] })).toBeNull();
    expect(readChartData({ labels: ['One', ''], values: [1, 2] })).toBeNull();
    expect(readChartData({ labels: ['One', 'Two'], values: [1, 'x'] })).toBeNull();
  });

  it('preserves structured data (including units) instead of a chart image URL', () => {
    const chart = readChartData({ labels: ['Q1', 'Q2'], values: [12, 19], unit: 'leads', kind: 'line' });
    expect(chart).toEqual({
      kind: 'line',
      labels: ['Q1', 'Q2'],
      values: [12, 19],
      unit: 'leads',
      title: undefined,
    });
  });
});

describe('diagrams and svg', () => {
  it('builds a flow from supplied steps and keeps the source', () => {
    const diagram = buildDiagram('Delivery', { steps: ['Discovery', 'Build', 'Launch'] });
    expect(diagram?.steps).toEqual(['Discovery', 'Build', 'Launch']);
    expect(diagram?.mermaid).toContain('Discovery');
    expect(diagram?.mermaid).toContain('N1 --> N2');
  });

  it('refuses to invent a diagram from a single phrase', () => {
    expect(buildDiagram('a nice process', undefined)).toBeNull();
    expect(buildDiagram('Discovery', { steps: ['Discovery'] })).toBeNull();
  });

  it('accepts existing mermaid and recovers its labels', () => {
    const diagram = buildDiagram('flow', { mermaid: 'graph LR\n  A["Scope"] --> B["Delivery"]' });
    expect(diagram?.steps).toEqual(['Scope', 'Delivery']);
  });

  it('strips scripts and event handlers from inline svg', () => {
    const svg = sanitiseSvg('<svg onload="alert(1)"><script>alert(1)</script><rect width="10"/></svg>');
    expect(svg).not.toContain('script');
    expect(svg).not.toContain('onload');
    expect(sanitiseSvg('<div>not svg</div>')).toBeNull();
  });
});

describe('resolveVisuals', () => {
  it('keeps two visuals in the same section apart instead of overwriting', async () => {
    stubSources({
      openverse: () => json({ results: [{ license: 'cc0', url: 'https://images.test/a.jpg', creator: 'Ann' }] }),
      iconify: () => json({ icons: ['mdi:handshake'] }),
    });

    const { items, assets } = await resolveVisuals([
      { type: 'image', query: 'studio', afterBlockId: 'intro' },
      { type: 'icon', query: 'handshake', afterBlockId: 'intro' },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('intro#0');
    expect(items[1].id).toBe('intro#1');
    expect(items[0].type).toBe('image');
    expect(items[1].type).toBe('icon');
    expect(items[1].icon).toBe('mdi:handshake');
    expect(assets['intro#1'].type).toBe('icon');
  });

  it('does not shift the remaining assets when one request has no result', async () => {
    // The first request finds nothing; the icon must still belong to its own block.
    stubSources({
      openverse: () => json({ results: [] }),
      iconify: () => json({ icons: ['mdi:chart-line'] }),
    });

    const { items, rejected } = await resolveVisuals([
      { type: 'image', query: 'nowhere', afterBlockId: 'intro' },
      { type: 'icon', query: 'chart line', afterBlockId: 'results' },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].afterBlockId).toBe('results');
    expect(items[0].icon).toBe('mdi:chart-line');
    expect(rejected.map((entry) => entry.reason)).toEqual(['no_matching_asset']);
  });

  it('never resolves a chart without data, and never as an image', async () => {
    stubSources({});
    const { items, rejected } = await resolveVisuals([
      { type: 'chart', query: '{"type":"bar"}', afterBlockId: 'results' },
    ]);
    expect(items).toHaveLength(0);
    expect(rejected[0].reason).toBe('chart_requires_real_data');
  });

  it('returns a structured chart when the document supplies real numbers', async () => {
    stubSources({});
    const { items } = await resolveVisuals([
      {
        type: 'chart',
        query: 'Monthly revenue',
        afterBlockId: 'results',
        data: { labels: ['Jan', 'Feb'], values: [1200, 1800], unit: 'GBP', title: 'Revenue' },
      },
    ]);
    expect(items[0].type).toBe('chart');
    expect(items[0].chart?.values).toEqual([1200, 1800]);
    expect(items[0].url).toBeUndefined();
  });

  it('prefers a relevant icon over the first search hit', async () => {
    stubSources({ iconify: () => json({ icons: ['mdi:weather-sunny', 'mdi:web'] }) });
    const { items } = await resolveVisuals([{ type: 'icon', query: 'web design', afterBlockId: 'b1' }]);
    expect(items[0].icon).toBe('mdi:web');
  });

  it('rejects an icon when nothing in the results matches the query', async () => {
    stubSources({ iconify: () => json({ icons: ['mdi:weather-sunny'] }) });
    const { items, rejected } = await resolveVisuals([{ type: 'icon', query: 'contract signing', afterBlockId: 'b1' }]);
    expect(items).toHaveLength(0);
    expect(rejected[0].reason).toBe('no_matching_asset');
  });

  it('keeps attribution for a licensed image', async () => {
    stubSources({
      openverse: () =>
        json({
          results: [
            {
              license: 'cc0',
              url: 'https://images.test/a.jpg',
              creator: 'Ann',
              foreign_landing_url: 'https://example.test/photo',
            },
          ],
        }),
    });
    const { items } = await resolveVisuals([{ type: 'image', query: 'architecture', afterBlockId: 'b1' }]);
    expect(items[0]).toMatchObject({
      type: 'image',
      license: 'cc0',
      creator: 'Ann',
      source: 'https://example.test/photo',
      attribution: 'Ann · cc0 · https://example.test/photo',
    });
  });

  it('drops duplicate assets instead of inserting the same visual twice', async () => {
    stubSources({
      openverse: () => json({ results: [{ license: 'cc0', url: 'https://images.test/a.jpg', creator: null }] }),
    });
    const { items, rejected } = await resolveVisuals([
      { type: 'image', query: 'architecture', afterBlockId: 'b1' },
      { type: 'image', query: 'architecture', afterBlockId: 'b2' },
    ]);
    expect(items).toHaveLength(1);
    expect(rejected[0].reason).toBe('duplicate_asset');
  });

  it('survives a failing source and still resolves the others', async () => {
    stubSources({
      openverse: () => {
        throw new Error('network down');
      },
      iconify: () => json({ icons: ['mdi:rocket-launch'] }),
    });
    const { items } = await resolveVisuals([
      { type: 'image', query: 'office', afterBlockId: 'b1' },
      { type: 'icon', query: 'rocket launch', afterBlockId: 'b2' },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('icon');
  });
});

describe('pdf sections from blocks', () => {
  it('uses the document blocks so edits and visuals reach the PDF', () => {
    const sections = blockSections({
      blocks: [
        { id: '1', type: 'heading', text: 'Introduction' },
        { id: '2', type: 'paragraph', text: 'We will redesign the site.' },
        {
          id: '3',
          type: 'chart',
          text: 'Traffic',
          chart: { labels: ['Jan', 'Feb'], values: [10, 20], unit: 'visits' },
        },
        { id: '4', type: 'diagram', diagram: { steps: ['Audit', 'Build'] } },
        { id: '5', type: 'icon', alt: 'Launch' },
        { id: '6', type: 'heading', text: 'Pricing' },
        { id: '7', type: 'packages', items: [{ label: 'Standard', price: 1200 }] },
      ],
    });

    expect(sections.map((section) => section.heading)).toEqual(['Introduction', 'Pricing']);
    expect(sections[0].body).toContain('We will redesign the site.');
    expect(sections[0].body).toContain('Jan: 10 visits');
    expect(sections[0].body).toContain('Audit -> Build');
    expect(sections[0].body).toContain('[Icon] Launch');
    expect(sections[1].body).toContain('Standard: 1200.00');
  });

  it('falls back to the legacy content fields when a document has no blocks', () => {
    const proposal = proposalSections({ content: { problem: 'A slow site', packages: [{ name: 'Build', price: 500 }] } });
    expect(proposal[0]).toEqual({ heading: 'The problem', body: 'A slow site' });

    const contract = contractSections({ content: { scope: 'Design and build', payment_terms: '50% upfront' } });
    expect(contract[0]).toEqual({ heading: 'Scope of work', body: 'Design and build' });
  });

  it('keeps contract block order and clause text', () => {
    const sections = contractSections({
      content: { scope: 'ignored when blocks exist', blocks: [{ type: 'heading', text: 'Scope' }, { type: 'paragraph', text: 'The agreed scope.' }] },
    });
    expect(sections).toEqual([{ heading: 'Scope', body: 'The agreed scope.' }]);
  });
});
