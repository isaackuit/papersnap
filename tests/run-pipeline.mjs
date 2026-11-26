// Runs the exact same pipeline the app's Web Worker uses (public/worker/imageproc.js)
// on tests/samples/*.jpg: edge detection accuracy against ground truth, every
// filter, and a before/after comparison sheet (tests/out/compare-*.jpg).
import sharp from 'sharp';
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, 'samples');
const out = join(here, 'out');
mkdirSync(out, { recursive: true });

let cv = require('../node_modules/@techstark/opencv-js/dist/opencv.js');
if (typeof cv.then === 'function') cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
await import('../public/worker/imageproc.js');
const P = globalThis.PaperSnapProc;

async function load(file, maxSide = 4096) {
  const { data, info } = await sharp(file).rotate().resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}
const toJpeg = (img, w) => sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: img.width, height: img.height, channels: 4 } })
  .resize({ width: w }).jpeg({ quality: 85 }).toBuffer();

const files = readdirSync(samples).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
let pass = 0, fail = 0;
const label = (t, w) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="44"><rect width="100%" height="100%" fill="#121417"/><text x="10" y="30" font-family="DM Sans" font-size="24" fill="#F2F4F5">${t}</text></svg>`);

for (const f of files) {
  const img = await load(join(samples, f));
  const t0 = Date.now();
  const det = P.detectQuad(cv, img);
  const tDetect = Date.now() - t0;
  let err = null;
  const gtFile = join(samples, f.replace(/\.\w+$/, '.json'));
  if (existsSync(gtFile)) {
    const gt = JSON.parse(readFileSync(gtFile, 'utf8')).quad;
    err = Math.max(...gt.map((g, i) => Math.hypot(g.x - det.quad[i].x, g.y - det.quad[i].y)));
  }
  const ok = det.found && (err === null || err < 0.02);
  ok ? pass++ : fail++;

  const timings = {};
  const results = [];
  for (const filter of P.FILTERS) {
    const t = Date.now();
    const r = P.processPage(cv, img, { quad: det.quad, filter, aspect: 'auto' });
    timings[filter] = Date.now() - t;
    results.push({ filter, img: r });
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${f}: found=${det.found} maxCornerErr=${err === null ? 'n/a' : (err * 100).toFixed(2) + '%'} detect=${tDetect}ms`,
    Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join(' '));

  // Comparison sheet: original photo with detected quad, then each filter.
  const TW = 420;
  const orig = await load(join(samples, f), 1400);
  const ow = orig.width, oh = orig.height;
  const poly = det.quad.map((p) => `${p.x * ow},${p.y * oh}`).join(' ');
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${ow}" height="${oh}"><polygon points="${poly}" fill="rgba(200,240,74,0.15)" stroke="#C8F04A" stroke-width="8"/></svg>`);
  const origWithQuad = await sharp(Buffer.from(orig.data.buffer), { raw: { width: ow, height: oh, channels: 4 } }).composite([{ input: overlay }]).png().toBuffer();
  const tiles = [{ name: 'photo + detected edges', buf: await sharp(origWithQuad).resize({ width: TW }).jpeg().toBuffer() }];
  for (const r of results) tiles.push({ name: r.filter, buf: await toJpeg(r.img, TW) });
  const metas = await Promise.all(tiles.map((t) => sharp(t.buf).metadata()));
  const H = Math.max(...metas.map((m) => m.height)) + 44;
  const sheet = sharp({ create: { width: TW * tiles.length + 12 * (tiles.length + 1), height: H + 24, channels: 3, background: '#1B1E22' } });
  const comps = [];
  tiles.forEach((t, i) => {
    const left = 12 + i * (TW + 12);
    comps.push({ input: label(t.name, TW), left, top: 12 });
    comps.push({ input: t.buf, left, top: 56 });
  });
  await sheet.composite(comps).jpeg({ quality: 82 }).toFile(join(out, 'compare-' + f.replace(/\.\w+$/, '.jpg')));
}
console.log(`\nEdge detection: ${pass}/${pass + fail} within 2% of ground truth`);
process.exit(fail ? 1 : 0);
