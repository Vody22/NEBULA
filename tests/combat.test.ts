import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { World, TICK_DT } from '../src/shared/sim/world';
import { buildZone } from '../src/shared/sim/zone';
import { SHIP_CLASSES } from '../src/shared/sim/shipClasses';
import { interceptPoint } from '../src/shared/math';

function openWorld() {
  const zone = buildZone(2);
  zone.colliders.length = 0;
  return new World(zone);
}
const run = (w: World, s: number) => { for (let i = 0; i < Math.round(s / TICK_DT); i++) w.step(); };

describe('combat', () => {
  it('lasers hit an enemy in front: shield first, then hull, then destruction', () => {
    const w = openWorld();
    const a = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'a', position: new Vector3(0, 0, 0) });
    const b = w.spawnShip({ classId: 'raider', faction: 'raiders', name: 'b', position: new Vector3(0, 0, -400) });
    a.input.fire = true;
    run(w, 0.6);
    const ev = w.drainEvents();
    expect(ev.filter((e) => e.type === 'shot').length).toBeGreaterThan(3);
    const hits = ev.filter((e) => e.type === 'hit');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].type === 'hit' && hits[0].shield).toBe(true);
    expect(b.shield).toBeLessThan(SHIP_CLASSES.raider.shield);
    expect(b.hull).toBe(SHIP_CLASSES.raider.hull);
    run(w, 4);
    const all = w.drainEvents();
    const destroyed = all.find((e) => e.type === 'destroyed');
    expect(destroyed).toBeDefined();
    expect(destroyed && destroyed.type === 'destroyed' && destroyed.by).toBe(a.id);
    expect(w.ships.has(b.id)).toBe(false);
  });

  it('friendly fire is ignored', () => {
    const w = openWorld();
    const a = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'a', position: new Vector3(0, 0, 0) });
    const b = w.spawnShip({ classId: 'warden', faction: 'union', name: 'b', position: new Vector3(0, 0, -300) });
    a.input.fire = true;
    run(w, 1);
    expect(b.shield).toBe(SHIP_CLASSES.warden.shield);
  });

  it('shields regenerate after the delay', () => {
    const w = openWorld();
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'a', position: new Vector3() });
    w.applyDamage(s, 100, null);
    expect(s.shield).toBe(SHIP_CLASSES.falcon.shield - 100);
    run(w, SHIP_CLASSES.falcon.shieldDelay - 0.5);
    expect(s.shield).toBe(SHIP_CLASSES.falcon.shield - 100);
    run(w, 3);
    expect(s.shield).toBeGreaterThan(SHIP_CLASSES.falcon.shield - 100);
  });

  it('weapons are limited by energy', () => {
    const w = openWorld();
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'a', position: new Vector3() });
    s.energy = 3;
    s.input.fire = true;
    w.step();
    w.step();
    w.step();
    const shots = w.drainEvents().filter((e) => e.type === 'shot').length;
    expect(shots).toBeLessThanOrEqual(2);
  });

  it('intercept point leads a crossing target', () => {
    const p = interceptPoint(new Vector3(), new Vector3(), new Vector3(0, 0, -1000), new Vector3(100, 0, 0), 1000)!;
    expect(p).not.toBeNull();
    expect(p.x).toBeGreaterThan(90);
    const t = p.length() / 1000;
    expect(p.x).toBeCloseTo(100 * t, 3);
  });

  it('lasers are stopped by asteroids', () => {
    const zone = buildZone(2);
    zone.colliders.length = 0;
    zone.colliders.push({ kind: 'asteroid', center: new Vector3(0, 0, -200), radius: 40 });
    const w = new World(zone);
    const a = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'a', position: new Vector3(), rotation: new Quaternion() });
    const b = w.spawnShip({ classId: 'raider', faction: 'raiders', name: 'b', position: new Vector3(0, 0, -500) });
    a.input.fire = true;
    run(w, 1);
    expect(b.shield).toBe(SHIP_CLASSES.raider.shield);
    expect(w.drainEvents().some((e) => e.type === 'impact')).toBe(true);
  });
});
