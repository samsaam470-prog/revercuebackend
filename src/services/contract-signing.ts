import { dbFirst, dbQuery, dbRun, dbRunResult } from '../utils/db';
import { generateId, generatePublicId } from '../utils/ids';
import { decodeDataUrl, sha256Hex } from '../utils/crypto';
import { fetchFromB2Bytes, putObject } from './storage';
import {
  SigningError,
  assertCanClientSign,
  assertCanEdit,
  assertCanFreelancerSign,
  assertCanPublish,
  canonicalize,
  consentRequired,
  deriveSigningState,
  statusAfterClientSignature,
  statusAfterPublish,
  type SigningSnapshot,
  type SigningState,
} from './contract-state';
import { buildSignedContractPdf, type SignatureEvidence } from './pdf-signed';
import { contractSections } from './pdf';
import { createDocumentLink, documentLinkUrl } from './document-links';
import { createNotification } from './notifications';
import { contractAwaitingSignatureEmail, contractFullySignedEmail } from './email-templates';
import { sendEmail } from './email';
import {
  CONTRACT_STATUS,
  SIGNATURE_MAX_BYTES,
  SIGNING_CONSENT_VERSION,
} from '../config/constants';
import type { Bindings } from '../types';

/**
 * Contract versioning, electronic signatures and signed-PDF generation.
 *
 * Immutability model: a version row is mutable only while it carries no
 * signature. The first signature sets `locked_at`; from then on any edit must
 * create a new version, and the old version keeps its own signatures, hash and
 * PDF forever.
 */

export interface ContractVersionRow {
  id: string;
  contract_id: string;
  user_id: string;
  version_number: number;
  title: string;
  content: string;
  content_hash: string;
  status: string;
  created_at: string;
  locked_at: string | null;
}

export interface ContractSignatureRow {
  id: string;
  contract_id: string;
  version_id: string;
  signer_role: 'freelancer' | 'client';
  signer_user_id: string | null;
  signer_name: string;
  signer_email: string | null;
  signature_key: string;
  signature_hash: string;
  consent_accepted: number;
  consent_version: string;
  signed_at: string;
  signer_ip: string | null;
  signer_user_agent: string | null;
}

function parseContent(raw: unknown): any {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

export function contentSnapshot(contract: any): { title: string; content: any; after_approval: string } {
  return {
    title: String(contract.title ?? ''),
    content: parseContent(contract.content),
    after_approval: String(contract.after_approval ?? 'pdf_only'),
  };
}

export async function hashContractSnapshot(contract: any): Promise<{
  snapshot: { title: string; content: any; after_approval: string };
  hash: string;
}> {
  const snapshot = contentSnapshot(contract);
  const hash = await sha256Hex(canonicalize(snapshot));
  return { snapshot, hash };
}

export async function getOwnedContract(
  env: Bindings,
  contractId: string,
  userId: string
): Promise<any> {
  const contract = await dbFirst(
    env,
    `SELECT * FROM contracts WHERE id = ? AND user_id = ? LIMIT 1`,
    [contractId, userId]
  );
  if (!contract) throw new SigningError('not_found', 'Contract not found.', 404);
  return contract;
}

export async function getContractByPublicId(env: Bindings, publicId: string): Promise<any> {
  const contract = await dbFirst(env, `SELECT * FROM contracts WHERE public_id = ? LIMIT 1`, [publicId]);
  if (!contract) throw new SigningError('not_found', 'Contract not found.', 404);
  return contract;
}

export async function getLatestVersion(
  env: Bindings,
  contractId: string
): Promise<ContractVersionRow | null> {
  return dbFirst<ContractVersionRow>(
    env,
    `SELECT * FROM contract_versions WHERE contract_id = ? ORDER BY version_number DESC LIMIT 1`,
    [contractId]
  );
}

export async function getVersion(env: Bindings, versionId: string): Promise<ContractVersionRow | null> {
  return dbFirst<ContractVersionRow>(env, `SELECT * FROM contract_versions WHERE id = ? LIMIT 1`, [versionId]);
}

export async function listSignatures(env: Bindings, versionId: string): Promise<ContractSignatureRow[]> {
  return dbQuery<ContractSignatureRow>(
    env,
    `SELECT * FROM contract_signatures WHERE version_id = ? ORDER BY signed_at ASC`,
    [versionId]
  );
}

/**
 * Backfills a version for contracts created before versioning existed, so the
 * signing flow works for in-flight documents without mutating old data.
 */
export async function ensureVersion(env: Bindings, contract: any): Promise<ContractVersionRow> {
  const existing = await getLatestVersion(env, contract.id);
  if (existing) return existing;
  const { snapshot, hash } = await hashContractSnapshot(contract);
  const id = generateId('cver');
  const now = new Date().toISOString();
  await dbRun(
    env,
    `INSERT INTO contract_versions (id, contract_id, user_id, version_number, title, content, content_hash, status, created_at, locked_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, 'draft', ?, NULL)`,
    [id, contract.id, contract.user_id, snapshot.title, JSON.stringify(snapshot), hash, now]
  );
  const created = await getVersion(env, id);
  if (!created) throw new SigningError('version_missing', 'Could not create the contract version.', 409);
  return created;
}

export interface SigningSummary {
  state: SigningState;
  version: {
    id: string;
    number: number;
    content_hash: string;
    created_at: string;
    locked_at: string | null;
    title: string;
    content: any;
  } | null;
  signatures: {
    role: 'freelancer' | 'client';
    name: string;
    email: string | null;
    signed_at: string;
    consent_version: string;
    signature_hash: string;
  }[];
  fully_signed_at: string | null;
  published_at: string | null;
  public_id: string | null;
  can_edit: boolean;
  can_freelancer_sign: boolean;
  can_publish: boolean;
  can_client_sign: boolean;
}

export function buildSnapshot(
  contract: any,
  version: ContractVersionRow | null,
  signatures: ContractSignatureRow[],
  contentHashMatches: boolean
): SigningSnapshot {
  return {
    status: String(contract.status ?? 'draft'),
    versionId: version?.id ?? null,
    versionLocked: Boolean(version?.locked_at),
    versionStatus: version?.status ?? null,
    published: Boolean(contract.published_at) || String(contract.status) === CONTRACT_STATUS.AWAITING_CLIENT_SIGNATURE,
    hasFreelancerSignature: signatures.some((s) => s.signer_role === 'freelancer'),
    hasClientSignature: signatures.some((s) => s.signer_role === 'client'),
    contentHashMatches,
    declined: String(contract.status) === CONTRACT_STATUS.DECLINED,
    voided: String(contract.status) === CONTRACT_STATUS.VOIDED,
  };
}

export async function readSigningSummary(env: Bindings, contract: any): Promise<SigningSummary> {
  const version = await ensureVersion(env, contract);
  const signatures = await listSignatures(env, version.id);
  const { hash } = await hashContractSnapshot(contract);
  const contentHashMatches = hash === version.content_hash;
  const snapshot = buildSnapshot(contract, version, signatures, contentHashMatches);
  const state = deriveSigningState(snapshot);

  return {
    state,
    version: version
      ? {
          id: version.id,
          number: Number(version.version_number),
          content_hash: version.content_hash,
          created_at: version.created_at,
          locked_at: version.locked_at,
          title: version.title,
          content: parseContent(version.content).content ?? {},
        }
      : null,
    signatures: signatures.map((signature) => ({
      role: signature.signer_role,
      name: signature.signer_name,
      email: signature.signer_email,
      signed_at: signature.signed_at,
      consent_version: signature.consent_version,
      signature_hash: signature.signature_hash,
    })),
    fully_signed_at:
      state === 'fully_signed'
        ? signatures.find((s) => s.signer_role === 'client')?.signed_at ?? contract.signed_at ?? null
        : null,
    published_at: contract.published_at ?? null,
    public_id: contract.public_id ?? null,
    can_edit: false,
    can_freelancer_sign: state === 'draft' && !snapshot.hasFreelancerSignature,
    can_publish: snapshot.hasFreelancerSignature && state !== 'fully_signed' && state !== 'voided',
    can_client_sign: state === 'awaiting_client_signature',
  };
}

export async function recordSigningEvent(
  env: Bindings,
  input: {
    contractId: string;
    versionId: string | null;
    signatureId?: string | null;
    eventType: string;
    actorRole: 'freelancer' | 'client' | 'system';
    actorId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    metadata?: unknown;
  }
): Promise<void> {
  await dbRun(
    env,
    `INSERT INTO contract_signing_events (id, contract_id, version_id, signature_id, event_type, actor_role, actor_id, ip_address, user_agent, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generateId('cevt'),
      input.contractId,
      input.versionId,
      input.signatureId ?? null,
      input.eventType,
      input.actorRole,
      input.actorId ?? null,
      input.ip ?? null,
      input.userAgent ?? null,
      JSON.stringify(input.metadata ?? {}).slice(0, 4000),
      new Date().toISOString(),
    ]
  ).catch((error) => console.error('SIGNING_EVENT_WRITE_FAILED', error));
}

/** Updates an unsigned version in place; refuses once it is locked. */
export async function syncVersionWithContract(env: Bindings, contract: any): Promise<void> {
  const version = await ensureVersion(env, contract);
  if (version.locked_at) return;
  const { snapshot, hash } = await hashContractSnapshot(contract);
  await dbRun(
    env,
    `UPDATE contract_versions SET title = ?, content = ?, content_hash = ? WHERE id = ? AND locked_at IS NULL`,
    [snapshot.title, JSON.stringify(snapshot), hash, version.id]
  );
}

export interface SignatureInput {
  signature: string;
  consent: boolean;
  name: string;
  email?: string | null;
  ip: string;
  userAgent: string;
  expectedVersionId?: string | null;
  expectedContentHash?: string | null;
}

export async function validateAndStoreSignature(
  env: Bindings,
  input: {
    contractId: string;
    versionId: string;
    role: 'freelancer' | 'client';
    signatureDataUrl: string;
  }
): Promise<{ key: string; hash: string; mime: string; bytes: Uint8Array }> {
  const decoded = decodeDataUrl(input.signatureDataUrl);
  if (!decoded) {
    throw new SigningError('invalid_signature', 'The signature image is not a valid image data URL.', 400);
  }
  if (!['image/png', 'image/jpeg'].includes(decoded.mime)) {
    throw new SigningError('invalid_signature', 'The signature must be a PNG or JPEG image.', 400);
  }
  if (decoded.bytes.byteLength === 0 || decoded.bytes.byteLength > SIGNATURE_MAX_BYTES) {
    throw new SigningError('invalid_signature', 'The signature image is empty or too large.', 400);
  }
  const isPng =
    decoded.bytes[0] === 0x89 && decoded.bytes[1] === 0x50 && decoded.bytes[2] === 0x4e && decoded.bytes[3] === 0x47;
  const isJpeg = decoded.bytes[0] === 0xff && decoded.bytes[1] === 0xd8;
  if ((decoded.mime === 'image/png' && !isPng) || (decoded.mime === 'image/jpeg' && !isJpeg)) {
    throw new SigningError('invalid_signature', 'The signature image content does not match its type.', 400);
  }

  const hash = await sha256Hex(decoded.bytes);
  const extension = decoded.mime === 'image/png' ? 'png' : 'jpg';
  const key = `private/signatures/${input.contractId}/${input.versionId}/${input.role}-${hash.slice(0, 16)}.${extension}`;
  const uploaded = await putObject(env, key, decoded.bytes, decoded.mime);
  if (!uploaded.ok) {
    throw new SigningError('invalid_signature', 'The signature could not be stored. Please try again.', 409);
  }
  return { key, hash, mime: decoded.mime, bytes: decoded.bytes };
}

async function insertSignature(
  env: Bindings,
  input: {
    contract: any;
    version: ContractVersionRow;
    role: 'freelancer' | 'client';
    signerName: string;
    signerEmail: string | null;
    signatureKey: string;
    signatureHash: string;
    ip: string;
    userAgent: string;
    contentHash: string;
  }
): Promise<{ id: string; signedAt: string; inserted: boolean }> {
  const id = generateId('sig');
  const signedAt = new Date().toISOString();
  const result = await dbRunResult(
    env,
    `INSERT OR IGNORE INTO contract_signatures
       (id, contract_id, version_id, signer_role, signer_user_id, signer_name, signer_email, signature_key, signature_hash, consent_accepted, consent_version, signed_at, signer_ip, signer_user_agent, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      id,
      input.contract.id,
      input.version.id,
      input.role,
      input.role === 'freelancer' ? input.contract.user_id : null,
      input.signerName,
      input.signerEmail,
      input.signatureKey,
      input.signatureHash,
      SIGNING_CONSENT_VERSION,
      signedAt,
      input.ip || null,
      input.userAgent || null,
      input.contentHash,
    ]
  );
  return { id, signedAt, inserted: result.changes > 0 };
}

// ---------------------------------------------------------------------------
// Freelancer signing
// ---------------------------------------------------------------------------

export async function signAsFreelancer(
  env: Bindings,
  contractId: string,
  userId: string,
  input: SignatureInput
): Promise<{ versionId: string; signedAt: string; state: SigningState; versionNumber: number }> {
  const contract = await getOwnedContract(env, contractId, userId);
  const version = await ensureVersion(env, contract);
  const signatures = await listSignatures(env, version.id);
  const { hash } = await hashContractSnapshot(contract);
  const contentHashMatches = hash === version.content_hash;

  if (input.expectedVersionId && input.expectedVersionId !== version.id) {
    throw new SigningError('stale_version', 'A newer contract version exists. Reload before signing.', 409);
  }

  const snapshot = buildSnapshot(contract, version, signatures, contentHashMatches);
  assertCanFreelancerSign(snapshot, input.expectedContentHash);

  consentRequired(input.consent);
  const name = String(input.name ?? '').trim();
  if (name.length < 2 || name.length > 200) {
    throw new SigningError('invalid_signature', 'A full name is required to sign.', 400);
  }

  const stored = await validateAndStoreSignature(env, {
    contractId: contract.id,
    versionId: version.id,
    role: 'freelancer',
    signatureDataUrl: input.signature,
  });

  const inserted = await insertSignature(env, {
    contract,
    version,
    role: 'freelancer',
    signerName: name,
    signerEmail: input.email ?? null,
    signatureKey: stored.key,
    signatureHash: stored.hash,
    ip: input.ip,
    userAgent: input.userAgent,
    contentHash: version.content_hash,
  });

  if (!inserted.inserted) {
    throw new SigningError('already_signed', 'This version is already signed by the freelancer.', 409);
  }

  const now = new Date().toISOString();
  await dbRun(env, `UPDATE contract_versions SET locked_at = ? WHERE id = ? AND locked_at IS NULL`, [
    now,
    version.id,
  ]);
  await dbRun(env, `UPDATE contracts SET updated_at = ? WHERE id = ?`, [now, contract.id]);

  await recordSigningEvent(env, {
    contractId: contract.id,
    versionId: version.id,
    signatureId: inserted.id,
    eventType: 'freelancer_signed',
    actorRole: 'freelancer',
    actorId: userId,
    ip: input.ip,
    userAgent: input.userAgent,
    metadata: { signature_hash: stored.hash, content_hash: version.content_hash, consent_version: SIGNING_CONSENT_VERSION },
  });

  const refreshed = buildSnapshot(contract, { ...version, locked_at: now }, [
    ...signatures,
    { signer_role: 'freelancer' } as ContractSignatureRow,
  ], true);

  return {
    versionId: version.id,
    signedAt: inserted.signedAt,
    state: deriveSigningState(refreshed),
    versionNumber: Number(version.version_number),
  };
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export async function publishSignedContract(
  env: Bindings,
  contractId: string,
  userId: string,
  context: { ip: string; userAgent: string }
): Promise<{ publicId: string; url: string; versionId: string }> {
  const contract = await getOwnedContract(env, contractId, userId);
  const version = await ensureVersion(env, contract);
  const signatures = await listSignatures(env, version.id);
  const { hash } = await hashContractSnapshot(contract);
  const snapshot = buildSnapshot(contract, version, signatures, hash === version.content_hash);

  assertCanPublish(snapshot);

  const publicId = contract.public_id ?? generatePublicId();
  const now = new Date().toISOString();
  await dbRun(
    env,
    `UPDATE contracts SET status = ?, public_id = COALESCE(public_id, ?), published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ? AND user_id = ?`,
    [statusAfterPublish(), publicId, now, now, contract.id, userId]
  );
  await dbRun(env, `UPDATE contract_versions SET status = 'awaiting_client' WHERE id = ? AND status = 'draft'`, [
    version.id,
  ]);

  await recordSigningEvent(env, {
    contractId: contract.id,
    versionId: version.id,
    eventType: 'published',
    actorRole: 'freelancer',
    actorId: userId,
    ip: context.ip,
    userAgent: context.userAgent,
    metadata: { public_id: publicId, content_hash: version.content_hash },
  });

  // Notify the client directly when Revercue has their email on file.
  const client = await dbFirst<{ name: string; email: string }>(
    env,
    `SELECT name, email FROM clients WHERE id = ? LIMIT 1`,
    [contract.client_id]
  ).catch(() => null);
  const appBase = (env.APP_URL || env.FRONTEND_ORIGIN || 'https://revercue.co.uk').replace(/\/$/, '');
  const signUrl = `${appBase}/c/${publicId}`;
  if (client?.email) {
    const rendered = contractAwaitingSignatureEmail({
      contractTitle: String(contract.title ?? 'Contract'),
      signerName: client.name || 'there',
      signUrl,
    });
    await sendEmail(env, {
      to: client.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      kind: 'contract_awaiting_signature',
      userId,
      documentType: 'contract',
      documentId: contract.id,
      idempotencyKey: `contract-awaiting:${contract.id}:${version.id}`,
      // The sign URL is permanent for this version, so a cron retry is safe.
      retryable: true,
    }).catch((error) => console.error('CONTRACT_INVITE_EMAIL_FAILED', error));
  }

  return { publicId, url: signUrl, versionId: version.id };
}

// ---------------------------------------------------------------------------
// Client signing
// ---------------------------------------------------------------------------

export interface ClientSignResult {
  status: 'fully_signed';
  signedAt: string;
  download: { token: string; url: string; expiresAt: string };
}

export async function signAsClient(
  env: Bindings,
  publicId: string,
  input: SignatureInput
): Promise<ClientSignResult> {
  const contract = await getContractByPublicId(env, publicId);
  if (contract.status === 'archived') {
    throw new SigningError('not_found', 'Contract not found.', 404);
  }
  const version = await ensureVersion(env, contract);
  const signatures = await listSignatures(env, version.id);
  const { hash } = await hashContractSnapshot(contract);
  const snapshot = buildSnapshot(contract, version, signatures, hash === version.content_hash);

  assertCanClientSign(snapshot, input.expectedContentHash);

  consentRequired(input.consent);
  const name = String(input.name ?? '').trim();
  if (name.length < 2 || name.length > 200) {
    throw new SigningError('invalid_signature', 'Please type your full name to sign.', 400);
  }

  const stored = await validateAndStoreSignature(env, {
    contractId: contract.id,
    versionId: version.id,
    role: 'client',
    signatureDataUrl: input.signature,
  });

  const inserted = await insertSignature(env, {
    contract,
    version,
    role: 'client',
    signerName: name,
    signerEmail: input.email ?? null,
    signatureKey: stored.key,
    signatureHash: stored.hash,
    ip: input.ip,
    userAgent: input.userAgent,
    contentHash: version.content_hash,
  });
  if (!inserted.inserted) {
    throw new SigningError('already_signed', 'This contract has already been signed.', 409);
  }

  const signedAt = inserted.signedAt;
  await dbRun(env, `UPDATE contracts SET status = ?, signed_at = ?, updated_at = ? WHERE id = ?`, [
    statusAfterClientSignature(),
    signedAt,
    signedAt,
    contract.id,
  ]);
  await dbRun(env, `UPDATE contract_versions SET status = 'signed', locked_at = COALESCE(locked_at, ?) WHERE id = ?`, [
    signedAt,
    version.id,
  ]);

  await recordSigningEvent(env, {
    contractId: contract.id,
    versionId: version.id,
    signatureId: inserted.id,
    eventType: 'client_signed',
    actorRole: 'client',
    actorId: null,
    ip: input.ip,
    userAgent: input.userAgent,
    metadata: { signature_hash: stored.hash, content_hash: version.content_hash, consent_version: SIGNING_CONSENT_VERSION },
  });

  const pdf = await ensureSignedPdf(env, contract.id).catch((error) => {
    console.error('SIGNED_PDF_FAILED', contract.id, error);
    return null;
  });

  const link = await createDocumentLink(env, {
    purpose: 'signed_pdf',
    documentType: 'contract',
    documentId: contract.id,
    versionId: version.id,
    audience: 'client',
  });

  await recordSigningEvent(env, {
    contractId: contract.id,
    versionId: version.id,
    eventType: 'contract_fully_signed',
    actorRole: 'system',
    metadata: { pdf_key: pdf?.key ?? null },
  });

  await createNotification(env, {
    userId: contract.user_id,
    eventType: 'contract_fully_signed',
    clientId: contract.client_id,
    documentId: contract.id,
    title: `${contract.title} is fully signed`,
    documentTitle: String(contract.title ?? ''),
    clientName: name,
    // The richer signed-PDF email below is the single email for this event.
    sendEmail: false,
  });

  if (pdf) {
    const ownerLink = await createDocumentLink(env, {
      purpose: 'signed_pdf',
      documentType: 'contract',
      documentId: contract.id,
      versionId: version.id,
      audience: 'freelancer',
    });
    const owner = await dbFirst<{ email: string }>(env, `SELECT email FROM users WHERE id = ? LIMIT 1`, [
      contract.user_id,
    ]).catch(() => null);
    if (owner?.email) {
      const rendered = contractFullySignedEmail({
        contractTitle: String(contract.title ?? 'Contract'),
        clientName: name,
        signedAt,
        pdfUrl: documentLinkUrl(env, `/api/public/contracts/${contract.id}/signed-pdf`, ownerLink.token),
      });
      await sendEmail(env, {
        to: owner.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        kind: 'contract_signed',
        userId: contract.user_id,
        documentType: 'contract',
        documentId: contract.id,
        idempotencyKey: `contract-signed:${contract.id}:${version.id}`,
        // Not cron-retryable: the signed-PDF link is valid for 15 minutes only.
        retryable: false,
      }).catch((error) => console.error('CONTRACT_SIGNED_EMAIL_FAILED', error));
    }
  }

  return {
    status: 'fully_signed',
    signedAt,
    download: {
      token: link.token,
      url: `/api/public/contracts/${contract.id}/signed-pdf?token=${encodeURIComponent(link.token)}`,
      expiresAt: link.expiresAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Signed PDF
// ---------------------------------------------------------------------------

export async function ensureSignedPdf(
  env: Bindings,
  contractId: string
): Promise<{ key: string; bytes: Uint8Array } | null> {
  const contract = await dbFirst(env, `SELECT * FROM contracts WHERE id = ? LIMIT 1`, [contractId]);
  if (!contract) return null;
  const version = await getLatestVersion(env, contractId);
  if (!version) return null;
  const signatures = await listSignatures(env, version.id);
  const freelancerSig = signatures.find((s) => s.signer_role === 'freelancer');
  const clientSig = signatures.find((s) => s.signer_role === 'client');
  if (!freelancerSig || !clientSig) return null;

  const existing = await dbFirst<{ key: string; sha256: string }>(
    env,
    `SELECT key, sha256 FROM signed_documents WHERE version_id = ? LIMIT 1`,
    [version.id]
  );
  if (existing) {
    const bytes = await fetchFromB2Bytes(env, existing.key);
    if (bytes) return { key: existing.key, bytes };
  }

  const snapshot = parseContent(version.content);
  const sections = contractSections({ content: JSON.stringify(snapshot.content ?? {}) });

  const evidenceFor = async (signature: ContractSignatureRow): Promise<SignatureEvidence> => {
    const bytes = await fetchFromB2Bytes(env, signature.signature_key);
    return {
      role: signature.signer_role,
      name: signature.signer_name,
      email: signature.signer_email,
      signedAt: signature.signed_at,
      ip: signature.signer_ip,
      userAgent: signature.signer_user_agent,
      consentVersion: signature.consent_version,
      signatureHash: signature.signature_hash,
      signatureBytes: bytes,
      signatureMime: signature.signature_key.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
    };
  };

  const bytes = await buildSignedContractPdf({
    contractId: contract.id,
    title: String(version.title ?? contract.title ?? 'Contract'),
    versionNumber: Number(version.version_number),
    versionHash: version.content_hash,
    versionCreatedAt: version.created_at,
    signedAt: clientSig.signed_at,
    sections,
    freelancer: await evidenceFor(freelancerSig),
    client: await evidenceFor(clientSig),
    appUrl: (env.APP_URL || env.FRONTEND_ORIGIN || '').replace(/\/$/, ''),
  });

  const hash = await sha256Hex(bytes);
  const key = `private/contracts/${contractId}/signed-v${version.version_number}-${hash.slice(0, 16)}.pdf`;
  const uploaded = await putObject(env, key, bytes, 'application/pdf');
  if (!uploaded.ok) {
    console.error('SIGNED_PDF_UPLOAD_FAILED', contractId, uploaded.status);
  }

  await dbRun(
    env,
    `INSERT OR REPLACE INTO signed_documents (id, document_type, document_id, version_id, key, sha256, size_bytes, created_at)
     VALUES (?, 'contract', ?, ?, ?, ?, ?, ?)`,
    [generateId('sdoc'), contractId, version.id, key, hash, bytes.byteLength, new Date().toISOString()]
  ).catch((error) => console.error('SIGNED_DOCUMENT_WRITE_FAILED', error));

  return { key, bytes };
}

export async function getSignedPdfForOwner(
  env: Bindings,
  contractId: string,
  userId: string
): Promise<{ bytes: Uint8Array; filename: string } | null> {
  const contract = await dbFirst<{ id: string; title: string; status: string }>(
    env,
    `SELECT id, title, status FROM contracts WHERE id = ? AND user_id = ? LIMIT 1`,
    [contractId, userId]
  );
  if (!contract) return null;
  if (contract.status !== CONTRACT_STATUS.FULLY_SIGNED) {
    throw new SigningError('freelancer_signature_required', 'This contract is not fully signed yet.', 409);
  }
  const pdf = await ensureSignedPdf(env, contractId);
  if (!pdf) return null;
  return { bytes: pdf.bytes, filename: `contract-${contractId}-signed.pdf` };
}

// ---------------------------------------------------------------------------
// New versions
// ---------------------------------------------------------------------------

export async function createNewVersion(
  env: Bindings,
  contractId: string,
  userId: string,
  context: { ip: string; userAgent: string }
): Promise<{ versionId: string; versionNumber: number }> {
  const contract = await getOwnedContract(env, contractId, userId);
  const latest = await ensureVersion(env, contract);
  const existing = await listSignatures(env, latest.id);

  if (existing.length === 0) {
    // Nothing was signed yet: the caller can simply edit the draft.
    throw new SigningError(
      'version_locked',
      'The current version has no signature yet. Edit the draft instead of creating a new version.',
      409
    );
  }

  const { snapshot, hash } = await hashContractSnapshot(contract);
  const id = generateId('cver');
  const now = new Date().toISOString();
  const nextNumber = Number(latest.version_number) + 1;

  if (latest.status !== 'signed') {
    await dbRun(env, `UPDATE contract_versions SET status = 'superseded' WHERE id = ?`, [latest.id]);
  }

  await dbRun(
    env,
    `INSERT INTO contract_versions (id, contract_id, user_id, version_number, title, content, content_hash, status, created_at, locked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, NULL)`,
    [id, contract.id, userId, nextNumber, snapshot.title, JSON.stringify(snapshot), hash, now]
  );
  await dbRun(
    env,
    `UPDATE contracts SET status = 'draft', published_at = NULL, signed_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?`,
    [now, contract.id, userId]
  );

  await recordSigningEvent(env, {
    contractId: contract.id,
    versionId: id,
    eventType: 'version_created',
    actorRole: 'freelancer',
    actorId: userId,
    ip: context.ip,
    userAgent: context.userAgent,
    metadata: { previous_version_id: latest.id, version_number: nextNumber, content_hash: hash },
  });

  return { versionId: id, versionNumber: nextNumber };
}

export async function assertContractEditable(env: Bindings, contract: any): Promise<void> {
  const version = await ensureVersion(env, contract);
  const signatures = await listSignatures(env, version.id);
  const { hash } = await hashContractSnapshot(contract);
  assertCanEdit(buildSnapshot(contract, version, signatures, hash === version.content_hash));
}
