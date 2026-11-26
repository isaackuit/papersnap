// Builds the sample photo set used to validate edge detection and filters.
// Each sample: a flat document (rendered from SVG) composited into a "photo"
// with a perspective tilt, a textured surface, lighting and shadow effects.
// Ground-truth corners are saved so detection accuracy can be measured.
import sharp from 'sharp';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'samples');
mkdirSync(outDir, { recursive: true });

let cv = require('../node_modules/@techstark/opencv-js/dist/opencv.js');
if (typeof cv.then === 'function') cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));

const lines = (x, y, n, w, gap, size, color = '#222') => Array.from({ length: n }, (_, i) =>
  `<text x="${x}" y="${y + i * gap}" font-family="DM Sans" font-size="${size}" fill="${color}">${['Invoice no. 2026-1147 issued to Stellar Signature Sdn Bhd', 'Payment due within 30 days of the invoice date shown above.', 'Item  Qty  Unit price  Amount  —  Flour 25 kg  4  RM 62.00', 'Jumlah perlu dibayar sebelum tarikh akhir. Terima kasih.', 'Please quote the invoice number on all correspondence.'][i % 5].slice(0, w)}</text>`).join('');

const docs = {
  a4: { w: 1240, h: 1754, svg: (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f7f5f0"/>
    <text x="110" y="200" font-family="DM Sans" font-weight="700" font-size="64" fill="#111">TAX INVOICE</text>
    <text x="110" y="270" font-family="Noto Sans CJK SC" font-size="34" fill="#333">发票 · 吉隆坡 Jalan Sultan</text>
    <rect x="110" y="320" width="1020" height="4" fill="#111"/>
    ${lines(110, 420, 22, 70, 52, 30)}
    <rect x="760" y="1560" width="370" height="90" fill="none" stroke="#b22" stroke-width="5"/><text x="790" y="1620" font-family="DM Sans" font-weight="700" font-size="40" fill="#b22">PAID</text></svg>` },
  receipt: { w: 560, h: 1500, svg: (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fbfbf8"/>
    <text x="280" y="110" text-anchor="middle" font-family="DM Sans" font-weight="700" font-size="44" fill="#222">MR DIY</text>
    <text x="280" y="160" text-anchor="middle" font-family="DM Sans" font-size="24" fill="#444">Kuala Lumpur · 26/11/2026 14:30</text>
    ${Array.from({ length: 18 }, (_, i) => `<text x="40" y="${240 + i * 56}" font-family="DM Mono, monospace" font-size="26" fill="#333">ITEM ${String(i + 1).padStart(2, '0')} ........ RM ${(3.5 + i * 1.75).toFixed(2)}</text>`).join('')}
    <text x="40" y="1330" font-family="DM Sans" font-weight="700" font-size="36" fill="#111">TOTAL  RM 331.50</text></svg>` },
  card: { w: 1050, h: 600, svg: (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#ffffff"/>
    <rect x="0" y="0" width="28" height="600" fill="#C8F04A"/>
    <text x="90" y="200" font-family="DM Sans" font-weight="700" font-size="64" fill="#111">Isaac K.</text>
    <text x="90" y="260" font-family="DM Sans" font-size="34" fill="#555">Director · Stellar Signature</text>
    <text x="90" y="460" font-family="DM Sans" font-size="30" fill="#333">+60 12-345 6789</text>
    <text x="90" y="510" font-family="DM Sans" font-size="30" fill="#333">hello@example.com</text></svg>` },
};

// Scenes: doc, photo size, destination corners (fractions), surface, lighting.
const scenes = [
  { name: '01-a4-desk', doc: 'a4', W: 3024, H: 4032, quad: [[0.14, 0.10], [0.86, 0.12], [0.89, 0.90], [0.11, 0.88]], surface: [118, 84, 58], light: 1.0 },
  { name: '02-receipt', doc: 'receipt', W: 3024, H: 4032, quad: [[0.33, 0.08], [0.67, 0.09], [0.69, 0.93], [0.31, 0.92]], surface: [52, 56, 62], light: 1.0 },
  { name: '03-business-card', doc: 'card', W: 4032, H: 3024, quad: [[0.22, 0.27], [0.79, 0.24], [0.81, 0.73], [0.20, 0.75]], surface: [150, 120, 92], light: 1.0 },
  { name: '04-oblique', doc: 'a4', W: 3024, H: 4032, quad: [[0.28, 0.20], [0.80, 0.14], [0.95, 0.86], [0.06, 0.80]], surface: [96, 70, 50], light: 1.0 },
  { name: '05-low-light', doc: 'a4', W: 3024, H: 4032, quad: [[0.12, 0.11], [0.87, 0.10], [0.88, 0.89], [0.13, 0.90]], surface: [80, 64, 50], light: 0.38, noise: 18 },
  { name: '06-shadow', doc: 'a4', W: 3024, H: 4032, quad: [[0.13, 0.09], [0.88, 0.11], [0.87, 0.90], [0.12, 0.89]], surface: [120, 92, 66], light: 1.0, shadow: true },
];

function rand(seed) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

for (const sc of scenes) {
  const d = docs[sc.doc];
  const flat = await sharp(Buffer.from(d.svg(d.w, d.h))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const docMat = cv.matFromImageData({ data: new Uint8ClampedArray(flat.data), width: flat.info.width, height: flat.info.height });

  // Surface with grain.
  const r = rand(sc.name.length * 7919);
  const bg = new Uint8ClampedArray(sc.W * sc.H * 4);
  for (let y = 0; y < sc.H; y++) {
    const band = Math.sin(y / 37) * 8 + Math.sin(y / 211) * 10;
    for (let x = 0; x < sc.W; x++) {
      const o = (y * sc.W + x) * 4, g = band + (r() - 0.5) * 14;
      bg[o] = sc.surface[0] + g; bg[o + 1] = sc.surface[1] + g; bg[o + 2] = sc.surface[2] + g; bg[o + 3] = 255;
    }
  }
  const scene = cv.matFromImageData({ data: bg, width: sc.W, height: sc.H });
  const dstPts = sc.quad.flatMap(([x, y]) => [x * sc.W, y * sc.H]);
  const M = cv.getPerspectiveTransform(
    cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, d.w, 0, d.w, d.h, 0, d.h]),
    cv.matFromArray(4, 1, cv.CV_32FC2, dstPts));
  const warped = new cv.Mat();
  cv.warpPerspective(docMat, warped, M, new cv.Size(sc.W, sc.H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
  // Alpha-composite the warped doc onto the surface.
  const s = scene.data, w = warped.data;
  for (let i = 0; i < s.length; i += 4) {
    const a = w[i + 3] / 255;
    if (a > 0) { s[i] = s[i] * (1 - a) + w[i] * a; s[i + 1] = s[i + 1] * (1 - a) + w[i + 1] * a; s[i + 2] = s[i + 2] * (1 - a) + w[i + 2] * a; }
  }
  // Lighting: vignette + overall exposure + optional hand/phone shadow + sensor noise.
  for (let y = 0; y < sc.H; y++) for (let x = 0; x < sc.W; x++) {
    const o = (y * sc.W + x) * 4;
    const dx = x / sc.W - 0.5, dy = y / sc.H - 0.45;
    let k = sc.light * (1 - 0.35 * (dx * dx + dy * dy)) * (0.96 + 0.06 * (x / sc.W));
    if (sc.shadow) { const t = (x / sc.W) * 0.9 + (y / sc.H) * 0.6; k *= t < 0.55 ? 0.42 : t < 0.7 ? 0.42 + (t - 0.55) / 0.15 * 0.58 : 1; }
    const n = sc.noise ? (r() - 0.5) * sc.noise : 0;
    s[o] = s[o] * k + n; s[o + 1] = s[o + 1] * k + n; s[o + 2] = s[o + 2] * k * 0.97 + n;
  }
  const blurred = new cv.Mat();
  cv.GaussianBlur(scene, blurred, new cv.Size(3, 3), 0);
  await sharp(Buffer.from(blurred.data), { raw: { width: sc.W, height: sc.H, channels: 4 } }).jpeg({ quality: 88 }).toFile(join(outDir, sc.name + '.jpg'));
  writeFileSync(join(outDir, sc.name + '.json'), JSON.stringify({ quad: sc.quad.map(([x, y]) => ({ x, y })) }));
  [docMat, scene, M, warped, blurred].forEach((m) => m.delete());
  console.log('sample', sc.name);
}
