import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveVisuals, sanitiseSvg, visualIdentity } from '../src/services/visuals';

const env = {} as any;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('visual resolution', () => {
  it('keeps a chart as data, never as a picture URL', async () => {
    const { assets, rejected } = await resolveVisuals(env, [
      {
        id: 'sec_performance',
        type: 'chart',
        query: 'delivery times',
        data: { title: 'Days to delivery', unit: 'days', series: [{ label: 'Q1', value: 12 }, { label: 'Q2', value: 8 }] },
      },
    ]);

    expect(rejected).toHaveLength(0);
    const asset = assets.sec_performance;
    expect(asset.type).toBe('chart');
    expect(asset.url).toBeUndefined();
    expect(asset.chart?.series).toEqual([{ label: 'Q1', value: 12 }, { label: 'Q2', value: 8 }]);
    expect(asset.chart?.unit).toBe('days');
  });

  it('refuses a chart that has no numeric data instead of inventing one', async () => {
    const { assets, rejected } = await resolveVisuals(env, [
      { id: 'a', type: 'chart', query: 'growth figures' },
      { id: 'b', type: 'chart', query: 'single point', data: { series: [{ label: 'Only', value: 1 }] } },
    ]);

    expect(assets).toEqual({});
    expect(rejected.map((item) => item.reason)).toEqual([
      'chart_requires_numeric_data',
      'chart_requires_numeric_data',
    ]);
  });

  it('builds a diagram only from supplied steps, not from prose', async () => {
    const { assets, rejected } = await resolveVisuals(env, [
      { id: 'scope', type: 'diagram', query: 'our process', data: { title: 'Discovery to delivery', steps: [{ title: 'Discovery' }, { title: 'Design' }, { title: 'Delivery' }] } },
      { id: 'vague', type: 'diagram', query: 'Discovery\nDesign\nDelivery' },
    ]);

    expect(rejected.map((item) => item.id)).toEqual(['vague']);
    expect(rejected[0].reason).toBe('diagram_requires_steps');
    const asset = assets.scope;
    expect(asset.diagram?.steps).toHaveLength(3);
    expect(asset.mermaid).toContain('S0 --> S1');
    expect(asset.mermaid).toContain('S1 --> S2');
  });

  it('keeps SVG markup and strips executable content', async () => {
    const markup = '<svg viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" onclick="steal()" /></svg>';
    const { assets } = await resolveVisuals(env, [{ id: 'logo', type: 'svg', query: 'brand mark', data: { svg: markup } }]);

    expect(assets.logo.svg).toContain('<rect');
    expect(assets.logo.svg).not.toContain('script');
    expect(assets.logo.svg).not.toContain('onclick');
    expect(sanitiseSvg('<div>not an svg</div>')).toBeNull();
  });

  it('maps each image to its own request id even when an earlier one fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('q=missing')) return jsonResponse({ results: [] });
        if (url.includes('api.openverse.org')) {
          return jsonResponse({
            results: [
              { url: 'https://images.example.com/team.jpg', license: 'cc0', creator: 'A. Person', foreign_landing_url: 'https://example.com/team' },
            ],
          });
        }
        return jsonResponse({});
      })
    );

    const { assets, rejected } = await resolveVisuals(env, [
      { id: 'first', afterBlockId: 'first', type: 'image', query: 'missing' },
      { id: 'second', afterBlockId: 'second', type: 'image', query: 'studio team' },
    ]);

    expect(rejected.map((item) => item.id)).toEqual(['first']);
    expect(rejected[0].reason).toBe('no_licensed_image');
    expect(assets.first).toBeUndefined();
    expect(assets.second.url).toBe('https://images.example.com/team.jpg');
    // Licensing travels with the asset, which the old resolver discarded.
    expect(assets.second.license).toBe('cc0');
    expect(assets.second.creator).toBe('A. Person');
    expect(assets.second.attribution).toContain('cc0');
  });

  it('does not place the same image in two sections', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          results: [{ url: 'https://images.example.com/repeat.jpg', license: 'cc0', creator: null, foreign_landing_url: null }],
        })
      )
    );

    const { assets, rejected } = await resolveVisuals(env, [
      { id: 'one', type: 'image', query: 'office' },
      { id: 'two', type: 'image', query: 'office' },
    ]);

    expect(Object.keys(assets)).toEqual(['one']);
    expect(rejected[0].reason).toBe('duplicate_asset');
    expect(visualIdentity(assets.one)).toBe('image:https://images.example.com/repeat.jpg');
  });

  it('rejects malformed requests without failing the batch', async () => {
    const { assets, rejected } = await resolveVisuals(env, [
      { id: 'bad', type: 'hologram', query: 'anything' },
      { id: 'no-query', type: 'image' },
      { id: 'ok', type: 'svg', query: 'mark', data: { svg: '<svg viewBox="0 0 1 1"></svg>' } },
    ]);

    expect(assets.ok).toBeDefined();
    expect(rejected).toHaveLength(2);
    expect(rejected.every((item) => item.reason.startsWith('invalid_request'))).toBe(true);
  });

  it('ignores a request array that is not an array', async () => {
    const { assets, rejected } = await resolveVisuals(env, 'not-a-list');
    expect(assets).toEqual({});
    expect(rejected).toEqual([]);
  });
});
