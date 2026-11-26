// PDF export with pdf-lib. Optional invisible OCR text layer → searchable PDF.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { db } from './db.js';
import { reencode } from './images.js';

export const QUALITY = {
  small: { maxSide: 1240, q: 0.55 },
  standard: { maxSide: 1754, q: 0.72 },
  high: { maxSide: 3508, q: 0.88 },
};

const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

async function pageJpeg(pageId, quality) {
  const proc = await db.get('blobs', `${pageId}:proc`);
  if (!proc) throw new Error('page not ready');
  const { maxSide, q } = QUALITY[quality];
  return reencode(proc, maxSide, 'image/jpeg', q);
}

// Estimate final size by encoding up to 3 pages and extrapolating.
export async function estimatePdfSize(pages, quality) {
  if (!pages.length) return 0;
  const sample = pages.length <= 3 ? pages : [pages[0], pages[Math.floor(pages.length / 2)], pages[pages.length - 1]];
  let bytes = 0;
  for (const p of sample) bytes += (await pageJpeg(p.id, quality)).size;
  return Math.round((bytes / sample.length) * pages.length + 2000 + pages.length * 600);
}

// Latin-1 only: the standard PDF font can't carry CJK glyphs, and embedding a CJK font
// would add many MB. Chinese text stays searchable in the app; PDF layer covers EN/MS.
const latin = (s) => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '');

export async function buildPdf(doc, pages, { pageSize = 'a4', quality = 'standard', textLayer = false } = {}, onProgress) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(doc.name);
  pdf.setCreator('PaperSnap');
  pdf.setProducer('PaperSnap');
  const font = textLayer ? await pdf.embedFont(StandardFonts.Helvetica) : null;

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const jpg = await pdf.embedJpg(new Uint8Array(await (await pageJpeg(p.id, quality)).arrayBuffer()));
    const landscape = jpg.width > jpg.height;
    let pw, ph;
    if (pageSize === 'fit') {
      // ~200 dpi equivalent keeps physical size sensible for a phone photo.
      const k = 72 / 200 * (Math.max(p.width || jpg.width, 1) / jpg.width);
      pw = jpg.width * k; ph = jpg.height * k;
    } else {
      [pw, ph] = SIZES[pageSize];
      if (landscape) [pw, ph] = [ph, pw];
    }
    const page = pdf.addPage([pw, ph]);
    const s = Math.min(pw / jpg.width, ph / jpg.height);
    const dw = jpg.width * s, dh = jpg.height * s, dx = (pw - dw) / 2, dy = (ph - dh) / 2;
    page.drawImage(jpg, { x: dx, y: dy, width: dw, height: dh });

    if (font && p.ocr?.words?.length) {
      const k = dw / p.ocr.w;
      for (const w of p.ocr.words) {
        const text = latin(w.t);
        if (!text.trim()) continue;
        const boxW = (w.x1 - w.x0) * k, boxH = (w.y1 - w.y0) * k;
        const unit = font.widthOfTextAtSize(text, 1) || 1;
        const size = Math.max(1, Math.min(boxW / unit, boxH * 1.3));
        page.drawText(text, { x: dx + w.x0 * k, y: ph - dy - w.y1 * k + boxH * 0.15, size, font, opacity: 0 });
      }
    }
    onProgress?.((i + 1) / pages.length);
  }
  const bytes = await pdf.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

export async function pageImage(pageId, format) {
  const proc = await db.get('blobs', `${pageId}:proc`);
  if (format === 'png') return reencode(proc, 4096, 'image/png');
  return reencode(proc, 4096, 'image/jpeg', 0.92);
}
