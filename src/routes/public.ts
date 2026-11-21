import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { dbFirst, dbQuery, dbRun } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { generateId, generatePublicId } from '../utils/ids';
import { createNotification } from '../services/notifications';
import { generatePrompt } from '../services/prompt-creator';
import {
  closeVisit,
  findTrackableDocument,
  isTrackedType,
  startVisit,
  trackEvent,
  type TrackedDocumentType,
} from '../services/tracking';
import { signAsClient, readSigningSummary, ensureSignedPdf } from '../services/contract-signing';
import { createDocumentLink, verifyDocumentLink } from '../services/document-links';
import { createSignedToken, verifySignedToken } from '../utils/crypto';
import { buildDocumentPdf } from '../services/pdf';
import { pdfResponse } from '../services/pdf-binary';
import { hashIp, clientIp, clientUserAgent } from '../utils/http';
import { jsonError, handleRouteError } from '../utils/api-errors';
import { checkRateLimit } from '../services/rate-limit';
import { putObject, isPublicKey } from '../services/storage';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  IMAGE_UPLOAD_TYPES,
  PROOF_UPLOAD_TYPES,
} from '../config/constants';
import { submitPublicForm } from '../services/form-submissions';
import { SigningError } from '../services/contract-state';
import type { Bindings } from '../types';

const pub = new Hono<{ Bindings: Bindings }>();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type DocType = 'proposal' | 'contract' | 'invoice' | 'form';

const TABLES: Record<DocType, string> = {
  proposal: 'proposals',
  contract: 'contracts',
  invoice: 'invoices',
  form: 'forms',
};

function appBase(env: Bindings): string {
  return (env.APP_URL || env.FRONTEND_ORIGIN || 'https://revercue.co.uk').replace(/\/$/, '');
}

async function getUserPlan(env: Bindings, userId: string): Promise<string> {
  const result = await tursoQuery(env, `SELECT plan FROM users WHERE id = ? LIMIT 1`, [userId]);
  return String(result.rows[0]?.plan ?? 'free');
}

async function visitorHash(c: any): Promise<string | null> {
  const ip = clientIp(c);
  if (!ip) return null;
  const ua = clientUserAgent(c);
  return hashIp(`${ip}|${ua}`, c.env.USER_JWT_KEY);
}

/**
 * Password wall. Proposals keep their existing `password_hash` columns; the
 * other document types use the additive `document_access` table so no legacy
 * table is altered.
 */
async function passwordRequired(env: Bindings, type: DocType, row: any): Promise<{ enabled: boolean; hash: string | null }> {
  if (type === 'proposal') {
    return { enabled: Number(row.password_protected) === 1 || Boolean(row.password_hash), hash: row.password_hash ?? null };
  }
  const access = await dbFirst<{ password_hash: string | null; enabled: number }>(
    env,
    `SELECT password_hash, enabled FROM document_access WHERE document_type = ? AND document_id = ? LIMIT 1`,
    [type, row.id]
  );
  return { enabled: Boolean(access?.enabled), hash: access?.password_hash ?? null };
}

const ACCESS_TOKEN_PURPOSE = 'document_access';

async function issueAccessToken(env: Bindings, type: DocType, documentId: string): Promise<string> {
  return createSignedToken(env.SIGNING_LINK_SECRET || env.USER_JWT_KEY, {
    p: ACCESS_TOKEN_PURPOSE,
    t: type,
    id: documentId,
    exp: Math.floor(Date.now() / 1000) + 2 * 3600,
  });
}

async function hasValidAccess(
  c: any,
  type: DocType,
  documentId: string
): Promise<boolean> {
  const headerToken = c.req.header('X-Password-Session') ?? '';
  const queryToken = c.req.query('session') ?? '';
  const token = headerToken || queryToken;
  if (!token) return false;
  const result = await verifySignedToken<{ p: string; t: string; id: string; exp: number }>(
    c.env.SIGNING_LINK_SECRET || c.env.USER_JWT_KEY,
    token
  );
  if (!result.ok) return false;
  return result.payload.p === ACCESS_TOKEN_PURPOSE && result.payload.t === type && result.payload.id === documentId;
}

interface PublicDocResult {
  row: any;
  plan: string;
  accessGranted: boolean;
  visitId: string | null;
}

/**
 * Loads a public document, enforcing archived/closed state, the password wall
 * and visit tracking. Returns a Response when the request must be rejected.
 */
async function openPublicDocument(
  c: any,
  type: DocType,
  publicId: string,
  options: { trackEvent?: string; allowDraft?: boolean } = {}
): Promise<PublicDocResult | Response> {
  const table = TABLES[type];
  const row = await dbFirst<any>(c.env, `SELECT * FROM ${table} WHERE public_id = ? LIMIT 1`, [publicId]);
  if (!row) return jsonError(c, 404, 'not_found', 'Document not found.');

  if (row.status === 'archived') return jsonError(c, 410, 'gone', 'This document is closed.', { closed: true });
  if (row.status === 'draft' && !options.allowDraft) {
    return jsonError(c, 403, 'forbidden', 'This document is not published yet.');
  }

  const password = await passwordRequired(c.env, type, row);
  let accessGranted = true;
  if (password.enabled) {
    accessGranted = await hasValidAccess(c, type, row.id);
    if (!accessGranted) {
      return c.json({ password_wall: true, error: 'password_required', message: 'This document is password protected.' }, 401);
    }
  }

  const plan = await getUserPlan(c.env, row.user_id);
  let visitId: string | null = null;
  if (isTrackedType(type)) {
    const started = await startVisit(c.env, {
      userId: row.user_id,
      plan,
      documentType: type,
      documentId: row.id,
      visitorHash: await visitorHash(c),
      userAgent: clientUserAgent(c),
    });
    visitId = started.visitId;
    if (started.visitId && !started.reused) {
      const eventMap: Record<DocType, string> = {
        proposal: 'proposal_opened',
        contract: 'contract_opened',
        invoice: 'invoice_opened',
        form: 'form_submitted',
      };
      if (type !== 'form') {
        await createNotification(c.env, {
          userId: row.user_id,
          eventType: eventMap[type],
          clientId: row.client_id ?? null,
          documentId: row.id,
          title: `${type === 'proposal' ? 'Proposal' : type === 'contract' ? 'Contract' : 'Invoice'} opened: ${row.title ?? row.invoice_number ?? ''}`,
          documentTitle: String(row.title ?? row.invoice_number ?? ''),
        }).catch((error) => console.error('OPEN_NOTIFICATION_FAILED', error));
      }
    }
  }

  return { row, plan, accessGranted, visitId };
}

/** Strips private fields before a public document is returned. */
function publicView(type: DocType, row: any): any {
  const {
    password_hash,
    proof_screenshot_key,
    user_id,
    ...rest
  } = row;
  if (type === 'proposal' || type === 'contract' || type === 'invoice' || type === 'form') {
    return rest;
  }
  return row;
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

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

pub.get('/p/:publicId', async (c) => {
  const opened = await openPublicDocument(c, 'proposal', c.req.param('publicId'));
  if (opened instanceof Response) return opened;
  return c.json({ proposal: publicView('proposal', opened.row), visit_id: opened.visitId });
});

pub.post('/p/:publicId/unlock', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT * FROM proposals WHERE public_id = ? LIMIT 1`, [c.req.param('publicId')]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  const ip = clientIp(c);
  const limit = await checkRateLimit(c.env, `unlock:proposal:${row.id}:${ip}`, 8, 900);
  if (!limit.allowed) return jsonError(c, 429, 'rate_limited', 'Too many attempts. Try again later.', { retry_after: limit.retryAfter });

  const body = await c.req.json().catch(() => ({}));
  const password = await passwordRequired(c.env, 'proposal', row);
  if (!password.enabled) return c.json({ success: true, session_token: await issueAccessToken(c.env, 'proposal', row.id) });
  let ok = false;
  try {
    ok = password.hash ? await bcrypt.compare(String(body.password ?? ''), password.hash) : false;
  } catch {
    ok = false;
  }
  if (!ok) return jsonError(c, 401, 'invalid_password', 'That password is not correct.');
  return c.json({ success: true, session_token: await issueAccessToken(c.env, 'proposal', row.id) });
});

pub.post('/p/:publicId/events', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT id, user_id FROM proposals WHERE public_id = ? LIMIT 1`, [
    c.req.param('publicId'),
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  const body = await c.req.json().catch(() => ({}));
  const plan = await getUserPlan(c.env, row.user_id);
  const outcome = await trackEvent(c.env, {
    userId: row.user_id,
    plan,
    documentType: 'proposal',
    documentId: row.id,
    visitId: body.visit_id ? String(body.visit_id) : null,
    eventType: String(body.event_type ?? 'unknown'),
    eventData: body.event_data,
  });
  if (!outcome.ok) {
    return jsonError(c, outcome.reason === 'rate_limited' ? 429 : 400, outcome.reason, 'The event was not recorded.');
  }
  return c.json({ success: true, visit_id: outcome.visitId, recorded: outcome.recorded });
});

pub.post('/p/:publicId/question', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT id, user_id, client_id, title FROM proposals WHERE public_id = ? LIMIT 1`, [
    c.req.param('publicId'),
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  const body = await c.req.json().catch(() => ({}));
  const text = String(body.question_text ?? '').trim();
  if (!text) return jsonError(c, 400, 'invalid_payload', 'A question is required.');
  await createNotification(c.env, {
    userId: row.user_id,
    eventType: 'client_replied',
    clientId: row.client_id,
    documentId: row.id,
    title: `Proposal question: ${text.slice(0, 80)}`,
    body: text.slice(0, 2000),
    documentTitle: row.title,
  });
  return c.json({ success: true }, 201);
});

pub.post('/p/:publicId/action', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT * FROM proposals WHERE public_id = ? LIMIT 1`, [c.req.param('publicId')]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  if (row.status === 'archived') return jsonError(c, 410, 'gone', 'This proposal is closed.', { closed: true });
  const body = await c.req.json().catch(() => ({}));
  const action = String(body.action ?? '');
  const now = new Date().toISOString();
  const plan = await getUserPlan(c.env, row.user_id);

  if (action === 'approve') {
    await dbRun(c.env, `UPDATE proposals SET status = 'accepted', updated_at = ? WHERE id = ?`, [now, row.id]);
    await dbRun(
      c.env,
      `INSERT INTO communication_log (id, user_id, client_id, entry_type, message_text, linked_document_type, linked_document_id, created_at)
       VALUES (?, ?, ?, 'client_action', ?, 'proposal', ?, ?)`,
      [generateId('log'), row.user_id, row.client_id, `Accepted by ${String(body.name ?? 'client').slice(0, 100)}`, row.id, now]
    );
    await createNotification(c.env, {
      userId: row.user_id,
      eventType: 'proposal_accepted',
      clientId: row.client_id,
      documentId: row.id,
      title: `Proposal accepted: ${row.title}`,
      documentTitle: row.title,
    });
    await trackEvent(c.env, {
      userId: row.user_id,
      plan,
      documentType: 'proposal',
      documentId: row.id,
      visitId: body.visit_id ?? null,
      eventType: 'button_click',
      eventData: { action: 'approve', package: body.package ?? null },
    });
    return c.json({ success: true, next_step: 'contract' });
  }

  if (action === 'decline') {
    await dbRun(c.env, `UPDATE proposals SET status = 'declined', updated_at = ? WHERE id = ?`, [now, row.id]);
    await createNotification(c.env, {
      userId: row.user_id,
      eventType: 'proposal_declined',
      clientId: row.client_id,
      documentId: row.id,
      title: `Proposal declined: ${row.title}`,
      body: String(body.reason ?? '').slice(0, 500) || null,
      documentTitle: row.title,
    });
    return c.json({ success: true });
  }

  return jsonError(c, 400, 'invalid_payload', 'Unsupported action.');
});

pub.get('/p/:publicId/pdf', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT * FROM proposals WHERE public_id = ? LIMIT 1`, [c.req.param('publicId')]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  if (row.status === 'archived') return jsonError(c, 410, 'gone', 'This proposal is closed.');
  const password = await passwordRequired(c.env, 'proposal', row);
  if (password.enabled && !(await hasValidAccess(c, 'proposal', row.id))) {
    return jsonError(c, 401, 'password_required', 'This document is password protected.');
  }
  const generated = await buildDocumentPdf(c.env, 'proposal', row.id);
  if (!generated) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  return pdfResponse(generated.bytes, `${row.title ?? 'proposal'}.pdf`, 'inline');
});

pub.post('/p/:publicId/close', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT id, user_id FROM proposals WHERE public_id = ? LIMIT 1`, [
    c.req.param('publicId'),
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Proposal not found.');
  const body = await c.req.json().catch(() => ({}));
  const closed = await closeVisit(c.env, {
    userId: row.user_id,
    documentType: 'proposal',
    documentId: row.id,
    visitId: body.visit_id ?? null,
    seconds: Number(body.time_spent_seconds ?? 0),
  });
  return c.json({ success: true, closed });
});

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

pub.get('/c/:publicId', async (c) => {
  const opened = await openPublicDocument(c, 'contract', c.req.param('publicId'));
  if (opened instanceof Response) return opened;
  const signing = await readSigningSummary(c.env, opened.row).catch(() => null);
  return c.json({
    contract: publicView('contract', opened.row),
    signing,
    visit_id: opened.visitId,
  });
});

pub.post('/c/:publicId/unlock', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT id FROM contracts WHERE public_id = ? LIMIT 1`, [c.req.param('publicId')]);
  if (!row) return jsonError(c, 404, 'not_found', 'Contract not found.');
  const limit = await checkRateLimit(c.env, `unlock:contract:${row.id}:${clientIp(c)}`, 8, 900);
  if (!limit.allowed) return jsonError(c, 429, 'rate_limited', 'Too many attempts.', { retry_after: limit.retryAfter });
  const access = await dbFirst<{ password_hash: string | null; enabled: number }>(
    c.env,
    `SELECT password_hash, enabled FROM document_access WHERE document_type = 'contract' AND document_id = ? LIMIT 1`,
    [row.id]
  );
  const body = await c.req.json().catch(() => ({}));
  if (!access?.enabled) return c.json({ success: true, session_token: await issueAccessToken(c.env, 'contract', row.id) });
  let ok = false;
  try {
    ok = access.password_hash ? await bcrypt.compare(String(body.password ?? ''), access.password_hash) : false;
  } catch {
    ok = false;
  }
  if (!ok) return jsonError(c, 401, 'invalid_password', 'That password is not correct.');
  return c.json({ success: true, session_token: await issueAccessToken(c.env, 'contract', row.id) });
});

pub.post('/c/:publicId/sign', async (c) => {
  const publicId = c.req.param('publicId');
  const row = await dbFirst<any>(c.env, `SELECT id, status FROM contracts WHERE public_id = ? LIMIT 1`, [publicId]);
  if (!row) return jsonError(c, 404, 'not_found', 'Contract not found.');
  const limit = await checkRateLimit(c.env, `sign:contract:${row.id}:${clientIp(c)}`, 10, 3600);
  if (!limit.allowed) return jsonError(c, 429, 'rate_limited', 'Too many signing attempts.', { retry_after: limit.retryAfter });

  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await signAsClient(c.env, publicId, {
      signature: String(body.signature ?? ''),
      consent: body.consent === true,
      name: String(body.name ?? ''),
      email: body.email ? String(body.email) : null,
      ip: clientIp(c),
      userAgent: clientUserAgent(c),
      expectedContentHash: body.expected_content_hash ? String(body.expected_content_hash) : null,
    });
    return c.json({ success: true, ...result });
  } catch (error) {
    const handled = handleRouteError(c, error);
    if (handled) return handled;
    console.error('CLIENT_SIGN_FAILED', error);
    return jsonError(c, 500, 'sign_failed', 'The signature could not be recorded.');
  }
});

/**
 * The old approve action must never bypass the signature requirement.
 * Declining and asking a question stay available; approving is redirected to
 * the signing endpoint.
 */
pub.post('/c/:publicId/action', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT * FROM contracts WHERE public_id = ? LIMIT 1`, [c.req.param('publicId')]);
  if (!row) return jsonError(c, 404, 'not_found', 'Contract not found.');
  if (row.status === 'archived') return jsonError(c, 410, 'gone', 'This contract is closed.', { closed: true });
  const body = await c.req.json().catch(() => ({}));
  const action = String(body.action ?? '');
  const now = new Date().toISOString();
  const plan = await getUserPlan(c.env, row.user_id);

  if (action === 'decline') {
    await dbRun(c.env, `UPDATE contracts SET status = 'declined', declined_at = ?, updated_at = ? WHERE id = ?`, [
      now,
      now,
      row.id,
    ]);
    await createNotification(c.env, {
      userId: row.user_id,
      eventType: 'contract_declined',
      clientId: row.client_id,
      documentId: row.id,
      title: `Contract declined: ${row.title}`,
      body: String(body.reason ?? '').slice(0, 500) || null,
      documentTitle: row.title,
    });
    return c.json({ success: true });
  }

  if (action === 'question') {
    const text = String(body.question ?? '').trim();
    if (!text) return jsonError(c, 400, 'invalid_payload', 'A question is required.');
    await createNotification(c.env, {
      userId: row.user_id,
      eventType: 'client_replied',
      clientId: row.client_id,
      documentId: row.id,
      title: `Contract question: ${text.slice(0, 80)}`,
      body: text.slice(0, 2000),
      documentTitle: row.title,
    });
    return c.json({ success: true });
  }

  if (action === 'approve') {
    if (row.status === 'fully_signed') return c.json({ success: true, status: 'fully_signed' });
    return jsonError(
      c,
      409,
      'signature_required',
      'Approval requires your electronic signature. Use the signing form to review, consent and sign.',
      { requires_signature: true, sign_endpoint: `/api/public/c/${c.req.param('publicId')}/sign` }
    );
  }

  return jsonError(c, 400, 'invalid_payload', 'Unsupported action.');
});

pub.get('/c/:publicId/pdf', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT * FROM contracts WHERE public_id = ? LIMIT 1`, [c.req.param('publicId')]);
  if (!row) return jsonError(c, 404, 'not_found', 'Contract not found.');
  if (row.status === 'archived') return jsonError(c, 410, 'gone', 'This contract is closed.');
  if (row.status === 'fully_signed') {
    return jsonError(
      c,
      403,
      'signed_pdf_requires_token',
      'The countersigned PDF is private. Use the download link returned when signing, or ask the freelancer for a fresh link.'
    );
  }
  const password = await passwordRequired(c.env, 'contract', row);
  if (password.enabled && !(await hasValidAccess(c, 'contract', row.id))) {
    return jsonError(c, 401, 'password_required', 'This document is password protected.');
  }
  const generated = await buildDocumentPdf(c.env, 'contract', row.id);
  if (!generated) return jsonError(c, 404, 'not_found', 'Contract not found.');
  return pdfResponse(generated.bytes, `${row.title ?? 'contract'}.pdf`, 'inline');
});

pub.post('/c/:publicId/close', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT id, user_id FROM contracts WHERE public_id = ? LIMIT 1`, [
    c.req.param('publicId'),
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Contract not found.');
  const body = await c.req.json().catch(() => ({}));
  const closed = await closeVisit(c.env, {
    userId: row.user_id,
    documentType: 'contract',
    documentId: row.id,
    visitId: body.visit_id ?? null,
    seconds: Number(body.time_spent_seconds ?? 0),
  });
  return c.json({ success: true, closed });
});

/**
 * Short-lived, authorized download of the countersigned PDF. The token is an
 * HMAC over the contract and version; possessing the public link is not enough.
 */
pub.get('/contracts/:id/signed-pdf', async (c) => {
  const token = c.req.query('token') ?? '';
  if (!token) return jsonError(c, 403, 'forbidden', 'A signed download token is required.');
  const contractId = c.req.param('id');
  const verification = await verifyDocumentLink(c.env, token, {
    purpose: 'signed_pdf',
    documentType: 'contract',
    documentId: contractId,
  });
  if (!verification.ok) {
    return jsonError(c, 403, 'invalid_token', `This download link is ${verification.reason === 'expired' ? 'expired' : 'not valid'}.`);
  }
  const contract = await dbFirst<any>(c.env, `SELECT id, title, status FROM contracts WHERE id = ? LIMIT 1`, [contractId]);
  if (!contract) return jsonError(c, 410, 'gone', 'This contract no longer exists.');
  if (contract.status !== 'fully_signed') return jsonError(c, 409, 'not_signed', 'The contract is not fully signed.');

  const pdf = await ensureSignedPdf(c.env, contractId);
  if (!pdf) {
    return jsonError(c, 503, 'pdf_unavailable', 'The signed PDF could not be generated. Try again shortly.');
  }
  return pdfResponse(pdf.bytes, `contract-${contractId}-signed.pdf`, 'attachment');
});

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

pub.get('/i/:publicId', async (c) => {
  const opened = await openPublicDocument(c, 'invoice', c.req.param('publicId'));
  if (opened instanceof Response) return opened;
  return c.json({ invoice: publicView('invoice', opened.row), visit_id: opened.visitId });
});

pub.post('/i/:publicId/unlock', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT id FROM invoices WHERE public_id = ? LIMIT 1`, [c.req.param('publicId')]);
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  const limit = await checkRateLimit(c.env, `unlock:invoice:${row.id}:${clientIp(c)}`, 8, 900);
  if (!limit.allowed) return jsonError(c, 429, 'rate_limited', 'Too many attempts.', { retry_after: limit.retryAfter });
  const access = await dbFirst<{ password_hash: string | null; enabled: number }>(
    c.env,
    `SELECT password_hash, enabled FROM document_access WHERE document_type = 'invoice' AND document_id = ? LIMIT 1`,
    [row.id]
  );
  const body = await c.req.json().catch(() => ({}));
  if (!access?.enabled) return c.json({ success: true, session_token: await issueAccessToken(c.env, 'invoice', row.id) });
  let ok = false;
  try {
    ok = access.password_hash ? await bcrypt.compare(String(body.password ?? ''), access.password_hash) : false;
  } catch {
    ok = false;
  }
  if (!ok) return jsonError(c, 401, 'invalid_password', 'That password is not correct.');
  return c.json({ success: true, session_token: await issueAccessToken(c.env, 'invoice', row.id) });
});

pub.post('/i/:publicId/buy-now', async (c) => {
  const row = await dbFirst<any>(
    c.env,
    `SELECT id, user_id, client_id, payment_arrangement, invoice_number FROM invoices WHERE public_id = ? LIMIT 1`,
    [c.req.param('publicId')]
  );
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  const arrangement = parseJson(row.payment_arrangement);
  await createNotification(c.env, {
    userId: row.user_id,
    eventType: 'invoice_opened',
    clientId: row.client_id,
    documentId: row.id,
    title: 'Client started payment',
    documentTitle: row.invoice_number,
  });
  if (arrangement.type === 'link' && arrangement.url) {
    const check = new URL(String(arrangement.url), 'https://invalid.example');
    if (check.protocol !== 'https:') {
      return jsonError(c, 409, 'invalid_payment_link', 'The payment link on this invoice is not valid.');
    }
    return c.json({ success: true, redirect: String(arrangement.url) });
  }
  return c.json({ success: true, show_account_details: true });
});

pub.post('/i/:publicId/proof', async (c) => {
  const row = await dbFirst<any>(
    c.env,
    `SELECT id, user_id, client_id, invoice_number FROM invoices WHERE public_id = ? LIMIT 1`,
    [c.req.param('publicId')]
  );
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  const limit = await checkRateLimit(c.env, `proof:${row.id}:${clientIp(c)}`, 10, 3600);
  if (!limit.allowed) return jsonError(c, 429, 'rate_limited', 'Too many uploads.', { retry_after: limit.retryAfter });

  const contentType = c.req.header('Content-Type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return jsonError(c, 400, 'invalid_payload', 'Upload the proof as multipart/form-data with a `file` field.');
  }
  const form = await c.req.parseBody();
  const file = form['file'];
  if (!(file instanceof File)) return jsonError(c, 400, 'invalid_payload', 'No file provided.');
  const maxBytes = Number(c.env.MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES);
  if (file.size > maxBytes) return jsonError(c, 413, 'file_too_large', 'The file is too large.');
  if (!PROOF_UPLOAD_TYPES.includes(file.type)) {
    return jsonError(c, 400, 'invalid_file_type', 'Upload a PNG, JPEG, WebP or PDF.');
  }

  const extension = (file.name.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = `private/proofs/${row.user_id}/${row.id}/${generateId('proof')}.${extension}`;
  const uploaded = await putObject(c.env, key, await file.arrayBuffer(), file.type);
  if (!uploaded.ok) return jsonError(c, 503, 'upload_failed', 'The proof could not be stored. Try again.');

  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `INSERT INTO document_uploads (id, document_type, document_id, user_id, key, mime, size_bytes, question_id, created_at)
     VALUES (?, 'invoice', ?, ?, ?, ?, ?, NULL, ?)`,
    [generateId('upl'), row.id, row.user_id, key, file.type, file.size, now]
  );
  await dbRun(c.env, `UPDATE invoices SET status = 'proof_submitted', proof_submitted_at = ?, updated_at = ? WHERE id = ?`, [
    now,
    now,
    row.id,
  ]);
  await createNotification(c.env, {
    userId: row.user_id,
    eventType: 'invoice_proof_submitted',
    clientId: row.client_id,
    documentId: row.id,
    title: 'Payment proof uploaded',
    documentTitle: row.invoice_number,
  });
  return c.json({ success: true, status: 'proof_submitted' });
});

pub.get('/i/:publicId/pdf', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT * FROM invoices WHERE public_id = ? LIMIT 1`, [c.req.param('publicId')]);
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  if (row.status === 'archived') return jsonError(c, 410, 'gone', 'This invoice is closed.');
  const password = await passwordRequired(c.env, 'invoice', row);
  if (password.enabled && !(await hasValidAccess(c, 'invoice', row.id))) {
    return jsonError(c, 401, 'password_required', 'This document is password protected.');
  }
  const generated = await buildDocumentPdf(c.env, 'invoice', row.id);
  if (!generated) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  return pdfResponse(generated.bytes, `${row.invoice_number ?? 'invoice'}.pdf`, 'inline');
});

pub.post('/i/:publicId/close', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT id, user_id FROM invoices WHERE public_id = ? LIMIT 1`, [
    c.req.param('publicId'),
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Invoice not found.');
  const body = await c.req.json().catch(() => ({}));
  const closed = await closeVisit(c.env, {
    userId: row.user_id,
    documentType: 'invoice',
    documentId: row.id,
    visitId: body.visit_id ?? null,
    seconds: Number(body.time_spent_seconds ?? 0),
  });
  return c.json({ success: true, closed });
});

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

pub.get('/f/:publicId', async (c) => {
  const opened = await openPublicDocument(c, 'form', c.req.param('publicId'));
  if (opened instanceof Response) return opened;
  if (opened.row.status === 'closed') return jsonError(c, 410, 'gone', 'This form is closed.', { closed: true });
  return c.json({ form: publicView('form', opened.row), visit_id: opened.visitId });
});

pub.post('/f/:publicId/unlock', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT id FROM forms WHERE public_id = ? LIMIT 1`, [c.req.param('publicId')]);
  if (!row) return jsonError(c, 404, 'not_found', 'Form not found.');
  const limit = await checkRateLimit(c.env, `unlock:form:${row.id}:${clientIp(c)}`, 8, 900);
  if (!limit.allowed) return jsonError(c, 429, 'rate_limited', 'Too many attempts.', { retry_after: limit.retryAfter });
  const access = await dbFirst<{ password_hash: string | null; enabled: number }>(
    c.env,
    `SELECT password_hash, enabled FROM document_access WHERE document_type = 'form' AND document_id = ? LIMIT 1`,
    [row.id]
  );
  const body = await c.req.json().catch(() => ({}));
  if (!access?.enabled) return c.json({ success: true, session_token: await issueAccessToken(c.env, 'form', row.id) });
  let ok = false;
  try {
    ok = access.password_hash ? await bcrypt.compare(String(body.password ?? ''), access.password_hash) : false;
  } catch {
    ok = false;
  }
  if (!ok) return jsonError(c, 401, 'invalid_password', 'That password is not correct.');
  return c.json({ success: true, session_token: await issueAccessToken(c.env, 'form', row.id) });
});

pub.post('/f/:publicId/upload', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT id, user_id, status, expiry_date FROM forms WHERE public_id = ? LIMIT 1`, [
    c.req.param('publicId'),
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Form not found.');
  if (row.status === 'archived' || row.status === 'closed') return jsonError(c, 410, 'gone', 'This form is closed.');
  const limit = await checkRateLimit(c.env, `formupload:${row.id}:${clientIp(c)}`, 30, 3600);
  if (!limit.allowed) return jsonError(c, 429, 'rate_limited', 'Too many uploads.', { retry_after: limit.retryAfter });

  const form = await c.req.parseBody();
  const file = form['file'];
  const questionId = String(form['question_id'] ?? '');
  if (!(file instanceof File)) return jsonError(c, 400, 'invalid_payload', 'No file provided.');
  const maxBytes = Number(c.env.MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES);
  if (file.size > maxBytes) return jsonError(c, 413, 'file_too_large', 'The file is too large.');
  if (![...IMAGE_UPLOAD_TYPES, 'application/pdf'].includes(file.type)) {
    return jsonError(c, 400, 'invalid_file_type', 'Upload an image or a PDF.');
  }

  const extension = (file.name.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = `private/form-uploads/${row.user_id}/${row.id}/${generateId('fu')}.${extension}`;
  const uploaded = await putObject(c.env, key, await file.arrayBuffer(), file.type);
  if (!uploaded.ok) return jsonError(c, 503, 'upload_failed', 'The file could not be stored.');

  const id = generateId('upl');
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `INSERT INTO document_uploads (id, document_type, document_id, user_id, key, mime, size_bytes, question_id, created_at)
     VALUES (?, 'form', ?, ?, ?, ?, ?, ?, ?)`,
    [id, row.id, row.user_id, key, file.type, file.size, questionId || null, now]
  );
  return c.json({ success: true, file_id: id, url: `/api/files/${key}` }, 201);
});

pub.post('/f/:publicId/submit', async (c) => {
  const publicId = c.req.param('publicId');
  const limit = await checkRateLimit(c.env, `formsubmit:${publicId}:${clientIp(c)}`, 10, 3600);
  if (!limit.allowed) return jsonError(c, 429, 'rate_limited', 'Too many submissions.', { retry_after: limit.retryAfter });

  const body = await c.req.json().catch(() => ({}));
  const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};
  try {
    const result = await submitPublicForm(c.env, {
      publicId,
      answers,
      serviceType: body.service_type,
      clientSubmissionId: body.client_submission_id,
      ip: clientIp(c),
      userAgent: clientUserAgent(c),
    });
    if (!result.ok) return jsonError(c, result.status, result.error, result.message);
    const prompt = result.generatedPrompt ?? generatePrompt(String(body.service_type ?? 'project'), answers);
    return c.json({
      success: true,
      submission_id: result.submissionId,
      status: result.status,
      generated_prompt: prompt,
      thank_you_config: result.thankYouConfig ?? null,
    }, 201);
  } catch (error) {
    console.error('FORM_SUBMIT_FAILED', error);
    return jsonError(c, 500, 'submit_failed', 'The submission could not be saved. Please try again.');
  }
});

pub.get('/f/:publicId/pdf', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT * FROM forms WHERE public_id = ? LIMIT 1`, [c.req.param('publicId')]);
  if (!row) return jsonError(c, 404, 'not_found', 'Form not found.');
  if (row.status === 'archived') return jsonError(c, 410, 'gone', 'This form is closed.');
  const generated = await buildDocumentPdf(c.env, 'form', row.id);
  if (!generated) return jsonError(c, 404, 'not_found', 'Form not found.');
  return pdfResponse(generated.bytes, `${row.title ?? 'form'}.pdf`, 'inline');
});

pub.post('/f/:publicId/close', async (c) => {
  const row = await dbFirst<any>(c.env, `SELECT id, user_id FROM forms WHERE public_id = ? LIMIT 1`, [c.req.param('publicId')]);
  if (!row) return jsonError(c, 404, 'not_found', 'Form not found.');
  const body = await c.req.json().catch(() => ({}));
  const closed = await closeVisit(c.env, {
    userId: row.user_id,
    documentType: 'form',
    documentId: row.id,
    visitId: body.visit_id ?? null,
    seconds: Number(body.time_spent_seconds ?? 0),
  });
  return c.json({ success: true, closed });
});

// ---------------------------------------------------------------------------
// Retention / owner delivery links
// ---------------------------------------------------------------------------

pub.get('/d/:type/:id/download', async (c) => {
  const type = c.req.param('type');
  const allowed: DocType[] = ['proposal', 'contract', 'invoice', 'form'];
  if (!allowed.includes(type as DocType)) return jsonError(c, 400, 'invalid_payload', 'Unknown document type.');
  const documentId = c.req.param('id');
  const token = c.req.query('token') ?? '';
  const verification = await verifyDocumentLink(c.env, token, {
    purpose: 'retention_copy',
    documentType: type,
    documentId,
  });
  if (!verification.ok) {
    return jsonError(c, 403, 'invalid_token', `This link is ${verification.reason === 'expired' ? 'expired' : 'not valid'}.`);
  }
  const generated = await buildDocumentPdf(c.env, type as DocType, documentId);
  if (!generated) return jsonError(c, 410, 'gone', 'This document no longer exists.');
  return pdfResponse(generated.bytes, `${type}-${documentId}.pdf`, 'attachment');
});

export default pub;
