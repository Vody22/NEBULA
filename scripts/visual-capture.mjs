// Reference captures for the visual direction: the same cameras and the same
// moment every time, so "before" and "after" images can be compared 1:1.
//   npm run build && npx vite preview --port 4173 &
//   node scripts/visual-capture.mjs before        (→ screenshots/visual/before/)
// Software rendering (SwiftShader): good for comparing images, not for frame rates.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const label = process.argv[2] ?? 'current';
const url = process.env.UI_URL ?? 'http://localhost:4173';
const quality = process.env.Q ?? 'high';
const out = `screenshots/visual/${label}`;
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
// Let the camera settle behind the ship, then a gameplay frame with the HUD.
await page.waitForFunction(() => window.__game.debug.frames > 40, null, { timeout: 300000, polling: 500 });
await page.screenshot({ path: `${out}/01-gameplay-hud.png` });

// Freeze the sector: from here on only the camera and the props move.
await page.evaluate(() => {
  const g = window.__game;
  g.setPaused(true);
  window.__menu.hide();
  document.getElementById('hud').style.display = 'none';
  document.getElementById('capture')?.classList.add('hidden');
  const views = g.views;
  const mine = views.get(g.inspect().myShipId);
  const V = mine.constructor;
  const cam = g.cam.camera;
  const T = cam.position.constructor; // THREE.Vector3
  const Q = cam.quaternion.constructor; // THREE.Quaternion
  window.__shot = { g, mine, V, T, Q, cam, extra: [] };
});

async function shot(name, setup) {
  // ONLY=10,20 captures just the shots whose names start with those prefixes.
  if (process.env.ONLY && !process.env.ONLY.split(',').some((k) => name.startsWith(k))) return;
  await page.evaluate(setup);
  // Two rendered frames so every pass (bloom, sky) sees the new camera.
  const f0 = await page.evaluate(() => window.__shot.g.debug.frames);
  await page.waitForTimeout(400);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('captured', name, f0);
}

const look = (pos, target, fov = 55) => ({ pos, target, fov });
const place = () => {
  window.__place = (s) => {
    const { cam } = window.__shot;
    cam.fov = s.fov;
    cam.updateProjectionMatrix();
    cam.up.set(0, 1, 0);
    cam.position.set(...s.pos);
    cam.lookAt(...s.target);
    cam.updateMatrixWorld();
  };
};
await page.evaluate(place);

// Ship close-ups: the player's Falcon, then all four classes side by side.
await shot('02-falcon-hero', () => {
  const { mine, T, cam } = window.__shot;
  const p = mine.group.position;
  const q = mine.group.quaternion;
  const off = new T(15, 6, -20).applyQuaternion(q);
  window.__place({ pos: [p.x + off.x, p.y + off.y, p.z + off.z], target: [p.x, p.y, p.z + 0], fov: 45 });
  mine.update(0.016, 1, 0.6, false, cam.position);
});
await shot('03-falcon-rear', () => {
  const { mine, T, cam } = window.__shot;
  const p = mine.group.position;
  const off = new T(-9, 4, 24).applyQuaternion(mine.group.quaternion);
  window.__place({ pos: [p.x + off.x, p.y + off.y, p.z + off.z], target: [p.x, p.y, p.z], fov: 45 });
  mine.update(0.016, 1, 0.9, false, cam.position);
});
await shot('04-fleet-lineup', () => {
  const s = window.__shot;
  const { g, V, T, Q } = s;
  for (const v of s.extra) v.dispose(g.scene);
  s.extra = [];
  const base = new T(900, 160, 900);
  const classes = ['falcon', 'warden', 'raider', 'marauder'];
  classes.forEach((c, i) => {
    const v = new V(c, g.scene, false);
    v.group.position.set(base.x + (i - 1.5) * 26, base.y, base.z);
    v.group.quaternion.copy(new Q().setFromAxisAngle(new T(0, 1, 0), Math.PI * 0.82));
    v.group.updateMatrixWorld();
    s.extra.push(v);
  });
  window.__place({ pos: [base.x + 22, base.y + 14, base.z + 52], target: [base.x, base.y, base.z], fov: 50 });
  for (const v of s.extra) v.update(0.016, 1, 0.5, false, s.cam.position);
});
await shot('05-combat', () => {
  const s = window.__shot;
  const { g, T } = s;
  const base = new T(900, 160, 900);
  g.effects.explosion(new T(base.x + 18, base.y + 4, base.z - 30), 1.4);
  g.effects.update(0.18);
  const t = g.time;
  for (let i = 0; i < 6; i++) g.lasers.add(9000 + i, i % 2 ? 'raiders' : 'union', [base.x - 40 + i * 6, base.y + (i % 3) * 3, base.z + 20], [i % 2 ? -600 : 600, 0, -900], t - 0.05, 2);
  window.__place({ pos: [base.x + 30, base.y + 22, base.z + 70], target: [base.x, base.y, base.z - 10], fov: 50 });
  g.lasers.update(t, s.cam.position);
});
// Station, planets, sky, asteroids.
await shot('06-station-wide', () => window.__place({ pos: [2300, 700, 2600], target: [0, 0, 0], fov: 55 }));
await shot('07-station-close', () => window.__place({ pos: [760, 90, 330], target: [0, 60, 0], fov: 60 }));
await shot('08-planet-kerys', () => window.__place({ pos: [600, 300, 1500], target: [-26000, -6500, -52000], fov: 50 }));
await shot('21-kerys-close', () => window.__place({ pos: [-8520, -2130, -17040], target: [-26000, -6500, -52000], fov: 50 }));
await shot('09-thalassa-nyx', () => window.__place({ pos: [1200, 300, 600], target: [30000, 7000, -26000], fov: 45 }));
await shot('20-thalassa-close', () => window.__place({ pos: [18840, 4390, -16325], target: [30000, 7000, -26000], fov: 45 }));
await shot('10-nebula-sky', () => window.__place({ pos: [0, 2000, 3000], target: [0, 4000, 9000], fov: 70 }));
// Station details (added in step 4, no v0.2 "before").
await shot('12-hangar-approach', () => window.__place({ pos: [70, -15, 470], target: [0, -5, 300], fov: 60 }));
await shot('14-hangar-inside', () => window.__place({ pos: [30, -18, 322], target: [-15, -32, 200], fov: 62 }));
await shot('15-hangar-deck', () => window.__place({ pos: [-70, -34, 300], target: [30, -30, 205], fov: 62 }));
await shot('18-hangar-side', () => window.__place({ pos: [300, 70, 420], target: [0, -10, 250], fov: 55 }));
await shot('19-hangar-fin', () => window.__place({ pos: [215, -45, 345], target: [108, -10, 245], fov: 55 }));
await shot('16-depot-approach', () => window.__place({ pos: [4834.4, -85, -5546.7], target: [4941.2, -100, -5731.8], fov: 60 }));
await shot('17-depot-inside', () => window.__place({ pos: [4934.0, -112, -5695.8], target: [4956.0, -122, -5771.9], fov: 62 }));
await shot('13-cargo-ring', () => window.__place({ pos: [-300, -30, 360], target: [-190, -68, 245], fov: 50 }));
await shot('11-asteroids', () => {
  const { g } = window.__shot;
  const big = g.zone.asteroids.filter((a) => a.radius > 150).sort((a, b) => a.position.length() - b.position.length())[0];
  const p = big.position;
  const d = big.radius * 2.6;
  window.__place({ pos: [p.x + d * 0.7, p.y + d * 0.35, p.z + d * 0.6], target: [p.x, p.y, p.z], fov: 60 });
});

console.log(errors.length ? `errors: ${errors.join(' | ')}` : 'no page errors');
await browser.close();
console.log(`VISUAL CAPTURE DONE → ${out}`);
