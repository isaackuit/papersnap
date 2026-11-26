// End-to-end run in headless Chrome with a sample photo as the camera feed:
// home → live camera (edge overlay, auto capture) → document → editor (corner drag, B&W)
// → export PDF → OCR → searchable PDF → settings / Chinese UI. Screenshots in tests/out/e2e-*.png.
// Usage: npm run build && node tests/e2e.mjs   (needs Chrome + Playwright)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const out = (f) => join(here, 'out', f);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { cwd: join(here, '..'), stdio: 'pipe', detached: true });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('4173') && r()));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${out('fakecam.y4m')}`],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'], acceptDownloads: true });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const step = async (name, fn) => { const t = Date.now(); await fn(); console.log(`✓ ${name} (${Date.now() - t}ms)`); };
const shot = (name) => page.screenshot({ path: out(`e2e-${name}.png`) });

try {
  await step('home loads', async () => {
    await page.goto('http://localhost:4173/');
    await page.getByText('No scans yet').waitFor();
    await shot('01-home-empty');
  });

  await step('live camera detects page and auto-captures', async () => {
    await page.getByRole('button', { name: 'Scan' }).click();
    await page.locator('.quad-overlay polygon').waitFor({ timeout: 60000 });
    await shot('02-camera-detected');
    await page.getByRole('button', { name: '1 page captured' }).waitFor({ timeout: 20000 });
  });

  await step('document view renders processed page', async () => {
    await page.getByRole('button', { name: 'Done' }).click();
    await page.locator('.page-thumb img').first().waitFor({ timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('.tile-busy'), null, { timeout: 60000 });
    await shot('03-document');
  });

  await step('editor: drag corner with magnifier, pick B&W, save', async () => {
    await page.getByRole('button', { name: 'Edit page 1' }).click();
    await page.locator('.handle.corner').first().waitFor();
    await page.locator('.filter-thumb img').first().waitFor({ timeout: 30000 });
    await shot('04-editor');
    const h = await page.locator('.handle.corner').nth(0).boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 + 25, h.y + h.height / 2 + 20, { steps: 6 });
    await page.locator('.loupe').waitFor();
    await shot('05-editor-drag-loupe');
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.getByRole('radio', { name: 'B&W' }).click();
    await page.getByRole('button', { name: 'Preview' }).click();
    await page.locator('.editor-result').waitFor({ timeout: 30000 });
    await shot('06-editor-preview-bw');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('.page-thumb img').first().waitFor();
    await page.waitForFunction(() => !document.querySelector('.tile-busy'), null, { timeout: 60000 });
  });

  await step('export PDF with size estimate', async () => {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByText(/Estimated size: ~/).waitFor({ timeout: 30000 });
    await shot('07-export-sheet');
    await page.getByRole('button', { name: 'Create PDF' }).click();
    await page.getByRole('button', { name: 'Download', exact: true }).waitFor({ timeout: 30000 });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download', exact: true }).click()]);
    await dl.saveAs(out('e2e-export.pdf'));
    await page.locator('.sheet-backdrop').click({ position: { x: 20, y: 20 } });
  });

  await step('enable OCR, download English, recognize text', async () => {
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByText('Enable text recognition').click();
    await page.getByRole('button', { name: /Download languages/ }).click();
    await page.getByText('Text recognition is ready').waitFor({ timeout: 120000 });
    await shot('08-settings-ocr');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.locator('.doc-row').first().click();
    await page.getByRole('button', { name: 'Recognize text' }).click();
    await page.locator('textarea.ocr-text').waitFor({ timeout: 120000 });
    const text = await page.locator('textarea.ocr-text').inputValue();
    writeFileSync(out('e2e-ocr.txt'), text);
    if (!/INVOICE/i.test(text)) throw new Error('OCR text missing expected words: ' + text.slice(0, 200));
    await shot('09-ocr-text');
    await page.locator('.sheet-backdrop').click({ position: { x: 20, y: 20 } });
  });

  await step('searchable PDF with hidden text layer', async () => {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'Create PDF' }).click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download', exact: true }).click({ timeout: 60000 })]);
    await dl.saveAs(out('e2e-searchable.pdf'));
    await page.locator('.sheet-backdrop').click({ position: { x: 20, y: 20 } });
  });

  await step('search by OCR text, Chinese UI, backup zip', async () => {
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('searchbox').fill('quote the invoice');
    await page.locator('.doc-row').first().waitFor();
    await shot('10-home-search');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: '中文' }).click();
    await shot('11-settings-zh');
    await page.getByRole('button', { name: '建立备份（.zip）' }).click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下载', exact: true }).click({ timeout: 60000 })]);
    await dl.saveAs(out('e2e-backup.zip'));
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await shot('12-home-zh');
  });
  console.log('\nE2E PASSED');
} catch (e) {
  await shot('zz-failure').catch(() => {});
  console.error('\nE2E FAILED:', e.message);
  process.exitCode = 1;
} finally {
  writeFileSync(out('e2e-console.log'), logs.join('\n'));
  await browser.close();
  try { process.kill(-server.pid); } catch {}
  process.exit(process.exitCode || 0);
}
