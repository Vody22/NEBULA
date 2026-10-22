// Phones and tablets: touch controls and layout, in emulated mobile Chromium
// (touch events, coarse pointer) against the real Node server.
//   npm run build && node scripts/mobile-check.mjs
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const out = process.env.MOBILE_OUT ?? 'screenshots/mobile';
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync('.mp-check', { recursive: true });
await build({ entryPoints: ['src/server/node/server.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: '.mp-check/server.mjs', logLevel: 'warning' });
const { startServer } = await import(pathToFileURL('.mp-check/server.mjs').href);
const server = await startServer({ port: 0, host: '127.0.0.1', staticDir: 'dist', npcs: false, log: () => {} });
const base = `http://127.0.0.1:${server.port}`;

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function phone(viewport, query = '') {
  const ctx = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'fr-FR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/fonts\.googleapis|ERR_|net::/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`${base}/${query}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__menu?.isOpen, null, { timeout: 300000 });
  const cdp = await ctx.newCDPSession(page);
  // Raw multi-touch, like two thumbs on the glass.
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id })) });
  const center = (sel) =>
    page.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    }, sel);
  const frames = async (n) => {
    const f0 = await page.evaluate(() => window.__game.debug.frames);
    await page.waitForFunction((f) => window.__game.debug.frames >= f, f0 + n, { timeout: 120000, polling: 100 });
  };
  return { ctx, page, errors, touch, center, frames };
}

const boxes = (page, sels) =>
  page.evaluate((list) => {
    const out = {};
    for (const s of list) {
      const el = document.querySelector(s);
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('.hidden')) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height) out[s] = [r.left, r.top, r.right, r.bottom];
    }
    return out;
  }, sels);
const hit = (a, b) => a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1;
const CONTROLS = ['#touch .fire', '#touch .boost', '#touch .target', '#touch .stop', '#touch .roll-l', '#touch .roll-r', '#touch .throttle', '#touch .tbar:not(.netbar)', '#touch.online .netbar'];
const HUD = ['#status', '#flight', '#radarWrap', '#topbar', '#zone', '#chat'];
const HUD_PAIRS = [['#topbar', '#zone .name'], ['#topbar', '#zone .net'], ['#topbar', '#status'], ['#zone', '#flight'], ['#flight', '#radarWrap'], ['#status', '#radarWrap']];
async function layoutCheck(page, label) {
  const b = await boxes(page, [...CONTROLS, ...HUD, '#zone .name', '#zone .net']);
  const clashes = [];
  for (const c of CONTROLS) for (const h of HUD) if (b[c] && b[h] && hit(b[c], b[h])) clashes.push(`${c} × ${h}`);
  for (let i = 0; i < CONTROLS.length; i++) for (let j = i + 1; j < CONTROLS.length; j++) if (b[CONTROLS[i]] && b[CONTROLS[j]] && hit(b[CONTROLS[i]], b[CONTROLS[j]])) clashes.push(`${CONTROLS[i]} × ${CONTROLS[j]}`);
  for (const [x, y] of HUD_PAIRS) if (b[x] && b[y] && hit(b[x], b[y])) clashes.push(`${x} × ${y}`);
  const vw = await page.evaluate(() => [innerWidth, innerHeight]);
  const offscreen = Object.entries(b).filter(([, r]) => r[0] < -1 || r[1] < -1 || r[2] > vw[0] + 1 || r[3] > vw[1] + 1).map(([s]) => s);
  check(clashes.length === 0 && offscreen.length === 0, `${label}: controls clear of the HUD and on screen (${[...clashes, ...offscreen.map((s) => `${s} off screen`)].join(', ') || 'ok'})`);
}

try {
  // ---- 1. Phone in landscape, solo --------------------------------------------
  const P = await phone({ width: 844, height: 390 });
  const media = await P.page.evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches, touch: document.body.classList.contains('touch') }));
  check(media.coarse && media.touch, `phone detected as a touch device (coarse pointer ${media.coarse}, touch mode ${media.touch})`);
  const menuText = await P.page.evaluate(() => document.getElementById('menu').textContent);
  check(menuText.includes('Commandes tactiles') && !menuText.includes('Clavier et souris requis'), 'start menu explains the touch controls instead of refusing the device');
  const quality = await P.page.evaluate(() => window.__game.renderPath);
  check(quality === 'direct', `lighter rendering by default on mobile (${quality})`);
  await P.page.screenshot({ path: `${out}/phone-menu.png` });
  await P.page.tap('[data-act="solo"]');
  await P.page.waitForFunction(() => window.__game.running, null, { timeout: 120000 });
  await P.frames(3);
  const vis = await P.page.evaluate(() => ({
    touch: !document.getElementById('touch').classList.contains('hidden'),
    capture: getComputedStyle(document.getElementById('capture')).display,
    online: getComputedStyle(document.querySelector('#touch .tbar [data-tap="pvp"]')).display,
  }));
  check(vis.touch && vis.capture === 'none', 'touch controls shown in flight, no "capture the mouse" hint');
  check(vis.online === 'none', 'online-only buttons (chat, PvP, pilots) hidden in solo');
  await layoutCheck(P.page, 'phone 844×390');
  await P.page.screenshot({ path: `${out}/phone-flight.png` });

  // Throttle slider: drag to the top.
  const thr = await P.page.evaluate(() => {
    const r = document.querySelector('#touch .throttle').getBoundingClientRect();
    return [r.left + r.width / 2, r.top, r.bottom];
  });
  await P.touch('touchStart', [[thr[0], thr[2] - 10, 1]]);
  await P.touch('touchMove', [[thr[0], thr[1] + 2, 1]]);
  await P.touch('touchEnd', []);
  await P.frames(2);
  const throttle = await P.page.evaluate(() => window.__game.input.input.throttle);
  check(throttle > 0.95, `GAZ slider sets full throttle (${throttle.toFixed(2)})`);

  // Left thumb steers, right thumb fires, at the same time.
  const fire = await P.center('#touch .fire');
  await P.touch('touchStart', [[180, 250, 2]]);
  await P.touch('touchMove', [[240, 250, 2]]);
  await P.touch('touchStart', [[240, 250, 2], [fire[0], fire[1], 3]]);
  const shots0 = await P.page.evaluate(() => window.__game.debug.myShots);
  await P.frames(6);
  const held = await P.page.evaluate(() => ({ yaw: window.__game.input.input.yaw, fire: window.__game.input.input.fire, cursor: { ...window.__game.input.cursor } }));
  check(held.yaw > 0.5 && held.fire, `two thumbs: stick turns right (yaw ${held.yaw.toFixed(2)}) while FEU fires (${held.fire})`);
  await P.page.screenshot({ path: `${out}/phone-stick-fire.png` });
  await P.page.waitForFunction((n) => window.__game.debug.myShots > n, shots0, { timeout: 60000, polling: 200 }).catch(() => {});
  const shots = await P.page.evaluate(() => window.__game.debug.myShots);
  check(shots > shots0, `FEU button shoots lasers (${shots - shots0} shots)`);
  await P.touch('touchEnd', []);
  await P.frames(2);
  const released = await P.page.evaluate(() => ({ yaw: window.__game.input.input.yaw, fire: window.__game.input.input.fire }));
  check(released.yaw === 0 && !released.fire, 'lifting both thumbs recentres the stick and stops firing');

  // Boost (hold) and STOP (tap).
  const boost = await P.center('#touch .boost');
  await P.touch('touchStart', [[boost[0], boost[1], 4]]);
  await P.frames(2);
  const boosting = await P.page.evaluate(() => window.__game.input.input.boost);
  await P.touch('touchEnd', []);
  check(boosting, 'BOOST button boosts while held');
  await P.page.tap('#touch .stop');
  await P.frames(2);
  check((await P.page.evaluate(() => window.__game.input.input.throttle)) === 0, 'STOP button cuts the throttle');

  // Pause button opens the menu, Reprendre resumes.
  await P.page.tap('#touch .pause');
  await P.page.waitForFunction(() => window.__menu.isOpen, null, { timeout: 30000 });
  const paused = await P.page.evaluate(() => ({ paused: window.__game.paused, touch: document.getElementById('touch').classList.contains('hidden') }));
  check(paused.paused && paused.touch, 'II button pauses and hides the controls');
  await P.page.screenshot({ path: `${out}/phone-pause.png` });
  await P.page.tap('[data-act="resume"]');
  await P.page.waitForFunction(() => !window.__menu.isOpen && !window.__game.paused, null, { timeout: 30000 });
  check(true, 'Reprendre resumes the flight');
  check(P.errors.length === 0, `no page errors on the phone (${P.errors.join(' | ')})`);

  // ---- 2. Other screens -------------------------------------------------------
  for (const [vp, label] of [
    [{ width: 667, height: 375 }, 'small phone 667×375'],
    [{ width: 1024, height: 768 }, 'tablet 1024×768'],
    [{ width: 768, height: 1024 }, 'tablet portrait 768×1024'],
  ]) {
    await P.page.setViewportSize(vp);
    await P.frames(3);
    await layoutCheck(P.page, label);
    await P.page.screenshot({ path: `${out}/${label.split(' ').pop()}.png` });
  }
  await P.page.setViewportSize({ width: 390, height: 844 });
  await P.frames(2);
  const rotate = await P.page.evaluate(() => getComputedStyle(document.querySelector('#touch .rotate')).display);
  check(rotate !== 'none', 'phone held upright: asks to turn the device');
  await P.page.screenshot({ path: `${out}/phone-portrait.png` });
  await P.page.setViewportSize({ width: 844, height: 390 });
  await P.frames(2);
  check((await P.page.evaluate(() => getComputedStyle(document.querySelector('#touch .rotate')).display)) === 'none', 'turned back to landscape: the game is visible again');
  await P.ctx.close();

  // ---- 3. Online on a phone ---------------------------------------------------
  const O = await phone({ width: 844, height: 390 }, `?server=ws://127.0.0.1:${server.port}/ws`);
  await O.page.waitForFunction(() => document.querySelector('#serverStatus.ok'), null, { timeout: 120000 });
  await O.page.fill('#pilotName', 'Mobile');
  await O.page.tap('[data-act="online"]');
  await O.page.waitForFunction(() => window.__game.running && window.__game.inspect().status?.state === 'online', null, { timeout: 120000 });
  await O.frames(3);
  const onlineBtns = await O.page.evaluate(() => [...document.querySelectorAll('#touch .tbar .online')].map((b) => getComputedStyle(b).display));
  check(onlineBtns.length === 3 && onlineBtns.every((d) => d !== 'none'), 'online: CHAT, PVP and PILOTES buttons shown');
  await layoutCheck(O.page, 'phone online 844×390');
  await O.page.tap('#touch [data-tap="pvp"]');
  await O.page.waitForFunction(() => window.__game.inspect().myPvp === true, null, { timeout: 30000 }).catch(() => {});
  check((await O.page.evaluate(() => window.__game.inspect().myPvp)) === true, 'PVP button switches PvP on (confirmed by the server)');
  await O.page.tap('#touch [data-act="chat"]');
  await O.page.waitForFunction(() => document.getElementById('chat').classList.contains('open'), null, { timeout: 10000 }).catch(() => {});
  const chatOpen = await O.page.evaluate(() => ({ open: document.getElementById('chat').classList.contains('open'), focus: document.activeElement?.tagName, touch: document.getElementById('touch').classList.contains('hidden') }));
  check(chatOpen.open && chatOpen.focus === 'INPUT', `CHAT button opens the chat field (keyboard) ${JSON.stringify(chatOpen)}`);
  await O.page.keyboard.type('salut depuis mobile');
  await O.page.keyboard.press('Enter');
  await O.page.waitForFunction(() => document.querySelector('#chat .log')?.textContent.includes('salut depuis mobile'), null, { timeout: 20000 }).catch(() => {});
  check((await O.page.evaluate(() => document.querySelector('#chat .log').textContent)).includes('salut depuis mobile'), 'chat message sent from the phone');
  await O.frames(3);
  check(!(await O.page.evaluate(() => document.getElementById('touch').classList.contains('hidden'))), 'controls come back after sending');
  await O.page.screenshot({ path: `${out}/phone-online.png` });
  check(O.errors.length === 0, `no page errors online (${O.errors.join(' | ')})`);
  await O.ctx.close();
} catch (e) {
  check(false, `script error: ${e.message}`);
} finally {
  await browser.close();
  await server.close();
}
console.log(failures.length ? `MOBILE CHECK FAILED (${failures.length})` : 'MOBILE CHECK OK');
process.exit(failures.length ? 1 : 0);
