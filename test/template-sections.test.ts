import { describe, expect, it } from 'vitest';
import { organizeSections, normaliseSection } from '../src/services/organizer';
import { SECTION_COPY_KEYS, draftSectionCopy, hasSectionCopy } from '../src/services/section-copy';
import { blockSections } from '../src/services/pdf';
import { buildPdf } from '../src/services/pdf-binary';

const CONTEXT = {
  client: 'Northwind Trading',
  businessName: 'Revercue Studio',
  businessWebsite: 'https://example.com',
  businessDescription: 'A design and development studio.',
  industry: 'Retail',
  service: 'a new marketing website',
  problem: 'The current site is slow and hard to update.',
  audience: 'independent retailers',
  timeline: 'eight weeks from kickoff',
  cta: 'Approve the proposal to book the kickoff.',
  scopeClause: 'Design, build and launch a five-page marketing website.',
  deliverables: ['Design system', 'Five pages', 'Training session'],
  packagesNote: 'Essential, Growth',
  documentType: 'proposal' as const,
  templateName: 'Website Design Proposal',
};

describe('template section copy', () => {
  it('writes meaningful copy for every section the templates can ask for', () => {
    const thin: string[] = [];
    for (const key of SECTION_COPY_KEYS) {
      const copy = draftSectionCopy(key, CONTEXT);
      if (!copy || copy.trim().length < 25) thin.push(key);
    }
    expect(thin).toEqual([]);
  });

  it('never invents a governing law, fee, or enforceability claim', () => {
    const governing = draftSectionCopy('governing_law', CONTEXT);
    expect(governing).toContain('[jurisdiction]');
    expect(governing.toLowerCase()).not.toContain('governed by the laws of england');

    const liability = draftSectionCopy('liability', CONTEXT);
    expect(liability).toContain('[');

    const fee = draftSectionCopy('fees_and_payment', CONTEXT);
    expect(fee).not.toMatch(/[$£€]\s?\d/);

    for (const key of SECTION_COPY_KEYS) {
      const copy = draftSectionCopy(key, CONTEXT).toLowerCase();
      expect(copy, key).not.toContain('legally guaranteed');
      expect(copy, key).not.toContain('100% enforceable');
      expect(copy, key).not.toContain('guaranteed to be enforceable');
    }
  });

  it('keeps researched prose out of contract clauses', () => {
    const sections = organizeSections({
      client_name: 'Northwind Trading',
      business_name: 'Revercue Studio',
      industry: 'Retail',
      service: 'a new marketing website',
      sections: ['Governing law', 'Confidentiality', 'Liability'],
      notes: [
        {
          title: 'About Northwind',
          body: 'Northwind Trading has served independent retailers across the north of England since 1998.',
          kind: 'client',
        },
      ],
      document_type: 'contract',
      packages: [],
    });
    expect(sections.governing_law).toContain('[jurisdiction]');
    expect(sections.confidentiality).toBeTruthy();
    expect(sections.confidentiality).not.toContain('Northwind Trading has served');
    expect(sections.liability).toBeTruthy();
    expect(sections.liability).not.toContain('independent retailers');
  });

  it('aligns section keys between the heading normaliser and the writers', () => {
    expect(normaliseSection('Understanding the requirements')).toBe('understanding_the_requirements');
    expect(hasSectionCopy('understanding_the_requirements')).toBe(true);
    expect(normaliseSection('Fees')).toBe('payment_terms');
    expect(normaliseSection('Schedule')).toBe('timeline');
  });
});

describe('organizer uses the template structure', () => {
  const base = {
    client_name: 'Northwind Trading',
    business_name: 'Revercue Studio',
    industry: 'Retail',
    service: 'a new marketing website',
    problem: 'The current site is slow and hard to update.',
    sections: [
      'Executive summary',
      'Client background',
      'Understanding the requirements',
      'Methodology',
      'Workstreams',
      'Investment',
      'Assumptions',
      'Next step',
    ],
    notes: [],
    packages: [],
    template_name: 'Website Design Proposal',
    document_type: 'proposal' as const,
  };

  it('writes every requested proposal section instead of leaving generic filler', () => {
    const sections = organizeSections(base);
    for (const name of base.sections) {
      const key = normaliseSection(name);
      expect(sections[key], name).toBeTruthy();
      expect(sections[key].length, name).toBeGreaterThan(25);
    }
    expect(sections.executive_summary).toContain('Northwind Trading');
    expect(sections.workstreams).toBeTruthy();
    expect(sections.assumptions).toBeTruthy();
  });

  it('drafts a contract section set with the clauses that relationship needs', () => {
    const sections = organizeSections({
      ...base,
      document_type: 'contract',
      template_name: 'Website Development Agreement',
      scope: 'Design, build and launch a five-page marketing website.',
      sections: [
        'Parties',
        'Scope',
        'Development process',
        'Acceptance',
        'Fees and payment',
        'Intellectual property',
        'Warranty period',
        'Termination',
        'Governing law',
        'Signatures',
      ],
    });
    for (const name of [
      'Parties',
      'Scope',
      'Development process',
      'Acceptance',
      'Fees and payment',
      'Intellectual property',
      'Warranty period',
      'Termination',
      'Governing law',
      'Signatures',
    ]) {
      const key = normaliseSection(name);
      expect(sections[key], name).toBeTruthy();
    }
  });
});

describe('PDF export covers the blocks templates use', () => {
  const blocks = [
    { id: 'h1', type: 'heading', level: 'h1', text: 'Website Development Agreement' },
    { id: 'p0', type: 'paragraph', text: 'Effective date: 1 January 2027' },
    { id: 'h2', type: 'heading', level: 'h2', text: 'What is included' },
    { id: 'l1', type: 'list', items: [{ label: 'Design system' }, { label: 'Five pages' }] },
    { id: 'h3', type: 'heading', level: 'h2', text: 'Timeline' },
    {
      id: 't1',
      type: 'timeline',
      items: [
        { label: 'Phase 1', value: 'Kickoff' },
        { label: 'Phase 2', value: 'Build' },
      ],
    },
    { id: 'h4', type: 'heading', level: 'h2', text: 'Investment' },
    {
      id: 'pk1',
      type: 'packages',
      items: [
        { label: 'Essential', price: 1200 },
        { label: 'Growth', price: 2400 },
      ],
    },
    { id: 'h5', type: 'heading', level: 'h2', text: 'Signatures' },
    { id: 's1', type: 'signature' },
    { id: 'n1', type: 'next_step', text: 'Approve this proposal to start the work.' },
  ];

  it('turns every template block into readable PDF sections', () => {
    const sections = blockSections({ blocks });
    expect(sections.length).toBeGreaterThanOrEqual(5);
    const flat = sections.map((section) => `${section.heading}\n${section.body}`).join('\n');
    expect(flat).toContain('What is included');
    expect(flat).toContain('- Design system');
    expect(flat).toContain('Phase 1 (Kickoff)');
    expect(flat).toContain('Essential: 1200.00');
    expect(flat).toContain('Approve this proposal to start the work.');
    expect(flat).not.toContain('{{');
  });

  it('produces a real PDF for a document laid out from a template', async () => {
    const bytes = await buildPdf('Website Development Agreement', blockSections({ blocks }), {
      subtitle: 'Northwind Trading',
    });
    expect(bytes.length).toBeGreaterThan(800);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });
});
