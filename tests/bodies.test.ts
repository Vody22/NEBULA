import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { Predictor } from '../src/client/net/Predictor';
import { GameServer } from '../src/server/GameServer';
import type { ServerMessage } from '../src/shared/net/protocol';
import { snapshotShip } from '../src/shared/net/protocol';
import { BODY_DEFS, bodyHp, bodyProps, type BodyKind } from '../src/shared/physics/bodies';
import { massOf } from '../src/shared/physics/hitboxes';
import { distanceTo } from '../src/shared/physics/shapes';
import { BODY_ACTIVE_RANGE, WRECK_LIFE } from '../src/shared/sim/looseBodies';
import type { Body, SimEvent } from '../src/shared/sim/types';
import { neutralInput } from '../src/shared/sim/types';
import { TICK_DT, World } from '../src/shared/sim/world';
import { buildSector } from '../src/shared/sim/zone';

const aurora = (bodies = true) => new World(buildSector('aurora', 1337), { bodies });

function run(w: World, seconds: number) {
  const events: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    w.step();
    events.push(...w.drainEvents());
  }
  return events;
}

/** Open space well clear of everything in Aurora (the station is at the origin, the belt far off). */
const OPEN = new Vector3(0, 2500, 0);

/** A player's ship coasting (no thrust, no assist): players keep the bodies around them awake. */
function coasting(w: World, position: Vector3, velocity: Vector3, rotation = new Quaternion(), classId: 'falcon' | 'marauder' = 'falcon') {
  const s = w.spawnShip({ classId, faction: 'union', name: 'p', position, velocity, rotation, ownerId: 'p1' });
  s.input.flightAssist = false;
  s.input.throttle = 0;
  return s;
}

function body(w: World, kind: BodyKind, position: Vector3, scale = 1) {
  return w.bodies.spawn(kind, scale, position, new Quaternion());
}

const momentum = (w: World) => {
  const p = new Vector3();
  for (const s of w.ships.values()) p.addScaledVector(s.velocity, massOf(s.classId).mass);
  for (const b of w.bodies.list.values()) p.addScaledVector(b.velocity, bodyProps(b.kind, b.scale).mass);
  return p;
};

/** Faces +X (forward is −Z). */
const FACE_X = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2);

describe('loose bodies: what a sector starts with', () => {
  it('moors cargo at both stations and boulders by the depot lane, every one clear of the structures and rocks', () => {
    for (const id of ['aurora', 'kepler'] as const) {
      const w = new World(buildSector(id, 1337));
      const list = [...w.bodies.list.values()];
      const kinds = new Set(list.map((b) => b.kind));
      expect(kinds).toEqual(new Set(['crate', 'container', 'boulder']));
      expect(list.length).toBeGreaterThan(15);
      for (const b of list) {
        expect(b.asleep).toBe(true);
        expect(b.home).not.toBeNull();
        const props = bodyProps(b.kind, b.scale);
        for (const h of props.spheres) {
          const at = h.at.clone().applyQuaternion(b.rotation).add(b.position);
          for (const c of w.grid.query(at, h.r + 50)) expect(distanceTo(c, at, 0) - h.r).toBeGreaterThan(0.01);
        }
      }
      // Two crates rest on the floor of each hangar (5 cm above it).
      const hub = w.zone.station;
      const inHub = list.filter((b) => b.kind === 'crate' && b.position.distanceTo(hub.position) < 300);
      expect(inHub.length).toBe(2);
    }
  });
});

describe('loose bodies: inertia and impulses', () => {
  it('keeps drifting and tumbling at the same rate in empty space (nothing slows it)', () => {
    const w = aurora(false);
    coasting(w, OPEN.clone().add(new Vector3(0, 0, 200)), new Vector3());
    const b = body(w, 'crate', OPEN);
    w.bodies.wake(b);
    b.velocity.set(3, 0, 0);
    b.spin.set(0, 0.8, 0);
    run(w, 5);
    expect(b.velocity.x).toBeCloseTo(3, 6);
    expect(b.position.x).toBeCloseTo(15, 1);
    expect(b.spin.length()).toBeCloseTo(0.8, 4);
    expect(b.asleep).toBe(false);
  });

  it('a long body tumbling off its axes keeps its angular momentum (it wobbles, as a real one does)', () => {
    const w = aurora(false);
    coasting(w, OPEN.clone().add(new Vector3(0, 0, 200)), new Vector3());
    const b = body(w, 'container', OPEN);
    w.bodies.wake(b);
    b.spin.set(0.6, 0.9, 0.3);
    const I = bodyProps('container', 1).inertia;
    const L = () => new Vector3(b.spin.x * I.x, b.spin.y * I.y, b.spin.z * I.z).applyQuaternion(b.rotation);
    const L0 = L();
    const w0 = b.spin.clone();
    run(w, 8);
    expect(L().distanceTo(L0)).toBeLessThan(L0.length() * 1e-3);
    // …while its spin in its own frame has changed: the wobble.
    expect(b.spin.distanceTo(w0)).toBeGreaterThan(0.05);
  });

  it('a fighter at 30 m/s shoves a crate away and barely slows: momentum is conserved, nobody is hurt', () => {
    const w = aurora(false);
    const s = coasting(w, OPEN.clone().add(new Vector3(-60, 0, 0)), new Vector3(30, 0, 0), FACE_X);
    const b = body(w, 'crate', OPEN);
    const p0 = momentum(w);
    const hull = s.hull;
    const events = run(w, 3);
    expect(b.asleep).toBe(false);
    expect(b.velocity.x).toBeGreaterThan(30);
    expect(s.velocity.x).toBeGreaterThan(25);
    expect(s.velocity.x).toBeLessThan(30);
    expect(momentum(w).distanceTo(p0)).toBeLessThan(p0.length() * 0.01);
    expect(s.hull).toBe(hull);
    expect(w.bodies.list.has(b.id)).toBe(true);
    const hit = events.find((e): e is Extract<SimEvent, { type: 'collision' }> => e.type === 'collision' && e.ship === s.id);
    expect(hit?.body).toBe(b.id);
    expect(hit?.mat).toBe('metal');
  });

  it('a container weighs a third of a fighter: the fighter loses real speed and the container moves off slower', () => {
    const w = aurora(false);
    const s = coasting(w, OPEN.clone().add(new Vector3(-60, 0, 0)), new Vector3(20, 0, 0), FACE_X);
    const b = body(w, 'container', OPEN);
    const p0 = momentum(w);
    run(w, 4);
    expect(s.velocity.x).toBeLessThan(15);
    expect(b.velocity.x).toBeGreaterThan(15);
    expect(b.velocity.x).toBeLessThan(30);
    expect(momentum(w).distanceTo(p0)).toBeLessThan(p0.length() * 0.01);
  });

  it('a boulder three times its mass stops a fighter dead and hurts it; one eight times its mass throws it back', () => {
    const w = aurora(false);
    const s = coasting(w, OPEN.clone().add(new Vector3(-60, 0, 0)), new Vector3(60, 0, 0), FACE_X);
    s.shield = 0;
    s.sinceDamage = -100;
    const rock = body(w, 'boulder', OPEN, 2);
    expect(bodyProps('boulder', 2).mass).toBeGreaterThan(massOf('falcon').mass * 2.5);
    const hull = s.hull;
    run(w, 3);
    // Rock gives back little (restitution 0.25): the fighter keeps a few m/s, the boulder takes the rest.
    expect(s.velocity.x).toBeLessThan(10);
    expect(s.hull).toBeLessThan(hull);
    expect(rock.velocity.x).toBeGreaterThan(15);

    const w1 = aurora(false);
    const s1 = coasting(w1, OPEN.clone().add(new Vector3(-60, 0, 0)), new Vector3(60, 0, 0), FACE_X);
    body(w1, 'boulder', OPEN, 2.8);
    run(w1, 3);
    expect(s1.velocity.x).toBeLessThan(-2);

    const w2 = aurora(false);
    coasting(w2, OPEN.clone().add(new Vector3(-200, 0, 0)), new Vector3(150, 0, 0), FACE_X);
    const crate = body(w2, 'crate', OPEN);
    const events = run(w2, 3);
    expect(w2.bodies.list.has(crate.id)).toBe(false);
    expect(events.some((e) => e.type === 'bodyBroken' && e.body === crate.id && e.kind === 'crate')).toBe(true);
  });

  it('a shoved crate knocks the next one on (body against body), and bounces off the station wall without going through', () => {
    const w = aurora(false);
    coasting(w, OPEN.clone().add(new Vector3(0, 0, 300)), new Vector3());
    const a = body(w, 'crate', OPEN);
    const b = body(w, 'crate', OPEN.clone().add(new Vector3(8, 0, 0)));
    w.bodies.wake(a);
    a.velocity.set(10, 0, 0);
    run(w, 2);
    expect(b.asleep).toBe(false);
    expect(b.velocity.x).toBeGreaterThan(5);
    expect(a.velocity.x).toBeLessThan(5);

    // The hub hangar's roof (outer face at y = 55, centred on z ≈ 253.6): a crate dropped onto it at 40 m/s.
    const w2 = aurora(false);
    coasting(w2, new Vector3(0, 400, 254), new Vector3());
    const c = body(w2, 'crate', new Vector3(0, 120, 254));
    w2.bodies.wake(c);
    c.velocity.set(0, -40, 0);
    const events = run(w2, 3);
    expect(c.position.y).toBeGreaterThan(55);
    expect(c.velocity.y).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'bodyHit' && e.body === c.id && e.mat === 'metal')).toBe(true);
  });

  it('bolts shove a crate and break it', () => {
    const w = aurora(false);
    const s = coasting(w, OPEN.clone().add(new Vector3(-150, 0, 0)), new Vector3(), FACE_X);
    // In line with the right-hand gun (hardpoint 4.6 m out, 0.6 m down).
    const b = body(w, 'crate', OPEN.clone().add(new Vector3(0, -0.6, 4.6)));
    s.input.fire = true;
    const events: SimEvent[] = [];
    for (let i = 0; i < 600 && w.bodies.list.has(b.id); i++) {
      w.step();
      events.push(...w.drainEvents());
      if (i === 40) {
        expect(b.asleep).toBe(false);
        expect(b.velocity.x).toBeGreaterThan(0);
        expect(b.hp).toBeLessThan(bodyHp('crate', 1));
      }
    }
    expect(w.bodies.list.has(b.id)).toBe(false);
    expect(events.some((e) => e.type === 'impact')).toBe(true);
    expect(events.some((e) => e.type === 'bodyBroken')).toBe(true);
  });
});

describe('loose bodies: sleep, active zones and housekeeping', () => {
  it('a body come to rest falls asleep after a second and costs nothing until struck', () => {
    const w = aurora(false);
    coasting(w, OPEN.clone().add(new Vector3(0, 0, 200)), new Vector3());
    const b = body(w, 'crate', OPEN);
    w.bodies.wake(b);
    b.velocity.set(0.01, 0, 0);
    run(w, 0.5);
    expect(b.asleep).toBe(false);
    run(w, 1);
    expect(b.asleep).toBe(true);
    expect(b.velocity.length()).toBe(0);
  });

  it('far from every player a body is frozen in place, and moves on when a player comes near', () => {
    const w = aurora(false);
    const b = body(w, 'crate', OPEN);
    w.bodies.wake(b);
    b.velocity.set(5, 0, 0);
    run(w, 1);
    expect(b.active).toBe(false);
    const x = b.position.x;
    run(w, 2);
    expect(b.position.x).toBe(x);
    coasting(w, OPEN.clone().add(new Vector3(0, 0, BODY_ACTIVE_RANGE * 0.5)), new Vector3());
    run(w, 1);
    expect(b.active).toBe(true);
    expect(b.position.x).toBeGreaterThan(x + 2);
  });

  it('a destroyed ship leaves wreckage that drifts, can be pushed, and is cleared away after a while', () => {
    const w = aurora(false);
    const p = coasting(w, OPEN.clone().add(new Vector3(0, 0, 300)), new Vector3());
    const victim = w.spawnShip({ classId: 'raider', faction: 'raiders', name: 'R', position: OPEN.clone(), velocity: new Vector3(10, 0, 0) });
    w.applyDamage(victim, 1e6, p.id);
    w.step();
    const wrecks = [...w.bodies.list.values()].filter((b) => b.kind === 'wreck');
    expect(wrecks.length).toBe(2);
    for (const b of wrecks) {
      expect(b.asleep).toBe(false);
      expect(b.position.distanceTo(OPEN)).toBeLessThan(20);
    }
    const events = run(w, WRECK_LIFE * 1.3);
    expect([...w.bodies.list.values()].some((b) => b.kind === 'wreck')).toBe(false);
    expect(events.filter((e) => e.type === 'bodyGone').length).toBe(2);
  });

  it('moored cargo shoved far away goes back to its mooring once nobody is near, and broken cargo is replaced', () => {
    const w = aurora();
    const crate = [...w.bodies.list.values()].find((b) => b.kind === 'crate' && b.home && b.position.length() > 300)!;
    const home = crate.home!.position.clone();
    crate.position.add(new Vector3(0, 900, 0));
    w.bodies.wake(crate);
    run(w, 2);
    expect(crate.position.distanceTo(home)).toBeLessThan(0.01);
    expect(crate.asleep).toBe(true);

    w.bodies.damage(crate, 1e6);
    expect(w.bodies.list.has(crate.id)).toBe(false);
    run(w, 125);
    const back = [...w.bodies.list.values()].find((b) => b.home && b.home.position.distanceTo(home) < 0.01);
    expect(back).toBeDefined();
    expect(back!.id).not.toBe(crate.id);
  });
});

describe('loose bodies: the network', () => {
  function pilot() {
    const server = new GameServer({ npcs: false });
    const inbox: ServerMessage[] = [];
    const session = server.connect({ send: (m: ServerMessage) => inbox.push(JSON.parse(JSON.stringify(m))), close: () => {} }, 'Vega');
    const me = () => [...server.world.ships.values()].find((x) => x.ownerId === session);
    const snaps = () => inbox.filter((m): m is Extract<ServerMessage, { t: 'snapshot' }> => m.t === 'snapshot');
    return { server, session, me, inbox, snaps };
  }

  it('a new pilot gets every body at once, then only the ones that move or change', () => {
    const { server, me, snaps } = pilot();
    server.tick();
    const first = snaps()[0].snap;
    expect(first.bf).toBe(true);
    expect(first.b!.length).toBe(server.world.bodies.list.size);
    for (let i = 0; i < 10; i++) server.tick();
    const quiet = snaps().slice(1, 10);
    for (const s of quiet) expect(s.snap.b).toBeUndefined();
    // Shove one: it is listed while it moves.
    const crate = [...server.world.bodies.list.values()].find((b) => b.kind === 'crate')!;
    me()!.position.copy(crate.position).add(new Vector3(0, 0, 200));
    server.world.bodies.wake(crate);
    crate.velocity.set(2, 0, 0);
    server.tick();
    const moving = snaps()[snaps().length - 1].snap;
    expect(moving.bf).toBeUndefined();
    expect(moving.b!.map((x) => x[0])).toEqual([crate.id]);
    expect(moving.b![0][3]).toBeCloseTo(crate.position.x, 1);
  });

  it('bumping a resting crate is predicted with the server impulse', () => {
    const w = aurora(false);
    const s = coasting(w, OPEN.clone().add(new Vector3(-40, 0, 0)), new Vector3(25, 0, 0), FACE_X);
    const b = body(w, 'crate', OPEN);
    const p = new Predictor(w.grid);
    p.reconcile(snapshotShip(s), 0);
    p.setRestingBodies([{ id: b.id, kind: b.kind, scale: b.scale, position: b.position.clone(), rotation: b.rotation.clone() }]);
    const input = { ...neutralInput(), flightAssist: false };
    for (let i = 1; i <= 150; i++) {
      p.step(i, input);
      w.setInput(s.id, input);
      w.step();
      w.drainEvents();
    }
    expect(b.asleep).toBe(false);
    expect(p.ship!.position.distanceTo(s.position)).toBeLessThan(0.25);
    expect(p.ship!.velocity.distanceTo(s.velocity)).toBeLessThan(0.05);
  });

  it('stays cheap: 60 ships and 40 tumbling bodies in a few milliseconds a tick', () => {
    const w = aurora();
    for (let i = 0; i < 60; i++) {
      const s = w.spawnShip({ classId: i % 2 ? 'raider' : 'falcon', faction: i % 2 ? 'raiders' : 'union', name: `s${i}`, position: new Vector3((i % 10) * 60 - 300, 1500 + Math.floor(i / 10) * 60, 0), ownerId: i < 4 ? `p${i}` : null });
      s.input.throttle = 0.5;
    }
    const kinds: BodyKind[] = ['crate', 'container', 'wreck', 'boulder'];
    const list: Body[] = [];
    for (let i = 0; i < 40; i++) {
      const b = w.bodies.spawn(kinds[i % 4], 1, new Vector3((i % 8) * 20 - 80, 1700 + Math.floor(i / 8) * 20, 200), new Quaternion());
      w.bodies.wake(b);
      b.velocity.set(Math.sin(i) * 5, Math.cos(i) * 5, -3);
      b.spin.set(0.3, 0.5, 0.2);
      list.push(b);
    }
    run(w, 1);
    const t0 = performance.now();
    run(w, 2);
    const perTick = (performance.now() - t0) / 120;
    expect(perTick).toBeLessThan(4);
    expect(list.every((b) => Number.isFinite(b.position.x))).toBe(true);
    expect(Object.keys(BODY_DEFS).length).toBe(4);
  });
});
