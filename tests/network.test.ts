import { afterEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import WebSocket from 'ws';
import { startServer, type RunningServer } from '../src/server/node/server';
import { AccountService } from '../src/server/accounts/AccountService';
import { MemoryStore } from '../src/server/accounts/store';
import { STARTING_CREDITS } from '../src/server/GameServer';
import { createMarket } from '../src/shared/economy/market';
import { PROTOCOL_VERSION, type AuthRequest, type ClientMessage, type ServerMessage } from '../src/shared/net/protocol';
import { SHIP_CLASSES } from '../src/shared/sim/shipClasses';
import { neutralInput, type ShipInput } from '../src/shared/sim/types';

const PASSWORD = 'mot-de-passe-test';

/**
 * End-to-end tests against the real Node server over real WebSockets
 * (localhost). `lag` delays every message in both directions to simulate
 * network latency. Clients sign up under their name unless told otherwise.
 */
class TestClient {
  ws: WebSocket;
  inbox: ServerMessage[] = [];
  welcome: Extract<ServerMessage, { t: 'welcome' }> | null = null;
  account: Extract<ServerMessage, { t: 'account' }> | null = null;
  lastSnap: Extract<ServerMessage, { t: 'snapshot' }> | null = null;
  lastPilot: Extract<ServerMessage, { t: 'pilot' }>['pilot'] | null = null;
  closed = false;
  closeCode = 0;
  private seq = 0;

  constructor(url: string, readonly name: string, auth: AuthRequest | null = { kind: 'register', name, password: PASSWORD }, readonly lag = 0, origin?: string) {
    this.ws = new WebSocket(url, origin ? { origin } : undefined);
    this.ws.on('open', () => this.send(auth ? { t: 'hello', version: PROTOCOL_VERSION, auth } : { t: 'hello', version: PROTOCOL_VERSION }));
    this.ws.on('message', (data) => {
      const deliver = () => {
        const parsed = JSON.parse(data.toString());
        for (const m of (Array.isArray(parsed) ? parsed : [parsed]) as ServerMessage[]) {
          this.inbox.push(m);
          if (m.t === 'welcome') this.welcome = m;
          if (m.t === 'account') this.account = m;
          if (m.t === 'snapshot') this.lastSnap = m;
          if (m.t === 'pilot') this.lastPilot = m.pilot;
        }
      };
      if (this.lag) setTimeout(deliver, this.lag);
      else deliver();
    });
    this.ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
    });
    this.ws.on('error', () => {});
  }

  send(msg: ClientMessage | unknown) {
    const go = () => this.ws.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify(msg));
    if (this.lag) setTimeout(go, this.lag);
    else go();
  }

  input(partial: Partial<ShipInput>) {
    this.send({ t: 'input', seq: ++this.seq, input: { ...neutralInput(), ...partial } });
  }

  get shipId() {
    return this.lastSnap?.you ?? null;
  }

  ship(id = this.shipId) {
    return this.lastSnap?.snap.ships.find((s) => s.id === id);
  }

  messages<T extends ServerMessage['t']>(t: T) {
    return this.inbox.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }

  close() {
    this.ws.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000, what = 'condition') {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

let server: RunningServer | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await server?.close();
  server = null;
});

/** Accounts in memory, with the anti-abuse limits out of the way (every test client comes from 127.0.0.1). */
function accounts(store = new MemoryStore(), opts: ConstructorParameters<typeof AccountService>[1] = {}) {
  return new AccountService(store, { limits: { perMinute: 1000, signupsPerHour: 1000, signupsPerHourTotal: 1000 }, ...opts });
}
async function boot(opts: Partial<Parameters<typeof startServer>[0]> = {}, waitReady = true) {
  server = await startServer({ port: 0, host: '127.0.0.1', npcs: false, log: () => {}, staticDir: undefined, accounts: accounts(), ...opts });
  if (waitReady) await server.ready;
  return `ws://127.0.0.1:${server.port}/ws`;
}
function join(url: string, name: string, auth?: AuthRequest | null, lag = 0, origin?: string) {
  const c = new TestClient(url, name, auth, lag, origin);
  clients.push(c);
  return c;
}
/** Parks a ship at the Aurora-7 hangar mouth, stopped (close enough to dock). */
function park(shipId: number) {
  const w = server!.game.world;
  const ship = w.ships.get(shipId)!;
  ship.position.copy(w.zone.station.dock.mouth).add(new Vector3(0, 0, 60));
  ship.velocity.set(0, 0, 0);
}
/** Holds a client's input every 1/60 s for `ms` (like the real client's fixed input tick). */
async function hold(c: TestClient, input: Partial<ShipInput>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    c.input(input);
    await sleep(1000 / 60);
  }
}
/** Places ship `targetId` 250 m straight ahead of ship `shooterId`, both at rest. */
function lineUp(shooterId: number, targetId: number) {
  const w = server!.game.world;
  const a = w.ships.get(shooterId)!;
  const b = w.ships.get(targetId)!;
  a.velocity.set(0, 0, 0);
  a.rotation.copy(new Quaternion());
  b.velocity.set(0, 0, 0);
  b.position.copy(a.position).add(new Vector3(0, 0, -250));
}

describe('multiplayer server (WebSocket)', () => {
  it('two clients join, get distinct sessions and see each other with their names', async () => {
    const url = await boot();
    const a = join(url, 'William');
    const b = join(url, 'Ami');
    await until(() => !!a.welcome && !!b.welcome && a.lastSnap?.snap.ships.length === 2 && b.lastSnap?.snap.ships.length === 2, 4000, 'both ships');
    expect(a.welcome!.playerId).not.toBe(b.welcome!.playerId);
    expect(a.welcome!.token).not.toBe(b.welcome!.token);
    expect(a.welcome!.token.length).toBeGreaterThanOrEqual(16);
    const names = b.lastSnap!.snap.ships.map((s) => s.name).sort();
    expect(names).toEqual(['Ami', 'William']);
    await until(() => (a.messages('players').at(-1)?.list.length ?? 0) === 2, 3000, 'player list');
    expect(a.messages('players').at(-1)!.list.every((p) => p.online)).toBe(true);
    // Snapshots arrive at ~20 Hz, not 60.
    const n0 = a.messages('snapshot').length;
    await sleep(500);
    const rate = (a.messages('snapshot').length - n0) * 2;
    expect(rate).toBeGreaterThan(12);
    expect(rate).toBeLessThan(28);
  });

  it('movement is synchronised: one player thrusts, the other sees the ship move', async () => {
    const url = await boot();
    const a = join(url, 'Pilote A');
    const b = join(url, 'Pilote B');
    await until(() => a.shipId !== null && b.lastSnap?.snap.ships.length === 2);
    const aId = a.shipId!;
    const start = new Vector3(...b.ship(aId)!.p);
    await hold(a, { throttle: 1 }, 1200);
    await sleep(150);
    const seen = b.ship(aId)!;
    expect(new Vector3(...seen.p).distanceTo(start)).toBeGreaterThan(60);
    expect(seen.throttle).toBe(1);
    expect(a.lastSnap!.ackSeq).toBeGreaterThan(40); // inputs are acknowledged for prediction
    expect(b.ship(b.shipId)!.v.every((v) => Math.abs(v) < 1)).toBe(true); // B did not move
  });

  it('co-op: a player kills a pirate; both see it, only the shooter gets kill and bounty', async () => {
    const url = await boot();
    const a = join(url, 'Tireur');
    const b = join(url, 'Témoin');
    await until(() => a.shipId !== null && b.shipId !== null);
    const w = server!.game.world;
    const pirate = w.spawnShip({ classId: 'raider', faction: 'raiders', name: 'Cible', position: new Vector3() });
    pirate.shield = 0;
    pirate.hull = 20;
    lineUp(a.shipId!, pirate.id);
    await hold(a, { fire: true }, 1200);
    await until(() => b.messages('events').some((m) => m.events.some((e) => e.type === 'destroyed' && e.ship === pirate.id)), 3000, 'destroyed event at B');
    const destroyed = b.messages('events').flatMap((m) => m.events).find((e) => e.type === 'destroyed' && e.ship === pirate.id);
    expect(destroyed && destroyed.type === 'destroyed' && destroyed.by).toBe(a.shipId);
    expect(b.messages('events').some((m) => m.events.some((e) => e.type === 'shot' && e.shooter === a.shipId))).toBe(true);
    await until(() => a.lastSnap!.stats.kills === 1);
    expect(a.lastSnap!.stats.credits).toBe(STARTING_CREDITS + SHIP_CLASSES.raider.bounty);
    expect(b.lastSnap!.stats).toEqual({ kills: 0, deaths: 0, credits: STARTING_CREDITS });
  });

  it('PvP only between players who both opted in, and PvP kills pay no credits', async () => {
    const url = await boot();
    const a = join(url, 'Alpha');
    const b = join(url, 'Bravo');
    await until(() => a.shipId !== null && b.shipId !== null);
    lineUp(a.shipId!, b.shipId!);
    await hold(a, { fire: true }, 700);
    await sleep(200);
    const hitsOff = a.messages('events').flatMap((m) => m.events).filter((e) => e.type === 'hit' && e.target === b.shipId).length;
    expect(hitsOff).toBe(0); // friendly by default

    a.send({ t: 'pvp', on: true });
    b.send({ t: 'pvp', on: true });
    await until(() => !!b.ship(b.shipId)?.pvp && !!b.ship(a.shipId)?.pvp, 2000, 'pvp flags');
    const bShip = server!.game.world.ships.get(b.shipId!)!;
    bShip.shield = 0;
    bShip.hull = 30;
    lineUp(a.shipId!, b.shipId!);
    const bId = b.shipId!;
    await hold(a, { fire: true }, 1200);
    await until(() => b.lastSnap!.stats.deaths === 1, 3000, 'B destroyed');
    await until(() => a.lastSnap!.stats.kills === 1);
    expect(a.lastSnap!.stats.credits).toBe(STARTING_CREDITS);
    expect(b.messages('events').some((m) => m.events.some((e) => e.type === 'destroyed' && e.ship === bId && e.by === a.shipId))).toBe(true);
    // B cannot switch PvP off right after the fight.
    b.send({ t: 'pvp', on: false });
    await until(() => b.messages('notice').some((n) => /impossible|trop rapide/.test(n.text)), 2000, 'pvp lock notice');
  });

  it('a client cannot invent damage, credits or kills, and garbage gets it disconnected', async () => {
    const url = await boot();
    const a = join(url, 'Tricheur');
    const b = join(url, 'Victime');
    await until(() => a.shipId !== null && b.shipId !== null);
    const hullBefore = b.ship(b.shipId)!.hull;
    a.send({ t: 'hit', target: b.shipId, damage: 9999 });
    a.send({ t: 'destroyed', ship: b.shipId, by: a.shipId });
    a.send({ t: 'snapshot', stats: { kills: 99, credits: 1e9 } });
    a.send({ t: 'input', seq: 999999, input: { throttle: 50, fire: true, damage: 9999, credits: 1e9 } });
    a.send([{ t: 'chat', text: 'salut' }, { t: 'credits', amount: 1e9 }]);
    await sleep(400);
    expect(a.lastSnap!.stats).toEqual({ kills: 0, deaths: 0, credits: STARTING_CREDITS });
    expect(b.ship(b.shipId)!.hull).toBe(hullBefore);
    // The forged 50 throttle was clamped to the legal maximum.
    expect(server!.game.world.ships.get(a.shipId!)!.input.throttle).toBeLessThanOrEqual(1);
    for (let i = 0; i < 260; i++) a.send({ t: 'nope', i });
    await until(() => a.closed, 3000, 'cheater disconnected');
    expect(a.messages('error').some((e) => e.code === 'protocol')).toBe(true);
  });

  it('disconnection: the ship stops at once and disappears after the grace period', async () => {
    const url = await boot({ reconnectGrace: 1 });
    const a = join(url, 'Reste');
    const b = join(url, 'Part');
    await until(() => a.lastSnap?.snap.ships.length === 2 && b.shipId !== null);
    const bId = b.shipId!;
    await hold(b, { throttle: 1 }, 600);
    b.close();
    await until(() => a.messages('players').at(-1)?.list.find((p) => p.name === 'Part')?.online === false, 2000, 'offline flag');
    expect(server!.game.world.ships.get(bId)!.input.throttle).toBe(0);
    await until(() => !a.lastSnap!.snap.ships.some((s) => s.id === bId), 3000, 'ghost ship removed');
    await until(() => a.messages('chat').some((c) => c.line.from === null && /Part a quitté/.test(c.line.text)), 2000, 'leave message');
    expect(server!.game.sessionCount).toBe(1);
  });

  it('reconnection with the login token resumes the same pilot, ship and score', async () => {
    const url = await boot({ reconnectGrace: 10 });
    const a = join(url, 'Fidèle');
    await until(() => a.shipId !== null && !!a.account);
    const w = server!.game.world;
    const pirate = w.spawnShip({ classId: 'raider', faction: 'raiders', name: 'Cible', position: new Vector3() });
    pirate.shield = 0;
    pirate.hull = 10;
    lineUp(a.shipId!, pirate.id);
    await hold(a, { fire: true }, 900);
    await until(() => a.lastSnap!.stats.kills === 1);
    const { playerId } = a.welcome!;
    const token = a.account!.token;
    expect(a.account).toMatchObject({ name: 'Fidèle', isNew: true });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const shipId = a.shipId;
    a.ws.terminate(); // connection lost without a clean close
    await sleep(300);
    const a2 = join(url, 'Fidèle', { kind: 'token', token });
    await until(() => !!a2.welcome && !!a2.lastSnap && !!a2.account);
    expect(a2.welcome!.resumed).toBe(true);
    expect(a2.welcome!.playerId).toBe(playerId);
    expect(a2.shipId).toBe(shipId);
    expect(a2.lastSnap!.stats.kills).toBe(1);
    expect(a2.account).toMatchObject({ token, isNew: false }); // the browser keeps its token, extended
    expect(server!.game.sessionCount).toBe(1);
    // The same pilot by password from another window takes the session over; the first window is told.
    const a3 = join(url, 'fidèle', { kind: 'login', name: '  FIDÈLE ', password: PASSWORD });
    await until(() => !!a3.welcome && a2.closed, 4000, 'takeover');
    expect(a3.welcome!.playerId).toBe(playerId);
    expect(a3.welcome!.name).toBe('Fidèle');
    expect(a3.account!.token).not.toBe(token); // a password login gets a new token
    expect(a2.messages('error')[0]?.code).toBe('kicked');
    expect(server!.game.sessionCount).toBe(1);
    // A wrong token no longer makes a guest pilot: it is refused.
    const other = join(url, 'Fidèle', { kind: 'token', token: 'x'.repeat(43) });
    await until(() => other.closed, 3000, 'bad token refused');
    expect(other.welcome).toBeNull();
    expect(other.messages('error')[0]).toMatchObject({ code: 'auth', reason: 'expired' });
  });

  it('stays consistent under 150 ms of simulated latency each way', async () => {
    const url = await boot();
    const a = join(url, 'Lointain', undefined, 150);
    const b = join(url, 'Proche');
    await until(() => a.shipId !== null && b.lastSnap?.snap.ships.length === 2, 5000);
    const aId = a.shipId!;
    const t0 = Date.now();
    a.input({ throttle: 1 });
    await until(() => (b.ship(aId)?.throttle ?? 0) === 1, 3000, 'remote input applied');
    const oneWayPlusTick = Date.now() - t0;
    expect(oneWayPlusTick).toBeGreaterThanOrEqual(140);
    expect(oneWayPlusTick).toBeLessThan(600);
    await hold(a, { throttle: 1 }, 1000);
    await sleep(400);
    // The lagging client's acknowledged input and its own view converge on the server state.
    const server_ = server!.game.world.ships.get(aId)!;
    const seenByA = new Vector3(...a.ship(aId)!.p);
    expect(seenByA.distanceTo(server_.position)).toBeLessThan(server_.velocity.length() * 0.5 + 5);
    expect(a.lastSnap!.ackSeq).toBeGreaterThan(30);
  });

  it('chat: broadcast with sender name, history for newcomers, flood protection', async () => {
    const url = await boot();
    const a = join(url, 'Bavard');
    const b = join(url, 'Lecteur');
    await until(() => !!a.welcome && !!b.welcome);
    a.send({ t: 'chat', text: '  Salut   le <b>secteur</b> ‮ ' });
    await until(() => b.messages('chat').some((c) => c.line.from === 'Bavard'), 2000, 'chat line');
    const line = b.messages('chat').find((c) => c.line.from === 'Bavard')!.line;
    expect(line.text).toBe('Salut le <b>secteur</b>'); // trimmed; HTML is escaped by the client when shown
    for (let i = 0; i < 8; i++) a.send({ t: 'chat', text: `message ${i}` });
    await sleep(400);
    const fromA = b.messages('chat').filter((c) => c.line.from === 'Bavard').length;
    expect(fromA).toBe(5); // burst limit
    expect(a.messages('notice').some((n) => /trop de messages/.test(n.text))).toBe(true);
    a.send({ t: 'chat', text: 'x'.repeat(5000) });
    const c = join(url, 'Nouveau');
    await until(() => c.messages('chatHistory').length > 0, 2000, 'history');
    expect(c.messages('chatHistory')[0].lines.some((l) => l.from === 'Bavard' && l.text.startsWith('Salut'))).toBe(true);
  });

  it('refuses players beyond capacity and foreign origins', async () => {
    const url = await boot({ maxPlayers: 2, allowedOrigins: ['https://nebula-iota-rust.vercel.app'] });
    const ok = 'https://nebula-iota-rust.vercel.app';
    const a = join(url, 'Uno', undefined, 0, ok);
    const b = join(url, 'Deux', undefined, 0, ok);
    await until(() => !!a.welcome && !!b.welcome);
    const c = join(url, 'Trois', undefined, 0, ok);
    await until(() => c.closed, 3000, 'third refused');
    expect(c.messages('error')[0]?.code).toBe('full');
    const evil = join(url, 'Pirate', undefined, 0, 'https://evil.example');
    await until(() => evil.closed, 3000, 'foreign origin refused');
    expect(evil.welcome).toBeNull();
  });

  it('serves /health and /status', async () => {
    await boot();
    const base = `http://127.0.0.1:${server!.port}`;
    expect(await (await fetch(`${base}/health`)).text()).toBe('ok');
    const st = await (await fetch(`${base}/status`)).json();
    expect(st).toMatchObject({ protocol: PROTOCOL_VERSION, online: 0, max: 30, accounts: 'memory' });
  });
});

describe('pilot accounts (WebSocket)', () => {
  it('refuses a hello without login, a wrong password, a taken name and a weak password, with reasons', async () => {
    const url = await boot();
    const anon = join(url, 'Anonyme', null);
    await until(() => anon.closed, 3000, 'anonymous refused');
    expect(anon.messages('error')[0]).toMatchObject({ code: 'auth', reason: 'invalid' });
    const a = join(url, 'Kerys');
    await until(() => !!a.account);
    const wrong = join(url, 'Kerys', { kind: 'login', name: 'Kerys', password: 'pas-le-bon' });
    const taken = join(url, 'KERYS'); // names are unique whatever the case
    const unknown = join(url, 'Personne', { kind: 'login', name: 'Personne', password: PASSWORD });
    const weak = join(url, 'Faible', { kind: 'register', name: 'Faible', password: 'court' });
    const long = join(url, 'Long', { kind: 'register', name: 'Un pseudo bien trop long', password: PASSWORD });
    await until(() => [wrong, taken, unknown, weak, long].every((c) => c.closed), 4000, 'refusals');
    expect(wrong.messages('error')[0]).toMatchObject({ code: 'auth', reason: 'credentials' });
    expect(unknown.messages('error')[0]).toMatchObject({ code: 'auth', reason: 'credentials', text: wrong.messages('error')[0].text });
    expect(taken.messages('error')[0]).toMatchObject({ code: 'auth', reason: 'taken' });
    expect(weak.messages('error')[0]).toMatchObject({ code: 'auth', reason: 'invalid' });
    expect(weak.messages('error')[0].text).toMatch(/8 caractères/);
    expect(long.messages('error')[0].text).toMatch(/3 à 16/);
    expect([wrong, taken, unknown, weak, long].every((c) => c.welcome === null)).toBe(true);
    expect(server!.game.sessionCount).toBe(1);
  });

  it('a new pilot is told its progress is saved; a login while the database is down is refused, not stuck', async () => {
    const store = new MemoryStore();
    store.failing = true;
    const url = await boot({ accounts: accounts(store) }, false);
    const st = await (await fetch(`http://127.0.0.1:${server!.port}/status`)).json();
    expect(st.accounts).toBe('unavailable');
    const a = join(url, 'Patient');
    await until(() => a.closed, 3000, 'refused while down');
    expect(a.messages('error')[0]).toMatchObject({ code: 'auth', reason: 'unavailable' });
    store.failing = false;
    await server!.ready; // the service retries in the background
    const b = join(url, 'Patient');
    await until(() => !!b.account && !!b.welcome, 4000, 'login once back');
    expect(b.messages('notice').some((n) => /Compte créé/.test(n.text))).toBe(true);
  });

  it('progress survives a server restart: the pilot comes back docked, with credits, hold, score and station stocks', async () => {
    const store = new MemoryStore();
    let url = await boot({ accounts: accounts(store) });
    const a = join(url, 'Marchand');
    await until(() => a.shipId !== null && !!a.account);
    const token = a.account!.token;
    park(a.shipId!);
    a.send({ t: 'dock' });
    await until(() => a.lastPilot?.docked === 'aurora', 3000, 'docked');
    a.send({ t: 'trade', item: 'water', qty: 6 });
    await until(() => a.lastPilot?.cargo.water === 6, 3000, 'bought');
    const credits = a.lastPilot!.credits;
    expect(credits).toBeLessThan(STARTING_CREDITS);
    a.send({ t: 'undock' });
    await until(() => a.shipId !== null && a.lastPilot?.docked === null, 3000, 'undocked');
    server!.game.world.ships.get(a.shipId!)!.hull = 150;
    await sleep(100);
    // Server shutdown (a deploy): progress and stocks are written before the sockets close.
    const first = server!;
    server = null;
    await first.close();
    const stock = first.game.markets.aurora.water.stock;
    expect(stock).toBeLessThan(createMarket('aurora').water.stock - 3);
    await until(() => a.closed, 2000, 'client dropped');
    expect(a.messages('notice').some((n) => /Redémarrage/.test(n.text))).toBe(true);

    url = await boot({ accounts: accounts(store) });
    expect(server!.game.markets.aurora.water.stock).toBeCloseTo(stock, 1);
    const back = join(url, 'Marchand', { kind: 'token', token });
    await until(() => !!back.welcome && back.lastPilot !== null && !!back.lastSnap, 4000, 'back');
    expect(back.welcome!.resumed).toBe(false);
    // Left in space: back in the hangar of the last station docked at, hull as it was.
    expect(back.lastPilot).toMatchObject({ docked: 'aurora', credits, cargo: { water: 6 }, hull: 150 });
    expect(back.lastSnap!.you).toBeNull();
    expect(back.messages('notice').some((n) => /Progression chargée : amarré à Station Aurora-7/.test(n.text))).toBe(true);
    // And by password too, after the token is gone (another browser).
    back.close();
    await until(() => back.closed);
    const again = join(url, 'Marchand', { kind: 'login', name: 'marchand', password: PASSWORD });
    await until(() => again.lastPilot !== null && !!again.account, 4000, 'password login');
    expect(again.lastPilot).toMatchObject({ credits, cargo: { water: 6 } });
  });

  it('POST /logout revokes a login token (sign out on a shared computer)', async () => {
    const url = await boot();
    const a = join(url, 'Bibliothèque');
    await until(() => !!a.account);
    const res = await fetch(`http://127.0.0.1:${server!.port}/logout`, { method: 'POST', body: a.account!.token, headers: { 'Content-Type': 'text/plain' } });
    expect(res.status).toBe(204);
    const again = join(url, 'Bibliothèque', { kind: 'token', token: a.account!.token });
    await until(() => again.closed, 3000, 'revoked token refused');
    expect(again.messages('error')[0]).toMatchObject({ code: 'auth', reason: 'expired' });
    // Junk is ignored.
    expect((await fetch(`http://127.0.0.1:${server!.port}/logout`, { method: 'POST', body: 'x'.repeat(1000) }).catch(() => ({ status: 0 }))).status).not.toBe(500);
  });

  it('writes progress in batches, and at once when a pilot leaves', async () => {
    const store = new MemoryStore();
    const url = await boot({ accounts: accounts(store, { saveInterval: 60 }), reconnectGrace: 0 });
    const a = join(url, 'Prudent');
    const b = join(url, 'Pressé');
    await until(() => a.shipId !== null && b.shipId !== null);
    await sleep(200);
    const writes = store.writes;
    expect(server!.accounts.pendingCount).toBe(2); // both new pilots, waiting for the next batch
    b.close(); // leaving: written now, without waiting for the 60 s batch
    await until(() => store.writes > writes, 3000, 'write on leave');
    const rec = await store.byKey('pressé');
    expect(rec!.save).toMatchObject({ v: 1, credits: STARTING_CREDITS, station: 'aurora' });
  });
});
