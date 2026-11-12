import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Bindings } from '../types';

export async function buildPdf(title: string, sections: { heading: string; body: string }[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([595, 842]);
  let y = 800;
  const margin = 50;
  const maxWidth = 595 - margin * 2;

  const wrap = (text: string, size: number, f: any): string[] => {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (f.widthOfTextAtSize(test, size) > maxWidth) { if (line) lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  };

  const write = (text: string, size: number, f: any, color = rgb(0.1, 0.1, 0.1)) => {
    for (const line of wrap(text, size, f)) {
      if (y < 60) { page = doc.addPage([595, 842]); y = 800; }
      page.drawText(line, { x: margin, y, size, font: f, color });
      y -= size + 4;
    }
  };

  write(title, 22, bold);
  y -= 12;
  for (const s of sections) {
    if (y < 100) { page = doc.addPage([595, 842]); y = 800; }
    write(s.heading, 15, bold);
    y -= 4;
    write(s.body || '—', 11, font);
    y -= 14;
  }

  return await doc.save();
}
