// In-game audio check: runs the built game (expects `vite preview` at
// AUDIO_URL, default http://localhost:4173) in headless Chromium and checks
// the sound system against the real gameplay: unlock after a gesture, engine
// and boost, camera views, combat sounds, explosions, docking (hangar),
// pause menu, hidden tab, focus loss, and a long session (no leaks, no
// runaway voices, no clipping). Chromium plays the sound into a virtual
// output: levels are measured, nothing is listened to.
import { chromium } from 'playwright-core';

const url = process.env.AUDIO_URL ?? 'http://localhost:4173';
const longSeconds = Number(process.env.AUDIO_LONG_S ?? 90);
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`);
};
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/fonts\.googleapis|ERR_|net::/.test(m.text())) errors.push('console: ' + m.text());
  });
};

// ---- 1. Browser autoplay policy: silent until a gesture, then running.
{
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  watch(page);
  await page.goto(`${url}/?q=low`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__game && window.__game.debug.frames > 3, null, { timeout: 300000 });
  const before = await page.evaluate(() => window.__game.audio.report().state);
  await page.mouse.click(5, 5);
  const after = await page.waitForFunction(() => window.__game.audio.report().state === 'running', null, { timeout: 10000 }).then(
    () => 'running',
    () => page.evaluate(() => window.__game.audio.report().state),
  );
  check(before !== 'running' && after === 'running', `audio stays silent before any gesture (${before}) and starts on the first click (${after})`);
  const menuMusic = await page
    .waitForFunction(() => window.__game.audio.report().music === 'calm' && window.__game.audio.report().musicNodes > 0, null, { timeout: 20000 })
    .then(
      () => true,
      () => false,
    );
  check(menuMusic, 'calm music plays on the title menu');
  await browser.close();
}

// ---- 2. The game itself (autoplay allowed so the run does not depend on clicks).
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: [...args, '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
watch(page);
await page.goto(`${url}/?q=low&autostart`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__game && window.__game.debug.frames > 5, null, { timeout: 300000 });
await page.mouse.click(640, 360);
const loaded = await page.waitForFunction(() => { const r = window.__game.audio.report(); return r.state === 'running' && r.loaded >= r.total; }, null, { timeout: 60000 }).then(() => true, () => false);
const rep = () => page.evaluate(() => window.__game.audio.report());
const wait = (ms) => page.waitForTimeout(ms);
// Headless software rendering runs a few frames per second and the sound is
// smoothed per frame: conditions are awaited (bounded) rather than slept on.
const until = (expr, ms = 15000) =>
  page.waitForFunction(`(() => { const a = window.__game.audio; return ${expr}; })()`, null, { timeout: ms, polling: 100 }).then(
    () => true,
    () => false,
  );
const inner = (expr) => page.evaluate(`(() => { const a = window.__game.audio; return ${expr}; })()`);
check(loaded, `sound bank rendered (${(await rep()).loaded} sounds), context running`);

// Engine: idle vs throttle vs boost.
await wait(1500);
const idle = await inner('a.ship.core.gain.gain.value');
await page.keyboard.down('KeyW');
await wait(2500);
await page.keyboard.up('KeyW');
const thrust = await inner('a.ship.core.gain.gain.value');
check(thrust > idle * 1.5, `engine core gets louder with throttle (${idle.toFixed(3)} → ${thrust.toFixed(3)})`);
await page.keyboard.down('ShiftLeft');
await until('a.ship.boostEnv > 0.8', 8000);
const boost = await inner('a.ship.boostEnv');
const boostStarts = (await rep()).started;
await page.keyboard.up('ShiftLeft');
await until('a.ship.boostEnv < 0.2', 10000);
const boostAfter = await inner('a.ship.boostEnv');
check(boost > 0.8 && boostAfter < 0.2, `boost layer rises while boosting (${boost.toFixed(2)}) and falls after (${boostAfter.toFixed(2)})`);

// Camera views change the engine mix.
await page.keyboard.press('KeyV');
await until('a.ship.view.interior > 0.9', 8000);
const interior = await inner('a.ship.view.interior');
await page.keyboard.press('KeyV');
await until('a.ship.view.wide > 0.9', 8000);
const wide = await inner('a.ship.view.wide');
await page.keyboard.press('KeyV');
check(interior > 0.8 && wide > 0.8, `close view mixes the cockpit in (${interior.toFixed(2)}), cinematic view widens (${wide.toFixed(2)})`);

// Our guns.
const s0 = (await rep()).started;
await page.mouse.down();
await wait(1500);
await page.mouse.up();
const s1 = (await rep()).started;
const shots = await page.evaluate(() => window.__game.debug.myShots);
check(shots > 0 && s1 - s0 >= Math.min(shots, 3), `our shots are heard (${shots} shots, ${s1 - s0} sounds started, boost ${boostStarts > 0 ? 'ok' : '?'})`);

// Combat: fast-forward to the pirates, then fight.
await page.evaluate(() => {
  const s = window.__game.transport.server;
  for (let i = 0; i < 60 * 22; i++) s.tick();
});
await page.keyboard.press('KeyT');
await page.mouse.down();
let combatMusic = false;
for (let i = 0; i < 16 && !combatMusic; i++) {
  await wait(500);
  combatMusic = ['combat', 'boss', 'danger', 'tension'].includes((await rep()).director);
}
await wait(3000);
await page.mouse.up();
const fight = await rep();
check(combatMusic, `the music follows the threat (director: ${fight.director}, playing: ${fight.music})`);
check(fight.voices <= 40, `voices stay capped in combat (${fight.voices} playing, ${fight.dropped} dropped, ${fight.stolen} stolen)`);

// An explosion close by, of a big ship.
const e0 = (await rep()).started;
await page.evaluate(() => {
  const s = window.__game.transport.server;
  const me = [...s.world.ships.values()].find((x) => x.ownerId);
  const at = me.position.clone().add(me.velocity.clone().set(0, 0, -150).applyQuaternion(me.rotation));
  const r = s.world.spawnShip({ classId: 'marauder', faction: 'raiders', name: 'Cible test', position: at, rotation: me.rotation.clone() });
  s.world.applyDamage(s.world.ships.get(r.id), 99999, null);
});
await wait(2000);
const e1 = await rep();
check(e1.started > e0, `a destroyed ship is heard (${e1.started - e0} sounds)`);

// Docking: the hangar (reverb, beds) and the station sounds.
await page.evaluate(() => {
  const g = window.__game;
  const s = g.transport.server;
  const me = [...s.world.ships.values()].find((x) => x.ownerId);
  if (me.hull <= 0) return;
  for (const x of s.world.ships.values()) if (!x.ownerId) s.world.applyDamage(x, 99999, null);
  me.position.copy(g.zone.station.dock.mouth);
  me.velocity.set(0, 0, 0);
  g.transport.send({ t: 'dock' });
});
const docked = await page.waitForFunction(() => window.__game.docked, null, { timeout: 30000 }).then(() => true, () => false);
await until('a.engine.room.gain.value > 0.5', 15000);
const room = await inner('a.engine.room.gain.value');
const hangar = await rep();
check(docked && room > 0.3 && hangar.director === 'calm', `docked: hangar reverb on (${room.toFixed(2)}), calm music (${hangar.director})`);
const u0 = (await rep()).started;
await page.click('#station [data-tab="yard"]').catch(() => {});
await wait(400);
check((await rep()).started > u0, 'a station tab click is heard');
await page.click('#station .undock').catch(() => {});
await until('a.engine.room.gain.value < 0.1', 15000);
const roomOut = await inner('a.engine.room.gain.value');
check(roomOut < room * 0.5, `after take-off the hangar reverb fades (${roomOut.toFixed(2)})`);

// Pause menu: the world goes quiet, music steps back.
await page.keyboard.press('Escape');
await wait(800);
const fxPaused = await inner('a.engine.groups.fx.state.gain.value');
const musicPaused = await inner('a.engine.groups.music.state.gain.value');
check(fxPaused < 0.05 && musicPaused > 0.2 && musicPaused < 0.7, `pause: effects silent (${fxPaused.toFixed(2)}), music lowered (${musicPaused.toFixed(2)})`);
await page.evaluate(() => window.__menu.hide?.());
await page.evaluate(() => window.__game.setPaused(false));
await wait(500);

// Hidden tab: the context is suspended, and resumes when shown.
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await wait(800);
const hiddenState = (await rep()).state;
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  document.dispatchEvent(new Event('visibilitychange'));
});
const back = await page.waitForFunction(() => window.__game.audio.report().state === 'running', null, { timeout: 5000 }).then(() => true, () => false);
check(hiddenState === 'suspended' && back, `hidden tab suspends the sound (${hiddenState}) and showing it resumes`);

// Focus loss: half volume, back on focus.
await page.evaluate(() => window.dispatchEvent(new Event('blur')));
await wait(500);
const blurred = await inner('a.engine.master.gain.value');
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await wait(500);
const focused = await inner('a.engine.master.gain.value');
check(blurred < focused * 0.7, `focus lost: volume lowered (${blurred.toFixed(2)} → back to ${focused.toFixed(2)})`);
await page.evaluate(() => window.__game.setPaused(false));

// Mute key.
await page.mouse.click(640, 360);
await page.keyboard.press('KeyM');
await until('a.muted && a.engine.master.gain.value < 0.01', 8000);
const muted = await inner('a.engine.master.gain.value');
await page.keyboard.press('KeyM');
await until('!a.muted', 8000);
check(muted < 0.01, `M mutes everything (${muted.toFixed(3)})`);

// Long session: fights in a loop, then the counters must be stable.
const startMem = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
const t0 = Date.now();
let maxVoices = 0;
let maxMusic = 0;
while (Date.now() - t0 < longSeconds * 1000) {
  await page.evaluate(() => {
    const s = window.__game.transport.server;
    for (let i = 0; i < 60 * 4; i++) s.tick();
  });
  await page.mouse.down();
  await wait(2500);
  await page.mouse.up();
  const r = await rep();
  maxVoices = Math.max(maxVoices, r.voices);
  maxMusic = Math.max(maxMusic, r.musicNodes);
}
await wait(4000);
const end = await rep();
const endMem = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
check(maxVoices <= 40 && maxMusic < 400, `long session (${longSeconds} s): voices ≤ ${maxVoices}, music nodes ≤ ${maxMusic}`);
check(end.started - end.ended <= 40, `no leaked voices: ${end.started} started, ${end.ended} ended`);
check(end.clipped === 0 && end.peak < 1, `no clipping (loudest sample ${end.peak.toFixed(3)})`);
check(end.errors === 0, `no sound failed to render (${end.errors})`);
console.log(JSON.stringify({ end, heapMB: [Math.round(startMem / 1e6), Math.round(endMem / 1e6)], fps: Math.round(await page.evaluate(() => window.__game.fps)) }));
await browser.close();

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `AUDIO CHECK FAILED (${failed.length})` : `AUDIO CHECK OK (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
