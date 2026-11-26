// Runs edge detection on real phone frames in tests/real/*.jpg and writes an
// overlay sheet (tests/out/real-detect.jpg). Usage: node tests/run-real.mjs
import sharp from 'sharp';
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'out'), { recursive: true });
let cv = require('../node_modules/@techstark/opencv-js/dist/opencv.js');
if (typeof cv.then === 'function') cv = await cv;
await import('../public/worker/imageproc.js');
const P = globalThis.PaperSnapProc;

const dir = join(here, 'real');
const files = readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort();
const tiles = [];
let found = 0, crossed = 0;
const cross = (q) => {
  // Self-intersection test for the 4-point polygon (edges 0-1 vs 2-3, 1-2 vs 3-0).
  const s = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  const inter = (a, b, c, d) => s(a, b, c) !== s(a, b, d) && s(c, d, a) !== s(c, d, b);
  return inter(q[0], q[1], q[2], q[3]) || inter(q[1], q[2], q[3], q[0]);
};
for (const f of files) {
  const { data, info } = await sharp(join(dir, f)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
  const t = Date.now();
  // Same downscale the live camera uses (360 px long side).
  const small = P.resizeImg(cv, img, 360);
  const det = P.detectQuad(cv, small, { maxSide: 360 });
  const ms = Date.now() - t;
  if (det.found) found++;
  const x = det.found && cross(det.quad);
  if (x) crossed++;
  console.log(`${f}: found=${det.found}${x ? ' CROSSED' : ''} cov=${det.coverage?.toFixed(2) ?? '-'} ${ms}ms`);
  const W = 240, H = Math.round(info.height * W / info.width);
  const pts = det.quad.map((p) => `${p.x * W},${p.y * H}`).join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${det.found ? `<polygon points="${pts}" fill="rgba(255,0,255,0.15)" stroke="#ff00ff" stroke-width="4"/>` : '<text x="8" y="24" font-size="18" fill="#ff4040" font-family="DM Sans">MISS</text>'}</svg>`;
  tiles.push(await sharp(join(dir, f)).resize(W, H).composite([{ input: Buffer.from(svg) }]).jpeg().toBuffer());
}
const W = 240, H = (await sharp(tiles[0]).metadata()).height, cols = 8, rows = Math.ceil(tiles.length / cols);
await sharp({ create: { width: cols * W, height: rows * H, channels: 3, background: '#000' } })
  .composite(tiles.map((b, i) => ({ input: b, left: (i % cols) * W, top: Math.floor(i / cols) * H })))
  .jpeg({ quality: 80 }).toFile(join(here, 'out', 'real-detect.jpg'));
console.log(`\nfound ${found}/${files.length}, crossed ${crossed}`);
