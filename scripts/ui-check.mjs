// In-browser UI and gameplay check (expects `vite preview` on UI_URL, default
// http://localhost:4173). Verifies HUD layout at several window sizes, the
// pause menu (simulation frozen, keyboard navigation, rebinding, persisted
// settings) and that both fire controls shoot. Writes screenshots to UI_OUT.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const url = process.env.UI_URL ?? 'http://localhost:4173';
const out = process.env.UI_OUT ?? 'screenshots/ui';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const HUD_IDS = ['zone', 'topbar', 'flight', 'status', 'radarWrap', 'feed', 'chat'];

async function open(viewport, query = 'q=low') {
  const ctx = await browser.newContext({ viewport, locale: 'fr-FR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !/fonts\.googleapis|ERR_|net::|GPU stall|GL Driver/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`${url}/?${query}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__game && window.__game.debug.frames > 1 && window.__menu?.isOpen, null, { timeout: 300000 });
  return { ctx, page, errors };
}

function rects(page) {
  return page.evaluate((ids) => {
    const r = {};
    for (const id of ids) {
      const e = document.getElementById(id);
      if (!e) continue;
      const b = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      r[id] = { x: b.x, y: b.y, w: b.width, h: b.height, visible: cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 };
    }
    return { r, vw: innerWidth, vh: innerHeight };
  }, HUD_IDS);
}

function overlaps(a, b) {
  return a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
}

// ---- Layout at three window sizes -------------------------------------------
for (const [w, h] of [[568, 1244], [1280, 720], [1920, 1080]]) {
  const { ctx, page, errors } = await open({ width: w, height: h });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/start-${w}x${h}.png` });
  await page.click('[data-act="solo"]');
  await page.waitForFunction(() => !window.__menu.isOpen, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/hud-${w}x${h}.png` });
  const { r, vw, vh } = await rects(page);
  for (const id of ['zone', 'topbar', 'flight', 'status', 'radarWrap']) {
    const e = r[id];
    check(e && e.visible && e.x >= 0 && e.y >= 0 && e.x + e.w <= vw + 0.5 && e.y + e.h <= vh + 0.5, `${w}x${h}: #${id} visible and inside the window`);
  }
  const ids = Object.keys(r).filter((k) => r[k].visible && k !== 'feed');
  check(!r.chat?.visible, `${w}x${h}: no chat panel in solo`);
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) check(!overlaps(r[ids[i]], r[ids[j]]), `${w}x${h}: #${ids[i]} does not overlap #${ids[j]}`);
  check(errors.length === 0, `${w}x${h}: no console errors/warnings ${errors.join(' | ')}`);
  await ctx.close();
}

// ---- Pause menu, keyboard navigation, rebinding, persistence ----------------
{
  const { ctx, page, errors } = await open({ width: 1280, height: 720 });
  await page.click('[data-act="solo"]');
  await page.waitForFunction(() => !window.__menu.isOpen);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyW');

  await page.keyboard.press('Escape');
  check(await page.evaluate(() => window.__menu.isOpen && window.__menu.mode === 'pause'), 'Échap opens the pause menu');
  const t0 = await page.evaluate(() => ({ tick: window.__game.transport.server.world.tick, frames: window.__game.debug.frames }));
  await page.waitForTimeout(2500);
  const t1 = await page.evaluate(() => ({ tick: window.__game.transport.server.world.tick, frames: window.__game.debug.frames }));
  check(t1.tick === t0.tick, `simulation frozen while paused (tick ${t0.tick} → ${t1.tick})`);
  check(t1.frames > t0.frames, 'scene keeps rendering behind the pause menu');
  await page.screenshot({ path: `${out}/pause-1280x720.png` });

  const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim() + '|' + (document.activeElement?.matches(':focus-visible') ?? false));
  check((await focused()).startsWith('Reprendre'), `focus starts on Reprendre (${await focused()})`);
  await page.keyboard.press('Tab');
  check((await focused()).startsWith('Commandes'), `Tab moves focus to Commandes (${await focused()})`);
  check((await focused()).endsWith('|true'), 'keyboard focus is visible (:focus-visible)');
  await page.keyboard.press('Enter');
  check(await page.evaluate(() => window.__menu.view === 'controls'), 'Entrée opens the controls view');
  await page.screenshot({ path: `${out}/controls-1280x720.png` });

  // Rebind "fire" from F to G via the keyboard.
  await page.focus('[data-bind="fire"]');
  await page.keyboard.press('Enter');
  check(await page.evaluate(() => document.querySelector('[data-bind="fire"]').textContent.includes('Appuyez')), 'rebind button waits for a key');
  await page.keyboard.press('KeyG');
  check(await page.evaluate(() => window.__game.settings?.bindings?.fire ?? JSON.parse(localStorage.getItem('nebula-frontier.settings')).bindings.fire) === 'KeyG', 'fire rebound to G');
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('nebula-frontier.settings')).bindings.fire === 'KeyG'), 'rebinding saved to localStorage');

  // Layout labels.
  await page.selectOption('#layoutSel', 'qwerty');
  const qwerty = await page.evaluate(() => document.querySelector('[data-bind="throttleUp"]').textContent.trim());
  await page.selectOption('#layoutSel', 'azerty');
  const azerty = await page.evaluate(() => document.querySelector('[data-bind="throttleUp"]').textContent.trim());
  check(qwerty === 'W' && azerty === 'Z', `throttle key shown as W (QWERTY) / Z (AZERTY): ${qwerty} / ${azerty}`);

  await page.keyboard.press('Escape');
  check(await page.evaluate(() => window.__menu.isOpen && window.__menu.view === 'main'), 'Échap in a sub-view goes back to the pause menu');
  await page.keyboard.press('Escape');
  check(await page.evaluate(() => !window.__menu.isOpen && !window.__game.paused), 'Échap on the pause menu resumes');
  const t2 = await page.evaluate(() => window.__game.transport.server.world.tick);
  await page.waitForTimeout(1500);
  const t3 = await page.evaluate(() => window.__game.transport.server.world.tick);
  check(t3 > t2, `simulation runs again after resume (tick ${t2} → ${t3})`);

  // Fire with the rebound key, then with the mouse.
  const shots = () => page.evaluate(() => window.__game.debug.myShots);
  let s0 = await shots();
  await page.keyboard.down('KeyG');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyG');
  await page.waitForTimeout(300);
  let s1 = await shots();
  check(s1 > s0, `rebound fire key shoots (${s1 - s0} shots)`);
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.waitForTimeout(1500);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const s2 = await shots();
  check(s2 > s1, `left click shoots (${s2 - s1} shots)`);

  // Options persist across a reload.
  await page.keyboard.press('Escape');
  await page.click('[data-act="options"]');
  await page.fill('[data-setting="volume"]', '40');
  await page.dispatchEvent('[data-setting="volume"]', 'input');
  await page.screenshot({ path: `${out}/options-1280x720.png` });
  check(errors.length === 0, `pause flow: no console errors/warnings ${errors.join(' | ')}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__menu?.isOpen, null, { timeout: 300000 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('nebula-frontier.settings')));
  check(saved.volume === 0.4 && saved.bindings.fire === 'KeyG', `settings survive a reload (volume ${saved.volume}, fire ${saved.bindings.fire})`);
  await page.click('[data-act="controls"]');
  await page.click('[data-act="reset-binds"]');
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('nebula-frontier.settings')).bindings.fire === 'KeyF'), '"Touches par défaut" restores F');
  await ctx.close();
}

// ---- F key with defaults, kill credit and energy lock in the real client ---
{
  const { ctx, page, errors } = await open({ width: 1280, height: 720 });
  await page.click('[data-act="solo"]');
  await page.waitForFunction(() => !window.__menu.isOpen);
  await page.evaluate(() => {
    const s = window.__game.transport.server;
    const me = [...s.world.ships.values()].find((x) => x.ownerId);
    me.velocity.set(0, 0, 0);
    const fwd = me.position.clone().add(me.velocity.clone().set(0, 0, -1).applyQuaternion(me.rotation).multiplyScalar(250));
    const t = s.world.spawnShip({ classId: 'raider', faction: 'raiders', name: 'Cible test', position: fwd });
    t.shield = 0;
    t.hull = 6;
  });
  await page.keyboard.down('KeyF');
  await page.waitForTimeout(3000);
  await page.keyboard.up('KeyF');
  await page.waitForTimeout(1500);
  const d = await page.evaluate(() => ({ ...window.__game.debug }));
  check(d.myShots > 0, `F shoots (${d.myShots} shots)`);
  check(d.myHits > 0 && d.myKills >= 1, `hits and kill registered for the player (hits ${d.myHits}, kills ${d.myKills})`);
  await page.screenshot({ path: `${out}/kill-1280x720.png` });

  // Drain the capacitor and check the HUD warning is text, not colour only.
  await page.evaluate(() => {
    const s = window.__game.transport.server;
    const me = [...s.world.ships.values()].find((x) => x.ownerId);
    me.energy = 1;
  });
  await page.keyboard.down('KeyF');
  await page.waitForTimeout(1500);
  const chip = await page.evaluate(() => document.getElementById('hud').textContent);
  await page.screenshot({ path: `${out}/weapons-locked-1280x720.png` });
  await page.keyboard.up('KeyF');
  check(/ARMES EN RECHARGE/.test(chip), 'empty capacitor shows "ARMES EN RECHARGE"');
  check(errors.length === 0, `combat: no console errors/warnings ${errors.join(' | ')}`);
  await ctx.close();
}

// ---- Touch-only device warning ------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'fr-FR' });
  const page = await ctx.newPage();
  await page.goto(`${url}/?q=low`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__menu?.isOpen, null, { timeout: 300000 });
  const warn = await page.evaluate(() => document.querySelector('.device-warning')?.textContent ?? '');
  check(/Clavier et souris requis/.test(warn), 'touch-only device shows "Clavier et souris requis"');
  await page.screenshot({ path: `${out}/touch-390x844.png` });
  await ctx.close();
}

await browser.close();
console.log(failures.length ? `UI CHECK FAILED (${failures.length})` : 'UI CHECK OK');
process.exit(failures.length ? 1 : 0);
