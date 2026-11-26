import { dbFirst, dbQuery } from '../utils/db';
import { sha256Hex } from '../utils/crypto';
import { putObject } from './storage';
import { buildPdf } from './pdf-binary';
import type { Bindings } from '../types';

/**
 * Document PDF generation for proposals, contracts, invoices and forms.
 *
 * The previous implementation returned an HTML string from endpoints named
 * `.../pdf` (and labelled the file `.html`). This version produces real PDF
 * bytes for every document type and stores them under a private B2 prefix.
 */

export type PdfDocumentType = 'proposal' | 'contract' | 'invoice' | 'form';

export interface GeneratedPdf {
  key: string;
  bytes: Uint8Array;
  contentType: 'application/pdf';
}

function parseJson(value: unknown): any {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

function formatMoney(amount: unknown, currency: unknown): string {
  const value = Number(amount ?? 0);
  return `${Number.isFinite(value) ? value.toFixed(2) : '0.00'} ${String(currency ?? 'USD')}`;
}

/**
 * The document's own blocks are the document. The PDF used to be rebuilt from
 * a handful of content fields, so nothing the author saw on the canvas —
 * edited paragraphs, charts, diagrams, icons — reached the export.
 */
export function blockSections(content: any): { heading: string; body: string }[] {
  const blocks = Array.isArray(content?.blocks)
    ? content.blocks.filter((block: any) => block && typeof block === 'object' && typeof block.type === 'string')
    : [];
  if (!blocks.length) return [];

  const out: { heading: string; body: string }[] = [];
  let heading = '';
  let lines: string[] = [];

  const flush = () => {
    const body = lines.filter(Boolean).join('\n').trim();
    if (heading || body) out.push({ heading: heading || 'Overview', body });
    heading = '';
    lines = [];
  };

  for (const block of blocks) {
    const text = typeof block.text === 'string' ? block.text.trim() : '';
    switch (block.type) {
      case 'heading':
        flush();
        heading = text || 'Section';
        break;
      case 'paragraph':
      case 'quote':
      case 'button':
      case 'card':
      case 'next_step':
        if (text) lines.push(block.type === 'quote' ? `"${text}"` : text);
        break;
      case 'list':
        for (const item of Array.isArray(block.items) ? block.items : []) {
          if (item?.label) lines.push(`- ${String(item.label)}`);
        }
        break;
      case 'timeline':
        for (const item of Array.isArray(block.items) ? block.items : []) {
          if (item?.label) lines.push(`- ${String(item.label)}${item.value ? ` (${item.value})` : ''}`);
        }
        break;
      case 'pricing_table':
      case 'packages':
        for (const item of Array.isArray(block.items) ? block.items : []) {
          if (!item?.label) continue;
          const price = Number(item.price ?? 0);
          lines.push(`${String(item.label)}${Number.isFinite(price) ? `: ${price.toFixed(2)}` : ''}`);
        }
        break;
      case 'faq':
        for (const faq of Array.isArray(block.faqs) ? block.faqs : []) {
          const question = String(faq?.question ?? '').trim();
          const answer = String(faq?.answer ?? '').trim();
          if (question) lines.push(`Q: ${question}`);
          if (answer) lines.push(`A: ${answer}`);
        }
        break;
      case 'chart':
      case 'graph': {
        const chart = block.chart ?? {};
        const labels = Array.isArray(chart.labels) ? chart.labels : [];
        const values = Array.isArray(chart.values) ? chart.values : [];
        if (text || chart.title) lines.push(String(chart.title || text));
        labels.forEach((label: unknown, index: number) => {
          const value = Number(values[index]);
          if (Number.isFinite(value)) lines.push(`${String(label)}: ${value}${chart.unit ? ` ${chart.unit}` : ''}`);
        });
        if (block.caption) lines.push(String(block.caption));
        break;
      }
      case 'diagram': {
        const steps = Array.isArray(block.diagram?.steps)
          ? block.diagram.steps.map((step: unknown) => String(step).trim()).filter(Boolean)
          : [];
        if (text) lines.push(text);
        if (steps.length) lines.push(steps.join(' -> '));
        break;
      }
      case 'image':
      case 'icon':
      case 'svg': {
        const label = String(block.alt || block.text || '').trim();
        const caption = String(block.caption || '').trim();
        if (label) lines.push(`[${block.type === 'image' ? 'Image' : block.type === 'icon' ? 'Icon' : 'Illustration'}] ${label}`);
        if (caption) lines.push(caption);
        break;
      }
      case 'two_column':
      case 'three_column':
        for (const column of Array.isArray(block.columns) ? block.columns : []) {
          if (Array.isArray(column)) lines.push(column.map((line: unknown) => String(line)).join(' '));
        }
        break;
      default:
        if (text) lines.push(text);
        break;
    }
  }
  flush();
  return out.filter((section) => section.heading || section.body);
}

export function proposalSections(row: any): { heading: string; body: string }[] {
  const content = parseJson(row.content);
  const fromBlocks = blockSections(content);
  if (fromBlocks.length) return fromBlocks;
  const out: { heading: string; body: string }[] = [];
  if (content.problem) out.push({ heading: 'The problem', body: String(content.problem) });
  if (content.target_audience) out.push({ heading: 'Audience', body: String(content.target_audience) });
  if (Array.isArray(content.sections)) {
    for (const section of content.sections) {
      if (typeof section === 'string') out.push({ heading: section, body: '' });
      else if (section && typeof section === 'object') {
        out.push({ heading: String(section.title ?? section.id ?? 'Section'), body: String(section.body ?? '') });
      }
    }
  }
  if (Array.isArray(content.packages) && content.packages.length > 0) {
    out.push({
      heading: 'Packages',
      body: content.packages
        .map((p: any) => `${p.name ?? 'Package'}: ${formatMoney(p.price, content.currency)}${p.deliverables ? ` — ${p.deliverables}` : ''}`)
        .join('\n'),
    });
  }
  if (Array.isArray(content.faqs) && content.faqs.length > 0) {
    out.push({
      heading: 'Frequently asked questions',
      body: content.faqs.map((f: any) => `${f.question ?? ''}\n${f.answer ?? ''}`).join('\n\n'),
    });
  }
  if (content.timeline) out.push({ heading: 'Timeline', body: String(content.timeline) });
  return out.length > 0 ? out : [{ heading: 'Proposal', body: String(content.problem ?? row.title ?? '') }];
}

export function contractSections(row: any): { heading: string; body: string }[] {
  const content = parseJson(row.content);
  const fromBlocks = blockSections(content);
  if (fromBlocks.length) return fromBlocks;
  const out: { heading: string; body: string }[] = [];
  const ordered: Array<[string, string]> = [
    ['Scope of work', 'scope'],
    ['Payment terms', 'payment_terms'],
    ['Timeline', 'timeline'],
    ['Revisions', 'revisions'],
    ['Cancellation', 'cancellation'],
    ['Confidentiality', 'confidentiality'],
    ['Governing terms', 'terms'],
  ];
  for (const [heading, key] of ordered) {
    if (content[key]) out.push({ heading, body: String(content[key]) });
  }
  if (Array.isArray(content.sections)) {
    for (const section of content.sections) {
      if (section && typeof section === 'object') {
        out.push({ heading: String(section.title ?? section.id ?? 'Section'), body: String(section.body ?? '') });
      }
    }
  }
  return out.length > 0 ? out : [{ heading: 'Terms', body: 'No contract content has been written yet.' }];
}

export function invoiceSections(row: any): { heading: string; body: string }[] {
  const items = parseJson(row.line_items);
  const list = Array.isArray(items) ? items : [];
  const body = list
    .map((item: any) => {
      const quantity = Number(item.quantity ?? 0);
      const price = Number(item.unit_price ?? item.price ?? 0);
      return `${item.description ?? 'Item'} — ${quantity} x ${price.toFixed(2)} = ${(quantity * price).toFixed(2)}`;
    })
    .join('\n');
  return [
    { heading: `Invoice ${row.invoice_number ?? ''}`, body: `Due: ${row.due_date ?? '-'}\nStatus: ${row.status ?? '-'}` },
    { heading: 'Line items', body: body || 'No line items.' },
    { heading: 'Total', body: formatMoney(row.total, row.currency) },
    ...(row.notes ? [{ heading: 'Notes', body: String(row.notes) }] : []),
  ];
}

export function formSections(row: any, submission?: any): { heading: string; body: string }[] {
  const questionsRaw = parseJson(row.questions);
  const questions = Array.isArray(questionsRaw) ? questionsRaw : [];
  const answers = submission ? parseJson(submission.answers) : {};
  const out: { heading: string; body: string }[] = [];
  if (row.description) out.push({ heading: 'About this form', body: String(row.description) });
  if (submission) {
    out.push({
      heading: 'Submission',
      body: `Submitted: ${submission.created_at ?? '-'}\nStatus: ${submission.status ?? '-'}`,
    });
    for (const question of questions) {
      const id = String(question.id ?? question.key ?? '');
      const label = String(question.label ?? question.question ?? id);
      const value = answers[id] ?? answers[label];
      const rendered = Array.isArray(value) ? value.join(', ') : value === undefined || value === null ? '' : String(value);
      out.push({ heading: label, body: rendered || '(no answer)' });
    }
    // Answers that are not tied to a question still belong in the record.
    const knownIds = new Set(questions.map((q: any) => String(q.id ?? q.key ?? q.label ?? q.question ?? '')));
    const extras = Object.entries(answers).filter(([key]) => !knownIds.has(key));
    if (extras.length > 0) {
      out.push({ heading: 'Additional answers', body: extras.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('\n') });
    }
  } else {
    out.push({
      heading: 'Questions',
      body: questions.map((q: any, index: number) => `${index + 1}. ${q.label ?? q.question ?? q.id ?? 'Question'}`).join('\n') || 'No questions.',
    });
  }
  return out;
}

export async function loadDocumentForPdf(
  env: Bindings,
  type: PdfDocumentType,
  id: string
): Promise<any | null> {
  switch (type) {
    case 'proposal':
      return dbFirst(env, `SELECT * FROM proposals WHERE id = ? LIMIT 1`, [id]);
    case 'contract':
      return dbFirst(env, `SELECT * FROM contracts WHERE id = ? LIMIT 1`, [id]);
    case 'invoice':
      return dbFirst(env, `SELECT * FROM invoices WHERE id = ? LIMIT 1`, [id]);
    case 'form':
      return dbFirst(env, `SELECT * FROM forms WHERE id = ? LIMIT 1`, [id]);
    default:
      return null;
  }
}

export function documentTitleFor(type: PdfDocumentType, row: any): string {
  if (type === 'invoice') return String(row.invoice_number ?? 'Invoice');
  return String(row.title ?? row.name ?? 'Document');
}

export async function buildDocumentPdf(
  env: Bindings,
  type: PdfDocumentType,
  id: string
): Promise<GeneratedPdf | null> {
  const row = await loadDocumentForPdf(env, type, id);
  if (!row) return null;

  let sections: { heading: string; body: string }[];
  let title = documentTitleFor(type, row);
  let subtitle = '';

  if (type === 'proposal') {
    sections = proposalSections(row);
    subtitle = `Status: ${row.status ?? '-'}`;
  } else if (type === 'contract') {
    sections = contractSections(row);
    subtitle = `Status: ${row.status ?? '-'}`;
  } else if (type === 'invoice') {
    sections = invoiceSections(row);
    subtitle = `Issued: ${row.created_at ?? '-'}`;
  } else {
    const submission = await dbFirst(
      env,
      `SELECT * FROM form_submissions WHERE form_id = ? ORDER BY created_at DESC LIMIT 1`,
      [id]
    ).catch(() => null);
    sections = formSections(row, submission);
    subtitle = `Status: ${row.status ?? '-'}`;
  }

  const bytes = await buildPdf(title, sections, {
    subtitle,
    footer: `Generated by Revercue on ${new Date().toISOString()} · ${type} ${id}`,
  });

  const hash = await sha256Hex(bytes);
  const key = `private/pdfs/${type}/${id}/${hash.slice(0, 16)}.pdf`;
  const uploaded = await putObject(env, key, bytes, 'application/pdf');
  if (!uploaded.ok) {
    console.error('PDF_UPLOAD_FAILED', type, id, uploaded.status);
    // The bytes are still returned so callers can stream them to the user.
  }

  return { key, bytes, contentType: 'application/pdf' };
}

/** Latest stored copy for a document, if one has been generated. */
export async function findStoredPdf(
  env: Bindings,
  type: PdfDocumentType,
  id: string
): Promise<{ key: string } | null> {
  const rows = await dbQuery<{ key: string }>(
    env,
    `SELECT key FROM signed_documents WHERE document_type = ? AND document_id = ? ORDER BY created_at DESC LIMIT 1`,
    [type, id]
  ).catch(() => []);
  return rows[0] ?? null;
}
