// OCR language packs must not ship inside the APK — the Android app downloads
// them on demand from the PWA's static host (VITE_LANG_BASE_URL).
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'ocr', 'lang');
rmSync(dir, { recursive: true, force: true });
console.log('removed dist/ocr/lang for the Android build');
