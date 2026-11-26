// Page lifecycle: capture/import → detect edges → warp + filter → store.
// Work is serialized through one queue so only one full-size image is in memory at a time.
import { db, uid } from './db.js';
import { decode, encode, reencode, rotateBlob } from './images.js';
import { detect, processImage } from './cv.js';
import { emit } from './bus.js';

let chain = Promise.resolve();
export function enqueue(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

const THUMB_SIDE = 360;

async function saveRendered(page, out) {
  const proc = await encode(out, 'image/jpeg', 0.9);
  const thumb = await reencode(proc, THUMB_SIDE, 'image/jpeg', 0.8);
  await db.put('blobs', proc, `${page.id}:proc`);
  await db.put('blobs', thumb, `${page.id}:thumb`);
  page.width = out.width; page.height = out.height; page.rendering = false; page.version = (page.version || 0) + 1;
  await db.put('pages', page);
  emit('page', page);
}

// Re-render a page from its original with its current quad / filter / rotation / aspect.
export function renderPage(pageId) {
  return enqueue(async () => {
    const page = await db.get('pages', pageId);
    if (!page) return;
    const orig = await db.get('blobs', `${pageId}:orig`);
    if (!orig) {
      // Original already removed: rotation is the only change we can still apply.
      const proc = await db.get('blobs', `${pageId}:proc`);
      const delta = (page.rotation || 0) - (page.renderedRotation || 0);
      if (proc && delta) {
        const rotated = await rotateBlob(proc, delta);
        await db.put('blobs', rotated, `${pageId}:proc`);
        await db.put('blobs', await reencode(rotated, THUMB_SIDE), `${pageId}:thumb`);
        page.renderedRotation = page.rotation;
        if (delta % 2) [page.width, page.height] = [page.height, page.width];
        page.version = (page.version || 0) + 1;
        await db.put('pages', page);
        emit('page', page);
      }
      return;
    }
    const img = await decode(orig);
    const out = await processImage(img, { quad: page.quad, rotation: page.rotation, filter: page.filter, aspect: page.aspect });
    page.renderedRotation = page.rotation;
    await saveRendered(page, out);
  });
}

// Add photos (camera captures or imports) to a document. quad may be provided
// (live camera detection); otherwise it is detected here.
export async function addPage(docId, blob, { quad = null, settings } = {}) {
  const page = {
    id: uid(), docId, createdAt: Date.now(),
    quad: quad || null, rotation: 0, renderedRotation: 0,
    filter: settings.defaultFilter, aspect: settings.defaultAspect,
    width: 0, height: 0, hasOriginal: true, rendering: true, ocr: null,
  };
  await db.put('blobs', blob, `${page.id}:orig`);
  await db.put('pages', page);
  const doc = await db.get('docs', docId);
  doc.pageIds.push(page.id);
  doc.updatedAt = Date.now();
  await db.put('docs', doc);
  emit('doc', doc);

  await enqueue(async () => {
    if (!page.quad) {
      const small = await decode(blob, 800);
      const det = await detect(small);
      page.quad = det.quad;
      page.detected = det.found;
      await db.put('pages', page);
    }
  });
  await renderPage(page.id);
  return page;
}

export async function replaceOriginal(pageId, blob, settings) {
  const page = await db.get('pages', pageId);
  await db.put('blobs', blob, `${pageId}:orig`);
  const small = await decode(blob, 800);
  const det = await detect(small);
  Object.assign(page, { quad: det.quad, detected: det.found, rotation: 0, renderedRotation: 0, hasOriginal: true, createdAt: Date.now(), rendering: true, ocr: null });
  await db.put('pages', page);
  emit('page', page);
  await renderPage(pageId);
}
