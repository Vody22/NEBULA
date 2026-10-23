import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { GameServer } from '../src/server/GameServer';
import { snapshotShip, validateClientMessage, type ServerMessage } from '../src/shared/net/protocol';
import { SAVE_VERSION, validateSave, type PilotSave } from '../src/shared/save';
import { SHIP_CLASSES } from '../src/shared/sim/shipClasses';
import { stepShipPhysics } from '../src/shared/sim/shipPhysics';
import type { Ship } from '../src/shared/sim/types';
import { effectiveStats, noMods, packMods, SHIPYARD, statsOf, unpackMods, upgradeCost, UPGRADE_MAX } from '../src/shared/sim/upgrades';
import { World } from '../src/shared/sim/world';
import { buildZone } from '../src/shared/sim/zone';

const NO_MODS = noMods();
const WARDEN_PRICE = SHIPYARD.find((o) => o.classId === 'warden')!.price;

function pilotSave(extra: Partial<PilotSave> = {}): PilotSave {
  return { v: SAVE_VERSION, credits: 20000, cargo: {}, kills: 0, deaths: 0, station: 'aurora', hull: SHIP_CLASSES.falcon.hull, ship: 'falcon', fleet: { falcon: { mods: noMods(), hull: SHIP_CLASSES.falcon.hull } }, missions: [], ...extra };
}

/** A returning account pilot, docked at its station. */
function docked(save: PilotSave = pilotSave()) {
  const saves: PilotSave[] = [];
  const server = new GameServer({ npcs: false, onSave: (_id, s) => saves.push(JSON.parse(JSON.stringify(s))) });
  const inbox: ServerMessage[] = [];
  const link = { send: (m: ServerMessage) => inbox.push(JSON.parse(JSON.stringify(m))) };
  const session = server.connect(link, { accountId: 'a1', name: 'Kerys', save });
  const me = () => [...server.world.ships.values()].find((s) => s.ownerId === session) as Ship | undefined;
  const pilot = () => {
    server.tick();
    return ([...inbox].reverse().find((m) => m.t === 'pilot') as Extract<ServerMessage, { t: 'pilot' }>).pilot;
  };
  const notices = () => inbox.filter((m) => m.t === 'notice').map((m) => (m as Extract<ServerMessage, { t: 'notice' }>).text);
  return { server, session, me, pilot, notices, saves };
}

describe('upgrades', () => {
  it('scale the characteristics of a ship by level', () => {
    const base = SHIP_CLASSES.falcon;
    const s = effectiveStats('falcon', { guns: 1, shields: 2, armor: 3, engines: 2, hold: 2, mining: 1 });
    expect(s.weapon.damage).toBeCloseTo(base.weapon.damage * 1.12);
    expect(s.shield).toBeCloseTo(base.shield * 1.3);
    expect(s.shieldRegen).toBeCloseTo(base.shieldRegen * 1.3);
    expect(s.hull).toBeCloseTo(base.hull * 1.45);
    expect(s.maxSpeed).toBeCloseTo(base.maxSpeed * 1.1);
    expect(s.cargo).toBe(Math.floor(base.cargo * 1.5));
    expect(s.miningRate).toBeCloseTo(1.25);
    // Everything else, the hardpoints and the turn rates included, stays the class value.
    expect(s.pitchRate).toBe(base.pitchRate);
    expect(s.weapon.hardpoints).toBe(base.weapon.hardpoints);
    expect(effectiveStats('falcon', NO_MODS)).toMatchObject({ hull: base.hull, cargo: base.cargo, miningRate: 1 });
  });

  it('cost more at each level, more on the Warden, and stop at the maximum', () => {
    const m = noMods();
    const costs = [];
    for (let l = 0; l < UPGRADE_MAX; l++) {
      costs.push(upgradeCost('falcon', m, 'guns'));
      m.guns++;
    }
    expect(costs).toEqual([500, 1400, 3200]);
    expect(upgradeCost('falcon', m, 'guns')).toBeNull();
    expect(upgradeCost('warden', NO_MODS, 'guns')).toBe(600);
  });

  it('travel packed in snapshots, and NPC ships send nothing', () => {
    expect(packMods(NO_MODS)).toBe('');
    expect(packMods({ ...NO_MODS, guns: 3, hold: 1 })).toBe('300010');
    expect(unpackMods('300010')).toEqual({ ...NO_MODS, guns: 3, hold: 1 });
    expect(unpackMods('9x')).toEqual({ ...NO_MODS, guns: 3 });
    expect(unpackMods(undefined)).toEqual(NO_MODS);
    const w = new World(buildZone(1337));
    const npc = w.spawnShip({ classId: 'raider', faction: 'raiders', name: 'r', position: new Vector3() });
    expect(snapshotShip(npc).u).toBeUndefined();
    const fitted = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'f', position: new Vector3(500, 0, 0), mods: { ...NO_MODS, engines: 2 } });
    expect(snapshotShip(fitted).u).toBe('000200');
  });

  it('change how the simulation flies a ship, from spawn on', () => {
    const w = new World(buildZone(1337));
    const plain = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'a', position: new Vector3(5e4, 0, 0) });
    const fast = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'b', position: new Vector3(-5e4, 0, 0), mods: { ...NO_MODS, engines: 3, armor: 2 } });
    expect(fast.hull).toBeCloseTo(SHIP_CLASSES.falcon.hull * 1.3);
    for (const s of [plain, fast]) s.input.throttle = 1;
    for (let i = 0; i < 60 * 20; i++) for (const s of [plain, fast]) stepShipPhysics(s, 1 / 60);
    expect(plain.velocity.length()).toBeCloseTo(SHIP_CLASSES.falcon.maxSpeed, 0);
    expect(fast.velocity.length()).toBeCloseTo(statsOf(fast).maxSpeed, 0);
    expect(statsOf(fast).maxSpeed).toBeGreaterThan(SHIP_CLASSES.falcon.maxSpeed * 1.14);
  });

  it('are bought docked, applied to the ship that undocks, and saved', () => {
    const { server, session, me, pilot, notices, saves } = docked();
    server.receive(session, { t: 'upgrade', slot: 'armor' });
    server.receive(session, { t: 'upgrade', slot: 'armor' });
    server.receive(session, { t: 'upgrade', slot: 'hold' });
    let p = pilot();
    expect(p.credits).toBe(20000 - 500 - 1400 - 500);
    expect(p.fleet).toEqual([{ classId: 'falcon', mods: { ...NO_MODS, armor: 2, hold: 1 }, hull: SHIP_CLASSES.falcon.hull * 1.3 }]);
    // The new plating comes intact: the hull stays full.
    expect(p.hull).toBeCloseTo(SHIP_CLASSES.falcon.hull * 1.3);
    expect(p.hullMax).toBeCloseTo(SHIP_CLASSES.falcon.hull * 1.3);
    expect(p.capacity).toBe(Math.floor(SHIP_CLASSES.falcon.cargo * 1.25));
    expect(notices().at(-1)).toMatch(/Soute niveau 1/);
    expect(saves.at(-1)!.fleet.falcon!.mods).toMatchObject({ armor: 2, hold: 1 });
    server.receive(session, { t: 'undock' });
    const ship = me()!;
    expect(ship.mods).toMatchObject({ armor: 2, hold: 1 });
    expect(ship.hull).toBeCloseTo(SHIP_CLASSES.falcon.hull * 1.3);
    // In space, nothing can be fitted.
    server.receive(session, { t: 'upgrade', slot: 'guns' });
    p = pilot();
    expect(p.fleet[0].mods.guns).toBe(0);
  });

  it('are refused without the credits, or past the maximum level', () => {
    const { server, session, pilot, notices } = docked(pilotSave({ credits: 900 }));
    server.receive(session, { t: 'upgrade', slot: 'guns' });
    server.receive(session, { t: 'upgrade', slot: 'guns' });
    expect(notices().at(-1)).toMatch(/crédits/i);
    expect(pilot()).toMatchObject({ credits: 400, fleet: [{ mods: { guns: 1 } }] });

    const maxed = docked(pilotSave({ fleet: { falcon: { mods: { ...NO_MODS, mining: 3 }, hull: 260 } } }));
    maxed.server.receive(maxed.session, { t: 'upgrade', slot: 'mining' });
    expect(maxed.notices().at(-1)).toMatch(/niveau maximal/);
    expect(maxed.pilot().credits).toBe(20000);
  });
});

describe('shipyard', () => {
  it('sells the Warden at Aurora-7, which becomes the ship flown', () => {
    const { server, session, me, pilot, saves } = docked();
    server.receive(session, { t: 'buyShip', ship: 'warden' });
    const p = pilot();
    expect(p.credits).toBe(20000 - WARDEN_PRICE);
    expect(p.ship).toBe('warden');
    expect(p.fleet.map((f) => f.classId)).toEqual(['falcon', 'warden']);
    expect(p.capacity).toBe(SHIP_CLASSES.warden.cargo);
    expect(p.hullMax).toBe(SHIP_CLASSES.warden.hull);
    expect(saves.at(-1)).toMatchObject({ ship: 'warden', fleet: { warden: { hull: SHIP_CLASSES.warden.hull } } });
    // Buying it again costs nothing more.
    server.receive(session, { t: 'buyShip', ship: 'warden' });
    expect(pilot().credits).toBe(20000 - WARDEN_PRICE);
    server.receive(session, { t: 'undock' });
    expect(me()!.classId).toBe('warden');
  });

  it('only sells at the shipyard, and only to pilots who can pay', () => {
    const ferro = docked(pilotSave({ station: 'ferro' }));
    ferro.server.receive(ferro.session, { t: 'buyShip', ship: 'warden' });
    expect(ferro.notices().at(-1)).toMatch(/chantier de .*Aurora-7/);
    expect(ferro.pilot()).toMatchObject({ credits: 20000, ship: 'falcon' });

    const poor = docked(pilotSave({ credits: WARDEN_PRICE - 1 }));
    poor.server.receive(poor.session, { t: 'buyShip', ship: 'warden' });
    expect(poor.pilot()).toMatchObject({ credits: WARDEN_PRICE - 1, ship: 'falcon' });
    expect(poor.pilot().fleet).toHaveLength(1);
  });

  it('swaps between owned ships at any station, each keeping its hull and upgrades', () => {
    const save = pilotSave({
      station: 'ferro',
      fleet: { falcon: { mods: { ...NO_MODS, guns: 2 }, hull: 100 }, warden: { mods: { ...NO_MODS, hold: 1 }, hull: 150 } },
    });
    const { server, session, me, pilot } = docked(save);
    expect(pilot()).toMatchObject({ ship: 'falcon', hull: 100 });
    server.receive(session, { t: 'useShip', ship: 'warden' });
    let p = pilot();
    expect(p).toMatchObject({ ship: 'warden', hull: 150, capacity: Math.floor(SHIP_CLASSES.warden.cargo * 1.25) });
    expect(p.fleet).toEqual([
      { classId: 'falcon', mods: { ...NO_MODS, guns: 2 }, hull: 100 },
      { classId: 'warden', mods: { ...NO_MODS, hold: 1 }, hull: 150 },
    ]);
    server.receive(session, { t: 'useShip', ship: 'falcon' });
    p = pilot();
    expect(p).toMatchObject({ ship: 'falcon', hull: 100 });
    server.receive(session, { t: 'undock' });
    expect(me()!.mods.guns).toBe(2);
    // Undocked, the ship cannot be swapped.
    server.receive(session, { t: 'useShip', ship: 'warden' });
    expect(pilot().ship).toBe('falcon');
  });

  it('refuses a swap when the cargo would not fit, and ships not owned', () => {
    const save = pilotSave({ ship: 'warden', cargo: { water: 55 }, fleet: { falcon: { mods: noMods(), hull: 260 }, warden: { mods: noMods(), hull: 240 } } });
    const { server, session, pilot, notices } = docked(save);
    server.receive(session, { t: 'useShip', ship: 'falcon' });
    expect(notices().at(-1)).toMatch(/Soute trop pleine/);
    expect(pilot().ship).toBe('warden');
    const other = docked();
    other.server.receive(other.session, { t: 'useShip', ship: 'warden' });
    expect(other.pilot().ship).toBe('falcon');
  });

  it('brings a pilot back with its fleet after a reconnection from the save', () => {
    const { server, session, saves } = docked();
    server.receive(session, { t: 'buyShip', ship: 'warden' });
    server.receive(session, { t: 'upgrade', slot: 'engines' });
    server.tick();
    server.disconnect(session);
    const back = docked(validateSave(saves.at(-1))!);
    expect(back.pilot()).toMatchObject({ ship: 'warden', credits: 20000 - WARDEN_PRICE - 600, fleet: [{ classId: 'falcon' }, { classId: 'warden', mods: { engines: 1 } }] });
  });

  it('accepts only sellable ships and known slots from clients', () => {
    expect(validateClientMessage({ t: 'buyShip', ship: 'warden' })).toEqual({ t: 'buyShip', ship: 'warden' });
    expect(validateClientMessage({ t: 'useShip', ship: 'falcon' })).toEqual({ t: 'useShip', ship: 'falcon' });
    expect(validateClientMessage({ t: 'buyShip', ship: 'marauder' })).toBeNull();
    expect(validateClientMessage({ t: 'useShip', ship: '__proto__' })).toBeNull();
    expect(validateClientMessage({ t: 'upgrade', slot: 'hold' })).toEqual({ t: 'upgrade', slot: 'hold' });
    expect(validateClientMessage({ t: 'upgrade', slot: 'warp' })).toBeNull();
    expect(validateClientMessage({ t: 'upgrade' })).toBeNull();
  });
});
