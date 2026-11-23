import { CONTRACT_STATUS, type ContractStatus } from '../config/constants';

/**
 * Pure contract lifecycle rules. Every route calls these before writing, so
 * the business rule "a freelancer must sign before publishing" cannot be
 * bypassed by calling the API directly instead of the UI.
 */

export type SignerRole = 'freelancer' | 'client';

export interface SigningSnapshot {
  status: string;
  versionId: string | null;
  versionLocked: boolean;
  versionStatus: string | null;
  published: boolean;
  hasFreelancerSignature: boolean;
  hasClientSignature: boolean;
  contentHashMatches: boolean;
  declined: boolean;
  voided: boolean;
}

export type SigningErrorCode =
  | 'not_found'
  | 'version_missing'
  | 'version_locked'
  | 'freelancer_signature_required'
  | 'already_signed'
  | 'not_published'
  | 'not_awaiting_client'
  | 'contract_closed'
  | 'stale_version'
  | 'consent_required'
  | 'invalid_signature'
  | 'forbidden';

export class SigningError extends Error {
  code: SigningErrorCode;
  status: 400 | 403 | 404 | 409;
  constructor(code: SigningErrorCode, message: string, status: 400 | 403 | 404 | 409 = 409) {
    super(message);
    this.name = 'SigningError';
    this.code = code;
    this.status = status;
  }
}

export type SigningState =
  | 'draft'
  | 'awaiting_publish'
  | 'awaiting_client_signature'
  | 'fully_signed'
  | 'declined'
  | 'voided';

/** Derives the state exposed to clients from persisted facts. */
export function deriveSigningState(snapshot: SigningSnapshot): SigningState {
  if (snapshot.voided || snapshot.status === CONTRACT_STATUS.VOIDED) return 'voided';
  if (snapshot.declined || snapshot.status === CONTRACT_STATUS.DECLINED) return 'declined';
  if (snapshot.hasFreelancerSignature && snapshot.hasClientSignature) return 'fully_signed';
  if (snapshot.status === CONTRACT_STATUS.FULLY_SIGNED) return 'fully_signed';
  if (snapshot.published || snapshot.status === CONTRACT_STATUS.AWAITING_CLIENT_SIGNATURE) {
    if (snapshot.hasFreelancerSignature) return 'awaiting_client_signature';
    return 'draft';
  }
  if (snapshot.hasFreelancerSignature) return 'awaiting_publish';
  return 'draft';
}

function assertOpen(snapshot: SigningSnapshot): void {
  if (snapshot.voided || snapshot.status === CONTRACT_STATUS.VOIDED) {
    throw new SigningError('contract_closed', 'This contract has been voided.', 409);
  }
  if (snapshot.declined || snapshot.status === CONTRACT_STATUS.DECLINED) {
    throw new SigningError('contract_closed', 'This contract was declined. Create a new version to continue.', 409);
  }
}

/** Editing is only allowed while the current version carries no signature. */
export function assertCanEdit(snapshot: SigningSnapshot): void {
  assertOpen(snapshot);
  if (snapshot.hasFreelancerSignature || snapshot.hasClientSignature || snapshot.versionLocked) {
    throw new SigningError(
      'version_locked',
      'This version is locked because it has been signed. Create a new version to make changes.',
      409
    );
  }
  if (snapshot.status === CONTRACT_STATUS.FULLY_SIGNED) {
    throw new SigningError('contract_closed', 'A fully signed contract cannot be edited.', 409);
  }
}

export function assertCanFreelancerSign(snapshot: SigningSnapshot, expectedHash?: string | null): void {
  assertOpen(snapshot);
  if (!snapshot.versionId) {
    throw new SigningError('version_missing', 'The contract has no version to sign.', 409);
  }
  if (snapshot.hasClientSignature || snapshot.hasFreelancerSignature) {
    throw new SigningError('already_signed', 'This version already carries the freelancer signature.', 409);
  }
  if (snapshot.status === CONTRACT_STATUS.FULLY_SIGNED) {
    throw new SigningError('already_signed', 'This contract is already fully signed.', 409);
  }
  if (snapshot.versionStatus === 'superseded') {
    throw new SigningError('stale_version', 'This version was superseded by a newer version.', 409);
  }
  if (expectedHash && snapshot.versionId && !snapshot.contentHashMatches) {
    throw new SigningError('stale_version', 'The contract changed while you were signing. Reload and try again.', 409);
  }
}

export function assertCanPublish(snapshot: SigningSnapshot): void {
  assertOpen(snapshot);
  if (!snapshot.versionId) {
    throw new SigningError('version_missing', 'The contract has no version to publish.', 409);
  }
  if (!snapshot.hasFreelancerSignature) {
    throw new SigningError(
      'freelancer_signature_required',
      'Sign the contract yourself before publishing it to the client.',
      409
    );
  }
  if (snapshot.hasClientSignature) {
    // Publishing again is harmless; the link already works.
    return;
  }
  if (snapshot.contentHashMatches === false) {
    throw new SigningError('stale_version', 'The signed version no longer matches the contract content.', 409);
  }
}

export function assertCanClientSign(snapshot: SigningSnapshot, expectedHash?: string | null): void {
  assertOpen(snapshot);
  if (!snapshot.published) {
    throw new SigningError('not_published', 'This contract is not published yet.', 409);
  }
  if (!snapshot.hasFreelancerSignature) {
    throw new SigningError(
      'freelancer_signature_required',
      'The freelancer has not signed this contract yet.',
      409
    );
  }
  if (snapshot.hasClientSignature) {
    throw new SigningError('already_signed', 'This contract has already been signed by the client.', 409);
  }
  if (snapshot.status === CONTRACT_STATUS.FULLY_SIGNED) {
    throw new SigningError('already_signed', 'This contract is already fully signed.', 409);
  }
  if (snapshot.versionStatus === 'superseded') {
    throw new SigningError('stale_version', 'This version was superseded by a newer version.', 409);
  }
  if (expectedHash && !snapshot.contentHashMatches) {
    throw new SigningError('stale_version', 'The contract changed while you were signing. Reload and try again.', 409);
  }
}

/** Status written to `contracts.status` once the freelancer has signed. */
export function statusAfterFreelancerSignature(snapshot: SigningSnapshot): ContractStatus {
  return snapshot.published ? CONTRACT_STATUS.AWAITING_CLIENT_SIGNATURE : CONTRACT_STATUS.DRAFT;
}

/**
 * Contract rows keep two values: `status` stays inside the table's legacy
 * CHECK list, while `signing_status` carries the electronic-signature
 * lifecycle that the rest of the code derives state from.
 */
export function statusAfterPublish(): { status: string; signingStatus: ContractStatus } {
  return { status: 'published', signingStatus: CONTRACT_STATUS.AWAITING_CLIENT_SIGNATURE };
}

export function statusAfterClientSignature(): { status: string; signingStatus: ContractStatus } {
  return { status: 'approved', signingStatus: CONTRACT_STATUS.FULLY_SIGNED };
}

export function consentRequired(consent: unknown): void {
  if (consent !== true) {
    throw new SigningError(
      'consent_required',
      'Explicit consent to sign electronically is required.',
      400
    );
  }
}

/** Stable JSON serialisation for content hashing (sorted keys, no whitespace). */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return 'null';
}
