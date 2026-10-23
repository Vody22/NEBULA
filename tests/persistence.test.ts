import { Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAccount, loadAccount, loadSolo, saveAccount, saveSolo } from '../src/client/account';
import { LocalTransport } from '../src/client/net/LocalTransport';
import { GameServer, STARTING_CREDITS } from '../src/server/GameServer';
import { createMarket } from '../src/shared/economy/market';
import type { ServerMessage } from '../src/shared/net/protocol';
import { restoreSector, SAVE_VERSION, sectorSave, validateSave, type PilotSave } from '../src/shared/save';
import { SHIP_CLASSES } from '../src/shared/sim/shipClasses';
import type { Ship } from '../src/shared/sim/types';

const HULL = SHIP_CLASSES.falcon.hull;
const CARGO = SHIP_CLASSES.falcon.cargo;
const NO_MODS = { guns: 0, shields: 0, armor: 0, engines: 0, hold: 0, mining: 0 };
/** The fleet of a pilot who only has the Falcon. */
const falconOnly = (hull: number) => ({ hull, ship: 'falcon' as const, fleet: { falcon: { mods: NO_MODS, hull } } });

/** A GameServer with one account pilot, recording what it asks to save. */
function game(save?: unknown, now = () => Date.UTC(2026, 9, 23)) {
  const saves: { id: string; save: PilotSave; final: boolean }[] = [];
  const server = new GameServer({ npcs: false, now, onSave: (id, s, final) => saves.push({ id, save: JSON.parse(JSON.stringify(s)), final }) });
  const inbox: ServerMessage[] = [];
  const link = { send: (m: ServerMessage) => inbox.push(JSON.parse(JSON.stringify(m))), close: () => {} };
  const session = server.connect(link, { accountId: '7', name: 'Kerys', save });
  const me = () => [...server.world.ships.values()].find((s) => s.ownerId === session) as Ship | undefined;
  const last = <T extends ServerMessage['t']>(t: T) => [...inbox].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  return { server, saves, inbox, link, session, me, last };
}

/** Parks a ship at the Aurora-7 hangar mouth, stopped. */
function park(server: GameServer, ship: Ship) {
  ship.position.copy(server.world.zone.station.dock.mouth).add(new Vector3(0, 0, 60));
  ship.velocity.set(0, 0, 0);
}

describe('pilot saves', () => {
  it('a new account pilot starts in space and its first state is saved', () => {
    const { server, saves, me } = game();
    expect(me()).toBeDefined();
    server.tick();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toEqual({ id: '7', final: false, save: { v: SAVE_VERSION, credits: STARTING_CREDITS, cargo: {}, kills: 0, deaths: 0, station: 'aurora', ...falconOnly(HULL) } });
    server.tick();
    expect(saves).toHaveLength(1); // nothing changed, nothing written
  });

  it('a returning pilot is back in the hangar of its last station, with its wallet, hold, score and hull', () => {
    const { server, me, last, inbox } = game({ v: 1, credits: 4321, cargo: { ironNickel: 12, water: 3 }, kills: 9, deaths: 2, station: 'ferro', hull: 140.5 });
    server.tick();
    expect(me()).toBeUndefined();
    expect(last('pilot')!.pilot).toMatchObject({ credits: 4321, cargo: { ironNickel: 12, water: 3 }, docked: 'ferro', hull: 140.5 });
    expect(last('market')!.market.station).toBe('ferro');
    expect(last('snapshot')!.stats).toEqual({ kills: 9, deaths: 2, credits: 4321 });
    expect(inbox.some((m) => m.t === 'notice' && /Progression chargée : amarré à .*Ferro-9/.test(m.text))).toBe(true);
  });

  it('cleans up a corrupted or foreign save instead of trusting it', () => {
    const { server, last } = game({ v: 1, credits: -50, cargo: { water: 1e9, gold: 5, parts: 'beaucoup' }, kills: 1e12, deaths: NaN, station: 'mars', hull: 1e6 });
    server.tick();
    const p = last('pilot')!.pilot;
    expect(p).toMatchObject({ credits: 0, cargo: { water: CARGO }, docked: 'aurora', hull: HULL });
    expect(last('snapshot')!.stats).toEqual({ kills: 1e7, deaths: 0, credits: 0 });
    // Not a save at all (other version, garbage): a fresh pilot in space.
    for (const raw of [{ v: 9, credits: 9e5 }, 'texte', 42, []]) {
      const g = game(raw);
      g.server.tick();
      expect(g.me()).toBeDefined();
      expect(g.last('pilot')!.pilot.credits).toBe(STARTING_CREDITS);
    }
  });

  it('validateSave reads a v0.4 save (no fleet), fits the hold to the capacity item by item, and keeps the hull between 1 and max', () => {
    const s = validateSave({ v: 1, credits: 12.9, cargo: { water: 20, parts: 20, medicine: 20, gold: 1 }, kills: 1, deaths: 1, station: 'ferro', hull: 0 });
    expect(s).toEqual({ v: SAVE_VERSION, credits: 12, cargo: { water: 20, parts: 20 }, kills: 1, deaths: 1, station: 'ferro', ...falconOnly(1) });
    expect(validateSave(null)).toBeNull();
    expect(validateSave({ v: '1' })).toBeNull();
    expect(validateSave({ v: 2, credits: 9 })).toBeNull();
  });

  it('validateSave keeps owned ships and their upgrades, and drops what cannot be owned', () => {
    const s = validateSave({
      v: 1,
      credits: 10,
      cargo: { water: 70 },
      kills: 0,
      deaths: 0,
      station: 'aurora',
      ship: 'warden',
      fleet: { warden: { mods: { hold: 2, guns: 9, armor: -1, shields: 1.7 }, hull: 1e6 }, marauder: { mods: {}, hull: 400 }, __proto__: { hull: 1 } },
    })!;
    expect(s.ship).toBe('warden');
    expect(Object.keys(s.fleet).sort()).toEqual(['falcon', 'warden']);
    expect(s.fleet.warden!.mods).toEqual({ ...NO_MODS, hold: 2, guns: 3, shields: 1 });
    expect(s.fleet.warden!.hull).toBe(SHIP_CLASSES.warden.hull);
    // Warden hold 60, +50 % with two hold levels.
    expect(s.cargo).toEqual({ water: 70 });
    // The ship flown must be owned; otherwise back to the Falcon (whose hold then limits the cargo).
    const t = validateSave({ v: 1, credits: 0, cargo: { water: 70 }, ship: 'marauder', fleet: {} })!;
    expect(t.ship).toBe('falcon');
    expect(t.cargo).toEqual({ water: CARGO });
  });

  it('writes saves a v0.4 server can still read (rollback): same version, hull of the ship flown on top', () => {
    const s = validateSave({ v: 1, credits: 5, cargo: {}, kills: 0, deaths: 0, station: 'aurora', hull: 10, ship: 'warden', fleet: { warden: { mods: {}, hull: 200 } } })!;
    expect(s).toMatchObject({ v: 1, hull: 200, ship: 'warden', credits: 5 });
  });

  it('reports trades and docking as they happen, the station docked at becomes home, and a leaving pilot is saved last', () => {
    const { server, saves, session, me } = game();
    const ferro = server.world.zone.stations.find((st) => st.id === 'ferro')!;
    const ship = me()!;
    ship.position.copy(ferro.dock.mouth);
    ship.velocity.set(0, 0, 0);
    server.receive(session, { t: 'dock' });
    server.receive(session, { t: 'trade', item: 'water', qty: 4 });
    server.receive(session, { t: 'trade', item: 'water', qty: 1 });
    server.tick();
    // Several changes in one tick: one save.
    expect(saves.at(-1)!.save).toMatchObject({ station: 'ferro', cargo: { water: 5 } });
    const n = saves.length;
    server.receive(session, { t: 'undock' });
    server.tick();
    expect(saves.length).toBe(n + 1);
    expect(saves.at(-1)!.save.station).toBe('ferro'); // in space, home is still Ferro-9
    me()!.hull = 99;
    server.disconnect(session);
    expect(saves.at(-1)).toMatchObject({ final: true, save: { station: 'ferro', fleet: { falcon: { hull: 99 } }, cargo: { water: 5 } } });
  });

  it('kills and deaths are saved; a destroyed pilot keeps its score but its hold is lost and the next ship is whole', () => {
    const { server, saves, session, me } = game({ v: 1, credits: 1000, cargo: { water: 5 }, kills: 4, deaths: 0, station: 'aurora', hull: 80 });
    server.receive(session, { t: 'undock' });
    server.tick();
    const ship = me()!;
    expect(ship.hull).toBe(80);
    server.world.applyDamage(ship, 1e6, null);
    server.tick();
    expect(ship.alive).toBe(false);
    expect(saves.at(-1)!.save).toEqual({ v: SAVE_VERSION, credits: 1000, cargo: {}, kills: 4, deaths: 1, station: 'aurora', ...falconOnly(HULL) });
  });

  it('persistAll reports every account pilot (server shutdown); dropAccount ends a session without saving', () => {
    const { server, saves } = game();
    server.connect({ send: () => {}, close: () => {} }, 'Invité'); // a guest: nothing to save
    server.connect({ send: () => {}, close: () => {} }, { accountId: '8', name: 'Vale' });
    server.tick();
    saves.length = 0;
    server.persistAll();
    expect(saves.map((s) => [s.id, s.final])).toEqual([
      ['7', true],
      ['8', true],
    ]);
    saves.length = 0;
    const kicked: ServerMessage[] = [];
    const s3 = server.connect({ send: (m) => kicked.push(m), close: () => {} }, { accountId: '9', name: 'Doublon' });
    expect(s3).not.toBe('');
    server.dropAccount('9', 'Ce pilote vient de se connecter sur un autre serveur.');
    expect(kicked.some((m) => m.t === 'error' && m.code === 'kicked')).toBe(true);
    expect(saves.some((s) => s.id === '9')).toBe(false);
    expect(server.sessionCount).toBe(3);
  });

  it('station stocks survive a restart, drifting back toward equilibrium for the time the server was down', () => {
    const t0 = Date.UTC(2026, 9, 23, 12);
    const a = game(undefined, () => t0);
    park(a.server, a.me()!);
    a.server.receive(a.session, { t: 'dock' });
    a.server.receive(a.session, { t: 'trade', item: 'water', qty: 20 });
    const sold = a.server.markets.aurora.water.stock;
    expect(sold).toBeLessThan(createMarket('aurora').water.stock - 15);
    const saved = JSON.parse(JSON.stringify(a.server.exportSector()));

    const b = game(undefined, () => t0 + 1000);
    expect(b.server.importSector(saved)).toBeGreaterThan(10);
    expect(b.server.markets.aurora.water.stock).toBeCloseTo(sold, 1);
    const c = game(undefined, () => t0 + 3 * 3600_000); // three hours later
    c.server.importSector(saved);
    const eq = c.server.markets.aurora.water.eq;
    expect(Math.abs(c.server.markets.aurora.water.stock - eq)).toBeLessThan(Math.abs(sold - eq) * 0.5);
    // Junk is ignored, stocks are clamped.
    const markets = { aurora: createMarket('aurora'), ferro: createMarket('ferro') };
    expect(restoreSector(markets, { v: 1, savedAt: 0, stocks: { mars: { water: 5 }, aurora: { water: -10, medicine: 1e9, gold: 3 } } })).toBe(2);
    expect(markets.aurora.water.stock).toBe(0);
    expect(markets.aurora.medicine.stock).toBe(markets.aurora.medicine.ref * 10);
    expect(restoreSector(markets, 'rien')).toBe(0);
    expect(sectorSave(markets, 5).savedAt).toBe(5);
  });
});

/** A Storage stand-in (the tests run in Node, the game in a browser). */
class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, String(v));
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

describe('browser storage', () => {
  const g = globalThis as unknown as { window?: { localStorage: MemoryStorage } };
  afterEach(() => {
    delete g.window;
  });

  it('keeps the login (never the password) until it expires, and survives garbage', () => {
    const kv = new MemoryStorage();
    const token = 'A'.repeat(43);
    saveAccount({ name: 'Kerys', token, expiresAt: 2000 }, kv);
    expect(kv.getItem('nebula-frontier.account')).not.toMatch(/password|mot/);
    expect(loadAccount(kv, 1000)).toEqual({ name: 'Kerys', token, expiresAt: 2000 });
    expect(loadAccount(kv, 2000)).toBeNull(); // expired
    kv.setItem('nebula-frontier.account', '{pas du json');
    expect(loadAccount(kv, 0)).toBeNull();
    kv.setItem('nebula-frontier.account', JSON.stringify({ name: 'K', token: 'court', expiresAt: 9e15 }));
    expect(loadAccount(kv, 0)).toBeNull();
    saveAccount({ name: 'Kerys', token, expiresAt: 2000 }, kv);
    clearAccount(kv);
    expect(loadAccount(kv, 0)).toBeNull();
    // Storage blocked: no crash.
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} };
    expect(loadAccount(blocked, 0)).toBeNull();
    expect(() => saveAccount({ name: 'Kerys', token, expiresAt: 2000 }, blocked)).not.toThrow();
    expect(loadSolo(blocked)).toBeNull();
  });

  it('solo progress lives in this browser: dock, buy, close the page, and it is all there next time', () => {
    const kv = new MemoryStorage();
    g.window = { localStorage: kv };
    const first = new LocalTransport('Solitaire', { persist: true });
    const inbox: ServerMessage[] = [];
    first.onMessage((m) => inbox.push(m));
    first.update(0);
    const ship = [...first.server.world.ships.values()].find((s) => s.name === 'Solitaire')!;
    park(first.server, ship);
    first.send({ t: 'dock' });
    first.send({ t: 'trade', item: 'medicine', qty: 3 });
    first.update(1 / 60);
    const pilot = [...inbox].reverse().find((m) => m.t === 'pilot') as Extract<ServerMessage, { t: 'pilot' }>;
    expect(pilot.pilot).toMatchObject({ docked: 'aurora', cargo: { medicine: 3 } });
    const stock = first.server.markets.aurora.medicine.stock;
    first.close(); // leaving the game / closing the page
    expect(loadSolo(kv)).not.toBeNull();

    const second = new LocalTransport('Solitaire', { persist: true });
    const inbox2: ServerMessage[] = [];
    second.onMessage((m) => inbox2.push(m));
    second.update(1 / 60);
    const back = [...inbox2].reverse().find((m) => m.t === 'pilot') as Extract<ServerMessage, { t: 'pilot' }>;
    expect(back.pilot).toMatchObject({ docked: 'aurora', cargo: { medicine: 3 }, credits: pilot.pilot.credits });
    expect(second.server.markets.aurora.medicine.stock).toBeCloseTo(stock, 0);
    second.close();

    // Without persist (tests, tools), nothing is read or written.
    kv.data.clear();
    const temp = new LocalTransport('Passager');
    temp.update(1 / 60);
    temp.close();
    expect(kv.data.size).toBe(0);
    saveSolo({ v: SAVE_VERSION, credits: 1, cargo: {}, kills: 0, deaths: 0, station: 'aurora', ...falconOnly(1) }, { v: 1, savedAt: 0, stocks: {} }, kv);
    expect(loadSolo(kv)!.save).toMatchObject({ credits: 1 });
  });
});
