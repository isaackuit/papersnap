// Copies large runtime assets from node_modules into public/ so they are served
// from the app's own origin (no CDN). Run automatically by `npm run dev/build`.
import { cpSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => join(root, 'node_modules', p);
const pub = (p) => join(root, 'public', p);

function copy(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest) && statSync(dest).size === statSync(src).size) return;
  cpSync(src, dest);
  console.log('copied', dest.replace(root + '/', ''));
}

// OpenCV.js (wasm embedded) — loaded lazily by the image worker.
copy(nm('@techstark/opencv-js/dist/opencv.js'), pub('vendor/opencv.js'));

// Tesseract.js worker + LSTM-only cores (shipped in the app; small enough).
copy(nm('tesseract.js/dist/worker.min.js'), pub('ocr/worker.min.js'));
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
  copy(nm('tesseract.js-core/' + f), pub('ocr/core/' + f));
}

// Language packs — served from the static host, downloaded on demand only.
// They are stripped from the Android APK by scripts/strip-ocr-lang.mjs.
for (const lang of ['eng', 'msa', 'chi_sim', 'chi_tra']) {
  copy(nm(`@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`), pub(`ocr/lang/${lang}.traineddata.gz`));
}
