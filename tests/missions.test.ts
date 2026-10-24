import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { GameServer, STARTING_CREDITS } from '../src/server/GameServer';
import type { StationId } from '../src/shared/economy/market';
import { BOARD_SIZE, cleanMissions, makeOffer, MAX_ACTIVE, OFFER_REFILL, type Mission } from '../src/shared/missions';
import { validateClientMessage, type ServerMessage } from '../src/shared/net/protocol';
import { SAVE_VERSION, validateSave, type PilotSave } from '../src/shared/save';
import { mulberry32 } from '../src/shared/rng';
import { SHIP_CLASSES } from '../src/shared/sim/shipClasses';
import type { Ship } from '../src/shared/sim/types';
import { noMods } from '../src/shared/sim/upgrades';

const CARGO = SHIP_CLASSES.falcon.cargo;

function game(save?: Partial<PilotSave>) {
  const saves: PilotSave[] = [];
  const server = new GameServer({ npcs: false, onSave: (_id, s) => saves.push(JSON.parse(JSON.stringify(s))) });
  const inbox: ServerMessage[] = [];
  const link = { send: (m: ServerMessage) => inbox.push(JSON.parse(JSON.stringify(m))) };
  const full: PilotSave | undefined = save && {
    v: SAVE_VERSION,
    credits: 1000,
    cargo: {},
    kills: 0,
    deaths: 0,
    station: 'aurora',
    hull: SHIP_CLASSES.falcon.hull,
    ship: 'falcon',
    fleet: { falcon: { mods: noMods(), hull: SHIP_CLASSES.falcon.hull } },
    missions: [],
    ...save,
  };
  const session = server.connect(link, { accountId: 'a1', name: 'Kerys', save: full });
  const me = () => [...server.world.ships.values()].find((s) => s.ownerId === session) as Ship | undefined;
  const last = <T extends ServerMessage['t']>(t: T) => [...inbox].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  const pilot = () => {
    server.tick();
    return last('pilot')!.pilot;
  };
  const notices = () => inbox.filter((m) => m.t === 'notice').map((m) => (m as Extract<ServerMessage, { t: 'notice' }>).text);
  /** Puts an offer on a station board, in its first slot. */
  const post = (station: StationId, m: Omit<Mission, 'id' | 'station' | 'progress'> & { id?: number }) => {
    const offer: Mission = { id: 900 + Math.floor(Math.random() * 1e6), station, progress: 0, ...m };
    server.boards[station].offers[0] = offer;
    return offer;
  };
  const dockAt = (station: StationId) => {
    const st = server.world.zone.stations.find((x) => x.id === station)!;
    const ship = me()!;
    ship.position.copy(st.dock.mouth);
    ship.velocity.set(0, 0, 0);
    server.receive(session, { t: 'dock' });
  };
  /** A pirate destroyed by the pilot's guns. */
  const killPirate = () => {
    const ship = me()!;
    const p = server.world.spawnShip({ classId: 'raider', faction: 'raiders', name: 'Raider-T', position: ship.position.clone().add(new Vector3(0, 300, 0)) });
    server.world.applyDamage(p, 1e5, ship.id);
    server.tick();
  };
  return { server, session, me, last, pilot, notices, post, dockAt, killPirate, saves, inbox };
}

describe('contract offers', () => {
  it('are varied, bounded, and point at a real destination', () => {
    const rng = mulberry32(7);
    const kinds = new Set<string>();
    const couriers = { near: [] as number[], far: [] as number[] };
    for (let i = 0; i < 300; i++) {
      const m = makeOffer(rng, 'ferro', i + 1);
      kinds.add(m.kind);
      expect(m.count).toBeGreaterThanOrEqual(2);
      expect(m.count).toBeLessThanOrEqual(15);
      expect(m.reward).toBeGreaterThan(0);
      expect(m.reward % 10).toBe(0);
      // Courier: Aurora-7 in the same sector, or a Kepler station (a jump away, paid more).
      if (m.kind === 'courier') {
        expect(['aurora', 'kepler', 'vesta']).toContain(m.target);
        couriers[m.target === 'aurora' ? 'near' : 'far'].push(m.reward / m.count);
      } else expect(m.target).toBe('ferro');
      if (m.kind === 'mining') expect(['carbon', 'regolith', 'silicates', 'ironNickel']).toContain(m.item);
      // Courier crates always fit an empty Falcon.
      if (m.kind === 'courier') expect(m.count).toBeLessThanOrEqual(CARGO);
    }
    expect([...kinds].sort()).toEqual(['courier', 'hunt', 'mining']);
    // About a third of the deliveries cross sectors, and they pay more per crate.
    const share = couriers.far.length / (couriers.far.length + couriers.near.length);
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.5);
    const mean = (l: number[]) => l.reduce((a, b) => a + b, 0) / l.length;
    expect(mean(couriers.far)).toBeGreaterThan(mean(couriers.near) * 1.5);
  });

  it('are shown on docking, and a taken one leaves the board for everyone until it is replaced', () => {
    const a = game({});
    const b = a.server.connect({ send: () => {} }, { accountId: 'a2', name: 'Autre', save: { v: 1, credits: 0, cargo: {}, kills: 0, deaths: 0, station: 'aurora', hull: 260 } });
    expect(a.last('board')!.offers).toHaveLength(BOARD_SIZE);
    const offer = a.last('board')!.offers[0];
    a.server.receive(a.session, { t: 'mission', op: 'accept', id: offer.id });
    expect(a.last('board')!.offers.map((o) => o.id)).not.toContain(offer.id);
    expect(a.pilot().missions.map((m) => m.id)).toEqual([offer.id]);
    // The other pilot cannot take it any more.
    a.server.receive(b, { t: 'mission', op: 'accept', id: offer.id });
    for (let i = 0; i < 60 * (OFFER_REFILL + 2); i++) a.server.tick();
    expect(a.last('board')!.offers).toHaveLength(BOARD_SIZE);
    expect(a.last('board')!.offers.map((o) => o.id)).not.toContain(offer.id);
  });

  it(`are limited to ${MAX_ACTIVE} at a time, and can be abandoned anywhere`, () => {
    const g = game({});
    const ids = g.server.boards.aurora.offers.map((o) => o!.id);
    for (const id of ids) g.server.receive(g.session, { t: 'mission', op: 'accept', id });
    expect(g.pilot().missions).toHaveLength(MAX_ACTIVE);
    expect(g.notices().at(-1)).toMatch(/au maximum/);
    g.server.receive(g.session, { t: 'undock' });
    g.server.receive(g.session, { t: 'mission', op: 'abandon', id: ids[0] });
    expect(g.pilot().missions.map((m) => m.id)).toEqual(ids.slice(1, MAX_ACTIVE));
    expect(g.notices().at(-1)).toMatch(/Contrat abandonné/);
  });
});

describe('courier contracts', () => {
  it('take hold space, are paid on docking at the destination', () => {
    const g = game({});
    const offer = g.post('aurora', { kind: 'courier', target: 'ferro', count: 8, reward: 480 });
    g.server.receive(g.session, { t: 'mission', op: 'accept', id: offer.id });
    let p = g.pilot();
    expect(p.reserved).toBe(8);
    // The market fills only what is left.
    g.server.receive(g.session, { t: 'trade', item: 'water', qty: 100 });
    p = g.pilot();
    expect(p.cargo.water).toBe(CARGO - 8);
    g.server.receive(g.session, { t: 'undock' });
    g.dockAt('aurora');
    expect(g.pilot().missions).toHaveLength(1); // not here
    g.server.receive(g.session, { t: 'undock' });
    const credits = g.pilot().credits;
    g.dockAt('ferro');
    p = g.pilot();
    expect(p).toMatchObject({ docked: 'ferro', reserved: 0, missions: [], credits: credits + 480 });
    expect(g.notices().some((n) => /Contrat rempli : Livraison : 8 caisses pour .*Ferro-9  \+480 cr/.test(n))).toBe(true);
  });

  it('need the room, and fail when the ship is destroyed', () => {
    const g = game({ cargo: { water: CARGO - 3 } });
    const offer = g.post('aurora', { kind: 'courier', target: 'ferro', count: 5, reward: 350 });
    g.server.receive(g.session, { t: 'mission', op: 'accept', id: offer.id });
    expect(g.notices().at(-1)).toMatch(/5 places libres/);
    g.server.receive(g.session, { t: 'trade', item: 'water', qty: -10 });
    g.server.receive(g.session, { t: 'mission', op: 'accept', id: offer.id });
    expect(g.pilot().missions).toHaveLength(1);
    g.server.receive(g.session, { t: 'undock' });
    g.server.world.applyDamage(g.me()!, 1e5, null);
    g.server.tick();
    expect(g.pilot()).toMatchObject({ missions: [], reserved: 0 });
    expect(g.notices().some((n) => /Contrat échoué/.test(n))).toBe(true);
  });

  it('crates must fit the ship swapped to', () => {
    const g = game({ credits: 9000 });
    g.server.receive(g.session, { t: 'buyShip', ship: 'warden' });
    const offer = g.post('aurora', { kind: 'courier', target: 'ferro', count: 10, reward: 570 });
    g.server.receive(g.session, { t: 'mission', op: 'accept', id: offer.id });
    g.server.receive(g.session, { t: 'trade', item: 'water', qty: 35 });
    g.server.receive(g.session, { t: 'useShip', ship: 'falcon' });
    expect(g.pilot().ship).toBe('warden');
    expect(g.notices().at(-1)).toMatch(/Soute trop pleine/);
  });
});

describe('mining contracts', () => {
  it('count only ore mined after taking them, and pay when it is brought back', () => {
    const g = game({});
    const offer = g.post('aurora', { kind: 'mining', target: 'aurora', item: 'ironNickel', count: 3, reward: 240 });
    g.server.receive(g.session, { t: 'mission', op: 'accept', id: offer.id });
    // Bought ore does not count.
    g.server.receive(g.session, { t: 'trade', item: 'ironNickel', qty: 3 });
    g.server.receive(g.session, { t: 'undock' });
    g.dockAt('aurora');
    let p = g.pilot();
    expect(p.missions[0].progress).toBe(0);
    expect(p.cargo.ironNickel).toBe(3);
    g.server.receive(g.session, { t: 'undock' });
    // The server credits mined units through collectOre; here straight to the hook it calls.
    const mined = (item: 'ironNickel' | 'carbon') => (g.server as unknown as { mined(s: unknown, i: string): void }).mined((g.server as unknown as { sessions: Map<string, unknown> }).sessions.get(g.session), item);
    mined('carbon');
    mined('ironNickel');
    mined('ironNickel');
    mined('ironNickel');
    mined('ironNickel');
    p = g.pilot();
    expect(p.missions[0].progress).toBe(3);
    expect(g.notices().at(-1)).toMatch(/Minerai réuni/);
    const credits = p.credits;
    g.dockAt('aurora');
    p = g.pilot();
    expect(p.missions).toEqual([]);
    expect(p.credits).toBe(credits + 240);
    // The three units in the hold were handed over.
    expect(p.cargo.ironNickel).toBeUndefined();
  });

  it('are not paid when the ore was sold, and the count resets when the ship is lost', () => {
    const g = game({ missions: [{ id: 1, kind: 'mining', station: 'aurora', target: 'aurora', item: 'carbon', count: 4, progress: 4, reward: 200 }] });
    g.server.receive(g.session, { t: 'undock' });
    g.dockAt('aurora');
    expect(g.notices().at(-1)).toMatch(/il manque 4 Carbone/);
    expect(g.pilot().missions[0].progress).toBe(4);
    g.server.receive(g.session, { t: 'undock' });
    g.server.world.applyDamage(g.me()!, 1e5, null);
    g.server.tick();
    expect(g.pilot().missions[0].progress).toBe(0);
  });
});

describe('hunt contracts', () => {
  it('count pirates destroyed by the pilot and pay at the last one', () => {
    const g = game({});
    const offer = g.post('aurora', { kind: 'hunt', target: 'aurora', count: 2, reward: 440 });
    g.server.receive(g.session, { t: 'mission', op: 'accept', id: offer.id });
    g.server.receive(g.session, { t: 'undock' });
    const start = g.pilot().credits;
    g.killPirate();
    expect(g.pilot().missions[0].progress).toBe(1);
    g.killPirate();
    const p = g.pilot();
    expect(p.missions).toEqual([]);
    expect(p.credits).toBe(start + 2 * SHIP_CLASSES.raider.bounty + 440);
  });
});

describe('saved contracts', () => {
  it('are saved with their progress and come back with new ids', () => {
    const g = game({});
    const offer = g.post('aurora', { kind: 'hunt', target: 'aurora', count: 3, reward: 660 });
    g.server.receive(g.session, { t: 'mission', op: 'accept', id: offer.id });
    g.server.receive(g.session, { t: 'undock' });
    g.killPirate();
    g.server.tick();
    const save = g.saves.at(-1)!;
    expect(save.missions).toEqual([{ ...offer, progress: 1 }]);
    const back = game(validateSave(save)!);
    const m = back.pilot().missions;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'hunt', count: 3, progress: 1, reward: 660 });
  });

  it('are cleaned up: garbage dropped, at most three, crates only while they fit', () => {
    expect(cleanMissions('x')).toEqual([]);
    expect(cleanMissions([{ kind: 'warp' }, { kind: 'mining', station: 'aurora', target: 'aurora', item: 'platinum', count: 3 }, null])).toEqual([]);
    const many = Array.from({ length: 5 }, () => ({ kind: 'hunt', station: 'ferro', target: 'ferro', count: 99, progress: -4, reward: 1e9 }));
    const c = cleanMissions(many);
    expect(c).toHaveLength(MAX_ACTIVE);
    expect(c[0]).toEqual({ id: 0, kind: 'hunt', station: 'ferro', target: 'ferro', count: 30, progress: 0, reward: 20000 });
    const s = validateSave({
      v: 1,
      credits: 0,
      cargo: { water: 40 },
      station: 'aurora',
      hull: 100,
      missions: [
        { kind: 'courier', station: 'aurora', target: 'ferro', count: 25, reward: 1 },
        { kind: 'courier', station: 'aurora', target: 'ferro', count: 25, reward: 1 },
      ],
    })!;
    // One crate load fits the Falcon (40); the second does not; cargo gets what is left.
    expect(s.missions).toHaveLength(1);
    expect(s.cargo).toEqual({ water: CARGO - 25 });
    // A v0.5 save (no contracts) is fine.
    expect(validateSave({ v: 1, credits: 5, cargo: {}, station: 'aurora', hull: 100 })!.missions).toEqual([]);
    expect(STARTING_CREDITS).toBeGreaterThan(0);
  });

  it('accepts only well-formed contract messages', () => {
    expect(validateClientMessage({ t: 'mission', op: 'accept', id: 4 })).toEqual({ t: 'mission', op: 'accept', id: 4 });
    expect(validateClientMessage({ t: 'mission', op: 'abandon', id: 4 })).toEqual({ t: 'mission', op: 'abandon', id: 4 });
    expect(validateClientMessage({ t: 'mission', op: 'complete', id: 4 })).toBeNull();
    expect(validateClientMessage({ t: 'mission', op: 'accept', id: 1.5 })).toBeNull();
    expect(validateClientMessage({ t: 'mission', op: 'accept' })).toBeNull();
  });
});

describe('boards', () => {
  it('start with one contract of each kind', () => {
    for (const seed of [1, 1337, 99]) {
      const g = new GameServer({ npcs: false, seed });
      for (const b of Object.values(g.boards)) expect(new Set(b.offers.map((o) => o!.kind)).size).toBe(3);
    }
  });
});
