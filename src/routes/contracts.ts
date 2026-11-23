import { Hono } from 'hono';
import { dbFirst, dbQuery, dbRun } from '../utils/db';
import { generateId, generatePublicId } from '../utils/ids';
import { userAuthMiddleware, getAuth } from '../middleware/user-auth';
import { createNotification } from '../services/notifications';
import { parsePagination, paginated, statusFilter } from '../utils/pagination';
import { clientIp, clientUserAgent } from '../utils/http';
import { jsonError, handleRouteError } from '../utils/api-errors';
import { pdfResponse } from '../services/pdf-binary';
import { buildDocumentPdf } from '../services/pdf';
import { resolveClientId } from '../services/clients';
import { archiveDocument, unarchiveDocument } from '../services/archive';
import {
  assertContractEditable,
  buildSnapshot,
  createNewVersion,
  ensureVersion,
  getLatestVersion,
  getOwnedContract,
  getSignedPdfForOwner,
  hashContractSnapshot,
  listSignatures,
  publishSignedContract,
  readSigningSummary,
  recordSigningEvent,
  signAsFreelancer,
  syncVersionWithContract,
} from '../services/contract-signing';
import { createDocumentLink } from '../services/document-links';
import { getTrackingSummary } from '../services/tracking';
import { activeDocumentLimitBody, checkActiveDocumentLimit } from '../services/plan-limits';
import { SigningError } from '../services/contract-state';
import type { Bindings } from '../types';

const contracts = new Hono<{ Bindings: Bindings }>();
contracts.use('*', userAuthMiddleware);

const LIST_STATUSES = [
  'draft',
  'published',
  'awaiting_client_signature',
  'awaiting_freelancer_signature',
  'fully_signed',
  'declined',
  'archived',
  'voided',
  'approved',
] as const;

function parseJson(value: unknown): any {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

/** Accepts both the builder's `content` object and flat draft fields. */
function buildContent(body: any, existing?: any): any {
  const base = existing ? parseJson(existing) : {};
  // A builder save carries the page, the brief and the settings together; keep
  // the stored clauses the save does not mention instead of dropping them.
  if (body.content && typeof body.content === 'object') return { ...base, ...body.content };
  const merged = { ...base };
  for (const key of ['scope', 'payment_terms', 'timeline', 'revisions', 'cancellation', 'confidentiality', 'terms', 'currency', 'sections', 'blocks']) {
    if (body[key] !== undefined) merged[key] = body[key];
  }
  return merged;
}

contracts.get('/', async (c) => {
  const auth = getAuth(c);
  const pagination = parsePagination(c);
  const status = statusFilter(c.req.query('status'), LIST_STATUSES);

  let where = `user_id = ?`;
  const args: any[] = [auth.userId];
  if (status) {
    where += ` AND COALESCE(signing_status, status) = ?`;
    args.push(status);
  } else if ((c.req.query('filter') ?? '') === 'active') {
    where += ` AND status != 'archived'`;
  }

  const totalRow = await dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM contracts WHERE ${where}`, args);
  const rows = await dbQuery(
    c.env,
    `SELECT id, title, client_id, COALESCE(signing_status, status) AS status, public_id, published_at, signed_at, created_at, updated_at
     FROM contracts WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...args, pagination.limit, pagination.offset]
  );
  return c.json(paginated(rows, Number(totalRow?.c ?? 0), pagination));
});

contracts.post('/draft', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  if (!body.title) return jsonError(c, 400, 'invalid_payload', 'A contract title is required.');

  const clientId = await resolveClientId(c.env, auth.userId, {
    client_id: body.client_id,
    client_name: body.client_name,
    client_email: body.client_email,
    source: 'auto_contract',
  });
  if (!clientId) {
    return jsonError(c, 400, 'invalid_payload', 'Provide a client_id, or a client_name and client_email.');
  }

  const id = generateId('con');
  const now = new Date().toISOString();
  const content = buildContent(body);
  await dbRun(
    c.env,
    `INSERT INTO contracts (id, user_id, client_id, linked_proposal_id, title, content, after_approval, status, draft_created_at, draft_retention_days, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, 30, ?, ?)`,
    [
      id,
      auth.userId,
      clientId,
      body.linked_proposal_id ?? null,
      String(body.title).slice(0, 300),
      JSON.stringify(content),
      body.after_approval ?? 'pdf_only',
      now,
      now,
      now,
    ]
  );

  const contract = await dbFirst<any>(c.env, `SELECT * FROM contracts WHERE id = ? AND user_id = ?`, [id, auth.userId]);
  if (contract) await ensureVersion(c.env, contract);

  return c.json({ success: true, id, status: 'draft', client_id: clientId }, 201);
});

contracts.get('/:id', async (c) => {
  const auth = getAuth(c);
  const contract = await dbFirst<any>(
    c.env,
    `SELECT ct.*, cl.name AS client_name, cl.email AS client_email, cl.phone AS client_phone,
            cl.industry AS industry, cl.website_url AS client_website
     FROM contracts ct
     LEFT JOIN clients cl ON cl.id = ct.client_id AND cl.user_id = ct.user_id
     WHERE ct.id = ? AND ct.user_id = ?`,
    [c.req.param('id'), auth.userId]
  );
  if (!contract) return jsonError(c, 404, 'not_found', 'Contract not found.');

  const content = parseJson(contract.content);
  const brief = Object.fromEntries(
    Object.entries({
      scope: content.scope ?? undefined,
      payment_terms: content.payment_terms ?? undefined,
      timeline: content.timeline ?? undefined,
      revisions: content.revisions ?? undefined,
      cancellation: content.cancellation ?? undefined,
      currency: content.currency ?? undefined,
      sections: content.sections ?? undefined,
      drafted: content.drafted === true,
    }).filter(([, value]) => value !== undefined)
  );

  const [signing, tracking] = await Promise.all([
    readSigningSummary(c.env, contract).catch((error) => {
      console.error('CONTRACT_SIGNING_SUMMARY_FAILED', contract.id, error);
      return null;
    }),
    getTrackingSummary(c.env, 'contract', contract.id),
  ]);

  return c.json({
    contract: {
      ...contract,
      ...brief,
      content: { ...content, blocks: Array.isArray(content.blocks) ? content.blocks : [] },
      signing,
      tracking,
    },
  });
});

contracts.patch('/:id', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  let contract: any;
  try {
    contract = await getOwnedContract(c.env, c.req.param('id'), auth.userId);
    await assertContractEditable(c.env, contract);
  } catch (error) {
    const handled = handleRouteError(c, error);
    if (handled) {
      if (error instanceof SigningError && error.code === 'version_locked') {
        const latest = await getLatestVersion(c.env, c.req.param('id'));
        return jsonError(c, 409, 'version_locked', error.message, {
          requires_new_version: true,
          version_id: latest?.id ?? null,
          version_number: latest ? Number(latest.version_number) : null,
        });
      }
      return handled;
    }
    throw error;
  }

  const content = buildContent(body, contract.content);
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `UPDATE contracts SET title = COALESCE(?, title), content = ?, after_approval = COALESCE(?, after_approval), updated_at = ? WHERE id = ? AND user_id = ?`,
    [body.title ?? null, JSON.stringify(content), body.after_approval ?? null, now, contract.id, auth.userId]
  );

  const updated = await dbFirst<any>(c.env, `SELECT * FROM contracts WHERE id = ? AND user_id = ?`, [
    contract.id,
    auth.userId,
  ]);
  if (updated) await syncVersionWithContract(c.env, updated);

  return c.json({ success: true, updated_at: now });
});

contracts.post('/:id/sign', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await signAsFreelancer(c.env, c.req.param('id'), auth.userId, {
      signature: String(body.signature ?? ''),
      consent: body.consent === true,
      name: String(body.name ?? ''),
      email: auth.email,
      ip: clientIp(c),
      userAgent: clientUserAgent(c),
      expectedVersionId: body.expected_version_id ? String(body.expected_version_id) : null,
      expectedContentHash: body.expected_content_hash ? String(body.expected_content_hash) : null,
    });
    return c.json({ success: true, ...result });
  } catch (error) {
    const handled = handleRouteError(c, error);
    if (handled) return handled;
    console.error('FREELANCER_SIGN_FAILED', error);
    return jsonError(c, 500, 'sign_failed', 'The signature could not be recorded.');
  }
});

contracts.post('/:id/publish', async (c) => {
  const auth = getAuth(c);
  try {
    const row = await dbFirst<{ id: string; status: string; published_at: string | null }>(
      c.env,
      `SELECT id, status, published_at FROM contracts WHERE id = ? AND user_id = ?`,
      [c.req.param('id'), auth.userId]
    );
    if (!row) return jsonError(c, 404, 'not_found', 'Contract not found.');
    const active = await checkActiveDocumentLimit(c.env, auth.userId, Boolean(row.published_at));
    if (!active.allowed) return c.json(activeDocumentLimitBody(active), 403);

    const result = await publishSignedContract(c.env, c.req.param('id'), auth.userId, {
      ip: clientIp(c),
      userAgent: clientUserAgent(c),
    });
    await createNotification(c.env, {
      userId: auth.userId,
      eventType: 'document_created',
      documentId: c.req.param('id'),
      title: 'Contract published to the client',
      documentTitle: 'Contract',
    });
    return c.json({ success: true, public_id: result.publicId, url: result.url });
  } catch (error) {
    const handled = handleRouteError(c, error);
    if (handled) return handled;
    console.error('CONTRACT_PUBLISH_FAILED', error);
    return jsonError(c, 500, 'publish_failed', 'The contract could not be published.');
  }
});

contracts.get('/:id/versions', async (c) => {
  const auth = getAuth(c);
  const contract = await getOwnedContract(c.env, c.req.param('id'), auth.userId).catch(() => null);
  if (!contract) return jsonError(c, 404, 'not_found', 'Contract not found.');
  const versions = await dbQuery(
    c.env,
    `SELECT v.id, v.version_number, v.content_hash, v.status, v.created_at, v.locked_at,
            (SELECT COUNT(*) FROM contract_signatures s WHERE s.version_id = v.id) AS signature_count
     FROM contract_versions v WHERE v.contract_id = ? ORDER BY v.version_number DESC`,
    [contract.id]
  );
  return c.json({ data: versions });
});

contracts.post('/:id/versions', async (c) => {
  const auth = getAuth(c);
  try {
    const result = await createNewVersion(c.env, c.req.param('id'), auth.userId, {
      ip: clientIp(c),
      userAgent: clientUserAgent(c),
    });
    return c.json({ success: true, ...result }, 201);
  } catch (error) {
    const handled = handleRouteError(c, error);
    if (handled) return handled;
    console.error('CONTRACT_NEW_VERSION_FAILED', error);
    return jsonError(c, 500, 'version_failed', 'A new version could not be created.');
  }
});

contracts.get('/:id/events', async (c) => {
  const auth = getAuth(c);
  const contract = await getOwnedContract(c.env, c.req.param('id'), auth.userId).catch(() => null);
  if (!contract) return jsonError(c, 404, 'not_found', 'Contract not found.');
  const events = await dbQuery(
    c.env,
    `SELECT id, version_id, event_type, actor_role, ip_address, user_agent, metadata, created_at
     FROM contract_signing_events WHERE contract_id = ? ORDER BY created_at ASC LIMIT 200`,
    [contract.id]
  );
  return c.json({ data: events });
});

contracts.post('/:id/duplicate', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT * FROM contracts WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Contract not found.');
  const body = await c.req.json().catch(() => ({}));
  const clientId = body.client_id
    ? await resolveClientId(c.env, auth.userId, { client_id: body.client_id })
    : row.client_id;
  const id = generateId('con');
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `INSERT INTO contracts (id, user_id, client_id, linked_proposal_id, title, content, after_approval, status, draft_created_at, draft_retention_days, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, 30, ?, ?)`,
    [
      id,
      auth.userId,
      clientId,
      null,
      `${row.title} (copy)`,
      row.content,
      row.after_approval ?? 'pdf_only',
      now,
      now,
      now,
    ]
  );
  const created = await dbFirst<any>(c.env, `SELECT * FROM contracts WHERE id = ?`, [id]);
  if (created) await ensureVersion(c.env, created);
  return c.json({ success: true, id, status: 'draft' }, 201);
});

contracts.post('/:id/archive', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT id, status, signing_status FROM contracts WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Contract not found.');
  if ((row.signing_status ?? row.status) === 'fully_signed') {
    return jsonError(c, 409, 'contract_signed', 'A fully signed contract cannot be archived; export it instead.');
  }
  try {
    const result = await archiveDocument(c.env, 'contract', row.id, auth.userId, auth.plan, row.status);
    return c.json({ success: true, status: 'archived', ...result });
  } catch (error: any) {
    if (error?.message === 'archive_limit_reached') {
      return jsonError(c, 403, 'archive_limit_reached', 'You reached the archive limit for your plan.');
    }
    console.error('CONTRACT_ARCHIVE_FAILED', error);
    return jsonError(c, 500, 'archive_failed', 'The contract could not be archived.');
  }
});

contracts.post('/:id/unarchive', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT id FROM contracts WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Contract not found.');
  const result = await unarchiveDocument(c.env, 'contract', row.id, auth.userId);
  return c.json({ success: true, ...result });
});

contracts.post('/:id/share', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  const row = await dbFirst<any>(c.env, `SELECT id, client_id FROM contracts WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Contract not found.');
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `INSERT INTO communication_log (id, user_id, client_id, entry_type, channel, linked_document_type, linked_document_id, created_at)
     VALUES (?, ?, ?, 'document_shared', ?, 'contract', ?, ?)`,
    [generateId('log'), auth.userId, row.client_id, String(body.channel ?? 'other').slice(0, 40), row.id, now]
  );
  if (row.client_id) {
    await dbRun(c.env, `UPDATE clients SET last_message_at = ? WHERE id = ? AND user_id = ?`, [
      now,
      row.client_id,
      auth.userId,
    ]);
  }
  return c.json({ success: true });
});

contracts.get('/:id/pdf', async (c) => {
  const auth = getAuth(c);
  const contract = await dbFirst<any>(c.env, `SELECT * FROM contracts WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!contract) return jsonError(c, 404, 'not_found', 'Contract not found.');

  if ((contract.signing_status ?? contract.status) === 'fully_signed') {
    try {
      const pdf = await getSignedPdfForOwner(c.env, contract.id, auth.userId);
      if (pdf) return pdfResponse(pdf.bytes, pdf.filename, 'attachment');
    } catch (error) {
      const handled = handleRouteError(c, error);
      if (handled) return handled;
      console.error('SIGNED_PDF_OWNER_FAILED', error);
    }
  }

  const generated = await buildDocumentPdf(c.env, 'contract', contract.id);
  if (!generated) return jsonError(c, 404, 'not_found', 'Contract not found.');
  return pdfResponse(generated.bytes, `contract-${contract.id}.pdf`, 'attachment');
});

contracts.get('/:id/signed-pdf-link', async (c) => {
  const auth = getAuth(c);
  const contract = await dbFirst<any>(c.env, `SELECT id, status, signing_status FROM contracts WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!contract) return jsonError(c, 404, 'not_found', 'Contract not found.');
  if ((contract.signing_status ?? contract.status) !== 'fully_signed') {
    return jsonError(c, 409, 'not_signed', 'The contract is not fully signed yet.');
  }
  const version = await getLatestVersion(c.env, contract.id);
  try {
    const link = await createDocumentLink(c.env, {
      purpose: 'signed_pdf',
      documentType: 'contract',
      documentId: contract.id,
      versionId: version?.id,
      audience: 'freelancer',
    });
    return c.json({
      success: true,
      token: link.token,
      expires_at: link.expiresAt,
      url: `/api/public/contracts/${contract.id}/signed-pdf?token=${encodeURIComponent(link.token)}`,
    });
  } catch (error) {
    const handled = handleRouteError(c, error);
    if (handled) return handled;
    throw error;
  }
});

contracts.get('/:id/tracking', async (c) => {
  const auth = getAuth(c);
  const contract = await dbFirst<any>(c.env, `SELECT id FROM contracts WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!contract) return jsonError(c, 404, 'not_found', 'Contract not found.');
  const summary = await getTrackingSummary(c.env, 'contract', contract.id);
  return c.json(summary);
});

contracts.delete('/:id', async (c) => {
  const auth = getAuth(c);
  const contract = await dbFirst<any>(c.env, `SELECT id, status, signing_status FROM contracts WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!contract) return jsonError(c, 404, 'not_found', 'Contract not found.');
  if ((contract.signing_status ?? contract.status) === 'fully_signed') {
    return jsonError(
      c,
      409,
      'contract_signed',
      'A fully signed contract is a legal record and cannot be deleted. Archive or export it instead.'
    );
  }
  await dbRun(c.env, `DELETE FROM contract_signatures WHERE contract_id = ?`, [contract.id]);
  await dbRun(c.env, `DELETE FROM contract_versions WHERE contract_id = ?`, [contract.id]);
  await dbRun(c.env, `DELETE FROM contract_signing_events WHERE contract_id = ?`, [contract.id]);
  await dbRun(c.env, `DELETE FROM signed_documents WHERE document_id = ? AND document_type = 'contract'`, [contract.id]);
  await dbRun(c.env, `DELETE FROM contracts WHERE id = ? AND user_id = ?`, [contract.id, auth.userId]);
  return c.json({ success: true });
});

export default contracts;
