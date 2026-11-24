import { describe, expect, it } from 'vitest';
import {
  assertCanClientSign,
  assertCanEdit,
  assertCanFreelancerSign,
  assertCanPublish,
  canonicalize,
  consentRequired,
  deriveSigningState,
  SigningError,
  statusAfterClientSignature,
  statusAfterFreelancerSignature,
  type SigningSnapshot,
} from '../src/services/contract-state';

function snapshot(overrides: Partial<SigningSnapshot> = {}): SigningSnapshot {
  return {
    status: 'draft',
    versionId: 'v1',
    versionLocked: false,
    versionStatus: 'draft',
    published: false,
    hasFreelancerSignature: false,
    hasClientSignature: false,
    contentHashMatches: true,
    declined: false,
    voided: false,
    ...overrides,
  };
}

function expectCode(fn: () => void, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SigningError);
    expect((error as SigningError).code).toBe(code);
    return;
  }
  throw new Error(`Expected SigningError ${code}, but nothing was thrown`);
}

describe('contract lifecycle rules', () => {
  it('refuses to publish a contract the freelancer has not signed', () => {
    expectCode(() => assertCanPublish(snapshot()), 'freelancer_signature_required');
  });

  it('allows publishing once the freelancer has signed', () => {
    expect(() => assertCanPublish(snapshot({ hasFreelancerSignature: true, versionLocked: true }))).not.toThrow();
  });

  it('refuses a second freelancer signature', () => {
    expectCode(() => assertCanFreelancerSign(snapshot({ hasFreelancerSignature: true })), 'already_signed');
  });

  it('refuses a signature on an outdated version', () => {
    expectCode(() => assertCanFreelancerSign(snapshot({ contentHashMatches: false }), 'hash-1'), 'stale_version');
  });

  it('requires a published contract with a freelancer signature before the client may sign', () => {
    expectCode(() => assertCanClientSign(snapshot({ hasFreelancerSignature: true })), 'not_published');
    expectCode(() => assertCanClientSign(snapshot({ published: true })), 'freelancer_signature_required');
    expect(() => assertCanClientSign(snapshot({ published: true, hasFreelancerSignature: true }))).not.toThrow();
  });

  it('prevents duplicate client signatures and rejected replays', () => {
    expectCode(
      () => assertCanClientSign(snapshot({ published: true, hasFreelancerSignature: true, hasClientSignature: true })),
      'already_signed'
    );
  });

  it('locks a signed version against edits', () => {
    expectCode(() => assertCanEdit(snapshot({ versionLocked: true })), 'version_locked');
    expectCode(() => assertCanEdit(snapshot({ hasFreelancerSignature: true })), 'version_locked');
    expect(() => assertCanEdit(snapshot())).not.toThrow();
  });

  it('treats voided and declined contracts as closed', () => {
    expectCode(() => assertCanEdit(snapshot({ voided: true })), 'contract_closed');
    expectCode(() => assertCanEdit(snapshot({ declined: true })), 'contract_closed');
  });

  it('derives the full state sequence Draft → signed → published → signed', () => {
    expect(deriveSigningState(snapshot())).toBe('draft');
    expect(deriveSigningState(snapshot({ hasFreelancerSignature: true }))).toBe('awaiting_publish');
    expect(
      deriveSigningState(snapshot({ hasFreelancerSignature: true, published: true, status: 'awaiting_client_signature' }))
    ).toBe('awaiting_client_signature');
    expect(
      deriveSigningState(
        snapshot({
          hasFreelancerSignature: true,
          hasClientSignature: true,
          published: true,
          status: 'fully_signed',
        })
      )
    ).toBe('fully_signed');
  });

  it('writes the expected contract statuses', () => {
    expect(statusAfterFreelancerSignature(snapshot({ published: false }))).toBe('draft');
    expect(statusAfterFreelancerSignature(snapshot({ published: true }))).toBe('awaiting_client_signature');
    expect(statusAfterClientSignature()).toEqual({ status: 'approved', signingStatus: 'fully_signed' });
  });

  it('requires explicit electronic-signature consent', () => {
    expectCode(() => consentRequired(undefined), 'consent_required');
    expectCode(() => consentRequired('true'), 'consent_required');
    expect(() => consentRequired(true)).not.toThrow();
  });

  it('canonicalises content so the hash is order-independent', () => {
    const a = canonicalize({ b: 2, a: [1, { d: 4, c: 3 }] });
    const b = canonicalize({ a: [1, { c: 3, d: 4 }], b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":[1,{"c":3,"d":4}],"b":2}');
  });
});
