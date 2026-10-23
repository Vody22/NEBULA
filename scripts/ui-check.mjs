// In-browser UI and gameplay check (expects `vite preview` on UI_URL, default
// http://localhost:4173). Verifies HUD layout at several window sizes, the
// pause menu (simulation frozen, keyboard navigation, rebinding, persisted
// settings), that both fire controls shoot, the v0.3 loop (docking, trading,
// take-off, mining) and the v0.4 solo save. Writes screenshots to UI_OUT.
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
  // Software rendering can go a few seconds without a frame: wait for the next ticks rather than a fixed delay.
  await page.waitForFunction((t) => window.__game.transport.server.world.tick > t, t2, { timeout: 20000, polling: 250 }).catch(() => {});
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
  // Software rendering runs this page at a few frames per second: wait for the bolt to land rather than a fixed delay.
  await page.waitForFunction(() => window.__game.debug.myKills >= 1, null, { timeout: 20000, polling: 250 }).catch(() => {});
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

// ---- v0.3: dock with G, trade at the station screen, take off, mine with R ----
{
  const { ctx, page, errors } = await open({ width: 1280, height: 720 });
  await page.click('[data-act="solo"]');
  await page.waitForFunction(() => !window.__menu.isOpen && window.__game.inspect().pilot);
  const me = `[...window.__game.transport.server.world.ships.values()].find((x) => x.ownerId)`;
  await page.evaluate(`(() => { const s = ${me}; const z = window.__game.transport.server.world.zone;
    window.__game.input.input.throttle = 0; s.position.copy(z.station.dock.mouth).add({ x: 0, y: 0, z: 100 }); s.velocity.set(0, 0, 0); s.rotation.set(0, 0, 0, 1); })()`);
  const zone = await page.waitForFunction(() => window.__game.inspect().dockable, null, { timeout: 30000 }).then(() => true, () => false);
  const prompt = await page.evaluate(() => document.querySelector('.prompt')?.textContent ?? '');
  check(zone && /amarrer/.test(prompt), `docking zone detected and the HUD says to press G (${prompt})`);
  await page.keyboard.press('KeyG');
  const docked = await page.waitForFunction(() => window.__game.inspect().stationScreen && window.__game.inspect().pilot.docked === 'aurora', null, { timeout: 30000 }).then(() => true, () => false);
  check(docked && !(await page.evaluate(() => document.getElementById('death').classList.contains('show'))), 'G docks: station screen open, no death screen');
  await page.screenshot({ path: `${out}/station-screen.png` });
  await page.click('#station .qty button[data-qty="10"]');
  await page.click('#station tr[data-item="water"] button[data-trade="buy"]');
  const bought = await page.waitForFunction(() => window.__game.inspect().pilot.cargo.water === 10, null, { timeout: 30000 }).then(() => true, () => false);
  const credits = await page.evaluate(() => window.__game.inspect().pilot.credits);
  check(bought && credits < 500, `buying 10 water fills the hold and costs credits (${credits} cr left)`);
  await page.click('#station .qty button[data-qty="max"]');
  await page.click('#station tr[data-item="water"] button[data-trade="sell"]');
  const sold = await page.waitForFunction(() => !window.__game.inspect().pilot.cargo.water, null, { timeout: 30000 }).then(() => true, () => false);
  check(sold, '"Max" sells the whole stack');
  await page.click('#station .undock');
  const out1 = await page.waitForFunction(() => window.__game.inspect().myShipId != null && !window.__game.inspect().stationScreen, null, { timeout: 30000 }).then(() => true, () => false);
  check(out1, 'take-off puts the ship back in space and closes the station screen');
  // Mining: a rock 140 m ahead with nothing else in the way.
  const aimed = await page.evaluate(`(() => {
    const srv = window.__game.transport.server; const z = srv.world.zone; const s = ${me};
    const V = z.station.position.constructor; const Q = s.rotation.constructor;
    for (let i = 0; i < z.asteroids.length; i++) {
      const a = z.asteroids[i]; if (a.radius > 60 || a.radius < 15) continue;
      for (const d of [[1, 0.2, 0.1], [-1, 0.1, 0.3], [0.2, 1, 0], [0, -1, 0.2]]) {
        const dir = new V(...d).normalize();
        const p = a.position.clone().addScaledVector(dir, a.radius + 140);
        let clear = true;
        for (let k = 0; k <= 10 && clear; k++) {
          const q = p.clone().lerp(a.position, (k / 10) * (140 / (a.radius + 140)));
          clear = !srv.world.grid.query(q, 80).some((c) => c.index !== i && c.center.distanceTo(q) < c.radius / 0.85 + 40);
        }
        if (!clear) continue;
        window.__game.input.input.throttle = 0; window.__game.input.centerCursor();
        s.position.copy(p); s.velocity.set(0, 0, 0); s.angularVelocity.set(0, 0, 0);
        s.rotation.copy(new Q().setFromUnitVectors(new V(0, 0, -1), dir.clone().negate()));
        return true;
      }
    }
    return false;
  })()`);
  await page.keyboard.down('KeyR');
  const beam = await page.waitForFunction(() => window.__game.inspect().beams > 0, null, { timeout: 60000 }).then(() => true, () => false);
  const readout = await page.evaluate(() => document.querySelector('.mining')?.textContent ?? '');
  check(aimed && beam && /Extraction/.test(readout), `holding R draws the beam and the HUD shows the rock (${readout})`);
  await page.screenshot({ path: `${out}/mining.png` });
  const ore = await page.waitForFunction(() => Object.keys(window.__game.inspect().pilot.cargo).length > 0, null, { timeout: 240000, polling: 500 }).then(() => true, () => false);
  await page.keyboard.up('KeyR');
  check(ore, `ore reaches the hold (${JSON.stringify(await page.evaluate(() => window.__game.inspect().pilot.cargo))})`);
  // v0.4: solo progress stays in this browser. Reload, solo again: back in the Aurora-7 hangar with the same hold and wallet.
  const wallet = () => page.evaluate(() => {
    const p = window.__game.inspect().pilot;
    return { credits: p.credits, cargo: Object.fromEntries(Object.entries(p.cargo).sort()) };
  });
  const before = await wallet();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.debug.frames > 1 && window.__menu?.isOpen, null, { timeout: 300000 });
  await page.click('[data-act="solo"]');
  const resumed = await page.waitForFunction(() => window.__game.inspect().pilot?.docked === 'aurora' && window.__game.inspect().stationScreen, null, { timeout: 60000 }).then(() => true, () => false);
  const after = await wallet();
  check(
    resumed && JSON.stringify(after) === JSON.stringify(before),
    `solo progress survives a reload: docked at Aurora-7, ${after.credits} cr, hold ${JSON.stringify(after.cargo)} (before: ${before.credits} cr, ${JSON.stringify(before.cargo)})`,
  );
  await page.screenshot({ path: `${out}/solo-resumed.png` });
  // v0.5: the shipyard tab. A rich pilot fits an upgrade, buys the Warden and takes off in it.
  await page.evaluate(() => {
    const s = [...window.__game.transport.server.sessions.values()][0];
    s.stats.credits = 20000;
    s.pilotDirty = true;
  });
  await page.waitForFunction(() => window.__game.inspect().pilot.credits === 20000, null, { timeout: 30000 });
  await page.click('#station [data-tab="yard"]');
  const yard = await page.evaluate(() => ({
    shown: getComputedStyle(document.querySelector('#station .pane-yard')).display !== 'none',
    market: getComputedStyle(document.querySelector('#station .pane-market')).display,
    rows: document.querySelectorAll('#station .mods li').length,
    ship: document.querySelector('#station .sname').textContent,
  }));
  check(yard.shown && yard.market === 'none' && yard.rows === 6 && /Falcon/.test(yard.ship), `the Chantier tab shows the ship flown and six upgrades (${JSON.stringify(yard)})`);
  await page.screenshot({ path: `${out}/shipyard.png` });
  await page.click('#station .mods li[data-slot="armor"] button');
  const fitted = await page.waitForFunction(() => window.__game.inspect().pilot.fleet[0].mods.armor === 1, null, { timeout: 30000 }).then(() => true, () => false);
  const fp = await page.evaluate(() => window.__game.inspect().pilot);
  const pips = await page.evaluate(() => document.querySelectorAll('#station .mods li[data-slot="armor"] .pips i.on').length);
  check(fitted && fp.credits === 19500 && fp.hullMax > 260 && pips === 1, `armor level 1 fitted: ${fp.credits} cr left, hull ${fp.hull}/${fp.hullMax}, ${pips} pip lit`);
  await page.click('#station .fleet li[data-ship="warden"] button');
  const boughtShip = await page.waitForFunction(() => window.__game.inspect().pilot.ship === 'warden', null, { timeout: 30000 }).then(() => true, () => false);
  const wp = await page.evaluate(() => window.__game.inspect().pilot);
  const flownLabel = await page.evaluate(() => document.querySelector('#station .fleet li.flown .n').firstChild.textContent);
  check(boughtShip && wp.capacity === 60 && wp.fleet.length === 2 && flownLabel === 'Warden', `Warden bought and flown: hold ${wp.capacity}, ${wp.credits} cr, ${wp.fleet.length} ships in the hangar`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/shipyard-warden.png` });
  await page.click('#station .undock');
  const inWarden = await page.waitForFunction(() => {
    const g = window.__game.inspect();
    const s = [...window.__game.transport.server.world.ships.values()].find((x) => x.ownerId);
    return g.myShipId != null && !g.stationScreen && s?.classId === 'warden';
  }, null, { timeout: 30000 }).then(() => true, () => false);
  check(inWarden, 'take-off in the Warden');
  // v0.6: contracts. A courier job taken at Aurora-7 is shown in flight and paid on docking at Ferro-9.
  const dockAt = (station) => page.evaluate((id) => {
    const srv = window.__game.transport.server;
    const st = srv.world.zone.stations.find((x) => x.id === id);
    const s = [...srv.world.ships.values()].find((x) => x.ownerId);
    window.__game.input.input.throttle = 0;
    s.position.copy(st.dock.mouth); s.velocity.set(0, 0, 0);
    window.__game.transport.send({ t: 'dock' });
  }, station);
  await page.evaluate(() => {
    window.__game.transport.server.boards.aurora.offers[0] = { id: 9001, kind: 'courier', station: 'aurora', target: 'ferro', count: 5, progress: 0, reward: 350 };
  });
  await dockAt('aurora');
  await page.waitForFunction(() => window.__game.inspect().stationScreen && window.__game.inspect().pilot.docked === 'aurora', null, { timeout: 30000 });
  await page.click('#station [data-tab="jobs"]');
  const board = await page.evaluate(() => ({
    shown: getComputedStyle(document.querySelector('#station .pane-jobs')).display !== 'none',
    offers: document.querySelectorAll('#station .jobs.offers button[data-accept]').length,
    first: document.querySelector('#station .jobs.offers li .n')?.textContent ?? '',
  }));
  check(board.shown && board.offers >= 1 && /Livraison : 5 caisses pour Ferro-9/.test(board.first), `the Missions tab lists the station's contracts (${JSON.stringify(board)})`);
  await page.screenshot({ path: `${out}/missions-board.png` });
  await page.click('#station button[data-accept="9001"]');
  const took = await page.waitForFunction(() => window.__game.inspect().pilot.missions.length === 1 && window.__game.inspect().pilot.reserved === 5, null, { timeout: 30000 }).then(() => true, () => false);
  const hold = await page.evaluate(() => document.querySelector('#station .hold').textContent);
  check(took && /^6 \/ 60$/.test(hold.trim()), `contract accepted: the crates take hold space (${hold})`);
  await page.click('#station .undock');
  await page.waitForFunction(() => window.__game.inspect().myShipId != null && !window.__game.inspect().stationScreen, null, { timeout: 30000 });
  const tracker = await page.evaluate(() => document.querySelector('#zone .jobs')?.textContent ?? '');
  check(/Livraison : 5 caisses pour Ferro-9/.test(tracker) && /amarrez-vous à Ferro-9/.test(tracker), `the flight HUD tracks the contract (${tracker})`);
  await page.screenshot({ path: `${out}/missions-hud.png` });
  const before6 = await page.evaluate(() => window.__game.inspect().pilot.credits);
  await dockAt('ferro');
  const paid = await page.waitForFunction((c) => {
    const p = window.__game.inspect().pilot;
    return p.docked === 'ferro' && p.missions.length === 0 && p.credits === c + 350;
  }, before6, { timeout: 30000 }).then(() => true, () => false);
  check(paid, 'docking at Ferro-9 delivers the crates and pays 350 cr');
  check(errors.length === 0, `economy: no console errors/warnings ${errors.join(' | ')}`);
  await ctx.close();
}

// ---- Touch-only device: touch controls explained (details in mobile-check.mjs) ----
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'fr-FR' });
  const page = await ctx.newPage();
  await page.goto(`${url}/?q=low`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__menu?.isOpen, null, { timeout: 300000 });
  const note = await page.evaluate(() => document.querySelector('.touch-note')?.textContent ?? '');
  check(/Commandes tactiles/.test(note), 'touch-only device shows the touch controls note');
  await page.screenshot({ path: `${out}/touch-390x844.png` });
  await ctx.close();
}

await browser.close();
console.log(failures.length ? `UI CHECK FAILED (${failures.length})` : 'UI CHECK OK');
process.exit(failures.length ? 1 : 0);
