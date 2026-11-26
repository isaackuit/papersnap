// Generates dist/sw.js: precaches every built file (except OCR language packs,
// which are downloaded on demand) so the app works fully offline after first open.
import { readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(dist, p).split('\\').join('/'));
  }
})(dist);

const precache = files.filter((f) => !f.startsWith('ocr/lang/') && f !== 'sw.js' && !f.endsWith('.map'));
const hash = createHash('sha256');
for (const f of precache) hash.update(f + statSync(join(dist, f)).size);
const version = hash.digest('hex').slice(0, 12);

const template = readFileSync(join(root, 'scripts/sw-template.js'), 'utf8');
const out = template
  .replace('__VERSION__', version)
  .replace('__PRECACHE__', JSON.stringify(['./', ...precache.map((f) => './' + f)]));
writeFileSync(join(dist, 'sw.js'), out);
console.log(`sw.js: ${precache.length} files precached, version ${version}`);
