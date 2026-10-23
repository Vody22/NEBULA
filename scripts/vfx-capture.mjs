// Combat effects at fixed moments, for before/after comparisons:
//   npm run build && npx vite preview --port 4173 &
//   node scripts/vfx-capture.mjs before        (→ screenshots/vfx/before/)
// The sector is paused and the effects are stepped by hand, so every run
// shows the same instant. Software rendering: compare images, not frame rates.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const label = process.argv[2] ?? 'current';
const url = process.env.UI_URL ?? 'http://localhost:4173';
const quality = process.env.Q ?? 'high';
const out = `screenshots/vfx/${label}`;
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
  const mine = g.views.get(g.inspect().myShipId);
  const cam = g.cam.camera;
  const V = cam.position.constructor;
  // A frame of reference attached to the player's ship.
  const P = mine.group.position.clone();
  const Qs = mine.group.quaternion.clone();
  const at = (x, y, z) => new V(x, y, z).applyQuaternion(Qs).add(P);
  const place = (pos, target, fov = 50) => {
    cam.fov = fov;
    cam.updateProjectionMatrix();
    cam.up.set(0, 1, 0).applyQuaternion(Qs);
    cam.position.copy(pos);
    cam.lookAt(target);
    cam.updateMatrixWorld();
  };
  // Clear whatever the live fight left behind, then step effects by hand.
  const reset = () => {
    g.lasers.clear();
    g.lasers.update(0, cam.position);
    g.effects.update(30);
    mine.flash = 0;
    for (const h of mine.shieldMat.uniforms.uHits.value) h.w = -10;
    mine.update(0.016, 0, 0.6, false, cam.position);
  };
  const step = (seconds) => {
    for (let t = 0; t < seconds - 1e-6; t += 1 / 60) g.effects.update(1 / 60);
  };
  const C = g.effects.debrisMat.color.constructor; // THREE.Color
  window.__fx = { g, mine, cam, V, C, P, Qs, at, place, reset, step };
});

async function shot(name, setup, arg) {
  await page.evaluate(setup, arg);
  await page.waitForTimeout(300);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('captured', name);
}

// 1. A burst from the player's guns and raider fire crossing it.
await shot('fx1-lasers', () => {
  const { g, mine, at, place, reset, V, C, Qs } = window.__fx;
  reset();
  const fwd = new V(0, 0, -1).applyQuaternion(Qs);
  const t = 100;
  for (let k = 0; k < 4; k++) {
    for (const sx of [-1, 1]) {
      const p0 = at(sx * 4.6, -0.6, -6.5 + k * 40);
      const v = fwd.clone().multiplyScalar(900);
      g.lasers.add(1000 + k * 2 + (sx > 0 ? 1 : 0), 'union', [p0.x, p0.y, p0.z], [v.x, v.y, v.z], t - 0.04 - k * 0.045, 2);
    }
  }
  for (let k = 0; k < 5; k++) {
    const p0 = at(160, 10 - k * 3, -120 - k * 25);
    const v = new V(-1, 0.02, 0.15).normalize().applyQuaternion(Qs).multiplyScalar(800);
    g.lasers.add(2000 + k, 'raiders', [p0.x, p0.y, p0.z], [v.x, v.y, v.z], t - 0.1 - k * 0.04, 2);
  }
  for (const sx of [-1, 1]) g.effects.muzzle(at(sx * 4.6, -0.6, -6.5), new V(), new C(1.5, 4, 9), sx > 0);
  g.effects.update(0.02);
  place(at(-22, 7, 26), at(10, -2, -90), 55);
  g.lasers.update(t, g.cam.camera.position);
  mine.update(0.016, t, 0.8, false, g.cam.camera.position);
});

// 2. Shield impact, 0.08 s after the hit.
await shot('fx2-shield-hit', () => {
  const { g, mine, at, place, reset, step, C } = window.__fx;
  reset();
  const hit = at(5, 1.5, -4);
  mine.shieldHit(hit, 200);
  g.effects.shieldSparks(hit, new C(0.6, 1.6, 4));
  step(0.08);
  mine.update(0.016, 200.08, 0.6, false, g.cam.camera.position);
  place(at(24, 6, -14), at(0, 0, 0), 45);
});

// 3. Hull impact, 0.08 s and 0.6 s after the hit.
for (const age of [0.08, 0.6]) {
  await shot(`fx3-hull-hit-${age}`, (a) => {
    const { g, mine, at, place, reset, step } = window.__fx;
    reset();
    const hit = at(3.5, 1.2, 1);
    if (mine.hullHit) mine.hullHit(hit, 300);
    g.effects.hullHit(hit);
    step(a);
    mine.update(0.016, 300 + a, 0.6, false, g.cam.camera.position);
    place(at(20, 7, 4), at(0, 0, 0), 40);
  }, age);
}

// 4. A fighter blowing up, seen from 150 m, at four moments.
for (const age of [0.06, 0.3, 1.0, 3.0]) {
  await page.evaluate((a) => {
    const { g, at, place, reset, step } = window.__fx;
    reset();
    const p = at(60, 10, -180);
    g.effects.explosion(p, 1);
    step(a);
    place(at(10, 25, -30), p, 50);
  }, age);
  await page.waitForTimeout(300);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: `${out}/fx4-explosion-${age}.png` });
  console.log('captured', `fx4-explosion-${age}`);
}

if (errors.length) {
  console.log('PAGE ERRORS', errors);
  process.exitCode = 1;
} else console.log('no page errors');
await browser.close();
console.log('VFX CAPTURE DONE →', out);
