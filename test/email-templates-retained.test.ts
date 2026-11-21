import { describe, expect, it } from 'vitest';
import {
  contractAwaitingSignatureEmail,
  contractFullySignedEmail,
  documentDeliveryEmail,
  retentionWarningEmail,
} from '../src/services/email-templates';

describe('transactional email templates retained', () => {
  it('keeps contract, retention and delivery emails available', () => {
    expect(
      contractAwaitingSignatureEmail({
        contractTitle: 'Website build',
        signerName: 'Sam',
        signUrl: 'https://revercue.co.uk/sign/1',
      }).subject
    ).toContain('please sign');

    expect(
      contractFullySignedEmail({
        contractTitle: 'Website build',
        clientName: 'Acme',
        signedAt: '2026-11-21',
        pdfUrl: 'https://revercue.co.uk/pdf/1',
      }).subject
    ).toContain('fully signed');

    expect(
      retentionWarningEmail({
        documentTitle: 'Proposal',
        documentType: 'proposal',
        expiryDate: '2026-12-01',
        daysRemaining: 10,
        keepUrl: 'https://revercue.co.uk/proposal/1',
      }).subject
    ).toContain('deleted in 10 days');

    expect(
      documentDeliveryEmail({
        documentTitle: 'Proposal',
        documentType: 'proposal',
        expiryDate: '2026-12-01',
        downloadUrl: 'https://revercue.co.uk/download/1',
        deleteAfterDelivery: true,
      }).subject
    ).toContain('expiring');
  });
});
