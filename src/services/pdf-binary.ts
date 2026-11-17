import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { sanitizePdfText } from '../utils/pdf-text';

/**
 * Generic document PDF. Every caller receives real PDF bytes; nothing in the
 * API returns HTML with a PDF filename.
 */
export async function buildPdf(
  title: string,
  sections: { heading: string; body: string }[],
  options: { subtitle?: string; footer?: string } = {}
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(sanitizePdfText(title));
  doc.setProducer('Revercue');
  doc.setCreator('Revercue');

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([595, 842]);
  let y = 800;
  const margin = 50;
  const maxWidth = 595 - margin * 2;

  const wrap = (text: string, size: number, target: typeof font): string[] => {
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

  const write = (text: string, size: number, target: typeof font, color = rgb(0.1, 0.1, 0.1)) => {
    for (const line of wrap(text, size, target)) {
      if (y < 60) {
        page = doc.addPage([595, 842]);
        y = 800;
      }
      page.drawText(line, { x: margin, y, size, font: target, color });
      y -= size + 4;
    }
  };

  write(title, 22, bold);
  if (options.subtitle) {
    y -= 4;
    write(options.subtitle, 9, font, rgb(0.45, 0.45, 0.45));
  }
  y -= 14;

  for (const section of sections) {
    if (y < 100) {
      page = doc.addPage([595, 842]);
      y = 800;
    }
    write(section.heading, 14, bold);
    y -= 3;
    write(section.body || '-', 10.5, font);
    y -= 14;
  }

  if (options.footer) {
    if (y < 80) {
      page = doc.addPage([595, 842]);
      y = 800;
    }
    y -= 8;
    write(options.footer, 8, font, rgb(0.5, 0.5, 0.5));
  }

  return await doc.save();
}

export function pdfResponse(bytes: Uint8Array, filename: string, disposition: 'inline' | 'attachment' = 'attachment'): Response {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${safe}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}
