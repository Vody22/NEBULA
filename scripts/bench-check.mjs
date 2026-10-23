// Runs the in-game performance test (?bench) and saves its report:
//   npm run build && npx vite preview --port 4173 &
//   node scripts/bench-check.mjs <label> [level|all]   (→ screenshots/bench/<label>/)
// Under SwiftShader the frame rates mean nothing; the draw calls and
// triangles per scene do (they do not depend on the GPU), and the run proves
// the test works from start to results.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const label = process.argv[2] ?? 'current';
const level = process.argv[3] ?? 'high';
const url = process.env.UI_URL ?? 'http://localhost:4173';
const out = `screenshots/bench/${label}`;
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/fonts\.googleapis|ERR_|net::/.test(m.text()) && errors.push(m.text()));
await page.goto(`${url}/?bench${level === 'all' ? '' : `=${level}`}`, { waitUntil: 'domcontentloaded', timeout: 120000 });

// One screenshot per scene and level, while it runs.
const seen = new Set();
const t0 = Date.now();
while (Date.now() - t0 < 1_500_000) {
  const state = await page.evaluate(() => ({ done: !!window.__bench, text: document.querySelector('#bench span')?.textContent ?? '' }));
  if (state.done) break;
  const m = state.text.match(/^Niveau (\S+) \(\d+\/\d+\) · ([^·]+) ·/);
  if (m && m[2].trim() !== 'préparation') {
    const key = `${m[1]}-${m[2].trim()}`;
    if (!seen.has(key)) {
      seen.add(key);
      // Let the scene settle a little into the segment.
      await page.waitForTimeout(1500);
      const name = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9-]+/g, '_');
      await page.screenshot({ path: `${out}/${name}.png` });
      console.log('captured', name, '·', state.text);
    }
  }
  await page.waitForTimeout(500);
}
const report = await page.evaluate(() => window.__bench);
if (!report) {
  errors.push('the test did not finish');
} else {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/results.png` });
  const text = await page.evaluate(() => document.querySelector('#bench textarea')?.value ?? '');
  fs.writeFileSync(`${out}/report.txt`, text + '\n');
  fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(text);
  for (const l of report.levels)
    for (const s of [...l.segments, l.total]) if (!(s.frames > 0)) errors.push(`no frames recorded: ${l.label} ${s.label}`);
}
if (errors.length) {
  console.log('PAGE ERRORS', errors);
  process.exitCode = 1;
} else console.log('no page errors');
await browser.close();
console.log('BENCH CHECK DONE →', out);
