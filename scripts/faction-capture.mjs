// The four hulls in the game scene, for checking faction identity at gameplay
// distances:
//   npm run build && npx vite preview --port 4173 &
//   node scripts/faction-capture.mjs after     (→ screenshots/factions/after/)
// The sector is paused and the ships are placed by hand, so every run shows
// the same moment. Software rendering: compare images, not frame rates.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const label = process.argv[2] ?? 'current';
const url = process.env.UI_URL ?? 'http://localhost:4173';
const quality = process.env.Q ?? 'high';
const out = `screenshots/factions/${label}`;
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/fonts\.googleapis|ERR_|net::/.test(m.text()) && errors.push(m.text()));
await page.goto(`${url}/?q=${quality}&autostart`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__game?.running && window.__game.inspect().myShipId !== null, null, { timeout: 300000 });
await page.waitForFunction(() => window.__game.debug.frames > 40, null, { timeout: 300000, polling: 500 });

await page.evaluate(() => {
  const g = window.__game;
  g.setPaused(true);
  window.__menu.hide();
  document.getElementById('hud').style.display = 'none';
  document.getElementById('capture')?.classList.add('hidden');
  // Hide the live sector's ships so only the placed ones show.
  for (const v of g.views.values()) {
    v.group.visible = false;
    if (v.trail) v.trail.mesh.visible = false;
  }
  const mine = g.views.get(g.inspect().myShipId);
  const ShipView = mine.constructor;
  const cam = g.cam.camera;
  const V = cam.position.constructor;
  const Q = cam.quaternion.constructor;
  const C = g.effects.debrisMat.color.constructor;
  // Far from the station and the belt. Each shot turns the scene (yaw) so
  // its camera looks out into open sky with the sun where it wants it.
  const base = new V(-3000, 600, 4000);
  const rot = new Q();
  const setYaw = (a) => rot.setFromAxisAngle(new V(0, 1, 0), a);
  const w = (p) => new V(...p).applyQuaternion(rot).add(base);
  let extra = [];
  const clear = () => {
    for (const v of extra) v.dispose(g.scene);
    extra = [];
    g.lasers.clear();
    g.lasers.update(0, cam.position);
    g.effects.update(30);
  };
  /** A ship at base + pos, nose pointing along dir. */
  const ship = (cls, pos, dir) => {
    const v = new ShipView(cls, g.scene, false);
    v.group.position.copy(w(pos));
    v.group.quaternion.copy(rot).multiply(new Q().setFromUnitVectors(new V(0, 0, -1), new V(...dir).normalize()));
    v.group.updateMatrixWorld();
    extra.push(v);
    return v;
  };
  const place = (pos, target, fov = 50) => {
    cam.fov = fov;
    cam.updateProjectionMatrix();
    cam.up.set(0, 1, 0);
    cam.position.copy(w(pos));
    cam.lookAt(w(target));
    cam.updateMatrixWorld();
  };
  const tick = (t, throttle = 0.5) => {
    for (const v of extra) v.update(0.016, t, throttle, false, cam.position);
  };
  /** A bolt fired from `from` toward `to`, `age` seconds ago. */
  const bolt = (id, faction, from, to, t, age) => {
    const p0 = w(from);
    const v = w(to).sub(p0).normalize().multiplyScalar(faction === 'union' ? 900 : 800);
    g.lasers.add(id, faction, [p0.x, p0.y, p0.z], [v.x, v.y, v.z], t - age, 2);
  };
  window.__f = { g, V, C, base, clear, ship, place, tick, bolt, cam, setYaw };
});

async function shot(name, setup) {
  await page.evaluate(setup);
  await page.waitForTimeout(300);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('captured', name);
}

// 1–2. The four classes side by side, front and rear three-quarters.
// Front: sun behind the camera. Rear: the scene turned half a turn.
const lineup = (yaw) => {
  const { clear, ship, setYaw } = window.__f;
  setYaw(yaw);
  clear();
  const dir = [0.45, 0, -1];
  [
    ['falcon', 45],
    ['warden', 17],
    ['raider', -9],
    ['marauder', -40],
  ].forEach(([c, x]) => ship(c, [x, 0, 0], dir));
};
await page.evaluate(`window.__lineup = ${lineup.toString()}`);
await shot('f1-lineup-front', () => {
  const { place, tick } = window.__f;
  window.__lineup(1.19);
  place([22, 12, -84], [7, 0, 0], 40);
  tick(1);
});
await shot('f2-lineup-rear', () => {
  const { place, tick } = window.__f;
  window.__lineup(1.19 + Math.PI);
  place([26, 12, 80], [4, 0, 0], 40);
  tick(1, 0.8);
});

// 3. An engagement from behind the player's Falcon: a Warden on its wing,
// two Raiders and a Marauder coming in, fire crossing both ways.
const engagement = () => {
  const { clear, ship, bolt, setYaw } = window.__f;
  setYaw(Math.PI);
  clear();
  const t = 100;
  ship('falcon', [0, 0, 0], [0, 0, -1]);
  ship('warden', [16, 3, -12], [0, 0, -1]);
  ship('raider', [-22, 9, -75], [0.45, -0.1, 1]);
  ship('raider', [26, -4, -105], [-0.4, 0.05, 1]);
  ship('marauder', [-8, 8, -170], [0.15, 0, 1]);
  for (let k = 0; k < 3; k++) {
    // Ages keep every bolt short of its target.
    for (const sx of [-1, 1]) bolt(100 + k * 2 + (sx > 0 ? 1 : 0), 'union', [sx * 4.6, -0.6, -6.5], [-22, 9, -75], t, 0.015 + k * 0.025);
    bolt(200 + k, 'union', [16 + 4.6, 2.4, -18.5], [26, -4, -105], t, 0.02 + k * 0.03);
    bolt(300 + k, 'raiders', [-22 + 3.2, 9, -75 + 5.5], [0, 0, 0], t, 0.02 + k * 0.025);
    bolt(400 + k, 'raiders', [-8 + 7, 7, -160], [16, 3, -12], t, 0.03 + k * 0.04);
  }
  window.__t = t;
};
await page.evaluate(`window.__engagement = ${engagement.toString()}`);
await shot('f3-engagement', () => {
  const { place, tick, g, cam } = window.__f;
  window.__engagement();
  place([0, 6, 28], [0, 1, -80], 60);
  g.lasers.update(window.__t, cam.position);
  tick(window.__t, 0.8);
});

// 4. The same moment from 600 m away: lights and engine colours must still
// say who is who.
await shot('f4-engagement-far', () => {
  const { place, tick, g, cam } = window.__f;
  place([420, 120, -60], [0, 0, -90], 35);
  g.lasers.update(window.__t, cam.position);
  tick(window.__t, 0.8);
});

// 5. A Raider taking a hull hit and a Marauder's shield flaring, 30–60 m.
await shot('f5-hits', () => {
  const { clear, ship, place, tick, g, V, C, cam, setYaw } = window.__f;
  setYaw(Math.PI);
  clear();
  const r = ship('raider', [0, 0, 0], [1, 0, -0.2]);
  const m = ship('marauder', [-8, 4, -60], [1, 0, 0.3]);
  const t = 300;
  const hit = r.group.localToWorld(new V(0.5, 0.6, 1));
  r.hullHit?.(hit, t);
  g.effects.hullHit(hit);
  const sh = m.group.localToWorld(new V(3, 2, 13));
  m.shieldHit(sh, t);
  g.effects.shieldSparks(sh, new C(4, 1.2, 0.4));
  for (let s = 0; s < 0.1; s += 1 / 60) g.effects.update(1 / 60);
  r.setDamage?.(0.7);
  place([-6, 7, 26], [-3, 1, -20], 55);
  for (const v of [r, m]) v.update(0.016, t + 0.1, 0.6, false, cam.position);
});

if (errors.length) {
  console.log('PAGE ERRORS', errors);
  process.exitCode = 1;
} else console.log('no page errors');
await browser.close();
console.log('FACTION CAPTURE DONE →', out);
