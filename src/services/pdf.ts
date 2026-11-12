import { dbFirst } from '../utils/db';
import { uploadToB2 } from './storage';
import { sendFormSubmitEmail } from './email';
import { tursoQuery } from '../utils/turso';
import { buildPdf } from './pdf-binary';
import type { Bindings } from '../types';

function proposalSections(p: any): { heading: string; body: string }[] {
  const c = p.content ? JSON.parse(p.content) : {};
  const out = [{ heading: 'Problem', body: String(c.problem ?? '') }];
  if (Array.isArray(c.sections)) out.push({ heading: 'Sections', body: c.sections.join(', ') });
  return out;
}

function contractSections(c: any): { heading: string; body: string }[] {
  const content = c.content ? JSON.parse(c.content) : {};
  return [
    { heading: 'Scope', body: String(content.scope ?? '') },
    { heading: 'Payment terms', body: String(content.payment_terms ?? '') },
  ];
}

function invoiceSections(i: any): { heading: string; body: string }[] {
  const items = i.line_items ? JSON.parse(i.line_items) : [];
  const body = items.map((it: any) => `${it.description ?? ''} — ${it.quantity ?? ''} x ${it.unit_price ?? ''}`).join('\n');
  return [
    { heading: `Invoice ${i.invoice_number}`, body: `Due: ${i.due_date ?? '—'}` },
    { heading: 'Line items', body },
    { heading: 'Total', body: `${i.total} ${i.currency ?? 'USD'}` },
  ];
}

export async function generateDocumentPdf(env: Bindings, type: 'proposal' | 'contract' | 'invoice', id: string): Promise<{ key: string; bytes: Uint8Array } | null> {
  let title = '';
  let sections: { heading: string; body: string }[] = [];
  if (type === 'proposal') {
    const row = await dbFirst<any>(env, `SELECT * FROM proposals WHERE id = ?`, [id]);
    if (!row) return null;
    title = row.title;
    sections = proposalSections(row);
  } else if (type === 'contract') {
    const row = await dbFirst<any>(env, `SELECT * FROM contracts WHERE id = ?`, [id]);
    if (!row) return null;
    title = row.title;
    sections = contractSections(row);
  } else {
    const row = await dbFirst<any>(env, `SELECT * FROM invoices WHERE id = ?`, [id]);
    if (!row) return null;
    title = row.invoice_number ?? 'Invoice';
    sections = invoiceSections(row);
  }

  const bytes = await buildPdf(title, sections);
  const key = `pdfs/${type}/${id}.pdf`;
  await uploadToB2(env, key, bytes.buffer as ArrayBuffer, 'application/pdf');
  return { key, bytes };
}

export async function emailPdfBeforeDeletion(env: Bindings, userId: string, type: string, id: string, title: string): Promise<void> {
  const user = await tursoQuery(env, `SELECT email FROM users WHERE id = ?`, [userId]);
  if (user.rows.length === 0 || !user.rows[0].email) return;
  const pdf = await generateDocumentPdf(env, type as any, id);
  if (!pdf) return;
  const base64 = btoa(String.fromCharCode(...new Uint8Array(pdf.bytes)));
  await sendFormSubmitEmail(env, String(user.rows[0].email), `Revercue — your ${type} "${title}" is being deleted`, {
    'Document': title,
    'Type': type,
    'Note': 'The document is being deleted per the retention policy. The PDF is attached as a base64 string.',
    'PDF_base64': base64.slice(0, 20000),
  });
}
