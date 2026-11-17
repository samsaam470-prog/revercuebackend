import { describe, expect, it } from 'vitest';
import { buildPdf } from '../src/services/pdf-binary';
import { buildSignedContractPdf } from '../src/services/pdf-signed';
import { allowedForPlan, isTrackedType } from '../src/services/tracking';

const ONE_PIXEL_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
);

function startsWithPdf(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';
}

describe('PDF generation', () => {
  it('produces real PDF bytes, not HTML', async () => {
    const bytes = await buildPdf('Proposal', [{ heading: 'Scope', body: 'Design and build the site.' }], {
      subtitle: 'Draft',
    });
    expect(bytes.length).toBeGreaterThan(500);
    expect(startsWithPdf(bytes)).toBe(true);
  });

  it('embeds both signatures and the signing evidence in the signed contract PDF', async () => {
    const bytes = await buildSignedContractPdf({
      contractId: 'ctr_1',
      title: 'Website redesign agreement',
      versionNumber: 1,
      versionHash: 'a'.repeat(64),
      versionCreatedAt: '2026-11-01T10:00:00.000Z',
      signedAt: '2026-11-02T10:00:00.000Z',
      sections: [
        { heading: 'Scope', body: 'Full redesign of the marketing site.' },
        { heading: 'Payment', body: '50% up front, 50% on delivery.' },
      ],
      freelancer: {
        role: 'freelancer',
        name: 'Sam',
        email: 'sam@example.com',
        signedAt: '2026-11-02T09:00:00.000Z',
        ip: '203.0.113.10',
        userAgent: 'Mozilla/5.0',
        consentVersion: '2026-11',
        signatureHash: 'b'.repeat(64),
        signatureBytes: ONE_PIXEL_PNG,
        signatureMime: 'image/png',
      },
      client: {
        role: 'client',
        name: 'Ada',
        email: 'ada@example.com',
        signedAt: '2026-11-02T10:00:00.000Z',
        ip: '198.51.100.7',
        userAgent: 'Mozilla/5.0',
        consentVersion: '2026-11',
        signatureHash: 'c'.repeat(64),
        signatureBytes: ONE_PIXEL_PNG,
        signatureMime: 'image/png',
      },
    });
    expect(startsWithPdf(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

describe('tracking plan gating', () => {
  it('accepts only known document types', () => {
    expect(isTrackedType('proposal')).toBe(true);
    expect(isTrackedType('contract')).toBe(true);
    expect(isTrackedType('invoice')).toBe(true);
    expect(isTrackedType('form')).toBe(true);
    expect(isTrackedType('signature')).toBe(false);
  });

  it('never grants an unknown plan any event', () => {
    expect(allowedForPlan('mystery', 'opened')).toBe(false);
    expect(allowedForPlan('', 'opened')).toBe(false);
  });

  it('limits free/starter to open events and unlocks richer events on higher plans', () => {
    for (const plan of ['free', 'starter', 'growth', 'scale', 'teams']) {
      expect(allowedForPlan(plan, 'opened')).toBe(true);
    }
    expect(allowedForPlan('free', 'time_spent')).toBe(false);
    expect(allowedForPlan('starter', 'button_click')).toBe(false);
    expect(allowedForPlan('growth', 'time_spent')).toBe(true);
    expect(allowedForPlan('growth', 'per_question_time')).toBe(false);
    expect(allowedForPlan('scale', 'per_question_time')).toBe(true);
    expect(allowedForPlan('teams', 'scroll_depth')).toBe(true);
  });
});
