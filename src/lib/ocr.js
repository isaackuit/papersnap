// On-device OCR with Tesseract.js. Worker + wasm core ship with the app;
// language packs are fetched once from our own static host, then cached in IndexedDB
// by Tesseract (works offline afterwards, also inside the Android APK).
import { LANG_BASE_URL, appUrl } from './platform.js';
import { db } from './db.js';

export const OCR_LANGS = [
  { code: 'eng', label: 'English', bytes: 2952873 },
  { code: 'msa', label: 'Bahasa Melayu', bytes: 1177136 },
  { code: 'chi_sim', label: '简体中文', bytes: 1718768 },
  { code: 'chi_tra', label: '繁體中文', bytes: 1656239 },
];

let current = null; // {key, worker}

async function getWorker(langs, onProgress) {
  const key = langs.slice().sort().join('+');
  if (current?.key === key) return current.worker;
  if (current) { await current.worker.terminate(); current = null; }
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(langs, 1, {
    workerPath: appUrl('ocr/worker.min.js'),
    corePath: appUrl('ocr/core'),
    langPath: LANG_BASE_URL,
    workerBlobURL: false,
    gzip: true,
    logger: (m) => onProgress?.(m),
  });
  current = { key, worker };
  return worker;
}

// Downloads (or loads from cache) the chosen language packs. Called from Settings.
export async function prepareLanguages(langs, onProgress) {
  await getWorker(langs, onProgress);
}

export async function releaseOcr() {
  if (current) { await current.worker.terminate(); current = null; }
}

// Runs OCR on a stored page; saves {text, words, w, h} on the page record.
export async function recognizePage(pageId, langs, onProgress) {
  const page = await db.get('pages', pageId);
  const proc = await db.get('blobs', `${pageId}:proc`);
  if (!page || !proc) throw new Error('page not ready');
  const worker = await getWorker(langs, onProgress);
  const { data } = await worker.recognize(proc, {}, { text: true, blocks: true });
  const words = [];
  for (const b of data.blocks || []) for (const para of b.paragraphs || []) for (const line of para.lines || []) for (const w of line.words || []) {
    if (w.text?.trim()) words.push({ t: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
  }
  page.ocr = { text: (data.text || '').trim(), words, w: page.width, h: page.height, langs, at: Date.now() };
  await db.put('pages', page);
  return page.ocr;
}
