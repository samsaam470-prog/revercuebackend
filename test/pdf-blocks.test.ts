import { describe, expect, it } from 'vitest';
import { blocksToSections, contractSections, proposalSections } from '../src/services/pdf';

/**
 * The export used to be rebuilt from the brief's legacy fields, so everything
 * the user typed on the canvas — and every visual — was missing from the PDF.
 */
const content = {
  blocks: [
    { id: 'h1', type: 'heading', text: 'Introduction' },
    { id: 'p1', type: 'paragraph', text: 'We will rebuild the marketing site in six weeks.' },
    { id: 'h2', type: 'heading', text: 'Performance' },
    {
      id: 'c1',
      type: 'chart',
      chart: { title: 'Days to delivery', unit: 'days', series: [{ label: 'Q1', value: 12 }, { label: 'Q2', value: 8 }] },
    },
    {
      id: 'd1',
      type: 'diagram',
      diagram: { title: 'Our process', steps: [{ title: 'Discovery' }, { title: 'Design' }] },
    },
    { id: 'i1', type: 'image', url: 'https://images.example.com/team.jpg', alt: 'The studio team in Leeds' },
    { id: 'i2', type: 'icon', icon: { name: 'mdi:calendar-check', label: 'Delivery' } },
  ],
};

describe('PDF block export', () => {
  it('renders the editor blocks rather than the legacy brief fields', () => {
    const sections = proposalSections({ content: JSON.stringify(content), title: 'Proposal' });
    expect(sections[0]).toEqual({ heading: 'Introduction', body: 'We will rebuild the marketing site in six weeks.' });
    const performance = sections.find((section) => section.heading === 'Performance');
    expect(performance?.body).toContain('Chart — Days to delivery: Q1 12 days, Q2 8 days');
    expect(performance?.body).toContain('Process — Our process: Discovery → Design');
    expect(performance?.body).toContain('[Image: The studio team in Leeds]');
    expect(performance?.body).toContain('[Icon: Delivery]');
  });

  it('falls back to the legacy fields when a document has no blocks', () => {
    const sections = proposalSections({ content: JSON.stringify({ problem: 'No site', timeline: 'Six weeks' }) });
    expect(sections.map((section) => section.heading)).toContain('The problem');
  });

  it('uses contract blocks when the contract editor has saved them', () => {
    const sections = contractSections({
      content: JSON.stringify({
        blocks: [
          { id: 'h', type: 'heading', text: 'Scope' },
          { id: 'p', type: 'paragraph', text: 'Design and build the marketing site.' },
        ],
        payment_terms: '50% up front.',
      }),
    });
    expect(sections).toEqual([{ heading: 'Scope', body: 'Design and build the marketing site.' }]);
  });

  it('returns null for a document without blocks', () => {
    expect(blocksToSections({})).toBeNull();
    expect(blocksToSections({ blocks: [] })).toBeNull();
  });
});
