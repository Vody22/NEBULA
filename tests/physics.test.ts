import { HITBOXES } from '../src/shared/physics/hitboxes';
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { World, TICK_DT } from '../src/shared/sim/world';
import { buildZone } from '../src/shared/sim/zone';
import { SHIP_CLASSES } from '../src/shared/sim/shipClasses';
import { forwardOf } from '../src/shared/math';

function emptyWorld() {
  const zone = buildZone(1);
  zone.colliders.length = 0; // open space for isolated physics tests
  return new World(zone);
}
const run = (w: World, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) w.step();
};

describe('ship physics', () => {
  it('accelerates along -Z with inertia up to the throttle speed', () => {
    const w = emptyWorld();
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 't', position: new Vector3(5e4, 0, 0) });
    s.input.throttle = 1;
    run(w, 0.5);
    const early = s.velocity.length();
    expect(early).toBeGreaterThan(20);
    expect(early).toBeLessThan(SHIP_CLASSES.falcon.maxSpeed); // not instantaneous
    run(w, 5);
    expect(s.velocity.z).toBeCloseTo(-SHIP_CLASSES.falcon.maxSpeed, 0);
    expect(Math.abs(s.velocity.x)).toBeLessThan(1e-6);
  });

  it('boost raises top speed and drains energy', () => {
    const w = emptyWorld();
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 't', position: new Vector3(5e4, 0, 0) });
    s.input.throttle = 1;
    s.input.boost = true;
    run(w, 1.5);
    expect(s.velocity.length()).toBeGreaterThan(SHIP_CLASSES.falcon.maxSpeed);
    expect(s.energy).toBeLessThan(SHIP_CLASSES.falcon.energy);
  });

  it('an emptied capacitor stops the boost cleanly until it is back to 30 %', () => {
    const w = emptyWorld();
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 't', position: new Vector3(5e4, 0, 0) });
    s.input.throttle = 1;
    s.input.boost = true;
    // Boost held all along: every time it comes back on, the capacitor is at 30 % at least.
    const restarts: number[] = [];
    let was = false;
    let emptied = 0;
    for (let i = 0; i < 60 * 30; i++) {
      w.step();
      if (s.boosting && !was && w.time > TICK_DT * 2) restarts.push(s.energy / SHIP_CLASSES.falcon.energy);
      if (!s.boosting && was) emptied++;
      was = s.boosting;
    }
    expect(emptied).toBeGreaterThan(0);
    expect(restarts.length).toBeGreaterThan(0);
    for (const r of restarts) expect(r).toBeGreaterThan(0.29);
    // Right after emptying, the boost stays off while energy comes back.
    const w2 = emptyWorld();
    const t = w2.spawnShip({ classId: 'falcon', faction: 'union', name: 't', position: new Vector3(5e4, 0, 0) });
    t.input.boost = true;
    t.energy = 2;
    run(w2, 0.1);
    expect(t.weaponsLocked).toBe(true);
    expect(t.boosting).toBe(false);
    run(w2, 1.5);
    expect(t.energy).toBeGreaterThan(2);
    expect(t.energy).toBeLessThan(SHIP_CLASSES.falcon.energy * 0.3);
    expect(t.boosting).toBe(false);
    for (let i = 0; i < 60 * 20 && !t.boosting; i++) w2.step();
    expect(t.boosting).toBe(true);
    expect(t.energy).toBeGreaterThan(SHIP_CLASSES.falcon.energy * 0.29);
  });

  it('turning with flight assist produces drift that decays', () => {
    const w = emptyWorld();
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 't', position: new Vector3(5e4, 0, 0) });
    s.input.throttle = 1;
    run(w, 5);
    s.input.yaw = 1;
    run(w, 1.0);
    s.input.yaw = 0;
    const fwd = forwardOf(s.rotation);
    const lateral = s.velocity.clone().sub(fwd.clone().multiplyScalar(s.velocity.dot(fwd))).length();
    expect(lateral).toBeGreaterThan(10); // velocity lags the nose: inertia
    run(w, 4);
    const fwd2 = forwardOf(s.rotation);
    const lateral2 = s.velocity.clone().sub(fwd2.clone().multiplyScalar(s.velocity.dot(fwd2))).length();
    expect(lateral2).toBeLessThan(1);
  });

  it('flight assist off keeps drifting (Newtonian)', () => {
    const w = emptyWorld();
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 't', position: new Vector3(5e4, 0, 0) });
    s.input.throttle = 1;
    run(w, 2);
    s.input.flightAssist = false;
    s.input.throttle = 0;
    const v = s.velocity.clone();
    s.input.yaw = 1;
    run(w, 1);
    expect(s.velocity.distanceTo(v)).toBeLessThan(1e-6);
  });

  it('yaw right turns the nose toward +X, pitch up toward +Y', () => {
    const w = emptyWorld();
    const a = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'a', position: new Vector3(5e4, 0, 0) });
    const b = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'b', position: new Vector3(-5e4, 0, 0) });
    a.input.yaw = 1;
    b.input.pitch = 1;
    run(w, 0.4);
    expect(forwardOf(a.rotation).x).toBeGreaterThan(0.1);
    expect(forwardOf(b.rotation).y).toBeGreaterThan(0.1);
  });

  it('bounces off asteroids and takes impact damage', () => {
    const zone = buildZone(1);
    zone.colliders.length = 0;
    zone.colliders.push({ kind: 'asteroid', center: new Vector3(0, 0, -300), radius: 50, material: 'rock' });
    const w = new World(zone);
    // A player's ship (full hit spheres) at 60 m/s: it survives, damaged (v0.8: 200 m/s into rock is fatal).
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 't', position: new Vector3(0, 0, 0), velocity: new Vector3(0, 0, -60), ownerId: 'p' });
    s.input.throttle = 0.3;
    run(w, 6);
    expect(s.alive).toBe(true);
    // No collision sphere of the ship ended up inside the rock (v0.8: the ship is a cluster of spheres).
    for (const h of HITBOXES.falcon) {
      const at = h.at.clone().applyQuaternion(s.rotation).add(s.position);
      expect(at.distanceTo(new Vector3(0, 0, -300))).toBeGreaterThanOrEqual(50 + h.r - 0.01);
    }
    expect(s.shield + s.hull).toBeLessThan(SHIP_CLASSES.falcon.shield + SHIP_CLASSES.falcon.hull);
    expect(w.drainEvents().some((e) => e.type === 'collision')).toBe(true);
  });
});
