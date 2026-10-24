import { Quaternion, Vector3 } from 'three';
import { HITBOXES } from '../src/shared/physics/hitboxes';
import { distanceTo } from '../src/shared/physics/shapes';
import { describe, expect, it } from 'vitest';
import { GameServer, REPAIR_COST, STARTING_CREDITS } from '../src/server/GameServer';
import { createMarket, quote } from '../src/shared/economy/market';
import { validateClientMessage, type ServerMessage } from '../src/shared/net/protocol';
import { MINING_RANGE, miningTarget, oreOf, richness } from '../src/shared/sim/mining';
import { SHIP_CLASSES } from '../src/shared/sim/shipClasses';
import type { Ship } from '../src/shared/sim/types';
import { noMods } from '../src/shared/sim/upgrades';
import { UNDOCK_DISTANCE, UNDOCK_SPEED } from '../src/shared/sim/zone';

function solo() {
  const server = new GameServer({ npcs: false });
  const inbox: ServerMessage[] = [];
  const link = { send: (m: ServerMessage) => inbox.push(JSON.parse(JSON.stringify(m))) };
  const session = server.connect(link, 'Pilote');
  const me = () => [...server.world.ships.values()].find((s) => s.ownerId === session) as Ship | undefined;
  const last = <T extends ServerMessage['t']>(t: T) => [...inbox].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  const notices = () => inbox.filter((m) => m.t === 'notice').map((m) => (m as Extract<ServerMessage, { t: 'notice' }>).text);
  return { server, inbox, link, session, me, last, notices };
}

/** Parks the player's ship at the Aurora-7 hangar mouth, stopped. */
function park(server: GameServer, ship: Ship) {
  ship.position.copy(server.world.zone.station.dock.mouth).add(new Vector3(0, 0, 60));
  ship.velocity.set(0, 0, 0);
}

describe('docking', () => {
  it('starts a pilot with credits and an empty hold', () => {
    const { server, last } = solo();
    server.tick();
    expect(last('pilot')!.pilot).toEqual({ credits: STARTING_CREDITS, cargo: {}, capacity: SHIP_CLASSES.falcon.cargo, docked: null, hull: null, parts: null, hullMax: SHIP_CLASSES.falcon.hull, ship: 'falcon', fleet: [{ classId: 'falcon', mods: noMods(), hull: SHIP_CLASSES.falcon.hull }], reserved: 0, missions: [] });
  });

  it('refuses far from a hangar or too fast, and docks a slow ship at the mouth', () => {
    const { server, session, me, last, notices } = solo();
    server.receive(session, { t: 'dock' });
    expect(notices().at(-1)).toMatch(/approchez-vous/);
    const ship = me()!;
    park(server, ship);
    ship.velocity.set(0, 0, 80);
    server.receive(session, { t: 'dock' });
    expect(notices().at(-1)).toMatch(/ralentissez/);
    ship.velocity.set(0, 0, 10);
    ship.hull = 100;
    server.receive(session, { t: 'dock' });
    server.tick();
    expect(me()).toBeUndefined();
    expect(server.world.ships.has(ship.id)).toBe(false);
    expect(last('pilot')!.pilot).toMatchObject({ docked: 'aurora', hull: 100 });
    expect(last('market')!.market.station).toBe('aurora');
    expect(last('snapshot')!.you).toBeNull();
    expect(last('snapshot')!.respawnIn).toBe(0);
    // Docked pilots stay docked: no respawn in space.
    for (let i = 0; i < 60 * 8; i++) server.tick();
    expect(me()).toBeUndefined();
  });

  it('undocks out of the hangar, moving outward, with the hull it docked with', () => {
    const { server, session, me } = solo();
    const ship = me()!;
    park(server, ship);
    ship.hull = 123;
    server.receive(session, { t: 'dock' });
    server.tick();
    server.receive(session, { t: 'undock' });
    const out = me()!;
    const dock = server.world.zone.station.dock;
    expect(out.position.distanceTo(dock.mouth.clone().addScaledVector(dock.out, UNDOCK_DISTANCE))).toBeLessThan(1);
    expect(out.velocity.dot(dock.out)).toBeCloseTo(UNDOCK_SPEED, 3);
    const nose = new Vector3(0, 0, -1).applyQuaternion(out.rotation);
    expect(nose.dot(dock.out)).toBeGreaterThan(0.999);
    expect(out.hull).toBe(123);
    expect(out.shield).toBe(SHIP_CLASSES.falcon.shield);
  });

  it('repairs the hull for credits, partly when money is short', () => {
    const { server, session, me, last } = solo();
    const ship = me()!;
    park(server, ship);
    ship.hull = 60;
    server.receive(session, { t: 'dock' });
    server.receive(session, { t: 'repair' });
    server.tick();
    const missing = SHIP_CLASSES.falcon.hull - 60;
    expect(last('pilot')!.pilot.hull).toBe(SHIP_CLASSES.falcon.hull);
    expect(last('pilot')!.pilot.credits).toBe(STARTING_CREDITS - missing * REPAIR_COST);
  });

  it('buys and sells at the docked station, with refusals explained', () => {
    const { server, session, me, last, notices } = solo();
    park(server, me()!);
    // Trading in space does nothing.
    server.receive(session, { t: 'trade', item: 'water', qty: 5 });
    server.tick();
    expect(last('pilot')!.pilot).toMatchObject({ credits: STARTING_CREDITS, cargo: {} });
    server.receive(session, { t: 'dock' });
    const price = quote('water', createMarket('aurora').water).buy;
    server.receive(session, { t: 'trade', item: 'water', qty: 5 });
    server.tick();
    let p = last('pilot')!.pilot;
    expect(p.cargo.water).toBe(5);
    expect(p.credits).toBeLessThanOrEqual(STARTING_CREDITS - 5 * price);
    server.receive(session, { t: 'trade', item: 'medicine', qty: 1000 });
    server.receive(session, { t: 'trade', item: 'parts', qty: -3 });
    expect(notices().at(-1)).toMatch(/pas en soute/);
    server.receive(session, { t: 'trade', item: 'water', qty: -5 });
    server.tick();
    p = last('pilot')!.pilot;
    expect(p.cargo.water).toBeUndefined();
    expect(p.cargo.medicine).toBeGreaterThan(0);
  });

  it('keeps a docked pilot docked across a reconnection', () => {
    const { server, session, me, link, last } = solo();
    park(server, me()!);
    server.receive(session, { t: 'dock' });
    const token = (server as unknown as { sessions: Map<string, { token: string }> }).sessions.get(session)!.token;
    server.detach(session);
    server.tick();
    server.connect(link, 'Pilote', token);
    server.tick();
    expect(me()).toBeUndefined();
    expect(last('pilot')!.pilot.docked).toBe('aurora');
  });

  it('docks at the Ferro-9 depot too, with its own market, and leaves it clear of every collider', () => {
    const { server, session, me, last } = solo();
    const ferro = server.world.zone.stations.find((st) => st.id === 'ferro')!;
    expect(ferro.position.distanceTo(server.world.zone.station.position)).toBeGreaterThan(6500);
    const ship = me()!;
    ship.position.copy(ferro.dock.mouth).addScaledVector(ferro.dock.out, 60);
    ship.velocity.set(0, 0, 0);
    server.receive(session, { t: 'dock' });
    server.tick();
    expect(last('pilot')!.pilot.docked).toBe('ferro');
    expect(last('market')!.market.station).toBe('ferro');
    // The depot sells ore cheaper than the hub buys it.
    const aurora = createMarket('aurora');
    const depot = createMarket('ferro');
    expect(quote('ironNickel', depot.ironNickel).buy).toBeLessThan(quote('ironNickel', aurora.ironNickel).sell);
    server.receive(session, { t: 'undock' });
    const out = me()!;
    // Every collision sphere of the ship is clear of the depot's real shapes (v0.8).
    for (const h of HITBOXES[out.classId]) {
      const at = h.at.clone().applyQuaternion(out.rotation).add(out.position);
      for (const c of server.world.grid.query(at, 40)) expect(distanceTo(c, at, server.world.time)).toBeGreaterThan(h.r);
    }
  });

  it('keeps rocks off the depot and its approach lane', () => {
    const zone = new GameServer({ npcs: false }).world.zone;
    const ferro = zone.stations.find((st) => st.id === 'ferro')!;
    for (const a of zone.asteroids) {
      expect(a.position.distanceTo(ferro.position) - a.radius).toBeGreaterThan(500);
      for (let d = 0; d <= 1400; d += 100) {
        const p = ferro.dock.mouth.clone().addScaledVector(ferro.dock.out, d);
        expect(a.position.distanceTo(p) - a.radius).toBeGreaterThan(150);
      }
    }
  });

  it('validates the new client messages', () => {
    expect(validateClientMessage({ t: 'dock' })).toEqual({ t: 'dock' });
    expect(validateClientMessage({ t: 'trade', item: 'water', qty: -3 })).toEqual({ t: 'trade', item: 'water', qty: -3 });
    expect(validateClientMessage({ t: 'trade', item: 'gold', qty: 3 })).toBeNull();
    expect(validateClientMessage({ t: 'trade', item: 'water', qty: 0.5 })).toBeNull();
    expect(validateClientMessage({ t: 'trade', item: '__proto__', qty: 1 })).toBeNull();
  });
});

/** Points the ship at an asteroid from `dist` metres, with nothing else in the way. */
function aimAtRock(server: GameServer, ship: Ship, dist = 150) {
  const zone = server.world.zone;
  for (let i = 0; i < zone.asteroids.length; i++) {
    const a = zone.asteroids[i];
    if (a.radius > 80) continue;
    const dir = new Vector3(1, 0.3, 0.2).normalize();
    ship.position.copy(a.position).addScaledVector(dir, a.radius + dist);
    ship.rotation.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir.clone().negate()));
    ship.velocity.set(0, 0, 0);
    // Out of every collider, and the beam meets this rock first.
    if (server.world.grid.query(ship.position, 40).some((c) => c.center.distanceTo(ship.position) < c.radius + 20)) continue;
    if (miningTarget(ship, server.world.grid, zone.asteroids)?.index === i) return i;
  }
  throw new Error('no asteroid to aim at');
}

describe('mining', () => {
  it('fills the hold with the ore of the rock under the beam', () => {
    const { server, session, me, last } = solo();
    const ship = me()!;
    const index = aimAtRock(server, ship);
    const ore = oreOf(server.world.zone.asteroids[index].variant);
    let seq = 1;
    const seconds = 5 / (0.6 * richness(index));
    for (let i = 0; i < 60 * seconds + 30; i++) {
      server.receive(session, { t: 'input', seq: seq++, input: { ...ship.input, mine: true, throttle: 0 } });
      server.tick();
      ship.velocity.set(0, 0, 0);
    }
    expect(last('snapshot')!.snap.ships.find((s) => s.id === ship.id)!.m).toBe(index);
    const cargo = last('pilot')!.pilot.cargo;
    const total = (cargo[ore] ?? 0) + (cargo.platinum ?? 0);
    expect(total).toBeGreaterThanOrEqual(5);
    expect(Object.keys(cargo).every((k) => k === ore || k === 'platinum')).toBe(true);
  });

  it('does nothing while firing, too fast, or out of range', () => {
    const { server, session, me } = solo();
    const ship = me()!;
    aimAtRock(server, ship);
    let seq = 1;
    const run = (extra: Partial<Ship['input']>, speed = 0) => {
      for (let i = 0; i < 10; i++) {
        server.receive(session, { t: 'input', seq: seq++, input: { ...ship.input, mine: true, fire: false, ...extra } });
        ship.velocity.set(0, 0, speed);
        server.tick();
      }
      return ship.mining;
    };
    expect(run({})).not.toBeNull();
    expect(run({ fire: true })).toBeNull();
    expect(run({}, 90)).toBeNull();
    ship.position.addScaledVector(new Vector3(0, 0, 1).applyQuaternion(ship.rotation), MINING_RANGE);
    expect(run({})).toBeNull();
  });

  it('stops at a full hold, and the cargo is lost with the ship', () => {
    const { server, session, me, last, notices } = solo();
    const ship = me()!;
    aimAtRock(server, ship, 60);
    const s = (server as unknown as { sessions: Map<string, { cargo: Record<string, number> }> }).sessions.get(session)!;
    s.cargo.water = SHIP_CLASSES.falcon.cargo;
    let seq = 1;
    for (let i = 0; i < 60 * 4; i++) {
      server.receive(session, { t: 'input', seq: seq++, input: { ...ship.input, mine: true } });
      server.tick();
      ship.velocity.set(0, 0, 0);
    }
    expect(notices().some((n) => /Soute pleine/.test(n))).toBe(true);
    server.world.applyDamage(ship, 1e6, null);
    server.tick();
    expect(last('pilot')!.pilot.cargo).toEqual({});
    expect(notices().at(-1)).toMatch(/Cargaison perdue/);
  });
});
