// Renders the PaperSnap "P" lettermark into every icon size the PWA and the
// Android launcher need. Source of truth: the SVG strings below.
import sharp from 'sharp';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BG = '#121417';
const INK = '#F2F4F5';
const LIME = '#C8F04A';

// Glyph drawn in a 180×180 box. Folded top-left corner = a page.
const glyph = `
  <path fill="${INK}" fill-rule="evenodd" d="M76 36h24a34 34 0 0 1 0 68H84v40H54V58z M84 62v16h14a8 8 0 0 0 0-16z"/>
  <path fill="${LIME}" d="M54 58L76 36V58z"/>`;

const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><rect width="180" height="180" rx="40" fill="${BG}"/><g transform="translate(-3 0)">${glyph}</g></svg>`;
const square = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><rect width="180" height="180" fill="${BG}"/><g transform="translate(-3 0)">${glyph}</g></svg>`;
// Maskable / adaptive: glyph inside the central 66% safe zone.
const safe = (bg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">${bg ? `<rect width="180" height="180" fill="${BG}"/>` : ''}<g transform="translate(90 90) scale(0.62) translate(-93 -90)">${glyph}</g></svg>`;

const out = (p) => { const f = join(root, p); mkdirSync(dirname(f), { recursive: true }); return f; };
const png = (svg, size, file) => sharp(Buffer.from(svg)).resize(size, size).png().toFile(out(file));

writeFileSync(out('public/icons/favicon.svg'), rounded);
await png(rounded, 192, 'public/icons/icon-192.png');
await png(rounded, 512, 'public/icons/icon-512.png');
await png(safe(true), 512, 'public/icons/maskable-512.png');
await png(square, 180, 'public/icons/apple-touch-icon.png');

// Android launcher icons (only if the native project exists).
const res = join(root, 'android/app/src/main/res');
if (existsSync(res)) {
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(dens)) {
    await png(rounded, Math.round(48 * k), `android/app/src/main/res/mipmap-${d}/ic_launcher.png`);
    await png(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><circle cx="90" cy="90" r="90" fill="${BG}"/><g transform="translate(90 90) scale(0.8) translate(-93 -90)">${glyph}</g></svg>`, Math.round(48 * k), `android/app/src/main/res/mipmap-${d}/ic_launcher_round.png`);
    await png(safe(false), Math.round(108 * k), `android/app/src/main/res/mipmap-${d}/ic_launcher_foreground.png`);
  }
  writeFileSync(out('android/app/src/main/res/values/ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG}</color>\n</resources>\n`);
}
console.log('icons generated');

// Android splash screens: dark background + lettermark (replaces Capacitor's default).
if (existsSync(res)) {
  const { readdirSync } = await import('node:fs');
  for (const dir of readdirSync(res).filter((d) => d.startsWith('drawable'))) {
    const f = join(res, dir, 'splash.png');
    if (!existsSync(f)) continue;
    const { width, height } = await sharp(f).metadata();
    const g = Math.round(Math.min(width, height) * 0.28);
    const mark = await sharp(Buffer.from(rounded)).resize(g, g).png().toBuffer();
    await sharp({ create: { width, height, channels: 4, background: BG } })
      .composite([{ input: mark, left: Math.round((width - g) / 2), top: Math.round((height - g) / 2) }])
      .png().toFile(f + '.tmp');
    const { renameSync } = await import('node:fs');
    renameSync(f + '.tmp', f);
  }
  console.log('splash screens generated');
}
