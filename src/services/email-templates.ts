/** Shared, dependency-free email templates. */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function layout(title: string, bodyHtml: string, footerNote?: string): string {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin:0;padding:0;background:#0A0A0A;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;padding:40px 20px;"><tr><td align="center">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#141414;border:1px solid #2A2A2A;border-radius:8px;padding:36px;">' +
    '<tr><td style="padding-bottom:24px;"><span style="font-family:Georgia,serif;font-size:22px;color:#FFFFFF;">' +
    '[<span style="color:#C9A961;">R</span>] Revercue</span></td></tr>' +
    '<tr><td style="padding-bottom:16px;"><h1 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#FFFFFF;margin:0;">' +
    escapeHtml(title) +
    '</h1></td></tr>' +
    '<tr><td style="color:#A0A0A0;font-size:15px;line-height:1.6;">' +
    bodyHtml +
    '</td></tr>' +
    (footerNote
      ? '<tr><td style="padding-top:28px;border-top:1px solid #2A2A2A;color:#777;font-size:12px;line-height:1.6;">' +
        escapeHtml(footerNote) +
        '</td></tr>'
      : '') +
    '</table></td></tr></table></body></html>'
  );
}

function button(url: string, label: string): string {
  return (
    '<p style="margin:24px 0;"><a href="' +
    escapeHtml(url) +
    '" style="display:inline-block;background:#C9A961;color:#0A0A0A;font-size:14px;font-weight:600;padding:12px 24px;border-radius:6px;text-decoration:none;">' +
    escapeHtml(label) +
    '</a></p>'
  );
}

export function documentDeliveryEmail(input: {
  documentTitle: string;
  documentType: string;
  expiryDate: string;
  downloadUrl: string;
  deleteAfterDelivery: boolean;
}): RenderedEmail {
  const action = input.deleteAfterDelivery
    ? 'It will be removed from Revercue after this delivery, as your retention policy requires.'
    : 'It will be archived and kept in Revercue because this document type is not auto-deleted.';
  const subject = `Revercue — your ${input.documentType} "${input.documentTitle}" is expiring`;
  const text =
    `Your ${input.documentType} "${input.documentTitle}" reached its retention date on ${input.expiryDate}.\n\n` +
    `A PDF copy is available at the link below (valid for 7 days):\n${input.downloadUrl}\n\n` +
    `${action}\n\nRevercue — Your work should speak, not you.`;
  const html = layout(
    `Your ${input.documentType} is expiring`,
    `<p>Your ${escapeHtml(input.documentType)} <strong>${escapeHtml(input.documentTitle)}</strong> reached its retention date on ${escapeHtml(input.expiryDate)}.</p>` +
      `<p>A PDF copy is available for the next 7 days.</p>` +
      button(input.downloadUrl, 'Download the PDF') +
      `<p>${escapeHtml(action)}</p>`,
    'Revercue — Your work should speak, not you.'
  );
  return { subject, text, html };
}

export function retentionWarningEmail(input: {
  documentTitle: string;
  documentType: string;
  expiryDate: string;
  daysRemaining: number;
  keepUrl: string;
}): RenderedEmail {
  const subject = `Revercue — ${input.documentType} "${input.documentTitle}" is deleted in ${input.daysRemaining} days`;
  const text =
    `Your ${input.documentType} "${input.documentTitle}" is scheduled for removal on ${input.expiryDate}.\n\n` +
    `Open Revercue to keep it: ${input.keepUrl}\n\n` +
    `When the retention date arrives, Revercue emails you a PDF copy and only then applies the ` +
    `retention policy. Fully signed contracts and invoices are never auto-deleted.\n\n` +
    `Revercue — Your work should speak, not you.`;
  const html = layout(
    `${input.daysRemaining} days until this document expires`,
    `<p>Your ${escapeHtml(input.documentType)} <strong>${escapeHtml(input.documentTitle)}</strong> is scheduled for removal on ${escapeHtml(input.expiryDate)}.</p>` +
      `<p>Open Revercue to keep it, or download a copy before then.</p>` +
      button(input.keepUrl, 'Open Revercue'),
    'Fully signed contracts and invoices are never auto-deleted.'
  );
  return { subject, text, html };
}

export function contractFullySignedEmail(input: {
  contractTitle: string;
  clientName: string;
  signedAt: string;
  pdfUrl: string;
}): RenderedEmail {
  const subject = `Revercue — "${input.contractTitle}" is fully signed`;
  const text =
    `${input.clientName} signed "${input.contractTitle}" on ${input.signedAt}. The contract is now fully signed.\n\n` +
    `Download the signed PDF (link valid for 15 minutes): ${input.pdfUrl}\n\n` +
    `You can generate a fresh link at any time from the contract in your dashboard.\n\n` +
    `Revercue — Your work should speak, not you.`;
  const html = layout(
    'Your contract is fully signed',
    `<p><strong>${escapeHtml(input.clientName)}</strong> signed <strong>${escapeHtml(input.contractTitle)}</strong> on ${escapeHtml(input.signedAt)}.</p>` +
      `<p>The signed PDF is available for 15 minutes from the link below. You can generate a new link from your dashboard at any time.</p>` +
      button(input.pdfUrl, 'Download the signed PDF'),
    'This is an automated signing notification.'
  );
  return { subject, text, html };
}

export function contractAwaitingSignatureEmail(input: {
  contractTitle: string;
  signerName: string;
  signUrl: string;
}): RenderedEmail {
  const subject = `Revercue — please sign "${input.contractTitle}"`;
  const text =
    `Hi ${input.signerName},\n\n${'A contract is ready for your signature: ' + input.contractTitle}.\n\n` +
    `Review and sign it here: ${input.signUrl}\n\nRevercue — Your work should speak, not you.`;
  const html = layout(
    'A contract is ready for your signature',
    `<p>Hi ${escapeHtml(input.signerName)},</p>` +
      `<p><strong>${escapeHtml(input.contractTitle)}</strong> is ready for your signature.</p>` +
      button(input.signUrl, 'Review and sign'),
    'Revercue — Your work should speak, not you.'
  );
  return { subject, text, html };
}

export function formSubmissionEmail(input: {
  formTitle: string;
  clientName: string;
  submissionsUrl: string;
  enriched: boolean;
}): RenderedEmail {
  const subject = `Revercue — new submission for "${input.formTitle}"`;
  const text =
    `${input.clientName} submitted "${input.formTitle}".\n\n` +
    `The original answers are saved${input.enriched ? ' and the research enrichment finished' : '; enrichment is still running'}.\n\n` +
    `Open the submission: ${input.submissionsUrl}\n\nRevercue — Your work should speak, not you.`;
  const html = layout(
    'New form submission',
    `<p><strong>${escapeHtml(input.clientName)}</strong> submitted <strong>${escapeHtml(input.formTitle)}</strong>.</p>` +
      `<p>The original answers are saved${input.enriched ? ' and the research enrichment finished' : '; enrichment is still running'}.</p>` +
      button(input.submissionsUrl, 'Open the submission'),
    'Revercue — Your work should speak, not you.'
  );
  return { subject, text, html };
}

export function adminLeadEmail(input: {
  kind: 'contact' | 'beta' | 'waitlist';
  email: string;
  summary: string;
  adminUrl: string;
}): RenderedEmail {
  const subject = `Revercue — new ${input.kind} submission`;
  const text = `New ${input.kind} submission from ${input.email}.\n\n${input.summary}\n\nAdmin: ${input.adminUrl}`;
  const html = layout(
    `New ${input.kind} submission`,
    `<p>From <strong>${escapeHtml(input.email)}</strong></p><pre style="white-space:pre-wrap;color:#A0A0A0;">${escapeHtml(input.summary)}</pre>` +
      button(input.adminUrl, 'Open the admin dashboard'),
    'Administrator notification.'
  );
  return { subject, text, html };
}

export function linkCodeEmail(input: { code: string; email: string }): RenderedEmail {
  const subject = 'Revercue — confirm linking your sign-in';
  const text =
    `Use this code to link your AuthAction sign-in to the Revercue account for ${input.email}:\n\n${input.code}\n\n` +
    `It expires in 10 minutes and can be used once. If you did not request it, ignore this email and ` +
    `contact support — someone may be trying to link your account.`;
  const html = layout(
    'Confirm linking your sign-in',
    `<p>Use this code to link your AuthAction sign-in to the Revercue account for <strong>${escapeHtml(input.email)}</strong>:</p>` +
      `<div style="font-family:monospace;font-size:34px;font-weight:600;color:#C9A961;letter-spacing:8px;background:#0A0A0A;border:1px solid #2A2A2A;border-radius:6px;padding:16px 24px;display:inline-block;">${escapeHtml(input.code)}</div>` +
      `<p>It expires in 10 minutes and can be used once. If you did not request it, ignore this email and contact support.</p>`,
    'Revercue — Your work should speak, not you.'
  );
  return { subject, text, html };
}
