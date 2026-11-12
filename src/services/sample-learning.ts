import type { Bindings } from '../types';

export interface SampleStructure {
  sections: string[];
  has_faqs: boolean;
  has_pricing: boolean;
  has_timeline: boolean;
  tone_hints: string[];
}

const SECTION_PATTERNS: { key: string; words: string[] }[] = [
  { key: 'introduction', words: ['introduction', 'overview', 'about', 'executive summary', 'summary'] },
  { key: 'scope', words: ['scope', 'scope of work', 'deliverables', 'what we will do', 'services'] },
  { key: 'timeline', words: ['timeline', 'schedule', 'milestones', 'roadmap', 'phases'] },
  { key: 'pricing', words: ['pricing', 'cost', 'budget', 'investment', 'packages', 'price'] },
  { key: 'terms', words: ['terms', 'conditions', 'agreement', 'policy', 'contract'] },
  { key: 'faqs', words: ['faq', 'questions', 'frequently asked'] },
  { key: 'about', words: ['about us', 'about me', 'who we are', 'our team', 'bio'] },
  { key: 'next_step', words: ['next step', 'next steps', 'call to action', 'cta', 'get started', 'contact'] },
];

export function extractStructure(samples: { title: string; snippet: string }[]): SampleStructure {
  const text = samples.map((s) => `${s.title} ${s.snippet}`).join(' ').toLowerCase();
  const found: string[] = [];
  for (const p of SECTION_PATTERNS) {
    if (p.words.some((w) => text.includes(w))) found.push(p.key);
  }
  const tone_hints: string[] = [];
  if (/\b(warm|friendly|delight|partner)\b/.test(text)) tone_hints.push('friendly');
  if (/\b(professional|formal|enterprise|compliance)\b/.test(text)) tone_hints.push('formal');
  if (/\b(concise|brief|short|quick)\b/.test(text)) tone_hints.push('concise');
  return {
    sections: found,
    has_faqs: found.includes('faqs'),
    has_pricing: found.includes('pricing'),
    has_timeline: found.includes('timeline'),
    tone_hints,
  };
}

export async function learnFromSamples(env: Bindings, samples: { title: string; snippet: string }[]): Promise<SampleStructure> {
  return extractStructure(samples);
}
