// Two (then three) real browser clients against the real Node server.
// Builds the server module, starts it in this process (so the script can set
// up combat situations through the authoritative world), serves the built
// client from dist/, and drives headless Chromium pages like players would.
//   npm run build && node scripts/mp-check.mjs
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const out = process.env.MP_OUT ?? 'screenshots/mp';
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync('.mp-check', { recursive: true });
await build({
  entryPoints: ['src/server/node/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: '.mp-check/server.mjs',
  logLevel: 'warning',
});
const { startServer } = await import(pathToFileURL('.mp-check/server.mjs').href);
const server = await startServer({ port: 0, host: '127.0.0.1', staticDir: 'dist', reconnectGrace: 150, npcs: false, log: () => {} });
const base = `http://127.0.0.1:${server.port}`;
const world = server.game.world;

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

async function pilot(name, viewport = { width: 800, height: 450 }, query = '') {
  const ctx = await browser.newContext({ viewport, locale: 'fr-FR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/fonts\.googleapis|ERR_|net::/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`${base}/?q=low${query}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__menu?.isOpen && document.querySelector('#serverStatus.ok'), null, { timeout: 300000 });
  await page.fill('#pilotName', name);
  await page.click('[data-act="online"]');
  await page.waitForFunction(() => window.__game.running && window.__game.inspect().status?.state === 'online', null, { timeout: 120000 });
  return { ctx, page, errors, name, inspect: () => page.evaluate(() => window.__game.inspect()) };
}
const shipOf = (name) => [...world.ships.values()].find((s) => s.name === name && s.ownerId);
const waitFor = async (page, fn, arg, ms = 60000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 200 });

try {
  // ---- 1. Two players join and see each other --------------------------------
  const A = await pilot('Alpha');
  const startShot = await A.page.screenshot({ path: `${out}/a-joined.png` });
  void startShot;
  const B = await pilot('Bravo', { width: 568, height: 1000 });
  await waitFor(A.page, () => window.__game.inspect().ships.filter((s) => s.owner).length === 2);
  await waitFor(B.page, () => window.__game.inspect().ships.filter((s) => s.owner).length === 2);
  const ia = await A.inspect();
  check(ia.myName === 'Alpha' && ia.ships.some((s) => s.name === 'Bravo'), 'Alpha sees Bravo in the shared sector');
  await waitFor(A.page, () => /EN LIGNE · 2\/30 pilotes/.test(document.getElementById('netStatus')?.textContent ?? ''), null, 20000).then(
    () => check(true, 'HUD shows "EN LIGNE · 2/30 pilotes" with latency'),
    () => check(false, 'HUD shows the connection state and pilot count'),
  );
  const netText = await A.page.evaluate(() => document.getElementById('netStatus').textContent);
  check(/\d+ ms/.test(netText), `latency shown in the HUD (${netText})`);

  // Put Bravo 120 m in front of Alpha (server side) so the name label is on screen.
  const a = shipOf('Alpha');
  const b = shipOf('Bravo');
  const fwd = (s, d) => s.position.clone().add(s.velocity.clone().set(0, 0, -d).applyQuaternion(s.rotation));
  b.position.copy(fwd(a, 120)).add(a.velocity.clone().set(8, 4, 0));
  b.velocity.set(0, 0, 0);
  await waitFor(A.page, () => [...document.querySelectorAll('.marker.player .lbl')].some((l) => /Bravo/.test(l.textContent) && l.offsetParent));
  check(true, 'Bravo\'s name is displayed above the ship on Alpha\'s screen');
  await A.page.screenshot({ path: `${out}/a-sees-b.png` });

  // ---- 2. Movement synchronised ------------------------------------------------
  const before = (await A.inspect()).ships.find((s) => s.name === 'Bravo').p;
  await B.page.keyboard.down('KeyW');
  await sleep(2500);
  await B.page.keyboard.up('KeyW');
  await sleep(800);
  const after = (await A.inspect()).ships.find((s) => s.name === 'Bravo').p;
  const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
  check(moved > 20, `Bravo's thrust is seen by Alpha (moved ${moved.toFixed(0)} m)`);
  const ib = await B.inspect();
  check(ib.predicted !== null, `Bravo's own ship is client-predicted (corrections so far: ${ib.corrections})`);

  // ---- 3. Chat ------------------------------------------------------------------
  await A.page.keyboard.press('Enter');
  await waitFor(A.page, () => document.activeElement?.id === 'chatField', null, 10000);
  await A.page.keyboard.type('Salut Bravo, on y va ?');
  await A.page.screenshot({ path: `${out}/a-chat-typing.png` });
  await A.page.keyboard.press('Enter');
  await waitFor(B.page, () => [...document.querySelectorAll('#chat .line')].some((l) => l.textContent === 'Alpha : Salut Bravo, on y va ?'), null, 20000).then(
    () => check(true, 'chat message delivered to Bravo with the sender name'),
    () => check(false, 'chat message delivered to Bravo'),
  );
  check(await A.page.evaluate(() => !window.__chat.isOpen && window.__game.running), 'chat closes after sending; Alpha still flying');
  // Typing does not fly the ship: "z" and "s" typed into the chat must not change throttle.
  const thrBefore = await A.page.evaluate(() => window.__game.input.input.throttle);
  await A.page.keyboard.press('Enter');
  await waitFor(A.page, () => document.activeElement?.id === 'chatField', null, 10000);
  await A.page.keyboard.type('wwwwssss');
  await A.page.keyboard.press('Escape');
  const thrAfter = await A.page.evaluate(() => window.__game.input.input.throttle);
  check(thrBefore === thrAfter, 'keys typed in the chat do not reach the flight controls');
  check(await A.page.evaluate(() => !window.__menu.isOpen), 'Échap in the chat closes the chat, not the game');

  // ---- 4. Co-op: both shoot the same pirate ----------------------------------
  // Both pilots cut their engines (X) so the staged positions below hold.
  await A.page.keyboard.press('KeyX');
  await B.page.keyboard.press('KeyX');
  await sleep(1500);
  const pirate = world.spawnShip({ classId: 'raider', faction: 'raiders', name: 'Cible commune', position: fwd(a, 260) });
  pirate.hull = 400;
  pirate.shield = 0;
  const pirateId = pirate.id;
  // Stage the fight on the authoritative server: both ships side by side, nose on the pirate.
  const anchor = a.position.clone();
  const rot = a.rotation.clone();
  const stage = setInterval(() => {
    const p = world.ships.get(pirateId);
    if (!p) return;
    a.position.copy(anchor);
    a.rotation.copy(rot);
    a.velocity.set(0, 0, 0);
    a.angularVelocity.set(0, 0, 0);
    // Bravo flies 40 m behind Alpha on the same line: allied bolts pass through Alpha.
    b.position.copy(anchor).add(b.velocity.clone().set(0, 0, 40).applyQuaternion(rot));
    b.rotation.copy(rot);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    p.position.copy(anchor).add(p.velocity.clone().set(0, 0, -260).applyQuaternion(rot));
    p.velocity.set(0, 0, 0);
  }, 30);
  await A.page.keyboard.down('KeyF');
  await B.page.mouse.move(284, 500);
  await B.page.mouse.down();
  await waitFor(B.page, () => window.__game.inspect().debug.myHits > 0, null, 90000).catch(() => {});
  await waitFor(A.page, () => window.__game.inspect().debug.myHits > 0, null, 90000).catch(() => {});
  const p0 = world.ships.get(pirateId);
  if (p0) p0.hull = Math.min(p0.hull, 40);
  await waitFor(A.page, () => window.__game.inspect().debug.explosions > 0, null, 90000).catch(() => {});
  await waitFor(B.page, () => window.__game.inspect().debug.explosions > 0, null, 30000).catch(() => {});
  clearInterval(stage);
  await A.page.keyboard.up('KeyF');
  await B.page.mouse.up();
  const da = (await A.inspect()).debug;
  const db = (await B.inspect()).debug;
  check(da.myHits > 0 && db.myHits > 0, `both players damage the same pirate (hits: Alpha ${da.myHits}, Bravo ${db.myHits})`);
  check(!world.ships.has(pirateId), 'the shared pirate is destroyed on the server');
  check(da.explosions > 0 && db.explosions > 0, 'both players see the explosion');
  const kills = (await A.inspect()).stats.kills + (await B.inspect()).stats.kills;
  check(kills === 1, `exactly one kill credited (${kills})`);
  check(da.bolts > da.myShots && db.bolts > db.myShots, 'each player sees the other\'s laser bolts');

  // ---- 5. PvP ------------------------------------------------------------------
  await A.page.keyboard.press('KeyP');
  await B.page.keyboard.press('KeyP');
  await waitFor(A.page, () => { const i = window.__game.inspect(); return i.myPvp && i.ships.filter((s) => s.owner && s.pvp).length === 2; }, null, 30000).then(
    () => check(true, 'both players switched PvP on with P'),
    () => check(false, 'PvP switched on for both'),
  );
  const hitsTakenBefore = (await B.inspect()).debug.hitsTaken;
  const pvpStage = setInterval(() => {
    a.position.copy(anchor);
    a.rotation.copy(rot);
    a.velocity.set(0, 0, 0);
    a.angularVelocity.set(0, 0, 0);
    b.position.copy(anchor).add(b.velocity.clone().set(0, 0, -200).applyQuaternion(rot));
    b.velocity.set(0, 0, 0);
    b.shield = 0;
    b.hull = Math.max(b.hull, 200); // keep Bravo alive for the rest of the test
  }, 30);
  await A.page.keyboard.down('KeyF');
  await waitFor(B.page, (n) => window.__game.inspect().debug.hitsTaken > n, hitsTakenBefore, 90000).then(
    () => check(true, 'PvP: Alpha\'s lasers damage Bravo'),
    () => check(false, 'PvP damage between players'),
  );
  await A.page.keyboard.up('KeyF');
  clearInterval(pvpStage);
  await A.page.screenshot({ path: `${out}/a-pvp.png` });
  await B.page.keyboard.down('Tab');
  await sleep(1200);
  await B.page.screenshot({ path: `${out}/b-scoreboard-568.png` });
  const board = await B.page.evaluate(() => document.getElementById('scoreboard').textContent);
  await B.page.keyboard.up('Tab');
  check(/Alpha/.test(board) && /Bravo \(vous\)/.test(board), 'Tab shows the pilots list');

  // Layout at 568 px with the chat visible.
  const rects = await B.page.evaluate(() => {
    const r = {};
    for (const id of ['zone', 'topbar', 'flight', 'status', 'radarWrap', 'chat']) {
      const e = document.getElementById(id);
      const b = e.getBoundingClientRect();
      r[id] = { x: b.x, y: b.y, w: b.width, h: b.height, vis: getComputedStyle(e).display !== 'none' && b.width > 0 };
    }
    return r;
  });
  const ov = (p, q) => p.x < q.x + q.w - 1 && q.x < p.x + p.w - 1 && p.y < q.y + q.h - 1 && q.y < p.y + p.h - 1;
  const ids = Object.keys(rects).filter((k) => rects[k].vis);
  let overlaps = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (ov(rects[ids[i]], rects[ids[j]])) overlaps.push(`${ids[i]}/${ids[j]}`);
  check(overlaps.length === 0, `568 px online HUD without overlaps (${overlaps.join(', ') || 'none'})`);

  // ---- 6. Latency: a third pilot with 120 ms simulated lag each way ----------
  const C = await pilot('Charlie', { width: 640, height: 360 }, '&lag=120&jitter=20');
  await waitFor(C.page, () => window.__game.inspect().ships.filter((s) => s.owner).length === 3, null, 60000);
  const cBefore = shipOf('Charlie').position.clone();
  await C.page.keyboard.down('KeyW');
  let serverThrottle = 0;
  for (let i = 0; i < 25; i++) {
    await sleep(100);
    serverThrottle = Math.max(serverThrottle, shipOf('Charlie').input.throttle);
  }
  await C.page.keyboard.up('KeyW');
  await sleep(600);
  const cMoved = shipOf('Charlie').position.distanceTo(cBefore);
  const ic = await C.inspect();
  // Headless software rendering runs this page at a few frames per second, so the throttle ramps slowly.
  check(serverThrottle > 0 && cMoved > 5, `with 120 ms lag, Charlie's inputs reach the server (throttle ${serverThrottle.toFixed(2)}, moved ${cMoved.toFixed(0)} m)`);
  check(ic.status.rtt > 200, `measured round trip reflects the simulated lag (${Math.round(ic.status.rtt)} ms)`);
  await C.page.screenshot({ path: `${out}/c-lag.png` });

  // ---- 7. Disconnection / reconnection ---------------------------------------
  const ibBefore = await B.inspect();
  const bravoKills = ibBefore.stats.kills;
  const bravoId = ibBefore.myShipId;
  const bravoSession = ibBefore.sessionId;
  const reloadStart = Date.now();
  await B.page.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(A.page, () => window.__game.inspect().players.some((p) => p.name === 'Bravo' && !p.online), null, 20000).then(
    () => check(true, 'Bravo shown as disconnected to the others'),
    () => check(false, 'disconnection visible'),
  );
  await B.page.waitForFunction(() => window.__menu?.isOpen && document.querySelector('#serverStatus.ok'), null, { timeout: 300000 });
  check((await B.page.inputValue('#pilotName')) === 'Bravo', 'pilot name remembered after reload');
  await B.page.click('[data-act="online"]');
  await B.page.waitForFunction(() => window.__game.running && window.__game.inspect().myShipId !== null, null, { timeout: 120000 });
  const ib2 = await B.inspect();
  console.log(`     (reload to rejoin took ${((Date.now() - reloadStart) / 1000).toFixed(0)} s in this headless environment)`);
  check(
    ib2.resumed && ib2.sessionId === bravoSession && ib2.myShipId === bravoId && ib2.stats.kills === bravoKills,
    `reload resumes the same session, ship and score (resumed ${ib2.resumed}, session ${bravoSession}→${ib2.sessionId}, ship ${bravoId}→${ib2.myShipId}, kills ${bravoKills}→${ib2.stats.kills}, deaths ${ib2.stats.deaths})`,
  );
  await waitFor(A.page, () => window.__game.inspect().players.filter((p) => p.online).length === 3, null, 30000).then(
    () => check(true, 'Bravo back online for the others'),
    () => check(false, 'Bravo back online'),
  );

  await C.ctx.close(); // tab closed for good
  await waitFor(A.page, () => !window.__game.inspect().ships.some((s) => s.name === 'Charlie'), null, 240000).then(
    () => check(true, 'a pilot who closes the game disappears after the grace period (no ghost ship)'),
    () => check(false, 'ghost ship removed'),
  );
  await waitFor(A.page, () => [...document.querySelectorAll('#chat .line.system')].some((l) => /Charlie a quitté/.test(l.textContent)), null, 20000).then(
    () => check(true, 'leave message shown in the chat'),
    () => check(false, 'leave message'),
  );
  await A.page.screenshot({ path: `${out}/a-final.png` });
  check(A.errors.length === 0 && B.errors.length === 0, `no page errors (${[...A.errors, ...B.errors].join(' | ')})`);
} catch (e) {
  failures.push(String(e?.message ?? e));
  console.log('ERROR', e);
} finally {
  await browser.close();
  await server.close();
}
console.log(failures.length ? `MP CHECK FAILED (${failures.length})` : 'MP CHECK OK');
process.exit(failures.length ? 1 : 0);
