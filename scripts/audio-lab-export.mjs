// Records every scene of the audio lab (audio-lab.html, served by `npx vite`)
// in headless Chromium and writes one WAV per scene, plus a summary with the
// loudest sample and the engine counters. Usage:
//   npx vite --port 5173 &   then   node scripts/audio-lab-export.mjs [outDir]
// The sound is rendered by Chromium's real Web Audio engine in real time.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.LAB_URL ?? 'http://localhost:5173/audio-lab.html';
const out = process.argv[2] ?? 'screenshots/audio';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__lab, null, { timeout: 60000 });
await page.evaluate(() => window.__lab.audio.unlock());
const t0 = Date.now();
await page.waitForFunction(() => window.__lab.audio.report().loaded >= window.__lab.audio.report().total, null, { timeout: 120000 });
console.log(`bank rendered in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

function wav(pcm, rate) {
  const data = Buffer.from(pcm, 'base64');
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const scenes = await page.evaluate(() => window.__lab.scenes);
const summary = [];
for (const s of scenes) {
  const [r] = await page.evaluate((id) => window.__lab.record([id]), s.id);
  const file = path.join(out, `${r.id}.wav`);
  fs.writeFileSync(file, wav(r.pcm, r.rate));
  const seconds = Buffer.from(r.pcm, 'base64').length / 4 / r.rate;
  const pcm = new Int16Array(Buffer.from(r.pcm, 'base64').buffer.slice(0));
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 32768) ** 2;
  const rms = Math.sqrt(sum / Math.max(1, pcm.length));
  const rep = await page.evaluate(() => window.__lab.audio.report());
  summary.push({ id: r.id, seconds: +seconds.toFixed(1), peak: +r.peak.toFixed(3), rmsDb: +(20 * Math.log10(rms + 1e-9)).toFixed(1), voices: rep.voices, music: rep.music });
  console.log(JSON.stringify(summary.at(-1)));
  console.log('   music', r.timeline.filter((x, i, a) => i === 0 || x.split(':')[1] !== a[i - 1].split(':')[1]).join(' '));
}
const final = await page.evaluate(() => window.__lab.audio.report());
console.log('report', JSON.stringify(final));
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ summary, final, errors }, null, 1));
console.log(errors.length ? 'ERRORS\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
