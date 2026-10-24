// v0.8 in-browser check of the collisions.
// Part A, solo (the authoritative server runs in the page): the five situations
// asked for — a ship into a wall, into an asteroid, two ships, a weak and a violent
// impact, a crash that damages one precise part — plus a pushed crate and the
// collision shapes drawn over the scene (?colliders). Each crash is staged on the
// server, then flown by the real client (prediction, interpolation, effects, HUD).
// Part B, online: the real Node server and two browser clients ramming each other.
// The server decides; both clients must see the same blow, the same damage, and the
// same pushed crate.
//   npm run build && (npx vite preview --port 4173 &) && node scripts/collision-check.mjs
// Software rendering (SwiftShader) runs a few frames a second: timings here say
// nothing about speed on a real GPU.
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const url = process.env.COLLISION_URL ?? 'http://localhost:4173';
const out = process.env.COLLISION_OUT ?? 'screenshots/collisions';
const part = process.env.COLLISION_PART ?? 'AB';
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync('.collision-check', { recursive: true });

// A probe injected into the pages: the game's own distance functions, to measure how
// deep a ship's hit spheres ever get into the world after each server tick.
await build({
  stdin: {
    contents: "export { distanceTo } from './src/shared/physics/shapes'; export { HITBOXES } from './src/shared/physics/hitboxes'; export { HUB_HANGAR } from './src/shared/physics/structures';",
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: '__phys',
  outfile: '.collision-check/probe.js',
  logLevel: 'warning',
});
const probe = fs.readFileSync('.collision-check/probe.js', 'utf8');
// The probe carries its own copy of three: hidden from the page's, which would warn of two instances.
const probeTag = `window.__pageThree = window.__THREE__; delete window.__THREE__;\n${probe}\nwindow.__THREE__ = window.__pageThree; delete window.__pageThree;`;
const phys = new Function(`${probe}; return __phys;`)();
const H = phys.HUB_HANGAR;
// Aurora-7's hangar (structures.ts): centre on z, outer face of its +x side wall.
const HANGAR_Z = 170 * 1.08 + H.d / 2 - H.wall + 4;
const WALL_X = H.w / 2 + 8;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
const errorsOf = (page) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    const expected = /fonts\.googleapis|ERR_|net::|GPU stall|GL Driver|AudioContext was not allowed to start|requestFullscreen.*user gesture/i;
    if ((m.type() === 'error' || m.type() === 'warning') && !expected.test(m.text())) errors.push(`${m.type()}: ${m.text()}`);
  });
  return errors;
};

/** Hooks in a game page: what the client did with each blow, and the server-side record when the server is in the page. */
function instrument() {
  const g = window.__game;
  const fx = (window.__fx = { kicks: [], shakes: [], sounds: [], sparks: [], cockpit: 0, notices: [], events: [] });
  const wrap = (obj, name, rec) => {
    const orig = obj[name].bind(obj);
    obj[name] = (...a) => {
      rec(...a);
      return orig(...a);
    };
  };
  wrap(g.cam, 'kick', (_n, a) => fx.kicks.push(a));
  wrap(g.cam, 'addShake', (a) => fx.shakes.push(a));
  wrap(g.audio, 'collision', (_p, o) => fx.sounds.push({ surface: o.surface, speed: o.speed, damage: o.damage, onMe: o.onMe }));
  wrap(g.effects, 'collision', (_p, _n, k, mat, hard) => fx.sparks.push({ k, mat, hard }));
  wrap(g.hud, 'cockpitHit', () => fx.cockpit++);
  wrap(g.hud, 'notice', (text) => fx.notices.push(text));
  wrap(g, 'handleEvent', (e) => fx.events.push(e));
  const srv = g.transport.server;
  if (!srv) return;
  // A quiet sector for the staged crashes: no pirate raids.
  srv.npcs = false;
  for (const sec of Object.values(srv.sectors)) {
    for (const id of sec.pilots.keys()) sec.world.removeShip(id);
    sec.pilots.clear();
  }
  const t = (window.__t = {
    world() {
      const w = srv.whereIs(g.sessionId);
      return srv.sectors[w.sector].world;
    },
    ship() {
      const w = srv.whereIs(g.sessionId);
      return w && w.shipId !== null ? srv.sectors[w.sector].world.ships.get(w.shipId) : null;
    },
    events: [],
    rec: null,
    full: null,
  });
  for (const sec of Object.values(srv.sectors)) {
    const w = sec.world;
    const drain = w.drainEvents.bind(w);
    w.drainEvents = () => {
      const e = drain();
      for (const x of e) t.events.push({ ...x, at: w.time });
      return e;
    };
  }
  const tick = srv.tick.bind(srv);
  srv.tick = () => {
    tick();
    const r = t.rec;
    const s = r && t.world().ships.get(r.id);
    if (!r || !s) return;
    const w = t.world();
    for (const h of __phys.HITBOXES[s.classId]) {
      const at = h.at.clone().applyQuaternion(s.rotation).add(s.position);
      for (const c of w.grid.query(at, h.r + 2)) r.deepest = Math.min(r.deepest, __phys.distanceTo(c, at, w.time) - h.r);
    }
    r.ticks++;
    if (r.track) r.track(s, w, r);
  };
  const s = t.ship();
  t.full = { hull: s.hull, shield: s.shield };
}

/**
 * Puts our ship (server side) at `pos`, nose along `face`, moving at `vel`, every
 * component intact; sets the client's throttle and flight assist to hold it there.
 */
function stage(o) {
  const g = window.__game;
  const t = window.__t;
  const s = t.ship();
  const V = s.position.constructor;
  s.position.set(...o.pos);
  s.velocity.set(...o.vel);
  s.rotation.setFromUnitVectors(new V(0, 0, -1), new V(...o.face).normalize());
  s.angularVelocity.set(0, 0, 0);
  s.spin.set(0, 0, 0);
  s.hull = t.full.hull;
  s.shield = o.shield ?? t.full.shield;
  if (o.shield === 0) s.sinceDamage = -100;
  for (const k of Object.keys(s.parts)) s.parts[k] = 1;
  const inp = g.input.input;
  inp.throttle = o.throttle;
  inp.flightAssist = o.assist;
  inp.boost = false;
  inp.fire = false;
  g.input.centerCursor();
  t.events.length = 0;
  for (const k of ['kicks', 'shakes', 'sounds', 'sparks', 'notices', 'events']) window.__fx[k].length = 0;
  window.__fx.cockpit = 0;
  t.rec = { id: s.id, deepest: Infinity, ticks: 0 };
  return s.id;
}

const collisionsOf = (page, id) => page.evaluate((id) => window.__t.events.filter((e) => e.type === 'collision' && e.ship === id), id);
const fxOf = (page) => page.evaluate(() => JSON.parse(JSON.stringify({ ...window.__fx, events: undefined })));
const recOf = (page) => page.evaluate(() => ({ deepest: window.__t.rec?.deepest ?? null, ticks: window.__t.rec?.ticks ?? 0, extra: window.__t.rec?.extra ?? null }));
const shipState = (page) =>
  page.evaluate(() => {
    const s = window.__t.ship();
    return s && { id: s.id, alive: s.alive, p: s.position.toArray(), v: s.velocity.toArray(), hull: s.hull, shield: s.shield, parts: { ...s.parts }, w: s.angularVelocity.toArray(), sp: s.spin.toArray() };
  });
const until = (page, fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout, polling: 200 }).then(() => true, () => false);
const len = (v) => Math.hypot(v[0], v[1], v[2]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function solo() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = errorsOf(page);
  await page.goto(`${url}/?q=low&autostart`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__game && window.__game.debug.frames > 5 && window.__game.inspect().myShipId !== null, null, { timeout: 300000 });
  await page.mouse.click(640, 360);
  await page.addScriptTag({ content: probeTag });
  await page.evaluate(instrument);
  const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
  const colliders = (on) => page.evaluate((on) => window.__game.setColliderDebug(on), on);
  /** Waits until the server saw a collision of ship `id` and the client drew it. */
  const impact = async (id, timeout = 120000) => {
    const ok = await until(page, (id) => window.__t.events.some((e) => e.type === 'collision' && e.ship === id), id, timeout);
    await until(page, () => window.__fx.sparks.length > 0, null, 30000);
    return ok;
  };
  const settle = (ms) => sleep(ms);

  // ---- 1. A ship into a wall: the side wall of Aurora-7's hangar, 40 m/s -------
  {
    const id = await page.evaluate(stage, { pos: [WALL_X + 140, 30, HANGAR_Z], vel: [-40, 0, 0], face: [-1, 0, 0], throttle: 40 / 210, assist: true });
    check(await impact(id), '1 wall: the ship hits the hangar wall');
    await shot('1-wall-impact');
    // Keep pushing on the wall with the throttle for a few seconds.
    await settle(5000);
    const hits = await collisionsOf(page, id);
    const rec = await recOf(page);
    const s = await shipState(page);
    const f = await fxOf(page);
    check(hits.length > 0 && hits[0].mat === 'metal' && hits[0].part === 'cockpit' && Math.abs(hits[0].speed - 40) < 6, `1 wall: struck nose first on metal at ${hits[0]?.speed} m/s (${hits[0]?.mat}, ${hits[0]?.part})`);
    check(rec.deepest > -0.1, `1 wall: never inside the wall, pushing on it with the throttle (deepest ${rec.deepest.toFixed(3)} m over ${rec.ticks} ticks)`);
    check(s.p[0] > WALL_X && s.alive, `1 wall: the ship stays on its side (x ${s.p[0].toFixed(1)} > ${WALL_X})`);
    check(f.sparks.some((x) => x.mat === 'metal') && f.sounds.some((x) => x.surface === 'metal' && x.onMe), 'client: metal sparks and a metal impact sound on our ship');
    check(f.kicks.length > 0 && f.shakes.length > 0, `client: camera jolt and shake (${f.kicks.length} jolts)`);
    await page.evaluate(() => (window.__game.input.input.throttle = 0));
    await colliders(true);
    await settle(1500);
    await shot('1-wall-colliders');
    await colliders(false);
  }

  // ---- 2. A ship into an asteroid: a 41 m rock, then an iron-nickel one -------
  for (const [label, want] of [
    ['rock', 'rock'],
    ['iron-nickel rock', 'metalRock'],
  ]) {
    const plan = await page.evaluate((want) => {
      const w = window.__t.world();
      const rocks = w.zone.asteroids.map((a, i) => ({ a, i, c: w.zone.colliders.find((c) => c.index === i) }));
      const pick = rocks.filter(({ a, c }) => a.radius > 40 && a.radius < 80 && c.material === want).sort((p, q) => p.a.position.length() - q.a.position.length())[0];
      const dir = pick.a.position.clone().negate().normalize();
      const pos = pick.a.position.clone().addScaledVector(dir, pick.a.radius * 1.4 + 120);
      return { index: pick.i, radius: pick.a.radius, pos: pos.toArray(), dir: dir.toArray(), spin: pick.a.spinSpeed };
    }, want);
    const face = plan.dir.map((x) => -x);
    const id = await page.evaluate(stage, { pos: plan.pos, vel: face.map((x) => x * 30), face, throttle: 30 / 210, assist: true });
    check(await impact(id), `2 asteroid (${label}, ${plan.radius.toFixed(0)} m, turning ${plan.spin.toFixed(2)} rad/s): the ship hits it`);
    await shot(`2-asteroid-${want}`);
    await settle(3000);
    const hits = await collisionsOf(page, id);
    const rec = await recOf(page);
    const f = await fxOf(page);
    check(hits.every((h) => h.mat === want), `2 asteroid: struck ${want} (${[...new Set(hits.map((h) => h.mat))].join(', ')})`);
    check(rec.deepest > -0.3, `2 asteroid: never inside the drawn rock (deepest ${rec.deepest.toFixed(3)} m)`);
    check(f.sounds.some((x) => x.surface === 'rock'), `client: rock impact sound (${[...new Set(f.sounds.map((x) => x.surface))].join(', ')})`);
    await page.evaluate(() => (window.__game.input.input.throttle = 0));
    if (want === 'rock') {
      await colliders(true);
      await settle(1500);
      await shot('2-asteroid-colliders');
      await colliders(false);
    }
  }

  // ---- 3. Two ships: our fighter rams a still pirate raider at 40 m/s ---------
  {
    const id = await page.evaluate(stage, { pos: [0, 150, 3000], vel: [0, 0, -40], face: [0, 0, -1], throttle: 40 / 210, assist: true });
    const npc = await page.evaluate(() => {
      const w = window.__t.world();
      const V = w.zone.station.position.constructor;
      const s = w.spawnShip({ classId: 'raider', faction: 'raiders', name: 'Cible', position: new V(0, 150.5, 2880) });
      window.__t.rec.track = (_me, w, r) => {
        const n = w.ships.get(s.id);
        if (n && !r.extra && window.__t.events.some((e) => e.type === 'collision' && e.ship === s.id)) r.extra = { npcSpeed: n.velocity.length(), npcShield: n.shield, meSpeed: _me.velocity.length() };
      };
      return { id: s.id, shield: s.shield };
    });
    check(await impact(id), '3 two ships: our ship hits the raider');
    await shot('3-ship-ship');
    await settle(1500);
    const mine = await collisionsOf(page, id);
    const theirs = await collisionsOf(page, npc.id);
    const rec = await recOf(page);
    const f = await fxOf(page);
    check(mine.some((e) => e.other === npc.id) && theirs.some((e) => e.other === id), 'both ships report the contact, each naming the other');
    check(rec.extra && rec.extra.npcSpeed > 5 && rec.extra.meSpeed < 35, `momentum passed on: the raider pushed to ${rec.extra?.npcSpeed.toFixed(1)} m/s, our ship slowed to ${rec.extra?.meSpeed.toFixed(1)} m/s`);
    check(rec.extra && rec.extra.npcShield < npc.shield, `the raider's shield took the blow (${npc.shield} → ${rec.extra?.npcShield.toFixed(0)})`);
    check(f.sounds.some((x) => x.surface === 'hull') && f.sparks.some((x) => x.mat === 'hull'), 'client: hull-on-hull sparks and sound');
    await page.evaluate((id) => window.__t.world().removeShip(id), npc.id);
    await page.evaluate(() => (window.__game.input.input.throttle = 0));
  }

  // ---- 4. A weak and a violent impact on the same wall: 5 m/s, then 200 m/s ----
  {
    const id = await page.evaluate(stage, { pos: [WALL_X + 30, 30, HANGAR_Z], vel: [-5, 0, 0], face: [-1, 0, 0], throttle: 5 / 210, assist: true });
    check(await impact(id, 180000), '4 weak: the ship touches the wall at 5 m/s');
    await settle(1500);
    const soft = await collisionsOf(page, id);
    const s = await shipState(page);
    const fSoft = await fxOf(page);
    const full = await page.evaluate(() => window.__t.full);
    check(soft.every((e) => e.damage === 0) && s.hull === full.hull && s.shield === full.shield, `4 weak: no damage (${soft.length} contacts, hull ${s.hull}, shield ${s.shield})`);
    await shot('4-weak');
    const id2 = await page.evaluate(stage, { pos: [WALL_X + 330, 30, HANGAR_Z], vel: [-200, 0, 0], face: [-1, 0, 0], throttle: 200 / 210, assist: true });
    check(await impact(id2), '4 violent: the ship hits the wall at 200 m/s');
    await shot('4-violent');
    const wrecked = await until(page, () => window.__fx.notices.some((n) => /Coque détruite/.test(n)), null, 30000);
    const hard = await collisionsOf(page, id2);
    const destroyed = await page.evaluate((id) => window.__t.events.some((e) => e.type === 'destroyed' && e.ship === id), id2);
    const fHard = await fxOf(page);
    const kSoft = Math.max(...fSoft.kicks);
    const kHard = Math.max(...fHard.kicks);
    check(destroyed && hard[0] && Math.abs(hard[0].speed - 200) < 15, `4 violent: 200 m/s into metal is fatal (struck at ${hard[0]?.speed} m/s, ${hard[0]?.damage.toFixed(0)} damage)`);
    check(kHard > kSoft * 5, `4: the camera jolt grows with the violence (${kSoft.toFixed(3)} → ${kHard.toFixed(3)})`);
    check(wrecked && fHard.sounds.some((x) => x.speed > 150 && x.onMe), 'client: the fatal blow is felt and heard as ours, then "Coque détruite"');
    check(Math.max(...fHard.sounds.map((x) => x.speed)) > 150 && Math.max(...fSoft.sounds.map((x) => x.speed)) < 10, '4: the impact sounds know the speed (weak < 10 m/s, violent > 150 m/s)');
    await settle(2500);
    await shot('4-violent-after');
    // Respawn at the station.
    check(await until(page, (old) => { const i = window.__game.inspect(); return i.myShipId !== null && i.myShipId !== old && !!window.__t.ship(); }, id2, 180000), '4: back in a new ship after the crash');
    await settle(2000);
  }

  // ---- 5. A crash that damages one precise part: the left wing, then the cockpit
  {
    const id = await page.evaluate(stage, { pos: [WALL_X + 14, 30, HANGAR_Z + 46], vel: [-80, 0, -20], face: [0, 0, -1], throttle: 0, assist: false, shield: 0 });
    check(await impact(id), '5 wing: the ship slides sideways into the wall, left wing first');
    await until(page, () => window.__fx.notices.some((n) => /Aile gauche/.test(n)), null, 30000);
    await settle(1200);
    await shot('5-wing');
    const hits = await collisionsOf(page, id);
    const s = await shipState(page);
    const parts = await page.evaluate((id) => window.__t.events.filter((e) => e.type === 'partDamaged' && e.ship === id).map((e) => `${e.part}:${e.state}`), id);
    const plan = await page.evaluate(() => ({ wingL: document.querySelector('.stat.parts path[data-p="wingL"]')?.getAttribute('class'), wingR: document.querySelector('.stat.parts path[data-p="wingR"]')?.getAttribute('class'), shown: document.querySelector('.stat.parts')?.classList.contains('show') }));
    const f = await fxOf(page);
    check(hits[0]?.part === 'wingL', `5 wing: the first contact is the left wing (${hits[0]?.part})`);
    check(s.parts.wingL < 0.5 && s.parts.wingR === 1 && s.parts.cockpit === 1 && parts.includes('wingL:damaged'), `5 wing: only the left wing is damaged (left ${(s.parts.wingL * 100).toFixed(0)} %, right ${(s.parts.wingR * 100).toFixed(0)} %; ${parts.join(' ')})`);
    check(plan.shown && plan.wingL === 'dmg' && plan.wingR === 'ok', `HUD plan view: left wing in the damaged colour (${plan.wingL}), right wing intact (${plan.wingR})`);
    check(f.notices.some((n) => /Aile gauche endommagée/.test(n)), 'alert: "Aile gauche endommagée : stabilité réduite"');
    check(len(s.w) + len(s.sp) > 0.01, `the off-centre blow turns the ship (${(len(s.w) + len(s.sp)).toFixed(2)} rad/s)`);

    const id2 = await page.evaluate(stage, { pos: [WALL_X + 140, 30, HANGAR_Z], vel: [-40, 0, 0], face: [-1, 0, 0], throttle: 0, assist: false, shield: 0 });
    check(await impact(id2), '5 cockpit: a frontal crash at 40 m/s, shield down');
    await until(page, () => window.__fx.notices.some((n) => /Verrière/.test(n)), null, 30000);
    await settle(1500);
    await shot('5-cockpit-cracked');
    const s2 = await shipState(page);
    const cracks = await page.evaluate(() => {
      const c = document.getElementById('cracks');
      return { shown: !!c && c.style.display !== 'none', paths: c ? [...c.querySelectorAll('path')].filter((p) => p.style.display !== 'none').length : 0 };
    });
    const f2 = await fxOf(page);
    check(s2.parts.cockpit < 0.5 && s2.parts.wingL === 1 && s2.parts.engines === 1 && s2.alive, `5 cockpit: the cockpit is damaged (${(s2.parts.cockpit * 100).toFixed(0)} %), the rest intact, the ship alive`);
    check(cracks.shown && cracks.paths >= 4 && f2.cockpit > 0, `HUD: the canopy cracks (${cracks.paths} cracks drawn)`);
    check(f2.notices.some((n) => /Verrière fissurée/.test(n)), 'alert: "Verrière fissurée : systèmes perturbés"');
  }

  // ---- Bonus: a moored crate pushed off by our ship ----------------------------
  {
    const crate = await page.evaluate(() => {
      const w = window.__t.world();
      const V = w.zone.station.position.constructor;
      const at = new V(-139, 27, 426);
      const b = [...w.bodies.list.values()].filter((b) => b.kind === 'crate').sort((p, q) => p.position.distanceTo(at) - q.position.distanceTo(at))[0];
      return { id: b.id, p: b.position.toArray() };
    });
    const id = await page.evaluate(stage, { pos: [crate.p[0] + 40, crate.p[1], crate.p[2]], vel: [-12, 0, 0], face: [-1, 0, 0], throttle: 12 / 210, assist: true });
    check(await until(page, (b) => window.__t.events.some((e) => e.type === 'collision' && e.body === b), crate.id, 180000), 'crate: our ship bumps the moored crate');
    await page.evaluate(() => (window.__game.input.input.throttle = 0));
    await settle(3000);
    await shot('6-crate-pushed');
    const moved = await page.evaluate((c) => {
      const b = window.__t.world().bodies.list.get(c.id);
      const view = window.__game.bodyViews.bodies.get(c.id);
      return { server: b.position.toArray(), client: view?.position.toArray() ?? null, speed: b.velocity.length() };
    }, crate);
    const d = Math.hypot(moved.server[0] - crate.p[0], moved.server[1] - crate.p[1], moved.server[2] - crate.p[2]);
    check(d > 1 && moved.speed > 0.5, `crate: knocked away (moved ${d.toFixed(1)} m, drifting at ${moved.speed.toFixed(1)} m/s)`);
    const gap = moved.client ? Math.hypot(moved.client[0] - moved.server[0], moved.client[1] - moved.server[1], moved.client[2] - moved.server[2]) : Infinity;
    check(gap < 3, `crate: drawn where the server has it (${gap.toFixed(2)} m apart, interpolation delay included)`);
    void id;
  }

  check(errors.length === 0, `solo: no console errors or warnings ${errors.join(' | ')}`);
  await page.close();
}

async function online() {
  await build({
    entryPoints: ['src/server/node/server.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: '.collision-check/server.mjs',
    logLevel: 'warning',
  });
  const { startServer } = await import(pathToFileURL('.collision-check/server.mjs').href);
  const server = await startServer({ port: 0, host: '127.0.0.1', staticDir: 'dist', npcs: false, log: () => {} });
  await server.ready;
  const base = `http://127.0.0.1:${server.port}`;
  const world = server.game.world;
  const serverEvents = [];
  // The server's path of one body, tick by tick: [time, x, y, z].
  const trail = [];
  let tracked = null;
  const drain = world.drainEvents.bind(world);
  world.drainEvents = () => {
    const e = drain();
    serverEvents.push(...e);
    if (tracked) trail.push([world.time, tracked.position.x, tracked.position.y, tracked.position.z]);
    return e;
  };
  /** Where the server had the tracked body at server time `t`. */
  const trailAt = (t) => {
    let i = trail.findIndex((x) => x[0] >= t);
    if (i < 0) i = trail.length - 1;
    if (i === 0 || trail[i][0] < t) return trail[i].slice(1);
    const [t0, ...p0] = trail[i - 1];
    const [t1, ...p1] = trail[i];
    const k = (t - t0) / (t1 - t0);
    return p0.map((v, j) => v + (p1[j] - v) * k);
  };
  const pilots = [];
  async function pilot(name) {
    const ctx = await browser.newContext({ viewport: { width: 640, height: 360 }, locale: 'fr-FR' });
    const page = await ctx.newPage();
    const errors = errorsOf(page);
    await page.goto(`${base}/?q=low`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__menu?.isOpen && document.querySelector('#serverStatus.ok'), null, { timeout: 300000 });
    await page.click('[data-tab="register"]');
    await page.fill('#pilotName', name);
    await page.fill('#pilotPass', 'mot-de-passe-test');
    await page.fill('#pilotPass2', 'mot-de-passe-test');
    await page.click('[data-act="online"]');
    await page.waitForFunction(() => window.__game.running && window.__game.inspect().status?.state === 'online' && window.__game.inspect().myShipId !== null, null, { timeout: 120000 });
    await page.evaluate(instrument);
    const p = { page, errors, name, ship: () => [...world.ships.values()].find((s) => s.name === name && s.ownerId) };
    pilots.push(p);
    return p;
  }
  try {
    const A = await pilot('Alpha');
    const B = await pilot('Bravo');
    const a = A.ship();
    const b = B.ship();
    check(!!a && !!b, 'online: two pilots in the shared sector');
    // Staged on the authoritative server: nose to nose 160 m apart in open space, closing at 2 × 30 m/s.
    const V = a.position.constructor;
    const set = (s, p, v, face) => {
      s.position.set(...p);
      s.velocity.set(...v);
      s.rotation.setFromUnitVectors(new V(0, 0, -1), new V(...face).normalize());
      s.angularVelocity.set(0, 0, 0);
      s.spin.set(0, 0, 0);
    };
    for (const P of [A, B]) await P.page.evaluate(() => Object.assign(window.__game.input.input, { throttle: 30 / 210, flightAssist: true }));
    serverEvents.length = 0;
    set(a, [0, 400, 2600], [0, 0, -30], [0, 0, -1]);
    set(b, [0.5, 400, 2440], [0, 0, 30], [0, 0, 1]);
    const t0 = Date.now();
    while (Date.now() - t0 < 120000 && !serverEvents.some((e) => e.type === 'collision' && e.ship === a.id && e.other === b.id)) await sleep(100);
    const pairs = () => serverEvents.filter((e) => e.type === 'collision' && e.other !== undefined);
    check(pairs().some((e) => e.ship === a.id && e.other === b.id) && pairs().some((e) => e.ship === b.id && e.other === a.id), 'online: the server sees Alpha and Bravo collide (each side reported)');
    for (const P of [A, B]) await P.page.evaluate(() => (window.__game.input.input.throttle = 0));
    await sleep(4000);
    // Every blow of the encounter, the first and any later touch (the ships pushing back at each other).
    const onServer = pairs();
    const seen = async (P) => P.page.evaluate(() => window.__fx.events.filter((e) => e.type === 'collision' && e.other !== undefined).map((e) => ({ ship: e.ship, other: e.other, damage: e.damage, speed: e.speed })));
    const sa = await seen(A);
    const sb = await seen(B);
    const key = (e) => `${e.ship}>${e.other}:${e.damage.toFixed(3)}:${e.speed}`;
    const want = onServer.map(key).sort();
    check(sa.length > 0 && JSON.stringify(sa.map(key).sort()) === JSON.stringify(want), `online: Alpha's client saw exactly the server's blows (${sa.length}: ${sa.map(key).join(' ')})`);
    check(sb.length > 0 && JSON.stringify(sb.map(key).sort()) === JSON.stringify(want), `online: Bravo's client saw exactly the server's blows (${sb.length})`);
    const hulls = await Promise.all([A, B].map((P) => P.page.evaluate(() => window.__game.inspect().ships.filter((s) => s.owner).map((s) => [s.name, s.hull]))));
    const truth = [a, b].map((s) => [s.name, Math.round(s.hull)]);
    check(hulls.every((h) => truth.every(([n, hull]) => Math.abs((h.find((x) => x[0] === n)?.[1] ?? -1) - hull) <= 1)), `online: both clients show the server's hulls (${JSON.stringify(truth)})`);
    const fa = await fxOf(A.page);
    const fb = await fxOf(B.page);
    check(fa.kicks.length > 0 && fb.kicks.length > 0 && fa.sounds.some((s) => s.surface === 'hull') && fb.sounds.some((s) => s.surface === 'hull'), 'online: each pilot feels it (camera jolt) and hears hull on hull');
    // Our own predicted ship converges on the server's after the blow.
    const drift = await Promise.all(
      [A, B].map(async (P) => {
        const s = P.ship();
        const pred = await P.page.evaluate(() => window.__game.inspect().predicted);
        return pred ? Math.hypot(pred[0] - s.position.x, pred[1] - s.position.y, pred[2] - s.position.z) : Infinity;
      }),
    );
    check(drift.every((d) => d < 3), `online: each client's predicted ship matches the server after the crash (${drift.map((d) => d.toFixed(2)).join(' m, ')} m)`);
    await A.page.screenshot({ path: `${out}/online-alpha.png` });
    await B.page.screenshot({ path: `${out}/online-bravo.png` });

    // A crate pushed by Alpha, watched by Bravo.
    const crate = [...world.bodies.list.values()].filter((x) => x.kind === 'crate').sort((p, q) => p.position.distanceTo(new V(160, -25, 450)) - q.position.distanceTo(new V(160, -25, 450)))[0];
    const c0 = crate.position.clone();
    tracked = crate;
    set(a, [c0.x + 40, c0.y, c0.z], [-12, 0, 0], [-1, 0, 0]);
    set(b, [c0.x, c0.y + 30, c0.z + 120], [0, 0, 0], [0, -0.2, -1]);
    await A.page.evaluate(() => Object.assign(window.__game.input.input, { throttle: 12 / 210 }));
    const t1 = Date.now();
    while (Date.now() - t1 < 120000 && !serverEvents.some((e) => e.type === 'collision' && e.body === crate.id)) await sleep(100);
    check(serverEvents.some((e) => e.type === 'collision' && e.body === crate.id), 'online: Alpha bumps a crate');
    await A.page.evaluate(() => (window.__game.input.input.throttle = 0));
    await sleep(4000);
    // Each client draws the server's past (its render clock runs an interpolation delay behind):
    // its crate is compared with where the server had the crate at that same server time.
    const views = await Promise.all([A, B].map((P) => P.page.evaluate((id) => ({ p: window.__game.bodyViews.bodies.get(id)?.position.toArray() ?? null, t: window.__game.renderTime, lag: window.__game.buffer.delay }), crate.id)));
    const gaps = views.map((v) => {
      const q = v.p && trailAt(v.t);
      return q ? Math.hypot(v.p[0] - q[0], v.p[1] - q[1], v.p[2] - q[2]) : Infinity;
    });
    const speed = crate.velocity.length();
    check(crate.position.distanceTo(c0) > 1, `online: the crate moved on the server (${crate.position.distanceTo(c0).toFixed(1)} m, drifting at ${speed.toFixed(1)} m/s)`);
    check(gaps.every((g) => g < 1), `online: both clients draw the crate where the server had it at their render time (${gaps.map((g) => g.toFixed(2)).join(' m, ')} m; render delay ${views.map((v) => (v.lag * 1000).toFixed(0)).join(' ms, ')} ms)`);
    await B.page.screenshot({ path: `${out}/online-bravo-crate.png` });
    check(A.errors.length === 0 && B.errors.length === 0, `online: no page errors ${[...A.errors, ...B.errors].join(' | ')}`);
  } finally {
    for (const p of pilots) await p.page.context().close();
    await server.close();
  }
}

try {
  if (part.includes('A')) await solo();
  if (part.includes('B')) await online();
} catch (e) {
  failed++;
  console.log('ERROR', e);
} finally {
  await browser.close();
}
console.log(failed ? `COLLISION CHECK FAILED (${failed})` : 'COLLISION CHECK OK');
process.exit(failed ? 1 : 0);
