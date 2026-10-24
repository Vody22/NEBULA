// v0.7 in-browser check of the hyperspace jump, in solo (the server runs in the page):
// HUD hints, charge countdown, change of sector (sky, stations, name), docking at
// Kepler-4, the way back, GPU memory across several jumps, and the touch button.
// Expects a running build at JUMP_URL (default http://localhost:4173).
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const url = process.env.JUMP_URL ?? 'http://localhost:4173';
const out = process.env.JUMP_OUT ?? 'screenshots/jump';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    // ?autostart starts without a click: the browser's autoplay and fullscreen notices are expected then.
    const expected = /fonts\.googleapis|ERR_|net::|GPU stall|GL Driver|AudioContext was not allowed to start|requestFullscreen.*user gesture/i;
    if ((m.type() === 'error' || m.type() === 'warning') && !expected.test(m.text())) errors.push(`${m.type()}: ${m.text()}`);
  });
};

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
watch(page);
await page.goto(`${url}/?q=low&autostart`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__game && window.__game.debug.frames > 5 && window.__game.inspect().myShipId !== null, null, { timeout: 300000 });
await page.mouse.click(640, 360);

/** Waits for a condition evaluated in the page (software rendering: about one frame a second). */
const until = (fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout, polling: 250 }).then(() => true, () => false);
const zoneText = () => page.evaluate(() => document.querySelector('#zone')?.textContent ?? '');
const ticks = (n) =>
  page.evaluate((n) => {
    const s = window.__game.transport.server;
    for (let i = 0; i < n; i++) s.tick();
  }, n);
/** Our ship on the server, moved to open space 3 km in front of its sector's hub and stopped. */
const goOut = () =>
  page.evaluate(() => {
    const s = window.__game.transport.server;
    const id = window.__game.sessionId;
    const w = s.whereIs(id);
    const ship = s.sectors[w.sector].world.ships.get(w.shipId);
    ship.position.set(0, 150, 3000);
    ship.velocity.set(0, 0, 0);
    ship.energy = 1e9;
  });
const memory = () => page.evaluate(() => ({ ...window.__game.renderer.info.memory }));
const jumpTo = async (sector) => {
  await goOut();
  check(await until(() => document.querySelector('#zone .jump.ready') !== null), `${sector}: the HUD offers the jump in open space`);
  await page.keyboard.press('KeyJ');
  check(await until((to) => window.__game.inspect().jump?.to === to, sector), `${sector}: J starts the charge`);
  check(await until(() => /Saut hyperspatial/i.test(document.querySelector('.prompt')?.textContent ?? '')), `${sector}: countdown shown`);
  await page.screenshot({ path: `${out}/charge-to-${sector}.png` });
  await ticks(60 * 6 + 5);
  check(await until((to) => window.__game.inspect().sector === to && window.__game.inspect().myShipId !== null, sector), `${sector}: arrived, ship in the new sector`);
  check(await until(() => document.getElementById('warp')?.classList.contains('reveal')), `${sector}: the flash lifts`);
};

// Near the spawn, 1.1 km from Aurora-7: no jump.
check(await until(() => /plus de 1,5 km/.test(document.querySelector('#zone .jump')?.textContent ?? '')), 'near a station the HUD says to move away to jump');
await page.keyboard.press('KeyJ');
check(await until(() => [...document.querySelectorAll('#feed .notice')].some((n) => /près d'une station/.test(n.textContent))), 'J near a station: the server refuses with a notice');
const before = await memory();

await jumpTo('kepler');
await page.waitForTimeout(4000);
check(/SECTEUR KEPLER/.test(await zoneText()), 'sector name: SECTEUR KEPLER');
const deathShown = await page.evaluate(() => document.getElementById('death').classList.contains('show'));
check(!deathShown, 'no "destroyed" screen after the jump');
await page.screenshot({ path: `${out}/kepler-arrival.png` });
// Look at Kepler-4 from the arrival point: the camera already faces it.
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/kepler-view.png` });

// Dock at Kepler-4.
await page.evaluate(() => {
  const s = window.__game.transport.server;
  const w = s.whereIs(window.__game.sessionId);
  const ship = s.sectors.kepler.world.ships.get(w.shipId);
  const st = s.sectors.kepler.world.zone.stations[0];
  ship.position.copy(st.dock.mouth);
  ship.velocity.set(0, 0, 0);
});
await page.waitForTimeout(1500);
await page.keyboard.press('KeyG');
check(await until(() => window.__game.inspect().pilot?.docked === 'kepler'), 'docked at Kepler-4');
check(await until(() => /Kepler-4/.test(document.querySelector('.station-panel, #station')?.textContent ?? document.body.textContent)), 'station screen names Kepler-4');
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/kepler-hangar.png` });
await page.keyboard.press('KeyJ');
check(await until(() => [...document.querySelectorAll('#feed .notice')].some((n) => /Décollez/.test(n.textContent))), 'J while docked: told to take off first');
await page.evaluate(() => window.__game.transport.send({ t: 'undock' }));
check(await until(() => window.__game.inspect().pilot?.docked === null && window.__game.inspect().myShipId !== null), 'undocked at Kepler-4');

// Cooldown, then back to Aurora.
await ticks(60 * 21);
await jumpTo('aurora');
check(/SECTEUR AURORA/.test(await zoneText()), 'back in SECTEUR AURORA');
await page.waitForTimeout(2000);
await page.screenshot({ path: `${out}/aurora-back.png` });
const back = await memory();

// Two more round trips: GPU memory must not grow with each sector built.
for (let i = 0; i < 2; i++) {
  await ticks(60 * 21);
  await jumpTo('kepler');
  await ticks(60 * 21);
  await jumpTo('aurora');
}
const after = await memory();
console.log('memory', JSON.stringify({ before, back, after }));
check(after.geometries <= back.geometries + 20 && after.textures <= back.textures + 4, `GPU memory stable over round trips (geometries ${back.geometries} → ${after.geometries}, textures ${back.textures} → ${after.textures})`);
check(errors.length === 0, `no console errors or warnings ${errors.join(' | ')}`);
await page.close();

// Touch screen: the SAUT button shows only in open space.
const phone = await browser.newPage({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
watch(phone);
await phone.goto(`${url}/?q=low&autostart&touch`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await phone.waitForFunction(() => window.__game && window.__game.inspect().myShipId !== null, null, { timeout: 300000 });
const jumpBtn = () => phone.evaluate(() => getComputedStyle(document.querySelector('#touch .jump')).display);
check((await jumpBtn()) === 'none', 'touch: no SAUT button near the station');
await phone.evaluate(() => {
  const s = window.__game.transport.server;
  const w = s.whereIs(window.__game.sessionId);
  const ship = s.sectors[w.sector].world.ships.get(w.shipId);
  ship.position.set(0, 150, 3000);
  ship.velocity.set(0, 0, 0);
});
check(await phone.waitForFunction(() => getComputedStyle(document.querySelector('#touch .jump')).display !== 'none', null, { timeout: 120000, polling: 250 }).then(() => true, () => false), 'touch: SAUT button in open space');
await phone.screenshot({ path: `${out}/touch-jump-button.png` });
await phone.tap('#touch .jump');
check(await phone.waitForFunction(() => window.__game.inspect().jump?.to === 'kepler', null, { timeout: 60000, polling: 250 }).then(() => true, () => false), 'touch: SAUT starts the charge');
await phone.screenshot({ path: `${out}/touch-charging.png` });
check(errors.length === 0, `touch: no console errors or warnings ${errors.join(' | ')}`);

await browser.close();
console.log(failed ? `JUMP CHECK FAILED (${failed})` : 'JUMP CHECK OK');
process.exit(failed ? 1 : 0);
