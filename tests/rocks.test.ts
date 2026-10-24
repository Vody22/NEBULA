import { describe, expect, it } from 'vitest';
import { IcosahedronGeometry, Quaternion, Vector3 } from 'three';
import { Predictor } from '../src/client/net/Predictor';
import { snapshotShip } from '../src/shared/net/protocol';
import { HITBOXES } from '../src/shared/physics/hitboxes';
import { rockCollision, rockShape } from '../src/shared/physics/rocks';
import { distanceTo, spinOf } from '../src/shared/physics/shapes';
import { StaticGrid } from '../src/shared/sim/spatialGrid';
import type { Ship, SimEvent, StaticCollider } from '../src/shared/sim/types';
import { neutralInput } from '../src/shared/sim/types';
import { World } from '../src/shared/sim/world';
import { asteroidCollider, buildSector, buildZone, type AsteroidDef } from '../src/shared/sim/zone';

/** One asteroid at `at` (the zone generator's parameters), alone in a world without loose bodies. */
function rockWorld(def: Partial<AsteroidDef> & { radius: number; variant: number }) {
  const a: AsteroidDef = { position: new Vector3(0, 0, -400), spinAxis: [0, 1, 0], spinSpeed: 0, ...def };
  const zone = buildZone(1);
  zone.asteroids.length = 0;
  zone.asteroids.push(a);
  zone.colliders.length = 0;
  zone.colliders.push(asteroidCollider(a, 0));
  const w = new World(zone, { bodies: false });
  return { w, a, c: zone.colliders[0] };
}

function coasting(w: World, position: Vector3, velocity: Vector3, rotation = new Quaternion()) {
  const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'p', position, velocity, rotation, ownerId: 'p' });
  s.input.flightAssist = false;
  s.input.throttle = 0;
  return s;
}

/** Deepest penetration of a ship's hit spheres into a collider (m, ≤ 0 when clear). */
function deepest(c: StaticCollider, s: Ship, time: number) {
  let worst = Infinity;
  for (const h of HITBOXES[s.classId]) worst = Math.min(worst, distanceTo(c, h.at.clone().applyQuaternion(s.rotation).add(s.position), time) - h.r);
  return worst;
}

/** Where the drawn surface is in the direction of world point `p` (distance from the rock's centre, m). */
function surfaceRadius(c: StaticCollider, a: AsteroidDef, p: Vector3, time: number) {
  const local = p.clone().sub(c.center).applyQuaternion(spinOf(c, time, new Quaternion()).invert());
  return rockCollision(a.variant, a.radius >= 140).surfaceAt(local.normalize()) * a.radius;
}

/** Facing `dir` (the nose is local −Z). */
const facing = (dir: Vector3) => new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir.clone().normalize());

describe('asteroids collide as they are drawn', () => {
  it('the collision surface follows the rendered rock within a few % of its radius (the old sphere was off by up to 45 %)', () => {
    const n = new Vector3();
    for (const big of [false, true]) {
      for (let v = 0; v < 4; v++) {
        const shape = rockShape(v, big);
        const rc = rockCollision(v, big);
        // The renderer's own vertices (Asteroids.ts: an icosphere displaced by the same relief).
        const pos = new IcosahedronGeometry(1, big ? 22 : 6).attributes.position;
        const u = new Vector3();
        let sum = 0;
        let max = 0;
        let oldWorst = 0;
        for (let i = 0; i < pos.count; i++) {
          u.fromBufferAttribute(pos, i).normalize();
          const p = u.clone().multiplyScalar(shape.relief(u).r).multiply(shape.stretch);
          const d = Math.abs(rc.distance(p, n));
          sum += d;
          max = Math.max(max, d);
          oldWorst = Math.max(oldWorst, Math.abs(p.length() - 0.85));
        }
        expect(sum / pos.count).toBeLessThan(0.005);
        expect(max).toBeLessThan(0.04); // crater rims, the only sharp steps
        expect(oldWorst).toBeGreaterThan(0.25);
      }
    }
  });

  it('the bounding sphere holds the whole rock, and the zone uses the drawn shapes', () => {
    const zone = buildSector('aurora', 1337);
    const rocks = zone.colliders.filter((c) => c.kind === 'asteroid');
    expect(rocks.length).toBe(zone.asteroids.length);
    for (const c of rocks.slice(0, 40)) {
      const a = zone.asteroids[c.index!];
      expect(c.shape).toEqual({ t: 'rock', v: a.variant, big: a.radius >= 140, s: a.radius });
      expect(c.spin).toBe(a.spinSpeed);
      const shape = rockShape(a.variant, a.radius >= 140);
      const u = new Vector3();
      for (let i = 0; i < 200; i++) {
        u.set(Math.sin(i * 1.7), Math.cos(i * 2.3), Math.sin(i * 0.9 + 1)).normalize();
        const p = u.clone().multiplyScalar(shape.relief(u).r).multiply(shape.stretch).multiplyScalar(a.radius);
        expect(p.length()).toBeLessThanOrEqual(c.radius);
      }
    }
  });

  it('a ship stops on the visible surface: the contact point is where the rock is drawn', () => {
    for (let v = 0; v < 4; v++) {
      const { w, a, c } = rockWorld({ radius: 60, variant: v, spinAxis: [0.3, 0.9, 0.3], spinSpeed: 0.1 });
      const dirs = [new Vector3(0, 0, 1), new Vector3(1, 0.2, 0), new Vector3(-0.4, 0.8, 0.4), new Vector3(0, -1, 0.2)];
      for (const d of dirs) {
        d.normalize();
        const s = coasting(w, a.position.clone().addScaledVector(d, 200), d.clone().multiplyScalar(-25), facing(d.clone().negate()));
        const events: SimEvent[] = [];
        let worst = Infinity;
        for (let i = 0; i < 360 && !events.some((e) => e.type === 'collision' && e.ship === s.id); i++) {
          w.step();
          events.push(...w.drainEvents());
          worst = Math.min(worst, deepest(c, s, w.time));
        }
        const hit = events.find((e): e is Extract<SimEvent, { type: 'collision' }> => e.type === 'collision' && e.ship === s.id)!;
        expect(hit, `variant ${v} from ${d.toArray()}`).toBeDefined();
        expect(hit.mat).toBe(v === 3 ? 'metalRock' : 'rock');
        const at = new Vector3(...hit.pos);
        // On the drawn surface: within 30 cm on a 60 m rock (the sphere it replaces was off by up to 27 m).
        expect(Math.abs(at.distanceTo(a.position) - surfaceRadius(c, a, at, w.time))).toBeLessThan(0.3);
        expect(worst).toBeGreaterThan(-0.3);
        w.removeShip(s.id);
      }
    }
  });

  it('cannot fly into a rock from any side, even at full boost speed', () => {
    for (const big of [false, true]) {
      for (let v = 0; v < 4; v++) {
        const radius = big ? 220 : 60;
        const { w, a, c } = rockWorld({ radius, variant: v, spinAxis: [0, 0.8, 0.6], spinSpeed: 0.05 });
        const ico = new IcosahedronGeometry(1, 0).attributes.position;
        for (let i = 0; i < ico.count; i += 3) {
          const d = new Vector3().fromBufferAttribute(ico, i).normalize();
          const s = coasting(w, a.position.clone().addScaledVector(d, radius * 1.4 + 160), d.clone().multiplyScalar(-470), facing(d.clone().negate()));
          let deepestSeen = Infinity;
          let centreInside = false;
          for (let k = 0; k < 90 && s.alive; k++) {
            w.step();
            w.drainEvents();
            if (!s.alive) break;
            deepestSeen = Math.min(deepestSeen, deepest(c, s, w.time));
            if (s.position.distanceTo(a.position) < surfaceRadius(c, a, s.position, w.time)) centreInside = true;
          }
          // 470 m/s into rock is fatal: but it ends on the near side, never inside.
          expect(centreInside, `variant ${v} big ${big} dir ${i}`).toBe(false);
          expect(deepestSeen).toBeGreaterThan(-1);
          if (s.alive) w.removeShip(s.id);
        }
      }
    }
  });

  it('a turning rock shoves a parked ship aside instead of swallowing it', () => {
    // A fast-turning lumpy rock (the belt's fastest small rocks: 0.27 rad/s), its bumps sweeping past a parked ship.
    const { w, a, c } = rockWorld({ radius: 70, variant: 1, spinAxis: [0, 1, 0], spinSpeed: 0.27 });
    const d = new Vector3(1, 0, 0);
    const start = a.position.clone().addScaledVector(d, surfaceRadius(c, a, a.position.clone().add(d), 0) + 10);
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'p', position: start, rotation: facing(new Vector3(0, 0, -1)), ownerId: 'p' });
    s.input.throttle = 0; // flight assist on: it tries to hold still
    let worst = Infinity;
    for (let i = 0; i < 600; i++) {
      w.step();
      w.drainEvents();
      worst = Math.min(worst, deepest(c, s, w.time));
    }
    expect(s.alive).toBe(true);
    expect(worst).toBeGreaterThan(-0.5);
  });

  it('laser bolts strike the drawn surface', () => {
    const { w, a, c } = rockWorld({ radius: 80, variant: 2, spinAxis: [0.6, 0.8, 0], spinSpeed: 0.2 });
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'p', position: a.position.clone().add(new Vector3(30, 15, 500)), ownerId: 'p' });
    s.input.fire = true;
    const impacts: { pos: Vector3; time: number }[] = [];
    for (let i = 0; i < 180; i++) {
      w.setInput(s.id, { ...neutralInput(), fire: true });
      w.step();
      for (const e of w.drainEvents()) if (e.type === 'impact') impacts.push({ pos: new Vector3(...e.pos), time: w.time });
    }
    expect(impacts.length).toBeGreaterThan(5);
    for (const im of impacts) expect(Math.abs(im.pos.distanceTo(a.position) - surfaceRadius(c, a, im.pos, im.time))).toBeLessThan(0.3);
  });

  it("client prediction against a turning rock matches the server (it uses the server's clock)", () => {
    const { w, a, c } = rockWorld({ radius: 70, variant: 0, spinAxis: [0.2, 1, 0.1], spinSpeed: 0.25 });
    // Late in the server's life: the rock has turned a long way since time 0.
    w.time = 3737;
    const d = new Vector3(0.3, 0.2, 1).normalize();
    const s = coasting(w, a.position.clone().addScaledVector(d, surfaceRadius(c, a, a.position.clone().add(d), w.time) + 60), d.clone().multiplyScalar(-30), facing(d.clone().negate()));
    w.step();
    const predict = (time: number) => {
      // Its own grid, as in the browser: only the predictor sets its clock.
      const p = new Predictor(new StaticGrid(w.zone.colliders));
      p.reconcile(snapshotShip(s), 0, time);
      return p;
    };
    const right = predict(w.time);
    const wrong = predict(0);
    const input = { ...neutralInput(), flightAssist: false };
    let hit = false;
    for (let seq = 1; seq <= 180; seq++) {
      right.step(seq, input);
      wrong.step(seq, input);
      w.setInput(s.id, input);
      w.step();
      hit ||= w.drainEvents().some((e) => e.type === 'collision');
    }
    expect(hit).toBe(true);
    expect(right.ship!.position.distanceTo(s.position)).toBeLessThan(0.25);
    expect(right.ship!.velocity.distanceTo(s.velocity)).toBeLessThan(0.1);
    // With the rock where it was at time 0, the prediction would be wrong.
    expect(wrong.ship!.position.distanceTo(s.position) + wrong.ship!.velocity.distanceTo(s.velocity)).toBeGreaterThan(1);
  });

  it('60 ships bouncing off the belt rocks stay cheap', () => {
    const w = new World(buildSector('aurora', 1337), { bodies: false });
    const rocks = w.zone.asteroids.filter((r) => r.radius > 30).slice(0, 60);
    rocks.forEach((r, i) => {
      // Each one aimed at its rock at 120 m/s.
      const d = new Vector3(Math.sin(i), 0.3, Math.cos(i)).normalize();
      const s = coasting(w, r.position.clone().addScaledVector(d, r.radius * 1.5 + 60), d.clone().multiplyScalar(-120), facing(d.clone().negate()));
      s.ownerId = `p${i}`;
    });
    for (let i = 0; i < 30; i++) w.step();
    const t0 = performance.now();
    const ticks = 240;
    let collisions = 0;
    for (let i = 0; i < ticks; i++) {
      w.step();
      collisions += w.drainEvents().filter((e) => e.type === 'collision').length;
    }
    const perTick = (performance.now() - t0) / ticks;
    expect(collisions).toBeGreaterThan(30);
    expect(perTick).toBeLessThan(3);
  });
});
