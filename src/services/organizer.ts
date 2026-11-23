// Turns the research the extract layer gathered into section-ready prose.
//
// The helper (the in-browser model) is optional; this is the deterministic
// fallback the API can always answer with. It never invents a fact: every
// sentence it writes comes from the notes, the facts the extract returned, or
// the freelancer's own brief. A generic encyclopedia definition is not used as
// the client's value proposition, because that is what made drafts read as
// filler.

export interface OrganizerNote {
  title?: string;
  body?: string;
  source?: string;
  kind?: 'client' | 'web' | 'background';
}

export interface OrganizerFacts {
  business_name?: string;
  value_prop?: string;
  key_points?: string[];
  location?: string;
}

export interface OrganizerPackage {
  name?: string;
  price?: number;
  deliverables?: string;
  description?: string;
}

export interface OrganizerInput {
  client_name?: string;
  business_name?: string;
  business_website?: string;
  business_description?: string;
  industry?: string;
  service?: string;
  tone?: string;
  sections: string[];
  notes: OrganizerNote[];
  facts?: OrganizerFacts;
  /** The brief's own content, which is first-hand and therefore preferred. */
  problem?: string;
  target_audience?: string;
  timeline?: string;
  cta?: string;
  packages?: OrganizerPackage[];
  /** The contract's own scope clause. It is first-hand wording, not research. */
  scope?: string;
}

const ALIASES: Record<string, string> = {
  intro: 'introduction',
  opening: 'introduction',
  about_you: 'about',
  about_us: 'about',
  who_we_are: 'about',
  deliverables: 'what_is_included',
  included: 'what_is_included',
  what_s_included: 'what_is_included',
  how_it_works: 'process',
  approach: 'process',
  schedule: 'timeline',
};

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'our',
  'are', 'was', 'were', 'will', 'can', 'has', 'have', 'had', 'about', 'into',
  'over', 'their', 'they', 'them', 'its', 'not', 'but', 'all', 'any', 'more',
  'when', 'what', 'who', 'how', 'why', 'new', 'use', 'using', 'get', 'one',
]);

/** Background notes, not facts about this client. */
const BACKGROUND_SOURCES = new Set(['wikipedia', 'duckduckgo']);

export function normaliseSection(value: string): string {
  const flat = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return ALIASES[flat] ?? flat;
}

function words(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (word) => word.length > 2 && !STOPWORDS.has(word),
  );
}

function clean(value: string): string {
  return String(value ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sentences(value: string, limit = 2): string {
  const text = clean(value);
  if (!text) return '';
  const parts = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const joined = parts
    .slice(0, limit)
    .map((part) => part.trim())
    .join(' ')
    .trim();
  return /[.!?]$/.test(joined) ? joined : `${joined}.`;
}

function capitalise(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function list(values: string[]): string {
  const cleanValues = values.map((value) => clean(value).replace(/[.]+$/, '')).filter(Boolean);
  if (cleanValues.length === 0) return '';
  if (cleanValues.length === 1) return capitalise(cleanValues[0]);
  return capitalise(`${cleanValues.slice(0, -1).join(', ')} and ${cleanValues[cleanValues.length - 1]}`);
}

function isBackground(note: OrganizerNote): boolean {
  return BACKGROUND_SOURCES.has(String(note.source ?? '').trim().toLowerCase());
}

/**
 * A search snippet cut with ellipses is not usable prose: quoting it produces
 * fragments like "… fully remote team … here at Buffer." on the page.
 */
function usableBody(value: string): boolean {
  const body = clean(value);
  if (!body) return false;
  if (body.includes('…') || /\s\.\.\.\s/.test(body)) return false;
  if (!/[.!?]/.test(body)) return false;
  return body.split(/\s+/).length >= 8;
}

/** Notes that describe this client, not the industry or another company. */
function clientNotes(notes: OrganizerNote[]): OrganizerNote[] {
  return notes.filter((note) => {
    if (!usableBody(note.body ?? '')) return false;
    if (note.kind) return note.kind === 'client';
    return !isBackground(note);
  });
}

/** Drops sentences that are already on the page, including near duplicates. */
function uniqueSentences(value: string): string {
  const seen = new Set<string>();
  const parts = clean(value).match(/[^.!?]+[.!?]+/g) ?? [clean(value)];
  const kept: string[] = [];
  for (const part of parts) {
    const sentence = part.trim();
    const key = sentence.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(sentence);
  }
  return kept.join(' ');
}

function scoreNote(note: OrganizerNote, section: string): number {
  const key = normaliseSection(section);
  const haystack = `${note.title ?? ''} ${note.body ?? ''}`.toLowerCase();
  let score = 0;
  for (const word of words(section)) {
    if (haystack.includes(word)) score += 2;
  }
  if (key === 'introduction' || key === 'about') score += 1;
  if (key === 'scope' && /service|work|project|design|market/i.test(haystack)) score += 1;
  return score;
}

function pickNote(notes: OrganizerNote[], section: string): OrganizerNote | null {
  let best: OrganizerNote | null = null;
  let bestScore = 0;
  for (const note of notes) {
    if (!usableBody(note.body ?? '')) continue;
    const score = scoreNote(note, section);
    if (score > bestScore) {
      best = note;
      bestScore = score;
    }
  }
  return best;
}

function deliverableLines(packages: OrganizerPackage[]): string[] {
  const lines: string[] = [];
  for (const item of packages) {
    // Split before cleaning: clean() collapses newlines into spaces.
    const text = String(item.deliverables ?? item.description ?? '');
    if (!text.trim()) continue;
    for (const line of text.split(/\r?\n|;|•/)) {
      const value = clean(line);
      if (value) lines.push(value);
    }
  }
  return Array.from(new Set(lines)).slice(0, 6);
}

/**
 * The organised copy for each requested section. Sections that need a real
 * business decision (price, dates, signature) are deliberately left to the
 * document itself rather than filled with invented text.
 */
export function organizeSections(input: OrganizerInput): Record<string, string> {
  const notes = (input.notes ?? []).filter((note) => clean(note.body ?? ''));
  const specific = clientNotes(notes);
  const facts = input.facts ?? {};
  const client = clean(input.client_name ?? '') || 'The client';
  const businessName = clean(input.business_name ?? '');
  const businessWebsite = String(input.business_website ?? '').trim().slice(0, 500);
  const businessDescription = clean(input.business_description ?? '');
  const authorLine = [
    businessName ? `Prepared by ${businessName}${businessWebsite ? ` (${businessWebsite})` : ''}.` : '',
    businessDescription ? `The business website describes its work as: ${sentences(businessDescription, 1)}` : '',
  ].filter(Boolean).join(' ');
  const industry = clean(input.industry ?? '');
  const service = clean(input.service ?? '');
  const problem = clean(input.problem ?? '');
  const audience = clean(input.target_audience ?? '');
  const timeline = clean(input.timeline ?? '');
  const cta = clean(input.cta ?? '');
  const scopeClause = String(input.scope ?? '').trim();
  const valueProp = clean(facts.value_prop ?? '');
  const keyPoints = (facts.key_points ?? []).map(clean).filter(Boolean).slice(0, 6);
  const deliverables = deliverableLines(input.packages ?? []);
  // The positioning note is the client's own description, quoted once in the
  // About section with attribution. Using it again as body copy repeats their
  // marketing line in the freelancer's voice.
  const valuePropKey = clean(valueProp).toLowerCase().slice(0, 40);
  const narrativeNotes = valuePropKey
    ? specific.filter((note) => !clean(note.body ?? '').toLowerCase().startsWith(valuePropKey))
    : specific;
  const sections = Array.isArray(input.sections) ? input.sections : [];
  const output: Record<string, string> = {};

  for (const section of sections) {
    const key = normaliseSection(section);
    const note = pickNote(narrativeNotes, section);
    const noteCopy = note ? sentences(note.body ?? '', 2) : '';
    let copy = '';

    if (key === 'introduction') {
      const lead = `${client}${industry ? ` works in ${industry}` : ''}${service ? ` and is looking for ${service}` : ''}.`;
      copy = [
        lead,
        authorLine,
        problem ? sentences(problem, 1) : '',
        audience ? `The work is aimed at ${audience.replace(/[.]+$/, '')}.` : '',
        noteCopy ? `The client's public materials state: ${noteCopy}` : '',
      ].filter(Boolean).join(' ');
    } else if (key === 'about') {
      const lead = `${client}${facts.location ? ` is based in ${clean(facts.location)}` : ''}.`;
      copy = [
        lead,
        authorLine,
        valueProp ? `Its own site describes it as: ${sentences(valueProp, 1)}` : '',
        keyPoints.length ? `The pages emphasise ${list(keyPoints.slice(0, 3))}.` : '',
        noteCopy ? `The client's public materials state: ${noteCopy}` : '',
      ].filter(Boolean).join(' ');
    } else if (key === 'scope') {
      if (scopeClause) {
        // Keep the user's actual scope wording intact; do not append new obligations.
        copy = scopeClause;
      } else if (deliverables.length) {
        copy = `Scope details supplied: ${list(deliverables.slice(0, 4))}. Confirm the complete scope before sharing.`;
      }
    } else if (key === 'what_is_included') {
      if (deliverables.length) copy = `The deliverables supplied are ${list(deliverables)}. Confirm the final list before sharing.`;
    } else if (key === 'process') {
      // Section headings are not evidence of a real delivery process or approval sequence.
      copy = '';
    } else if (key === 'timeline') {
      if (timeline) copy = `The timeline provided for this project is ${timeline.replace(/[.]+$/, '')}. Confirm dates and milestones before sharing.`;
    } else if (key === 'next_step') {
      copy = cta ? sentences(cta, 1) : '';
    } else if (key === 'pricing') {
      // The document's own package data carries pricing; never infer an amount.
      copy = '';
    } else {
      // Client research must not be repurposed as a legal or commercial clause.
      copy = '';
    }

    const finalCopy = uniqueSentences(copy).trim();
    if (finalCopy.length > 20) output[key] = finalCopy;
  }

  return output;
}
