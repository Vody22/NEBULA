// Ship close-ups in the hangar viewer (hangar.html), same cameras every time.
//   npx vite --port 5180 &   (or vite preview)
//   node scripts/ship-capture.mjs <label> [ship=falcon]   → screenshots/ships/<label>/
//   GLB=1 also writes screenshots/ships/<label>/<ship>.glb
// Software rendering (SwiftShader): for comparing images, not for frame rates.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const label = process.argv[2] ?? 'current';
const ship = process.argv[3] ?? 'falcon';
const url = process.env.HANGAR_URL ?? 'http://localhost:5180/hangar.html';
const out = `screenshots/ships/${label}`;
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`${url}?clean&ship=${ship}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => window.__hangar && window.__hangar.frames > 5, null, { timeout: 300000, polling: 500 });
const info = await page.evaluate(() => window.__hangar.stats());
console.log(JSON.stringify(info));
fs.writeFileSync(`${out}/${ship}-stats.json`, JSON.stringify(info, null, 2));

const views = (process.env.VIEWS ?? 'hero,side,rear,top,front,cockpit,belly').split(',');
for (const v of views) {
  await page.evaluate((name) => {
    window.__hangar.setView(name);
    window.__hangar.angular = name === 'rear' ? [0.9, 0.4, 0.6] : [0, 0, 0];
  }, v);
  const f0 = await page.evaluate(() => window.__hangar.frames);
  await page.waitForFunction((f) => window.__hangar.frames > f + 3, f0, { timeout: 120000, polling: 200 });
  await page.screenshot({ path: `${out}/${ship}-${v}.png` });
  console.log('captured', v);
}
if (process.env.GLB) {
  const b64 = await page.evaluate(() => window.__hangar.exportGlbBase64());
  fs.writeFileSync(`${out}/${ship}.glb`, Buffer.from(b64, 'base64'));
  console.log('glb', Math.round((b64.length * 0.75) / 1024), 'KB');
}
console.log(errors.length ? `errors: ${errors.join(' | ')}` : 'no page errors');
await browser.close();
console.log(`SHIP CAPTURE DONE → ${out}`);
