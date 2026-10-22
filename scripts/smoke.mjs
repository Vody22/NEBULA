// Automated in-browser smoke test: builds nothing, expects a running server
// at SMOKE_URL (default http://localhost:4173). Launches headless Chromium,
// flies the ship, fires, takes screenshots and fails on any page error.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const url = process.env.SMOKE_URL ?? 'http://localhost:4173';
const quality = process.env.SMOKE_Q ?? 'low';
const out = process.env.SMOKE_OUT ?? 'screenshots';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/fonts\.googleapis|ERR_|net::/.test(m.text())) errors.push('console: ' + m.text());
});

await page.goto(`${url}/?q=${quality}&autostart`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__game && window.__game.debug.frames > 5, null, { timeout: 300000 });
const wait = (ms) => page.waitForTimeout(ms);
const debug = () => page.evaluate(() => ({ ...window.__game.debug }));

await wait(1500);
await page.screenshot({ path: `${out}/01-start.png` });

// Throttle up, steer with the mouse (absolute mode in headless), fire.
await page.keyboard.down('KeyW');
await wait(1500);
await page.keyboard.up('KeyW');
await page.mouse.move(820, 330);
await wait(1500);
await page.mouse.move(640, 360);
await page.screenshot({ path: `${out}/02-flight.png` });
await page.mouse.down();
await wait(1200);
await page.screenshot({ path: `${out}/03-firing.png` });
await page.mouse.up();
await page.keyboard.down('ShiftLeft');
await wait(1200);
await page.screenshot({ path: `${out}/04-boost.png` });
await page.keyboard.up('ShiftLeft');

// Software GL renders only a few frames per second, so fast-forward the
// embedded authoritative server until the first pirate wave is engaging.
await page.evaluate(() => {
  const s = window.__game.transport.server;
  for (let i = 0; i < 60 * 22; i++) s.tick();
});
await page.keyboard.press('KeyT');
await page.mouse.down();
await wait(Number(process.env.SMOKE_FIGHT_MS ?? 6000));
await page.screenshot({ path: `${out}/05-combat.png` });
await page.mouse.up();
await page.evaluate(() => {
  const s = window.__game.transport.server;
  for (let i = 0; i < 60 * 10; i++) s.tick();
});
await wait(4000);
await page.screenshot({ path: `${out}/06-combat2.png` });
const server = await page.evaluate(() => {
  const s = window.__game.transport.server;
  return { wave: s.wave, ships: [...s.world.ships.values()].map((x) => `${x.name}:${x.faction}:${Math.round(x.hull)}`) };
});
console.log(JSON.stringify(server));

// Close-up: spawn a pirate gunship right in front of the player, then destroy it.
await page.evaluate(() => {
  const g = window.__game;
  const s = g.transport.server;
  const me = [...s.world.ships.values()].find((x) => x.ownerId);
  if (!me) return;
  me.input.throttle = 0;
  me.velocity.set(0, 0, 0);
  const fwd = me.position.clone().add(me.velocity.clone().set(0, 0, -1).applyQuaternion(me.rotation).multiplyScalar(90));
  // Face the player, slightly banked, so the hull is visible.
  const facing = me.rotation.clone().multiply(me.rotation.clone().setFromAxisAngle(me.velocity.clone().set(0, 1, 0), 2.5));
  const r = s.world.spawnShip({ classId: 'marauder', faction: 'raiders', name: 'Cible test', position: fwd, rotation: facing });
  window.__testShip = r.id;
  const r2 = s.world.spawnShip({ classId: 'raider', faction: 'raiders', name: 'Cible test 2', position: fwd.clone().add(me.velocity.clone().set(45, 12, 20).applyQuaternion(me.rotation)), rotation: facing });
  window.__testShip2 = r2.id;
});
await wait(3000);
await page.screenshot({ path: `${out}/07-closeup.png` });
await page.evaluate(() => {
  const s = window.__game.transport.server;
  const r = s.world.ships.get(window.__testShip);
  if (r) s.world.applyDamage(r, 99999, null);
});
await wait(1200);
await page.screenshot({ path: `${out}/08-explosion.png` });
const d = await debug();
const fps = await page.evaluate(() => window.__game.fps);
console.log(JSON.stringify({ debug: d, fps: Math.round(fps), errors }, null, 2));
await browser.close();
if (errors.length || d.frames < 30 || d.bolts === 0) {
  console.error('SMOKE TEST FAILED');
  process.exit(1);
}
console.log('SMOKE TEST OK');
