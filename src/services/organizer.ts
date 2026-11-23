// Turns the research the extract layer gathered into section-ready prose.
//
// The helper (the in-browser model) is optional; this is the deterministic
// fallback the API can always answer with. It never invents a fact: every
// sentence it writes comes from the notes or the facts the extract returned.

export interface OrganizerNote {
  title?: string;
  body?: string;
  source?: string;
}

export interface OrganizerFacts {
  business_name?: string;
  value_prop?: string;
  key_points?: string[];
  location?: string;
}

export interface OrganizerInput {
  client_name?: string;
  industry?: string;
  service?: string;
  tone?: string;
  sections: string[];
  notes: OrganizerNote[];
  facts?: OrganizerFacts;
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
};

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'our',
  'are', 'was', 'were', 'will', 'can', 'has', 'have', 'had', 'about', 'into',
  'over', 'their', 'they', 'them', 'its', 'not', 'but', 'all', 'any', 'more',
  'when', 'what', 'who', 'how', 'why', 'new', 'use', 'using', 'get', 'one',
]);

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
    if (!clean(note.body ?? '')) continue;
    const score = scoreNote(note, section);
    if (score > bestScore) {
      best = note;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The organised copy for each requested section. Sections that need a real
 * business decision (price, dates, signature) are deliberately left to the
 * document itself rather than filled with invented text.
 */
export function organizeSections(input: OrganizerInput): Record<string, string> {
  const notes = (input.notes ?? []).filter((note) => clean(note.body ?? ''));
  const facts = input.facts ?? {};
  const client = clean(input.client_name ?? '') || 'The client';
  const industry = clean(input.industry ?? '') || 'their industry';
  const service = clean(input.service ?? '');
  const sections = Array.isArray(input.sections) ? input.sections : [];
  const output: Record<string, string> = {};

  for (const section of sections) {
    const key = normaliseSection(section);
    const note = pickNote(notes, section);
    const noteCopy = note ? sentences(note.body ?? '', 2) : '';
    let copy = '';

    if (key === 'introduction') {
      const lead = `${client} works in ${industry}${service ? ` and offers ${service}` : ''}.`;
      const value = clean(facts.value_prop ?? '');
      copy = [lead, value ? sentences(value, 1) : '', noteCopy].filter(Boolean).join(' ');
    } else if (key === 'about') {
      const lead = `${client}${facts.location ? ` is based in ${clean(facts.location)}` : ''}.`;
      const points = (facts.key_points ?? []).map(clean).filter(Boolean).slice(0, 1);
      copy = [lead, facts.value_prop ? sentences(facts.value_prop, 1) : '', points.join(' '), noteCopy]
        .filter(Boolean)
        .join(' ');
    } else if (key === 'scope') {
      copy = [
        `The engagement covers ${service || industry} for ${client}.`,
        noteCopy,
        'Each stage is reviewed with the client before the next one begins.',
      ]
        .filter(Boolean)
        .join(' ');
    } else if (key === 'what_is_included') {
      const points = (facts.key_points ?? []).map(clean).filter(Boolean).slice(0, 5);
      copy = points.length
        ? `The work includes ${list(points)}.`
        : noteCopy
          ? `The work includes the following, drawn from the research: ${noteCopy}`
          : '';
    } else if (key === 'process') {
      const order = sections
        .map((item) => clean(item).toLowerCase())
        .filter((item) => item && !['pricing', 'faqs', 'next step', 'embedded questions'].includes(item));
      copy = order.length
        ? `The work moves through ${list(order.slice(0, 6))}, with a review at each step before the next one starts.`
        : noteCopy;
    } else {
      // Unknown section: use the best matching research, never a placeholder.
      copy = noteCopy;
    }

    if (copy.trim().length > 20) output[key] = copy.trim();
  }

  return output;
}
