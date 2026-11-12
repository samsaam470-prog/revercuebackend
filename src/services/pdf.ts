import { dbFirst, dbQuery } from '../utils/db';
import { uploadToB2 } from './storage';
import { sendFormSubmitEmail } from './email';
import type { Bindings } from '../types';

function htmlToPdfShell(html: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:Georgia,serif;max-width:720px;margin:40px auto;padding:24px;line-height:1.6;color:#111}h1{font-size:28px}h2{font-size:20px;margin-top:24px}.meta{color:#666;font-size:12px}</style></head><body>${html}</body></html>`;
}

function renderProposal(p: any): string {
  const c = p.content ? JSON.parse(p.content) : {};
  return htmlToPdfShell(`<h1>${p.title}</h1><p class="meta">Prepared for client. Reference: ${p.public_id ?? p.id}</p><h2>Problem</h2><p>${c.problem ?? ''}</p><h2>Sections</h2><p>${(c.sections ?? []).join(', ')}</p>`);
}

function renderContract(c: any): string {
  const content = c.content ? JSON.parse(c.content) : {};
  return htmlToPdfShell(`<h1>${c.title}</h1><p class="meta">Contract reference: ${c.public_id ?? c.id}</p><h2>Scope</h2><p>${content.scope ?? ''}</p><h2>Payment terms</h2><p>${content.payment_terms ?? ''}</p>`);
}

function renderInvoice(i: any): string {
  const items = i.line_items ? JSON.parse(i.line_items) : [];
  const rows = items.map((it: any) => `<tr><td>${it.description ?? ''}</td><td>${it.quantity ?? ''}</td><td>${it.unit_price ?? ''}</td></tr>`).join('');
  return htmlToPdfShell(`<h1>Invoice ${i.invoice_number}</h1><p class="meta">Due: ${i.due_date ?? '—'}</p><table width="100%"><thead><tr><th>Description</th><th>Qty</th><th>Price</th></tr></thead><tbody>${rows}</tbody></table><p><strong>Total: ${i.total} ${i.currency ?? 'USD'}</strong></p>`);
}

export async function generateDocumentPdf(env: Bindings, type: 'proposal' | 'contract' | 'invoice', id: string): Promise<{ key: string; html: string } | null> {
  let html = '';
  if (type === 'proposal') {
    const row = await dbFirst<any>(env, `SELECT * FROM proposals WHERE id = ?`, [id]);
    if (!row) return null;
    html = renderProposal(row);
  } else if (type === 'contract') {
    const row = await dbFirst<any>(env, `SELECT * FROM contracts WHERE id = ?`, [id]);
    if (!row) return null;
    html = renderContract(row);
  } else {
    const row = await dbFirst<any>(env, `SELECT * FROM invoices WHERE id = ?`, [id]);
    if (!row) return null;
    html = renderInvoice(row);
  }

  const key = `pdfs/${type}/${id}.html`;
  await uploadToB2(env, key, new TextEncoder().encode(html).buffer, 'text/html');
  return { key, html };
}

export async function emailPdfBeforeDeletion(env: Bindings, userId: string, type: string, id: string, title: string): Promise<void> {
  const user = await dbQuery<any>(env, `SELECT email FROM users WHERE id = ?`, [userId]);
  if (user.length === 0 || !user[0].email) return;
  const pdf = await generateDocumentPdf(env, type as any, id);
  if (!pdf) return;
  await sendFormSubmitEmail(env, user[0].email, `Revercue — your ${type} "${title}" is being deleted`, {
    'Document': title,
    'Type': type,
    'Note': 'The document is being deleted per the retention policy. A copy of the content is below.',
    'Content': pdf.html.slice(0, 5000),
  });
}
