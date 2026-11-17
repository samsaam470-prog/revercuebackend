import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { sanitizePdfText } from '../utils/pdf-text';
import type { SignerRole } from './contract-state';

/**
 * Builds the countersigned contract PDF: content snapshot, both embedded
 * signatures and the signing evidence (names, timestamps, IPs, user agents,
 * consent version and the immutable content hash).
 */

export interface SignatureEvidence {
  role: SignerRole;
  name: string;
  email: string | null;
  signedAt: string;
  ip: string | null;
  userAgent: string | null;
  consentVersion: string;
  signatureHash: string;
  signatureBytes?: Uint8Array | null;
  signatureMime?: string | null;
}

export interface SignedContractPdfInput {
  contractId: string;
  title: string;
  versionNumber: number;
  versionHash: string;
  versionCreatedAt: string;
  signedAt: string;
  sections: { heading: string; body: string }[];
  freelancer: SignatureEvidence;
  client: SignatureEvidence;
  appUrl?: string;
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 50;

export async function buildSignedContractPdf(input: SignedContractPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(sanitizePdfText(`${input.title} (signed)`));
  doc.setProducer('Revercue');
  doc.setCreator('Revercue electronic signature');
  doc.setSubject(`Contract ${input.contractId} version ${input.versionNumber}`);

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  let page: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const ensureSpace = (needed: number) => {
    if (y - needed < MARGIN + 30) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  };

  const wrap = (text: string, size: number, target: PDFFont): string[] => {
    const maxWidth = PAGE_WIDTH - MARGIN * 2;
    const lines: string[] = [];
    for (const paragraph of sanitizePdfText(text).split('\n')) {
      const words = paragraph.split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        lines.push('');
        continue;
      }
      let line = '';
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (target.widthOfTextAtSize(candidate, size) > maxWidth) {
          if (line) lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  };

  const write = (
    text: string,
    size: number,
    target: PDFFont,
    options: { color?: ReturnType<typeof rgb>; indent?: number; gapAfter?: number } = {}
  ) => {
    const color = options.color ?? rgb(0.1, 0.1, 0.1);
    const indent = options.indent ?? 0;
    for (const line of wrap(text, size, target)) {
      ensureSpace(size + 4);
      page.drawText(line, { x: MARGIN + indent, y, size, font: target, color });
      y -= size + 4;
    }
    y -= options.gapAfter ?? 0;
  };

  // --- Header -----------------------------------------------------------------
  write('REVERCUE', 9, bold, { color: rgb(0.72, 0.58, 0.3), gapAfter: 4 });
  write(input.title, 22, bold, { gapAfter: 6 });
  write(
    `Contract ${input.contractId}  |  Version ${input.versionNumber}  |  Signed ${input.signedAt}`,
    9,
    font,
    { color: rgb(0.42, 0.42, 0.42), gapAfter: 2 }
  );
  write(`Content hash (SHA-256): ${input.versionHash}`, 8, mono, {
    color: rgb(0.42, 0.42, 0.42),
    gapAfter: 10,
  });

  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.7,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= 18;

  // --- Content ----------------------------------------------------------------
  write('CONTRACT CONTENT', 8, bold, { color: rgb(0.72, 0.58, 0.3), gapAfter: 8 });
  for (const section of input.sections) {
    if (!section.body && !section.heading) continue;
    ensureSpace(40);
    write(section.heading || 'Section', 13, bold, { gapAfter: 3 });
    write(section.body || '-', 10.5, font, { gapAfter: 12 });
  }

  // --- Signatures -------------------------------------------------------------
  ensureSpace(260);
  y -= 10;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.7,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= 24;

  write('SIGNATURES', 8, bold, { color: rgb(0.72, 0.58, 0.3), gapAfter: 10 });

  const renderSignatureBlock = async (evidence: SignatureEvidence, label: string) => {
    ensureSpace(180);
    write(label, 11, bold, { gapAfter: 4 });
    write(`Name: ${evidence.name}`, 9.5, font, { gapAfter: 1 });
    write(`Email: ${evidence.email ?? '-'}`, 9.5, font, { gapAfter: 1 });
    write(`Signed at: ${evidence.signedAt}`, 9.5, font, { gapAfter: 1 });
    write(`IP address: ${evidence.ip ?? 'not recorded'}`, 9.5, font, { gapAfter: 1 });
    write(`User agent: ${evidence.userAgent ?? 'not recorded'}`, 8, font, {
      color: rgb(0.42, 0.42, 0.42),
      gapAfter: 1,
    });
    write(`Consent version: ${evidence.consentVersion}`, 8, font, {
      color: rgb(0.42, 0.42, 0.42),
      gapAfter: 1,
    });
    write(`Signature hash: ${evidence.signatureHash}`, 7.5, mono, {
      color: rgb(0.42, 0.42, 0.42),
      gapAfter: 8,
    });

    if (evidence.signatureBytes && evidence.signatureBytes.length > 0) {
      try {
        const image =
          evidence.signatureMime === 'image/jpeg'
            ? await doc.embedJpg(evidence.signatureBytes)
            : await doc.embedPng(evidence.signatureBytes);
        const maxWidth = 200;
        const maxHeight = 70;
        const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
        const width = image.width * scale;
        const height = image.height * scale;
        ensureSpace(height + 20);
        page.drawImage(image, { x: MARGIN, y: y - height, width, height });
        page.drawRectangle({
          x: MARGIN,
          y: y - height - 4,
          width: Math.max(width, 180),
          height: 0.7,
          color: rgb(0.6, 0.6, 0.6),
        });
        y -= height + 16;
      } catch (error) {
        console.error('SIGNATURE_IMAGE_EMBED_FAILED', evidence.role, error);
        write('[signature image could not be embedded; the signature hash above is authoritative]', 8, font, {
          color: rgb(0.6, 0.2, 0.2),
        });
      }
    } else {
      write('[signature image unavailable; signature hash is authoritative]', 8, font, {
        color: rgb(0.6, 0.2, 0.2),
      });
    }
    y -= 10;
  };

  await renderSignatureBlock(input.freelancer, 'Freelancer');
  await renderSignatureBlock(input.client, 'Client');

  // --- Evidence footer --------------------------------------------------------
  ensureSpace(110);
  y -= 6;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.7,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= 18;
  write('SIGNING EVIDENCE', 8, bold, { color: rgb(0.72, 0.58, 0.3), gapAfter: 6 });
  write(
    `Both parties signed this exact version (hash ${input.versionHash}) through Revercue. ` +
      `Each signature is bound to the version hash, the signer identity, the timestamp and the consent ` +
      `text in force at signing. Altering the contract content produces a different hash and invalidates ` +
      `this document. The signature images and the original event log are retained privately by Revercue.`,
    8.5,
    font,
    { color: rgb(0.35, 0.35, 0.35), gapAfter: 4 }
  );
  write(`Version created: ${input.versionCreatedAt}`, 8, font, { color: rgb(0.45, 0.45, 0.45), gapAfter: 1 });
  write(`Document generated: ${new Date().toISOString()}`, 8, font, {
    color: rgb(0.45, 0.45, 0.45),
    gapAfter: 1,
  });
  if (input.appUrl) {
    write(`Verify: ${input.appUrl}/c/${input.contractId}`, 8, font, { color: rgb(0.45, 0.45, 0.45) });
  }

  return doc.save();
}
