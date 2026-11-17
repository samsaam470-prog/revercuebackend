/**
 * pdf-lib's standard fonts use WinAnsi encoding; characters outside Latin-1
 * throw at draw time. Contract text is user-authored, so it is normalised
 * before drawing to keep PDF generation deterministic and crash-free.
 */
const REPLACEMENTS: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B]/g, "'"],
  [/[\u201C\u201D\u201E\u201F]/g, '"'],
  [/[\u2013\u2014]/g, '-'],
  [/[\u2026]/g, '...'],
  [/[\u00A0]/g, ' '],
  [/[\u2022]/g, '-'],
  [/[\u20AC]/g, 'EUR'],
  [/[\u00A3]/g, 'GBP'],
];

export function sanitizePdfText(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  for (const [pattern, replacement] of REPLACEMENTS) text = text.replace(pattern, replacement);
  // Keep printable ASCII plus Latin-1 supplement.
  return text.replace(/[^\n\t\x20-\x7E\u00A1-\u00FF]/g, '?');
}
