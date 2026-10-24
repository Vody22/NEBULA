import { describe, expect, it } from 'vitest';
import { GameServer } from '../src/server/GameServer';
import { createMarket, STATION_IDS } from '../src/shared/economy/market';
import { crossSector, makeOffer, missionStatus, type Mission } from '../src/shared/missions';
import { PROTOCOL_VERSION, validateClientMessage, type ServerMessage } from '../src/shared/net/protocol';
import { mulberry32 } from '../src/shared/rng';
import { SAVE_VERSION, validateSave, type PilotSave } from '../src/shared/save';
import { JUMP_CHARGE, JUMP_CLEARANCE, JUMP_COOLDOWN, JUMP_ENERGY, SECTOR_IDS, sectorSeed, STATION_NAMES, STATION_SECTOR } from '../src/shared/sectors';
import { distanceTo } from '../src/shared/physics/shapes';
import { SHIP_CLASSES } from '../src/shared/sim/shipClasses';
import type { Ship } from '../src/shared/sim/types';
import { noMods } from '../src/shared/sim/upgrades';
import { TICK_RATE } from '../src/shared/sim/world';
import { buildSector, buildZone, zoneOf } from '../src/shared/sim/zone';

const FALCON = SHIP_CLASSES.falcon;

function pilot(server: GameServer, name: string, save?: Partial<PilotSave>) {
  const inbox: ServerMessage[] = [];
  const link = { send: (m: ServerMessage) => inbox.push(JSON.parse(JSON.stringify(m))) };
  const full: PilotSave | undefined = save && {
    v: SAVE_VERSION,
    credits: 1000,
    cargo: {},
    kills: 0,
    deaths: 0,
    station: 'aurora',
    hull: FALCON.hull,
    ship: 'falcon',
    fleet: { falcon: { mods: noMods(), hull: FALCON.hull } },
    missions: [],
    ...save,
  };
  const session = server.connect(link, { accountId: `acc-${name}`, name, save: full });
  const where = () => server.whereIs(session)!;
  const me = () => {
    const w = where();
    return w.shipId !== null ? (server.sectors[w.sector].world.ships.get(w.shipId) as Ship) : undefined;
  };
  const last = <T extends ServerMessage['t']>(t: T) => [...inbox].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  const all = <T extends ServerMessage['t']>(t: T) => inbox.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  const notices = () => all('notice').map((m) => m.text);
  /** Out in open space, 3 km in front of the hub, stopped. */
  const goOut = () => {
    const ship = me()!;
    ship.position.set(0, 150, 3000);
    ship.velocity.set(0, 0, 0);
  };
  const jump = (to: 'aurora' | 'kepler' | null) => server.receive(session, { t: 'jump', to });
  const ticks = (n: number) => {
    for (let i = 0; i < n; i++) server.tick();
  };
  const dockAt = (station: (typeof STATION_IDS)[number]) => {
    const st = server.sectors[STATION_SECTOR[station]].world.zone.stations.find((x) => x.id === station)!;
    const ship = me()!;
    ship.position.copy(st.dock.mouth);
    ship.velocity.set(0, 0, 0);
    server.receive(session, { t: 'dock' });
    server.tick();
  };
  return { session, inbox, where, me, last, all, notices, goOut, jump, ticks, dockAt };
}

const CHARGE_TICKS = JUMP_CHARGE * TICK_RATE + 2;

describe('the Kepler sector', () => {
  it('is built the same everywhere, with its two stations clear of rocks', () => {
    const a = buildSector('kepler', 1337);
    const b = zoneOf('kepler', sectorSeed('kepler', 1337));
    expect(a.seed).toBe(b.seed);
    expect(a.asteroids.length).toBe(b.asteroids.length);
    expect(a.asteroids[17].position.equals(b.asteroids[17].position)).toBe(true);
    expect(a.stations.map((s) => s.id)).toEqual(['kepler', 'vesta']);
    expect(a.stations.map((s) => s.name)).toEqual([STATION_NAMES.kepler, STATION_NAMES.vesta]);
    // A richer belt than Aurora's: more rocks, more metal, more platinum, harder raids.
    const aurora = buildZone(1337);
    const metal = (z: typeof a) => z.asteroids.filter((r) => r.variant === 3).length / z.asteroids.length;
    expect(a.asteroids.length).toBeGreaterThan(aurora.asteroids.length);
    expect(metal(a)).toBeGreaterThan(metal(aurora) * 1.5);
    expect(a.platinum).toBeGreaterThan(aurora.platinum);
    expect(a.danger).toBeGreaterThan(aurora.danger);
    for (const z of [a, aurora]) {
      // Hangar mouths and the jump arrival point are in open space.
      for (const st of z.stations) {
        for (const c of z.colliders) expect(distanceTo(c, st.dock.mouth, 0)).toBeGreaterThan(20);
        // A ship that just arrived may jump again without flying anywhere first.
        expect(st.position.distanceTo(z.jumpPoint)).toBeGreaterThan(JUMP_CLEARANCE + 400);
      }
      for (const c of z.colliders) expect(distanceTo(c, z.jumpPoint, 0)).toBeGreaterThan(300);
    }
  });

  it('keeps the Aurora sector as it was', () => {
    // v0.6 values: the asteroid indices are part of the saves and of the client's rock meshes.
    const z = buildSector('aurora', 1337);
    expect(z.asteroids.length).toBe(518);
    // v0.8 replaced the stations' spheres by their real shapes; the rocks and planets are unchanged.
    expect(z.colliders.filter((c) => c.kind === 'asteroid').length).toBe(518);
    expect(z.colliders.filter((c) => c.kind === 'planet').length).toBe(z.planets.length);
    expect(z.seed).toBe(1337);
  });

  it('has its own markets, and every station is in exactly one sector', () => {
    for (const id of STATION_IDS) expect(SECTOR_IDS).toContain(STATION_SECTOR[id]);
    const k = createMarket('kepler');
    const v = createMarket('vesta');
    const f = createMarket('ferro');
    // Trade routes that need a jump: Vesta's water to Ferro, Kepler's medicine to the depots, platinum to Kepler.
    expect(v.water.eq).toBeGreaterThan(f.water.eq * 5);
    expect(k.medicine.eq).toBeGreaterThan(f.medicine.eq * 5);
    expect(k.platinum.eq).toBeLessThan(createMarket('aurora').platinum.eq);
  });
});

describe('hyperspace jump', () => {
  it('needs open space, charges, then carries the ship, its hold and its contracts to the other sector', () => {
    const server = new GameServer({ npcs: false });
    const a = pilot(server, 'Vega', { credits: 500, cargo: { water: 3 } });
    // Saved pilots start docked: take off.
    server.receive(a.session, { t: 'undock' });
    server.tick();
    expect(a.where().sector).toBe('aurora');
    a.jump('kepler');
    expect(a.notices().at(-1)).toMatch(/près d'une station/);
    a.goOut();
    a.jump('kepler');
    expect(a.notices().at(-1)).toMatch(/en charge/);
    a.ticks(TICK_RATE * 3);
    expect(a.last('snapshot')!.jump.to).toBe('kepler');
    expect(a.last('snapshot')!.jump.left).toBeGreaterThan(2);
    expect(a.where().sector).toBe('aurora');
    const before = a.me()!;
    const hull = (before.hull = 150);
    const energy = before.energy;
    a.ticks(CHARGE_TICKS - TICK_RATE * 3);
    expect(a.where().sector).toBe('kepler');
    expect(a.last('sector')).toEqual({ t: 'sector', sector: 'kepler', zoneSeed: server.sectors.kepler.world.zone.seed });
    expect(a.notices().at(-1)).toBe('Arrivée : Secteur Kepler');
    const ship = a.me()!;
    expect(server.sectors.kepler.world.ships.has(ship.id)).toBe(true);
    expect([...server.world.ships.values()].some((s) => s.ownerId === a.session)).toBe(false);
    expect(ship.hull).toBe(hull);
    expect(ship.energy).toBeLessThan(energy - FALCON.energy * JUMP_ENERGY + 1);
    expect(ship.position.distanceTo(server.sectors.kepler.world.zone.jumpPoint)).toBeLessThan(400);
    expect(a.last('pilot')!.pilot.cargo).toEqual({ water: 3 });
    // Snapshots now come from Kepler.
    a.ticks(1);
    const snap = a.last('snapshot')!;
    expect(snap.you).toBe(ship.id);
    expect(snap.snap.ships.map((s) => s.id)).toContain(ship.id);
    expect(snap.jump.cooldown).toBeGreaterThan(JUMP_COOLDOWN - 1);
    expect(server.playerList().find((p) => p.id === a.session)!.sector).toBe('kepler');
  });

  it('is cancelled by the pilot, by flying back to a station, or by draining the capacitor; refused in a PvP fight and during the cooldown', () => {
    const server = new GameServer({ npcs: false });
    const a = pilot(server, 'Rigel');
    a.goOut();
    a.jump('kepler');
    a.jump('kepler'); // again: cancel
    expect(a.notices().at(-1)).toBe('Saut annulé.');
    a.ticks(CHARGE_TICKS);
    expect(a.where().sector).toBe('aurora');

    a.jump('kepler');
    a.ticks(TICK_RATE);
    a.me()!.position.set(0, 0, 900);
    a.ticks(1);
    expect(a.notices().at(-1)).toMatch(/^Saut annulé : trop près de Station Aurora-7/);
    a.ticks(CHARGE_TICKS);
    expect(a.where().sector).toBe('aurora');

    a.goOut();
    a.jump('kepler');
    a.ticks(TICK_RATE);
    a.me()!.energy = FALCON.energy * JUMP_ENERGY * 0.5;
    a.ticks(1);
    expect(a.notices().at(-1)).toMatch(/^Saut annulé : énergie/);
    a.jump('kepler');
    expect(a.notices().at(-1)).toMatch(/énergie insuffisante/);

    a.me()!.energy = FALCON.energy;
    a.me()!.lastPvpCombat = server.time;
    a.jump('kepler');
    expect(a.notices().at(-1)).toMatch(/PvP/);
    a.me()!.lastPvpCombat = -999;
    a.jump('aurora');
    expect(a.notices().at(-1)).toMatch(/déjà dans le Secteur Aurora/);

    a.jump('kepler');
    a.ticks(CHARGE_TICKS);
    expect(a.where().sector).toBe('kepler');
    a.me()!.energy = FALCON.energy;
    a.jump('aurora');
    expect(a.notices().at(-1)).toMatch(/recharge/);
    a.ticks(JUMP_COOLDOWN * TICK_RATE);
    a.me()!.energy = FALCON.energy;
    a.jump('aurora');
    a.ticks(CHARGE_TICKS);
    expect(a.where().sector).toBe('aurora');
  });

  it('a destroyed ship does not jump', () => {
    const server = new GameServer({ npcs: false });
    const a = pilot(server, 'Deneb');
    a.goOut();
    a.jump('kepler');
    a.ticks(TICK_RATE);
    server.world.applyDamage(a.me()!, 1e6, null);
    a.ticks(CHARGE_TICKS);
    expect(a.where().sector).toBe('aurora');
    // The new ship comes out at Aurora's spawn.
    expect(a.me()).toBeDefined();
    expect(a.last('snapshot')!.jump.to).toBeNull();
  });
});

describe('sectors on one server', () => {
  it('show each pilot only the ships and events of its own sector; chat and the player list are shared', () => {
    const server = new GameServer({ npcs: false });
    const a = pilot(server, 'Altair');
    const b = pilot(server, 'Bellatrix');
    a.goOut();
    a.jump('kepler');
    a.ticks(CHARGE_TICKS);
    const aShip = a.me()!.id;
    const bShip = b.me()!.id;
    // B saw A leave.
    const bEvents = b.all('events').flatMap((m) => m.events);
    expect(bEvents.some((e) => e.type === 'jumpOut')).toBe(true);
    b.inbox.length = 0;
    a.inbox.length = 0;
    a.ticks(2);
    const aSnap = a.last('snapshot')!.snap.ships;
    const bSnap = b.last('snapshot')!.snap.ships;
    expect(aSnap.every((s) => s.owner !== b.session)).toBe(true);
    expect(bSnap.every((s) => s.owner !== a.session)).toBe(true);
    expect(aSnap.find((s) => s.id === aShip)!.owner).toBe(a.session);
    expect(bSnap.find((s) => s.id === bShip)!.owner).toBe(b.session);
    // A shot in Kepler is not an event in Aurora.
    a.me()!.input.fire = true;
    server.receive(a.session, { t: 'input', seq: 1, input: { throttle: 0, strafeX: 0, strafeY: 0, pitch: 0, yaw: 0, roll: 0, boost: false, fire: true, flightAssist: true, mine: false } });
    a.ticks(10);
    expect(a.all('events').flatMap((m) => m.events).some((e) => e.type === 'shot')).toBe(true);
    expect(b.all('events').flatMap((m) => m.events).some((e) => e.type === 'shot')).toBe(false);
    server.receive(b.session, { t: 'chat', text: 'Tu es où ?' });
    expect(a.last('chat')!.line.text).toBe('Tu es où ?');
    expect(server.playerList().map((p) => [p.name, p.sector])).toEqual([
      ['Altair', 'kepler'],
      ['Bellatrix', 'aurora'],
    ]);
  });

  it('raids a sector only while someone is there, and harder in Kepler', () => {
    const server = new GameServer({ npcs: true });
    const a = pilot(server, 'Mira');
    const raiders = (id: 'aurora' | 'kepler') => [...server.sectors[id].world.ships.values()].filter((s) => s.faction === 'raiders').length;
    let guard = 0;
    while (raiders('aurora') === 0 && guard++ < TICK_RATE * 20) server.tick();
    const auroraFirst = raiders('aurora');
    expect(auroraFirst).toBeGreaterThan(0);
    expect(raiders('kepler')).toBe(0);
    // Jump out of the fight: Aurora is cleared once empty, Kepler starts its own raids.
    a.goOut();
    a.me()!.position.set(0, 150, 6000);
    a.jump('kepler');
    a.ticks(CHARGE_TICKS);
    if (a.where().sector !== 'kepler') {
      // Raiders may have shot the ship down during the charge: retry from the respawn.
      a.ticks(TICK_RATE * 6);
      a.goOut();
      a.me()!.lastPvpCombat = -999;
      a.jump('kepler');
      a.ticks(CHARGE_TICKS);
    }
    expect(a.where().sector).toBe('kepler');
    expect(raiders('aurora')).toBe(0);
    expect(server.sectors.aurora.wave).toBe(0);
    guard = 0;
    while (raiders('kepler') === 0 && guard++ < TICK_RATE * 20) server.tick();
    expect(raiders('kepler')).toBeGreaterThan(auroraFirst);
    expect(server.sectors.kepler.wave).toBe(1);
  });
});

describe('trade and contracts across sectors', () => {
  it('docks and trades at Kepler-4, and comes back there after a restart', () => {
    const saves: PilotSave[] = [];
    const server = new GameServer({ npcs: false, onSave: (_id, s) => saves.push(JSON.parse(JSON.stringify(s))) });
    const a = pilot(server, 'Sirius', { credits: 2000 });
    server.receive(a.session, { t: 'undock' });
    server.tick();
    a.goOut();
    a.jump('kepler');
    a.ticks(CHARGE_TICKS);
    // Logging off in Kepler's space: back at Kepler-4, not at Aurora-7.
    expect(saves.at(-1)!.station).toBe('kepler');
    a.dockAt('kepler');
    expect(a.last('pilot')!.pilot.docked).toBe('kepler');
    expect(a.last('market')!.market.station).toBe('kepler');
    expect(a.last('board')!.station).toBe('kepler');
    server.receive(a.session, { t: 'trade', item: 'medicine', qty: 5 });
    server.tick();
    expect(a.last('pilot')!.pilot.cargo.medicine).toBe(5);
    server.disconnect(a.session);
    const save = saves.at(-1)!;
    expect(save.station).toBe('kepler');
    expect(validateSave(save)!.station).toBe('kepler');

    const again = new GameServer({ npcs: false });
    const b = pilot(again, 'Sirius', save);
    expect(b.where()).toEqual({ sector: 'kepler', shipId: null, docked: 'kepler' });
    expect(b.last('welcome')!.sector).toBe('kepler');
    expect(b.last('welcome')!.zoneSeed).toBe(again.sectors.kepler.world.zone.seed);
    again.receive(b.session, { t: 'undock' });
    again.tick();
    expect(b.me()).toBeDefined();
    expect(again.sectors.kepler.world.ships.has(b.me()!.id)).toBe(true);
  });

  it('pays a courier contract to the other sector on docking there', () => {
    const server = new GameServer({ npcs: false });
    const a = pilot(server, 'Polaris', { credits: 0 });
    const offer: Mission = { id: 4242, kind: 'courier', station: 'aurora', target: 'kepler', count: 5, progress: 0, reward: 900 };
    expect(crossSector(offer)).toBe(true);
    expect(missionStatus(offer)).toMatch(/secteur Kepler/);
    server.boards.aurora.offers[0] = offer;
    server.receive(a.session, { t: 'mission', op: 'accept', id: 4242 });
    server.receive(a.session, { t: 'undock' });
    server.tick();
    a.goOut();
    a.jump('kepler');
    a.ticks(CHARGE_TICKS);
    expect(a.last('pilot')!.pilot.missions.map((m) => m.id)).toEqual([4242]);
    a.dockAt('kepler');
    expect(a.last('pilot')!.pilot.missions).toEqual([]);
    expect(a.last('pilot')!.pilot.credits).toBe(900);
  });

  it('offers deliveries from Kepler to Aurora too', () => {
    const rng = mulberry32(3);
    const targets = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const m = makeOffer(rng, 'vesta', i + 1, 'courier');
      expect(m.target).not.toBe('vesta');
      targets.add(m.target);
    }
    expect([...targets].sort()).toEqual(['aurora', 'ferro', 'kepler']);
  });
});

describe('protocol 7', () => {
  it('validates jump requests', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(7);
    expect(validateClientMessage({ t: 'jump', to: 'kepler' })).toEqual({ t: 'jump', to: 'kepler' });
    expect(validateClientMessage({ t: 'jump', to: null })).toEqual({ t: 'jump', to: null });
    expect(validateClientMessage({ t: 'jump', to: 'mars' })).toBeNull();
    expect(validateClientMessage({ t: 'jump' })).toBeNull();
  });

  it('keeps saves readable: an unknown station falls back to Aurora-7', () => {
    const s = validateSave({ v: 1, credits: 5, cargo: {}, kills: 0, deaths: 0, station: 'mars', hull: 100 })!;
    expect(s.station).toBe('aurora');
    // The hub of each sector is a station of that sector.
    expect(STATION_SECTOR[validateSave({ v: 1, credits: 0, cargo: {}, kills: 0, deaths: 0, station: 'vesta', hull: 100 })!.station]).toBe('kepler');
  });
});
