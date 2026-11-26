// Feeds a real recording as the camera and samples the live outline over time.
// Usage: node tests/live-cam.mjs tests/out/realcam.y4m
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const cam = resolve(process.argv[2]);
const server = spawn('npx', ['vite', 'preview', '--port', '4174', '--strictPort'], { cwd: join(here, '..'), stdio: 'pipe', detached: true });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('4174') && r()));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${cam}`] });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'] })).newPage();
try {
  await page.goto('http://localhost:4174/');
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  await page.getByText(/Auto capture/).click(); // turn auto capture off so we only watch the outline
  await page.waitForFunction(() => document.querySelector('.cam-hint') && !/Getting ready/.test(document.querySelector('.cam-hint').innerText), null, { timeout: 60000 });
  let shown = 0, crossed = 0, samples = 0;
  for (let i = 0; i < 40; i++) {
    const pts = await page.evaluate(() => {
      const p = document.querySelector('.quad-overlay polygon');
      return p ? p.getAttribute('points').split(' ').map((s) => s.split(',').map(Number)) : null;
    });
    samples++;
    if (pts) {
      shown++;
      const sgn = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
      const x = (a, b, c, d) => sgn(a, b, c) !== sgn(a, b, d) && sgn(c, d, a) !== sgn(c, d, b);
      if (x(pts[0], pts[1], pts[2], pts[3]) || x(pts[1], pts[2], pts[3], pts[0])) crossed++;
    }
    if (i % 10 === 5) await page.screenshot({ path: join(here, 'out', `live-${i}.png`) });
    await page.waitForTimeout(100);
  }
  console.log(`outline visible in ${shown}/${samples} samples, crossed ${crossed}`);
} finally { await browser.close(); try { process.kill(-server.pid); } catch {} process.exit(0); }
