import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { Predictor } from '../src/client/net/Predictor';
import { snapshotShip } from '../src/shared/net/protocol';
import { IMPACT_THRESHOLD, impactDamage } from '../src/shared/physics/collide';
import { flightFactors } from '../src/shared/physics/damage';
import { HITBOXES, massOf } from '../src/shared/physics/hitboxes';
import { MATERIALS } from '../src/shared/physics/materials';
import { distanceTo } from '../src/shared/physics/shapes';
import { HUB_HANGAR } from '../src/shared/physics/structures';
import { statsOf } from '../src/shared/sim/upgrades';
import type { Ship, ShipClassId, SimEvent, StaticCollider } from '../src/shared/sim/types';
import { neutralInput } from '../src/shared/sim/types';
import { TICK_DT, World } from '../src/shared/sim/world';
import { buildSector, buildZone } from '../src/shared/sim/zone';

const Y = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
/** Facing −Y. */
const FACE_DOWN = new Quaternion().setFromAxisAngle(X, -Math.PI / 2);

/** A world with only the given colliders. */
function worldWith(colliders: StaticCollider[]) {
  const zone = buildZone(1);
  zone.colliders.length = 0;
  zone.colliders.push(...colliders);
  return new World(zone);
}
const aurora = () => new World(buildSector('aurora', 1337));

/** A player's ship (players always get the full hit spheres), coasting: no thrust, no flight assist. */
function coasting(w: World, classId: ShipClassId, position: Vector3, velocity: Vector3, rotation = new Quaternion(), owner = 'p1') {
  const s = w.spawnShip({ classId, faction: 'union', name: owner, position, velocity, rotation, ownerId: owner });
  s.input.flightAssist = false;
  s.input.throttle = 0;
  return s;
}

function run(w: World, seconds: number) {
  const events: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    w.step();
    events.push(...w.drainEvents());
  }
  return events;
}

/** Deepest penetration of any hit sphere of `s` into the world's colliders (m, ≤ 0 when clear). */
function deepest(w: World, s: Ship) {
  let worst = Infinity;
  for (const h of HITBOXES[s.classId]) {
    const at = h.at.clone().applyQuaternion(s.rotation).add(s.position);
    for (const c of w.zone.colliders) worst = Math.min(worst, distanceTo(c, at, w.time) - h.r);
  }
  return worst;
}

const collisions = (events: SimEvent[], ship?: number) =>
  events.filter((e): e is Extract<SimEvent, { type: 'collision' }> => e.type === 'collision' && (ship === undefined || e.ship === ship));

/** Hub hangar (Aurora-7, at the origin): its centre on z, and the outer face of its roof. */
const HANGAR_Z = 170 * 1.08 + HUB_HANGAR.d / 2 - HUB_HANGAR.wall + 4;
const ROOF = HUB_HANGAR.h / 2;
/** Above the middle of the hangar roof, `h` metres up. */
const aboveRoof = (h: number) => new Vector3(0, ROOF + h, HANGAR_Z);

describe('collisions: a ship against a wall', () => {
  it('hits the hangar wall instead of passing through it, and bounces back off the metal', () => {
    const w = aurora();
    const s = coasting(w, 'falcon', aboveRoof(60), new Vector3(0, -30, 0), FACE_DOWN);
    const events = run(w, 3);
    // The roof (14 m of plating): never crossed.
    expect(s.position.y).toBeGreaterThan(ROOF);
    expect(s.velocity.y).toBeGreaterThan(0); // bounced back
    expect(s.velocity.y).toBeLessThan(30 * MATERIALS.metal.restitution + 1);
    expect(deepest(w, s)).toBeGreaterThan(-0.05);
    const hit = collisions(events, s.id)[0];
    expect(hit.mat).toBe('metal');
    expect(hit.part).toBe('cockpit');
    expect(hit.speed).toBeCloseTo(30, 0);
    expect(s.alive).toBe(true);
  });

  it('cannot tunnel through a 3 m thick solar panel at full boost speed (continuous detection)', () => {
    const w = aurora();
    // The upper solar arrays: tilted panels 3 m thick at y = 380 to 490; 470 m/s is 7.8 m per tick.
    const s = coasting(w, 'falcon', new Vector3(200, 520, 0), new Vector3(0, -470, 0), FACE_DOWN);
    const events = run(w, 0.5);
    expect(s.alive).toBe(false); // 470 m/s into a station panel is fatal...
    expect(collisions(events, s.id).length).toBeGreaterThan(0);
    // ...and it died above the top panel: it never went through.
    const destroyed = events.find((e) => e.type === 'destroyed' && e.ship === s.id) as Extract<SimEvent, { type: 'destroyed' }>;
    expect(destroyed.pos[1]).toBeGreaterThan(490 - 30);
  });

  it('stays out of the wall when pushing against it with the throttle', () => {
    const w = aurora();
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'p', position: aboveRoof(25), rotation: FACE_DOWN, ownerId: 'p' });
    s.input.throttle = 1;
    run(w, 6);
    expect(s.position.y).toBeGreaterThan(ROOF);
    expect(deepest(w, s)).toBeGreaterThan(-0.05);
    expect(s.alive).toBe(true);
  });
});

describe('collisions: a ship against an asteroid', () => {
  const rock = (material: StaticCollider['material']): StaticCollider => ({ kind: 'asteroid', center: new Vector3(0, 0, -300), radius: 50, material });

  it('bounces off according to the material: iron-nickel rebounds more than ice', () => {
    const rebound = (material: StaticCollider['material']) => {
      const w = worldWith([rock(material)]);
      const s = coasting(w, 'falcon', new Vector3(0, 0, -200), new Vector3(0, 0, -20));
      run(w, 4);
      expect(deepest(w, s)).toBeGreaterThan(-0.05);
      return s.velocity.z;
    };
    const metal = rebound('metalRock');
    const stone = rebound('rock');
    const ice = rebound('ice');
    expect(metal).toBeGreaterThan(stone);
    expect(stone).toBeGreaterThan(ice);
    expect(ice).toBeGreaterThan(0);
  });

  it('a glancing blow on a wing spins the ship and wears that wing', () => {
    const w = worldWith([rock('rock')]);
    // Passing 57 m from the rock's centre: only the left wing tip (x −8.2) clips it.
    const s = coasting(w, 'falcon', new Vector3(56.5, 0, -150), new Vector3(0, 0, -60));
    s.shield = 0;
    s.sinceDamage = -100;
    const events = run(w, 3);
    const hit = collisions(events, s.id)[0];
    expect(hit.part).toBe('wingL');
    expect(s.parts.wingL).toBeLessThan(1);
    expect(s.parts.wingR).toBe(1);
    expect(s.parts.engines).toBe(1);
    // An off-centre blow: the ship yaws.
    expect(Math.abs(s.spin.y) + Math.abs(s.angularVelocity.y)).toBeGreaterThan(0.05);
    expect(deepest(w, s)).toBeGreaterThan(-0.05);
  });
});

describe('collisions: ship against ship', () => {
  it('two ships head-on exchange momentum and both take damage', () => {
    const w = worldWith([]);
    const a = coasting(w, 'falcon', new Vector3(0, 0, 100), new Vector3(0, 0, -40), new Quaternion(), 'a');
    const b = coasting(w, 'falcon', new Vector3(0, 0, -100), new Vector3(0, 0, 40), new Quaternion().setFromAxisAngle(Y, Math.PI), 'b');
    const ma = massOf('falcon').mass;
    const before = a.velocity.clone().multiplyScalar(ma).add(b.velocity.clone().multiplyScalar(ma));
    const events = run(w, 4);
    const after = a.velocity.clone().multiplyScalar(ma).add(b.velocity.clone().multiplyScalar(ma));
    expect(after.distanceTo(before)).toBeLessThan(1e-6); // momentum conserved
    expect(a.velocity.z).toBeGreaterThan(0); // they rebound
    expect(b.velocity.z).toBeLessThan(0);
    expect(a.position.z).toBeGreaterThan(b.position.z); // never passed through each other
    const hits = collisions(events);
    expect(hits.find((e) => e.ship === a.id)?.other).toBe(b.id);
    expect(hits.find((e) => e.ship === b.id)?.other).toBe(a.id);
    expect(a.shield).toBeLessThan(statsOf(a).shield);
    expect(b.shield).toBeLessThan(statsOf(b).shield);
  });

  it('a light raider rammed by a heavy marauder takes the bigger blow', () => {
    const w = worldWith([]);
    const heavy = coasting(w, 'marauder', new Vector3(0, 0, 100), new Vector3(0, 0, -60), new Quaternion(), 'm');
    const light = coasting(w, 'raider', new Vector3(0, 0, -100), new Vector3(0, 0, 0), new Quaternion(), 'r');
    const events = run(w, 4);
    const dmg = (id: number) => collisions(events, id).reduce((n, e) => n + e.damage, 0);
    expect(dmg(light.id)).toBeGreaterThan(dmg(heavy.id) * 2);
    expect(light.velocity.z).toBeLessThan(-40); // knocked away
    expect(heavy.velocity.z).toBeLessThan(0); // barely slowed
  });

  it('two ships boosting head-on at 470 m/s each cannot pass through each other', () => {
    const w = worldWith([]);
    // 940 m/s closing is 15.7 m per tick, nearly a whole ship length.
    const a = coasting(w, 'falcon', new Vector3(0, 0, 60), new Vector3(0, 0, -470), new Quaternion(), 'a');
    const b = coasting(w, 'falcon', new Vector3(0, 0.5, -60), new Vector3(0, 0, 470), new Quaternion().setFromAxisAngle(Y, Math.PI), 'b');
    const events = run(w, 0.4);
    expect(collisions(events).length).toBeGreaterThan(0);
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(false);
  });
});

describe('collisions: low and violent impacts', () => {
  it('5 m/s leaves no mark, 60 m/s costs the shield, 200 m/s destroys the ship', () => {
    const impact = (speed: number) => {
      const w = aurora();
      const s = coasting(w, 'falcon', aboveRoof(50), new Vector3(0, -speed, 0), FACE_DOWN);
      const events = run(w, 50 / speed + 1);
      return { s, events: collisions(events, s.id) };
    };
    const soft = impact(5);
    expect(soft.events.every((e) => e.damage === 0)).toBe(true);
    expect(soft.s.shield).toBe(statsOf(soft.s).shield);
    expect(soft.s.hull).toBe(statsOf(soft.s).hull);
    const medium = impact(60);
    expect(medium.s.alive).toBe(true);
    expect(medium.s.shield).toBeLessThan(statsOf(medium.s).shield);
    expect(medium.events[0].shield).toBe(true);
    const violent = impact(200);
    expect(violent.s.alive).toBe(false);
  });

  it('damage grows with the square of the velocity change', () => {
    expect(impactDamage(IMPACT_THRESHOLD, 1)).toBe(0);
    expect(impactDamage(100, 1) / impactDamage(50, 1)).toBeGreaterThan(3.9);
    expect(impactDamage(50, MATERIALS.ice.hardness)).toBeLessThan(impactDamage(50, MATERIALS.metal.hardness));
  });

  it('an active shield takes the blow and spreads part of its energy', () => {
    const hit = (shield: boolean) => {
      const w = aurora();
      const s = coasting(w, 'falcon', aboveRoof(50), new Vector3(0, -60, 0), FACE_DOWN);
      if (!shield) {
        s.shield = 0;
        s.sinceDamage = -100; // no regeneration before the impact
      }
      return collisions(run(w, 2), s.id)[0];
    };
    const shielded = hit(true);
    const bare = hit(false);
    expect(shielded.shield).toBe(true);
    expect(bare.shield).toBe(false);
    expect(shielded.damage).toBeCloseTo(bare.damage * 0.75, 1);
  });
});

describe('collisions: localised damage', () => {
  it('a frontal crash damages the cockpit; a reversing crash damages the engines and the drive weakens', () => {
    const w = aurora();
    const nose = coasting(w, 'falcon', aboveRoof(50), new Vector3(0, -90, 0), FACE_DOWN, 'nose');
    nose.shield = 0;
    nose.sinceDamage = -100;
    run(w, 2);
    expect(nose.parts.cockpit).toBeLessThan(0.7);
    expect(nose.parts.engines).toBe(1);

    const w2 = aurora();
    // Facing up, drifting backward onto the roof: engines first.
    const back = coasting(w2, 'falcon', aboveRoof(50), new Vector3(0, -90, 0), new Quaternion().setFromAxisAngle(X, Math.PI / 2), 'back');
    back.shield = 0;
    back.sinceDamage = -100;
    run(w2, 2);
    expect(back.parts.engines).toBeLessThan(0.7);
    expect(back.parts.cockpit).toBe(1);
    expect(flightFactors(back).thrust).toBeLessThan(1);
  });

  it('a ship with destroyed engines limps on its manoeuvring thrusters, and a broken wing pulls it into a roll', () => {
    const w = worldWith([]);
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'p', position: new Vector3(), ownerId: 'p' });
    s.parts.engines = 0;
    s.input.throttle = 1;
    s.input.boost = true;
    run(w, 8);
    expect(s.boosting).toBe(false);
    expect(s.velocity.length()).toBeCloseTo(statsOf(s).maxSpeed * 0.3, 0);

    const w2 = worldWith([]);
    const t = w2.spawnShip({ classId: 'falcon', faction: 'union', name: 'q', position: new Vector3(), ownerId: 'q' });
    t.parts.wingL = 0;
    t.input.flightAssist = false;
    run(w2, 2);
    expect(t.angularVelocity.z).toBeGreaterThan(0.2); // rolling left wing down, nobody touching the stick
  });

  it('weapon hits wear the component they strike, more slowly than a crash', () => {
    const w = worldWith([]);
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'p', position: new Vector3(), ownerId: 'p' });
    s.shield = 0;
    // A hit 8 m to the left of the ship's centre: the left wing.
    w.applyDamage(s, 40, null, 'wingL');
    expect(s.parts.wingL).toBeLessThan(1);
    expect(s.parts.wingL).toBeGreaterThan(1 - 40 / (statsOf(s).hull * 0.5));
    expect(s.hull).toBe(statsOf(s).hull - 40);
  });
});

describe('collisions: spin, assist and moving structures', () => {
  it('flight assist damps a collision spin much faster than pure Newtonian flight', () => {
    const spinAfter = (assist: boolean) => {
      const w = worldWith([]);
      const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'p', position: new Vector3(), ownerId: 'p' });
      s.input.flightAssist = assist;
      s.spin.set(0, 2, 0);
      run(w, 1);
      return s.spin.length();
    };
    expect(spinAfter(true)).toBeLessThan(0.3);
    expect(spinAfter(false)).toBeGreaterThan(1);
  });

  it('a turning structure sweeps a parked ship along with it (moving colliders)', () => {
    // A 500 m arm turning at 0.02 rad/s about the world Y axis: (cos θ, 0, −sin θ) at θ = 0.02 t.
    const spin = 0.02;
    const arm: StaticCollider = { kind: 'station', center: new Vector3(), radius: 520, material: 'metal', shape: { t: 'capsule', a: [0, 0, 0], b: [500, 0, 0], r: 11 }, spin };
    const w = worldWith([arm]);
    const ahead = 0.07;
    const s = coasting(w, 'falcon', new Vector3(400 * Math.cos(ahead), 0, -400 * Math.sin(ahead)), new Vector3());
    const events = run(w, 6);
    expect(collisions(events, s.id).length).toBeGreaterThan(0);
    // Pushed along the arm's motion (−z here), at about the arm's speed at that radius.
    expect(s.velocity.z).toBeLessThan(-0.5 * spin * 400);
    expect(deepest(w, s)).toBeGreaterThan(-0.3);
  });

  it('laser bolts fly into the open hangar mouth and stop on its back wall', () => {
    const w = aurora();
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'p', position: new Vector3(0, 0, 520), ownerId: 'p' });
    s.input.fire = true;
    const events = run(w, 0.5);
    const impacts = events.filter((e): e is Extract<SimEvent, { type: 'impact' }> => e.type === 'impact');
    expect(impacts.length).toBeGreaterThan(0);
    // The back wall's inner face is at z = hangar centre − depth / 2 + wall.
    const back = HANGAR_Z - HUB_HANGAR.d / 2 + HUB_HANGAR.wall;
    for (const i of impacts) expect(i.pos[2]).toBeCloseTo(back, -1);
  });
});

describe('collisions: multiplayer and performance', () => {
  it("client prediction of a wall hit matches the server's result (no correction)", () => {
    const zone = buildSector('aurora', 1337);
    const w = new World(zone);
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'p', position: aboveRoof(40), rotation: FACE_DOWN, ownerId: 'p' });
    w.step();
    const predictor = new Predictor(w.grid);
    predictor.reconcile(snapshotShip(s), 0);
    const input = { ...neutralInput(), throttle: 1 };
    for (let seq = 1; seq <= 120; seq++) {
      w.grid.time = w.time;
      predictor.step(seq, input);
      w.setInput(s.id, input);
      w.step();
    }
    expect(s.position.y).toBeLessThan(ROOF + 15); // it reached the roof
    // Only the snapshot's rounding (1 cm, 1e-4 on the rotation) separates them.
    expect(predictor.ship!.position.distanceTo(s.position)).toBeLessThan(0.25);
  });

  it('ships far from every player collide as one sphere (physics level of detail)', () => {
    const w = aurora();
    w.spawnShip({ classId: 'falcon', faction: 'union', name: 'p', position: new Vector3(0, 0, 1200), ownerId: 'p' });
    w.spawnShip({ classId: 'raider', faction: 'raiders', name: 'near', position: new Vector3(0, 0, 1500) });
    w.spawnShip({ classId: 'raider', faction: 'raiders', name: 'far', position: new Vector3(0, 0, 9000) });
    w.step();
    expect(w.coarseShips).toBe(1);
  });

  it('60 ships flying through a belt cost well under a millisecond per tick', () => {
    const w = aurora();
    const rocks = w.zone.asteroids.filter((a) => a.radius > 40).slice(0, 60);
    const ships = rocks.map((r, i) => {
      const s = w.spawnShip({ classId: i % 2 ? 'raider' : 'falcon', faction: 'union', name: `s${i}`, position: r.position.clone().add(new Vector3(0, 0, r.radius + 120)), ownerId: `p${i}` });
      s.input.throttle = 1;
      return s;
    });
    run(w, 1);
    const t0 = performance.now();
    const ticks = 300;
    for (let i = 0; i < ticks; i++) w.step();
    const perTick = (performance.now() - t0) / ticks;
    expect(ships.some((s) => s.alive)).toBe(true);
    expect(perTick).toBeLessThan(3);
  });
});
