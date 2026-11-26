# PaperSnap

Offline document scanner — turns phone photos into clean scans and PDFs.
**No backend, no database server, no account, no tracking.** Everything is processed and stored on the phone.

- **iPhone:** PWA (Safari → Share → *Add to Home Screen*), served from any static HTTPS host (GitHub Pages here).
- **Android:** the same web code packaged as an APK with Capacitor.

离线文件扫描 App：把手机照片变成干净的扫描件和 PDF。**不用后端、不用数据库服务器、不用账号、不追踪。** 所有处理和存储都在手机本地完成。iPhone 用 PWA（Safari → 分享 → 添加到主屏幕），Android 用 Capacitor 打包成 APK，两边是同一套网页代码。

---

## Features · 功能

| | |
|---|---|
| Live camera | Rear camera at the highest resolution, live paper outline, auto capture when steady ~1 s, torch, single / batch mode. Falls back to the system camera (`<input capture>`) if `getUserMedia` fails. |
| Import | Multiple photos from the gallery (images only). |
| Edge detection | OpenCV.js (wasm, bundled, lazy-loaded, never a CDN) in a Web Worker: downscale → gray → blur → Canny → dilate → findContours → approxPolyDP → largest quad; whole image if nothing found. |
| Editing | Drag 4 corners or 4 edge midpoints with a magnifier; full-resolution perspective warp; follow-page or A4 ratio; rotate 90°; retake; delete. |
| Filters | Original · Enhance (relight + white balance + contrast) · Gray · B&W (background divide → adaptive threshold) · Ink saver. Per page or all pages. |
| Documents | Multi-page, drag to reorder, auto name `Scan 2026-11-26 14:30`, rename, folders, tags, search (incl. OCR text), sort. |
| Storage | IndexedDB (processed page, thumbnail, metadata). Originals optional — default delete after 30 days. `navigator.storage.persist()`, usage shown in Settings. |
| Backup | Export everything as one `.zip`, restore from `.zip`. Reminder banner (iPhone can clear PWA data). |
| Export | PDF via pdf-lib — A4 / Letter / fit image, small / standard / high with size estimate; single page JPG / PNG. Share sheet (Web Share API on iPhone, Capacitor Share on Android) or save (Documents/PaperSnap on Android). |
| OCR (optional) | Tesseract.js in a worker, English / Malay / Simplified / Traditional Chinese. Language packs downloaded only when the user enables OCR (size shown first) from the app's own static host, then cached for offline use. Copy text, search, searchable PDF with hidden text layer. |
| Offline & privacy | Service worker caches the whole app. The only network request is the optional OCR language download. |
| UI | English (default) / 中文, all strings in `src/i18n/*.json`. Dark-first “Night Ink” theme + light mode, large one-hand targets. |

## Project layout · 项目结构

```
public/worker/imageproc.js   image pipeline (OpenCV.js) — used by the app worker AND by the tests
public/worker/cv-worker.js   classic Web Worker, lazy-loads public/vendor/opencv.js
src/lib/*                    db (IndexedDB), pages, pdf, backup, ocr, share, i18n
src/screens/*                Home, Camera, Editor, DocView, ExportSheet, Settings
scripts/                     asset copy, icon generation, service-worker generation
android/                     Capacitor Android project (committed)
tests/                       sample photos, pipeline test, end-to-end browser test
```

---

## 1. Local development · 本地开发

Requirements: Node.js 22+.

```bash
npm install
npm run dev          # http://localhost:5173  (also on your LAN with --host)
```

`npm run dev` / `npm run build` first copy OpenCV.js, the Tesseract worker/core and the OCR language packs from `node_modules` into `public/` (git-ignored), and render the icons.

> The camera only works on **HTTPS or localhost**. To try on a phone during development, use `npm run build && npm run preview` behind an HTTPS tunnel, or just deploy (step 3).
>
> 相机只能在 **HTTPS 或 localhost** 下使用。要在手机上测试，请先部署（第 3 步），或用 HTTPS 隧道。

## 2. Build the PWA · Build PWA

```bash
npm run build        # → dist/  (static files + sw.js precache list)
npm run preview      # serve dist/ locally
```

## 3. Deploy to static hosting · 部署到静态托管

Any static HTTPS host works — no database, no Worker, no server code.

**GitHub Pages (automatic, already set up):**
1. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**. (Free accounts: the repo must be public.)
2. Push to `main`. Workflow `.github/workflows/pages.yml` builds and deploys.
3. Open `https://<user>.github.io/papersnap/` on the iPhone in Safari → Share → **Add to Home Screen**.

**Cloudflare Pages (alternative, static only):** build command `npm run build`, output directory `dist`.

任何静态 HTTPS 托管都可以。用 GitHub Pages：Settings → Pages → Source 选 **GitHub Actions**（免费账号 repo 需为 Public），push 到 `main` 就会自动部署。iPhone 用 Safari 打开网址 → 分享 → **添加到主屏幕**。

## 4. Android release APK · Build Android APK

### Option A — GitHub Actions (recommended · 推荐)

`.github/workflows/android.yml` runs on every push to `main` (and on tags `v*`, attaching the APK to a Release).

1. Create the signing keystore **once** (keep it safe — every future update must be signed with the same key):
   ```bash
   keytool -genkeypair -v -keystore papersnap-release.keystore -alias papersnap \
     -keyalg RSA -keysize 2048 -validity 10000
   base64 -w0 papersnap-release.keystore > keystore.base64.txt   # macOS: base64 -i papersnap-release.keystore
   ```
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**, add:
   | Secret | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | contents of `keystore.base64.txt` |
   | `ANDROID_KEYSTORE_PASSWORD` | keystore password |
   | `ANDROID_KEY_ALIAS` | `papersnap` |
   | `ANDROID_KEY_PASSWORD` | key password |
3. Push (or **Actions → Build Android APK → Run workflow**). Download **PaperSnap.apk** from the run's *Artifacts*, or from *Releases* for a `v*` tag.

Without the secrets the workflow still produces `PaperSnap-debug.apk` (installable, but each build has a different signature, so updates need an uninstall first).

The APK does **not** contain the OCR language packs; it downloads them from `VITE_LANG_BASE_URL` (set by the workflow to your GitHub Pages URL `…/ocr/lang`). Deploy the PWA too, otherwise OCR download fails in the APK.

### Option B — on your computer · 在自己电脑 build

Requirements: Node 22+, JDK 21, Android SDK (Android Studio).

```bash
npm install
VITE_LANG_BASE_URL=https://<user>.github.io/papersnap/ocr/lang npm run build:android
cp android/keystore.properties.example android/keystore.properties   # fill in the 4 values
cd android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

`android/keystore.properties` and `*.keystore` are git-ignored — **never commit the keystore**.
签名 keystore 和 `keystore.properties` 都不会进 repo，请自己妥善保存；以后每次更新都必须用同一个 keystore 签名。

Package name is the placeholder `com.example.scanner` (`capacitor.config.json`, `android/app/build.gradle`, `strings.xml`). Change it **before** the first public release — changing it later makes Android treat it as a different app.

---

## Tests · 测试

```bash
node tests/make-samples.mjs   # builds tests/samples/*.jpg (+ ground-truth corners)
npm test                      # edge detection accuracy + every filter → tests/out/compare-*.jpg
npm run build && node tests/e2e.mjs   # headless Chrome, sample photo as fake camera, full flow
```

Sample set: A4 invoice on a desk, long receipt on a dark surface, business card, steep oblique angle, low light with sensor noise, hard diagonal shadow. Current result: **6/6 detected, max corner error < 1 %**; comparison sheets show photo + detected outline → each filter.

The e2e test covers: live camera outline + auto capture → document → corner drag with magnifier → B&W → PDF export with size estimate → enable OCR + language download → recognize → searchable PDF → search by text → Chinese UI → backup zip.

Still to do on real devices: one full *capture → export PDF → share* on iPhone Safari and on an Android phone (checklist below).

| Device check | iPhone (PWA) | Android (APK) |
|---|---|---|
| Camera permission prompt / denied message | ☐ | ☐ |
| Live outline + auto capture | ☐ | ☐ |
| Torch | n/a (Safari has no torch API) | ☐ |
| Export PDF → share to Files / WhatsApp / Drive | ☐ | ☐ |
| Save to Documents/PaperSnap | download → Files | ☐ |
| Offline (airplane mode) after first open | ☐ | ☐ |

## OCR on Android: ML Kit evaluation · Android OCR 评估

Option: [`@capacitor-mlkit/text-recognition`](https://capawesome.io/docs/sdks/capacitor/mlkit/text-recognition/) (Capawesome, wraps Google ML Kit Text Recognition v2 — on-device, free, offline, Latin + Chinese scripts; Malay uses the Latin model). ML Kit is generally more robust than Tesseract on phone photos and much faster on Android, but it can't run on iPhone PWA, adds native model size to the APK, and couldn't be measured here without an Android device.
**Decision for v1:** Tesseract.js on both platforms. Switching Android later is contained to `src/lib/ocr.js` (`recognizePage` returns `{text, words[]}` — the same shape the PDF text layer already uses).

## Privacy · 隐私

No analytics, no remote logging, no third-party CDN. Network is used only to (a) load the app itself and (b) download OCR language packs when the user turns OCR on.

## Known limits · 已知限制

- iPhone Safari has no torch API and may clear PWA storage after weeks of non-use → the app nags for backups.
- The searchable-PDF text layer uses a standard PDF font: English/Malay text is embedded; Chinese OCR text stays searchable inside the app only.
- Handwriting OCR is poor (Tesseract limitation).
