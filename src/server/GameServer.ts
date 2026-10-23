import { Quaternion, Vector3 } from 'three';
import { addCargo, cargoTotal, ITEMS, ITEM_IDS, type Cargo, type ItemId } from '../shared/economy/items';
import { createMarket, quote, REPAIR_COST, repairCost, stepMarket, trade, TRADE_REFUSALS, type MarketState, type StationId } from '../shared/economy/market';
import { AIPilot } from '../shared/sim/ai';
import { oreOf, PLATINUM_CHANCE } from '../shared/sim/mining';
import { mulberry32 } from '../shared/rng';
import { SHIP_CLASSES } from '../shared/sim/shipClasses';
import type { EntityId, ShipClassId, SimEvent } from '../shared/sim/types';
import { TICK_DT, TICK_RATE, World } from '../shared/sim/world';
import { buildZone, DOCK_MAX_SPEED, UNDOCK_DISTANCE, UNDOCK_SPEED, type StationDef } from '../shared/sim/zone';
import type { ChatLine, ClientMessage, MarketView, PilotState, PlayerInfo, PlayerStats, ServerMessage } from '../shared/net/protocol';
import { PROTOCOL_VERSION, sanitizeChat, sanitizeInput, sanitizeName, snapshotShip } from '../shared/net/protocol';
import type { ShipInput } from '../shared/sim/types';
import { neutralInput } from '../shared/sim/types';

/** Anything able to deliver server messages to one client (in-process, WebSocket...). */
export interface ClientLink {
  send(msg: ServerMessage): void;
  /** Optional fast path: an already-serialised ServerMessage (shared snapshot JSON). */
  sendRaw?(json: string): void;
  /** Optional: drop the connection (WebSocket links). */
  close?(): void;
}

interface Session {
  id: string;
  token: string;
  name: string;
  link: ClientLink | null;
  shipId: EntityId | null;
  respawnAt: number;
  /** Highest input sequence received, and the one last applied (acknowledged). */
  lastSeq: number;
  ackSeq: number;
  inputs: { seq: number; input: ShipInput }[];
  /** Sim time of the last input received (a silent client lets go of the controls). */
  lastInputAt: number;
  stats: PlayerStats;
  pvp: boolean;
  pvpChangedAt: number;
  ping: number;
  /** Sim time the link dropped (session kept for reconnection until GRACE expires). */
  offlineSince: number;
  chatTimes: number[];
  lastChat: string;
  lastChatAt: number;
  cargo: Cargo;
  /** Docked at this station: the ship has left space and waits in `stored`. */
  docked: StationId | null;
  stored: { hull: number; shield: number; energy: number } | null;
  /** Credits, cargo or docking changed: send a `pilot` message at the end of the tick. */
  pilotDirty: boolean;
  holdFullNotified: boolean;
}

export interface GameServerOptions {
  seed?: number;
  /** Send a snapshot every N ticks (1 in-process, ~3 over a real network). */
  snapshotEvery?: number;
  /** Spawn NPC waves and wingmen. Disabled in some tests. */
  npcs?: boolean;
  /** Maximum simultaneous player sessions (online or awaiting reconnection). */
  maxPlayers?: number;
  /** Seconds a disconnected player's session (and stopped ship) survives for reconnection. */
  reconnectGrace?: number;
  /** Wall clock for chat timestamps (injectable for tests). */
  now?: () => number;
}

/** Chat flood control: at most CHAT_BURST messages per CHAT_WINDOW seconds. */
const CHAT_BURST = 5;
const CHAT_WINDOW = 10;
const CHAT_HISTORY = 30;
/** Inputs buffered beyond this are dropped (keeps input latency bounded). */
const MAX_QUEUED_INPUTS = 6;
const PVP_SWITCH_COOLDOWN = 5;
const INPUT_TIMEOUT = 1;
const PVP_COMBAT_LOCK = 15;
const PVP_KILL_BOUNTY = 0;
/** Credits of a new pilot. */
export const STARTING_CREDITS = 500;
export { REPAIR_COST };
/** Players fly the Falcon: its hold is theirs. */
const PLAYER_CLASS: ShipClassId = 'falcon';

function randomToken() {
  const b = new Uint8Array(18);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[x & 63]).join('');
}

const _v = new Vector3();
const _m = new Quaternion();

/**
 * Authoritative game server: owns the World, runs NPC AI, the wave director
 * and player respawns. It is transport-agnostic: today it runs inside the
 * browser behind LocalTransport; the same class will run in Node behind a
 * WebSocket transport for real multiplayer.
 */
export class GameServer {
  readonly world: World;
  private sessions = new Map<string, Session>();
  private shipOwner = new Map<EntityId, string>();
  private pilots = new Map<EntityId, AIPilot>();
  private rng;
  private accumulator = 0;
  private nextSession = 1;
  private snapshotEvery: number;
  private npcs: boolean;
  wave = 0;
  private waveTimer = 4;
  private wingmenTimers: number[] = [2, 2.5];
  readonly maxPlayers: number;
  private reconnectGrace: number;
  private now: () => number;
  private chatLog: ChatLine[] = [];
  private nextChatId = 1;
  private playersDirty = true;
  readonly markets: Record<StationId, MarketState> = { aurora: createMarket('aurora'), ferro: createMarket('ferro') };
  private marketClock = 0;
  /** Platinum finds (kept apart from the wave director's random stream). */
  private lootRng;

  constructor(opts: GameServerOptions = {}) {
    const seed = opts.seed ?? 1337;
    this.world = new World(buildZone(seed));
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    this.lootRng = mulberry32(seed ^ 0x51ed270b);
    this.snapshotEvery = opts.snapshotEvery ?? 1;
    this.npcs = opts.npcs ?? true;
    this.maxPlayers = opts.maxPlayers ?? 30;
    this.reconnectGrace = opts.reconnectGrace ?? 20;
    this.now = opts.now ?? Date.now;
  }

  get snapshotRate() {
    return TICK_RATE / this.snapshotEvery;
  }

  /** Players with a live connection. */
  get onlineCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.link) n++;
    return n;
  }

  get sessionCount() {
    return this.sessions.size;
  }

  /**
   * Opens (or, with a valid token, resumes) a player session. Returns the
   * session id, or null when the server is full (an error is sent first).
   */
  connect(link: ClientLink, name = 'Pilote', token?: string): string {
    if (token) {
      for (const s of this.sessions.values()) {
        if (s.token !== token) continue;
        if (s.link && s.link !== link) {
          s.link.send({ t: 'error', code: 'kicked', text: 'Session reprise depuis une autre fenêtre.' });
          s.link.close?.();
        }
        s.link = link;
        s.offlineSince = -1;
        s.inputs.length = 0;
        // The client may have restarted (page reload): its input sequence starts over.
        s.lastSeq = 0;
        s.ackSeq = 0;
        this.welcome(s, true);
        if (s.shipId === null && s.respawnAt <= 0 && !s.docked) this.spawnPlayer(s);
        this.system(`${s.name} est de retour dans le secteur`);
        this.playersDirty = true;
        return s.id;
      }
    }
    if (this.sessions.size >= this.maxPlayers) {
      link.send({ t: 'error', code: 'full', text: `Secteur complet (${this.maxPlayers} pilotes maximum).` });
      link.close?.();
      return '';
    }
    const id = `p${this.nextSession++}`;
    const session: Session = {
      id,
      token: randomToken(),
      name: this.uniqueName(sanitizeName(name) || 'Pilote'),
      link,
      shipId: null,
      respawnAt: 0,
      lastSeq: 0,
      ackSeq: 0,
      inputs: [],
      lastInputAt: 0,
      stats: { kills: 0, deaths: 0, credits: STARTING_CREDITS },
      pvp: false,
      pvpChangedAt: -999,
      ping: 0,
      offlineSince: -1,
      chatTimes: [],
      lastChat: '',
      lastChatAt: -999,
      cargo: {},
      docked: null,
      stored: null,
      pilotDirty: true,
      holdFullNotified: false,
    };
    this.sessions.set(id, session);
    this.welcome(session, false);
    this.spawnPlayer(session);
    if (this.sessions.size > 1) this.system(`${session.name} a rejoint le secteur`);
    this.playersDirty = true;
    return id;
  }

  private welcome(s: Session, resumed: boolean) {
    s.link?.send({
      t: 'welcome',
      playerId: s.id,
      token: s.token,
      name: s.name,
      zoneSeed: this.world.zone.seed,
      tickRate: TICK_RATE,
      snapshotRate: this.snapshotRate,
      resumed,
    });
    if (this.chatLog.length) s.link?.send({ t: 'chatHistory', lines: this.chatLog.slice() });
    s.pilotDirty = true;
    this.sendMarket(s);
  }

  private uniqueName(base: string) {
    const taken = new Set([...this.sessions.values()].map((s) => s.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) {
      const n = `${base.slice(0, 13)} ${i}`;
      if (!taken.has(n.toLowerCase())) return n;
    }
  }

  /**
   * The connection dropped: the ship cuts its engines and the session waits
   * `reconnectGrace` seconds for the same token before being removed.
   */
  detach(id: string, link?: ClientLink) {
    const s = this.sessions.get(id);
    // A resumed session already has a new link: the old socket closing must not detach it.
    if (!s || !s.link || (link && s.link !== link)) return;
    s.link = null;
    s.offlineSince = this.world.time;
    s.inputs.length = 0;
    if (s.shipId !== null) this.world.setInput(s.shipId, neutralInput());
    this.playersDirty = true;
  }

  /** Removes a session and its ship immediately. */
  disconnect(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.shipId !== null) {
      this.world.removeShip(s.shipId);
      this.shipOwner.delete(s.shipId);
    }
    this.sessions.delete(id);
    this.playersDirty = true;
    if (this.sessions.size > 0) this.system(`${s.name} a quitté le secteur`);
    else this.resetSector();
  }

  /** Last pilot left: clear the pirates so the next visitor starts at wave 1. */
  private resetSector() {
    for (const ship of [...this.world.ships.values()]) {
      if (ship.faction !== 'raiders') continue;
      this.world.removeShip(ship.id);
      this.pilots.delete(ship.id);
    }
    this.wave = 0;
    this.waveTimer = 4;
  }

  receive(sessionId: string, msg: ClientMessage) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.link) return;
    switch (msg.t) {
      case 'input': {
        if (msg.seq <= s.lastSeq) return; // stale or duplicated packet
        const input = sanitizeInput(msg.input);
        if (!input) return;
        s.lastSeq = msg.seq;
        s.lastInputAt = this.world.time;
        s.inputs.push({ seq: msg.seq, input });
        // A client far ahead of the server clock (or flooding): keep only the newest inputs.
        if (s.inputs.length > MAX_QUEUED_INPUTS) s.inputs.splice(0, s.inputs.length - MAX_QUEUED_INPUTS);
        break;
      }
      case 'hello':
        if (msg.version !== PROTOCOL_VERSION) {
          s.link.send({ t: 'notice', text: 'Version du client incompatible', tone: 'warn' });
        }
        break;
      case 'chat':
        this.chat(s, msg.text);
        break;
      case 'pvp':
        this.setPvp(s, msg.on);
        break;
      case 'ping':
        if (msg.rtt !== undefined) s.ping = Math.round(msg.rtt);
        s.link.send({ t: 'pong', c: msg.c });
        break;
      case 'dock':
        this.dock(s);
        break;
      case 'undock':
        this.undock(s);
        break;
      case 'trade':
        this.trade(s, msg.item, msg.qty);
        break;
      case 'repair':
        this.repair(s);
        break;
    }
  }

  private notice(s: Session, text: string, tone: 'info' | 'warn' | 'good' = 'info') {
    s.link?.send({ t: 'notice', text, tone });
  }

  private station(id: StationId): StationDef {
    return this.world.zone.stations.find((st) => st.id === id) ?? this.world.zone.station;
  }

  /** A ship slow enough at a hangar mouth leaves space and waits at the station. */
  private dock(s: Session) {
    const w = this.world;
    const ship = s.shipId !== null ? w.ships.get(s.shipId) : undefined;
    if (s.docked || !ship || !ship.alive) return;
    const st = w.zone.stations.find((x) => ship.position.distanceTo(x.dock.mouth) <= x.dock.radius);
    if (!st) return this.notice(s, "Amarrage : approchez-vous de l'entrée d'un hangar.", 'warn');
    if (ship.velocity.length() > DOCK_MAX_SPEED) return this.notice(s, `Amarrage : ralentissez sous ${DOCK_MAX_SPEED} m/s.`, 'warn');
    if (w.time - ship.lastPvpCombat < PVP_COMBAT_LOCK) return this.notice(s, 'Amarrage refusé : combat PvP en cours.', 'warn');
    // The station recharges shield and capacitor; the hull needs a paid repair.
    const cls = SHIP_CLASSES[ship.classId];
    s.stored = { hull: ship.hull, shield: cls.shield, energy: cls.energy };
    w.removeShip(ship.id);
    this.shipOwner.delete(ship.id);
    s.shipId = null;
    s.inputs.length = 0;
    s.docked = st.id;
    s.pilotDirty = true;
    this.playersDirty = true;
    this.notice(s, `Amarré à ${st.name}`, 'good');
    this.sendMarket(s);
  }

  private undock(s: Session) {
    if (!s.docked) return;
    const st = this.station(s.docked);
    const look = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), st.dock.out);
    const ship = this.spawnPlayer(s, st.dock.mouth.clone().addScaledVector(st.dock.out, UNDOCK_DISTANCE), look, st.dock.out.clone().multiplyScalar(UNDOCK_SPEED));
    if (s.stored) {
      ship.hull = s.stored.hull;
      ship.shield = s.stored.shield;
      ship.energy = s.stored.energy;
    }
    s.docked = null;
    s.stored = null;
    s.pilotDirty = true;
  }

  private repair(s: Session) {
    if (!s.docked || !s.stored) return;
    const max = SHIP_CLASSES[PLAYER_CLASS].hull;
    const missing = max - s.stored.hull;
    if (missing < 0.5) return this.notice(s, 'La coque est intacte.');
    const fix = Math.min(missing, s.stats.credits / REPAIR_COST);
    if (fix < 0.5) return this.notice(s, TRADE_REFUSALS.funds, 'warn');
    const cost = repairCost(fix);
    s.stats.credits -= cost;
    s.stored.hull = fix >= missing ? max : s.stored.hull + fix;
    s.pilotDirty = true;
    this.notice(s, `Coque réparée${fix < missing ? ' en partie' : ''}  −${cost} cr`, 'good');
  }

  private trade(s: Session, item: ItemId, qty: number) {
    if (!s.docked) return;
    const r = trade(this.markets[s.docked], item, qty, s.stats, s.cargo, SHIP_CLASSES[PLAYER_CLASS].cargo);
    if (!r.ok) return this.notice(s, TRADE_REFUSALS[r.reason], 'warn');
    if (r.qty < 0) s.holdFullNotified = false;
    const label = ITEMS[item].label;
    this.notice(s, r.qty > 0 ? `Achat : ${r.qty} × ${label}  −${-r.credits} cr` : `Vente : ${-r.qty} × ${label}  +${r.credits} cr`, 'good');
    s.pilotDirty = true;
    this.playersDirty = true;
    // Everyone docked there sees the new prices.
    for (const o of this.sessions.values()) if (o.docked === s.docked) this.sendMarket(o);
  }

  private sendMarket(s: Session) {
    if (!s.docked || !s.link) return;
    const m = this.markets[s.docked];
    const market: MarketView = {
      station: s.docked,
      items: ITEM_IDS.map((id) => ({ id, ...quote(id, m[id]), stock: Math.floor(m[id].stock) })),
    };
    s.link.send({ t: 'market', market });
  }

  pilotState(s: Session): PilotState {
    return {
      credits: s.stats.credits,
      cargo: { ...s.cargo },
      capacity: SHIP_CLASSES[PLAYER_CLASS].cargo,
      docked: s.docked,
      hull: s.stored ? Math.round(s.stored.hull * 10) / 10 : null,
      hullMax: SHIP_CLASSES[PLAYER_CLASS].hull,
    };
  }

  /** Whole units of ore under the beams go into the miners' holds. */
  private collectOre() {
    const w = this.world;
    for (const s of this.sessions.values()) {
      const ship = s.shipId !== null ? w.ships.get(s.shipId) : undefined;
      if (!ship || ship.mining === null || ship.mineProgress < 1) continue;
      const ore = oreOf(w.zone.asteroids[ship.mining].variant);
      const units = Math.floor(ship.mineProgress);
      const cap = SHIP_CLASSES[PLAYER_CLASS].cargo;
      let added = 0;
      for (; added < units; added++) {
        const item: ItemId = ore === 'ironNickel' && this.lootRng() < PLATINUM_CHANCE ? 'platinum' : ore;
        if (!addCargo(s.cargo, item, 1, cap)) break;
        if (item === 'platinum') this.notice(s, 'Pépite de platine !', 'good');
      }
      ship.mineProgress -= added;
      if (added) s.pilotDirty = true;
      if (added < units) {
        ship.mineProgress = Math.min(ship.mineProgress, 1);
        if (!s.holdFullNotified) this.notice(s, 'Soute pleine : allez vendre votre minerai à une station.', 'warn');
        s.holdFullNotified = true;
      }
    }
  }

  private chat(s: Session, raw: string) {
    const text = sanitizeChat(raw);
    if (!text || !s.link) return;
    const t = this.world.time;
    s.chatTimes = s.chatTimes.filter((x) => t - x < CHAT_WINDOW);
    if (s.chatTimes.length >= CHAT_BURST) {
      s.link.send({ t: 'notice', text: 'Chat : trop de messages, patientez quelques secondes.', tone: 'warn' });
      return;
    }
    if (text.toLowerCase() === s.lastChat && t - s.lastChatAt < 30) {
      s.link.send({ t: 'notice', text: 'Chat : message identique ignoré.', tone: 'warn' });
      return;
    }
    s.chatTimes.push(t);
    s.lastChat = text.toLowerCase();
    s.lastChatAt = t;
    this.postChat(s.name, text);
  }

  /** System line in the chat (joins, leaves). */
  private system(text: string) {
    this.postChat(null, text);
  }

  private postChat(from: string | null, text: string) {
    const line: ChatLine = { id: this.nextChatId++, from, text, time: this.now() };
    this.chatLog.push(line);
    if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();
    this.broadcast({ t: 'chat', line });
  }

  private setPvp(s: Session, on: boolean) {
    if (s.pvp === on || !s.link) return;
    const t = this.world.time;
    const ship = s.shipId !== null ? this.world.ships.get(s.shipId) : undefined;
    if (t - s.pvpChangedAt < PVP_SWITCH_COOLDOWN) {
      s.link.send({ t: 'notice', text: 'PvP : changement trop rapide, réessayez dans quelques secondes.', tone: 'warn' });
      return;
    }
    if (!on && ship && t - ship.lastPvpCombat < PVP_COMBAT_LOCK) {
      s.link.send({ t: 'notice', text: 'PvP : impossible de le désactiver en plein combat.', tone: 'warn' });
      return;
    }
    s.pvp = on;
    s.pvpChangedAt = t;
    if (ship) ship.pvp = on;
    s.link.send({
      t: 'notice',
      text: on ? 'PvP activé : les autres pilotes en PvP peuvent vous attaquer.' : 'PvP désactivé.',
      tone: on ? 'warn' : 'info',
    });
    this.playersDirty = true;
  }

  playerList(): PlayerInfo[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      name: s.name,
      ship: s.shipId,
      pvp: s.pvp,
      kills: s.stats.kills,
      deaths: s.stats.deaths,
      ping: s.ping,
      online: s.link !== null,
    }));
  }

  /** Advance real time; runs as many fixed ticks as needed. */
  update(dt: number) {
    this.accumulator += Math.min(dt, 0.25);
    while (this.accumulator >= TICK_DT) {
      this.accumulator -= TICK_DT;
      this.tick();
    }
  }

  tick() {
    const w = this.world;
    // One buffered input per player per tick, so client prediction replays the same steps.
    for (const s of this.sessions.values()) {
      const next = s.inputs.shift();
      if (!next) {
        // No input for a second (frozen or backgrounded client): cut the engines and the guns.
        if (s.shipId !== null && w.time - s.lastInputAt > INPUT_TIMEOUT && w.time - s.lastInputAt < INPUT_TIMEOUT + TICK_DT * 1.5) {
          const ship = w.ships.get(s.shipId);
          if (ship) w.setInput(s.shipId, { ...neutralInput(), flightAssist: ship.input.flightAssist });
        }
        continue;
      }
      s.ackSeq = next.seq;
      if (s.shipId !== null) w.setInput(s.shipId, next.input);
    }
    for (const pilot of this.pilots.values()) {
      const input = pilot.update(w, TICK_DT);
      w.setInput(pilot.shipId, input);
    }
    w.step(TICK_DT);
    const events = w.drainEvents();
    this.handleEvents(events);
    this.collectOre();
    this.marketClock += TICK_DT;
    if (this.marketClock >= 1) {
      this.marketClock -= 1;
      for (const m of Object.values(this.markets)) stepMarket(m, 1);
      for (const s of this.sessions.values()) this.sendMarket(s);
    }
    if (this.npcs && this.sessions.size > 0) this.directWaves(TICK_DT);

    for (const s of [...this.sessions.values()]) {
      if (!s.link) {
        if (w.time - s.offlineSince >= this.reconnectGrace) this.disconnect(s.id);
        continue;
      }
      if (s.shipId === null && s.respawnAt > 0 && w.time >= s.respawnAt) this.spawnPlayer(s);
      if (s.pilotDirty) {
        s.pilotDirty = false;
        s.link.send({ t: 'pilot', pilot: this.pilotState(s) });
      }
    }

    if (events.length) this.broadcast({ t: 'events', tick: w.tick, events });
    if (w.tick % this.snapshotEvery === 0) this.sendSnapshots();
    if (this.playersDirty || w.tick % TICK_RATE === 0) {
      this.playersDirty = false;
      this.broadcast({ t: 'players', list: this.playerList(), max: this.maxPlayers });
    }
  }

  private sendSnapshots() {
    const w = this.world;
    const snap = { tick: w.tick, time: w.time, ships: [...w.ships.values()].map(snapshotShip) };
    // The world part is identical for everyone: serialise it once for network links.
    let snapJson: string | null = null;
    for (const s of this.sessions.values()) {
      if (!s.link) continue;
      const personal = {
        ackSeq: s.ackSeq,
        you: s.shipId,
        stats: s.stats,
        wave: this.wave,
        respawnIn: s.shipId === null ? Math.max(0, s.respawnAt - w.time) : 0,
      };
      if (s.link.sendRaw) {
        snapJson ??= JSON.stringify(snap);
        s.link.sendRaw(`{"t":"snapshot","snap":${snapJson},${JSON.stringify(personal).slice(1)}`);
      } else {
        s.link.send({ t: 'snapshot', snap, ...personal });
      }
    }
  }

  private broadcast(msg: ServerMessage) {
    for (const s of this.sessions.values()) s.link?.send(msg);
  }

  private handleEvents(events: SimEvent[]) {
    for (const e of events) {
      if (e.type !== 'destroyed') continue;
      this.pilots.delete(e.ship);
      const ownerSession = this.shipOwner.get(e.ship);
      if (ownerSession) {
        this.shipOwner.delete(e.ship);
        const s = this.sessions.get(ownerSession);
        if (s) {
          s.shipId = null;
          s.stats.deaths++;
          s.respawnAt = this.world.time + 5;
          this.playersDirty = true;
          if (cargoTotal(s.cargo) > 0) {
            s.cargo = {};
            s.holdFullNotified = false;
            s.pilotDirty = true;
            this.notice(s, 'Cargaison perdue avec le vaisseau.', 'warn');
          }
        }
      }
      if (e.faction === 'union' && !ownerSession) {
        this.wingmenTimers.push(20);
      }
      if (e.by !== null) {
        const killer = this.shipOwner.get(e.by);
        const ks = killer ? this.sessions.get(killer) : undefined;
        if (ks && ks.id !== ownerSession) {
          ks.stats.kills++;
          // Player kills (PvP) pay nothing: two friends cannot farm credits off each other.
          const bounty = ownerSession ? PVP_KILL_BOUNTY : SHIP_CLASSES[e.classId].bounty;
          ks.stats.credits += bounty;
          if (bounty) ks.pilotDirty = true;
          ks.link?.send({ t: 'notice', text: bounty ? `${e.name} détruit  +${bounty} cr` : `${e.name} abattu en PvP`, tone: 'good' });
          if (ownerSession) this.system(`${ks.name} a abattu ${e.name}`);
          this.playersDirty = true;
        }
      }
    }
  }

  /** Puts the player's ship in space: near the spawn point, or where given (undocking). */
  private spawnPlayer(s: Session, position?: Vector3, rotation?: Quaternion, velocity?: Vector3) {
    const z = this.world.zone;
    const offset = _v.set((this.rng() - 0.5) * 120, (this.rng() - 0.5) * 40, (this.rng() - 0.5) * 60);
    const ship = this.world.spawnShip({
      classId: PLAYER_CLASS,
      faction: 'union',
      name: s.name,
      ownerId: s.id,
      position: position ?? z.playerSpawn.clone().add(offset),
      rotation,
      velocity,
    });
    ship.pvp = s.pvp;
    s.shipId = ship.id;
    this.playersDirty = true;
    s.respawnAt = 0;
    this.shipOwner.set(ship.id, s.id);
    return ship;
  }

  private spawnNpc(classId: ShipClassId, faction: 'union' | 'raiders', name: string, pos: Vector3, skill: number, home: Vector3, anchor = home) {
    // Face the station on arrival.
    const look = _v.copy(home).sub(pos).normalize();
    _m.setFromUnitVectors(new Vector3(0, 0, -1), look);
    const ship = this.world.spawnShip({ classId, faction, name, position: pos, rotation: _m });
    this.pilots.set(ship.id, new AIPilot(ship.id, mulberry32(Math.floor(this.rng() * 2 ** 31)), skill, home.clone(), anchor.clone()));
    return ship;
  }

  /** A point ~3 km from the station, away from the asteroid belt, with no obstacle nearby. */
  private findOpenSpawn(): Vector3 {
    const w = this.world;
    const station = w.zone.station.position;
    const beltDir = w.zone.beltCenter.clone().sub(station).normalize();
    const p = new Vector3();
    for (let attempt = 0; attempt < 40; attempt++) {
      const dir = new Vector3(this.rng() - 0.5, (this.rng() - 0.5) * 0.5, this.rng() - 0.5).normalize();
      if (dir.dot(beltDir) > 0.2) continue;
      p.copy(station).addScaledVector(dir, 2800 + this.rng() * 600);
      if (w.grid.query(p, 600).every((c) => c.center.distanceTo(p) > c.radius + 600)) return p;
    }
    return p.copy(station).add(new Vector3(-3000, 400, 0));
  }

  private directWaves(dt: number) {
    const w = this.world;
    // Allied wingmen defending the station.
    for (let i = this.wingmenTimers.length - 1; i >= 0; i--) {
      this.wingmenTimers[i] -= dt;
      if (this.wingmenTimers[i] <= 0) {
        this.wingmenTimers.splice(i, 1);
        const pos = w.zone.playerSpawn.clone().add(new Vector3((this.rng() - 0.5) * 400, 80 + this.rng() * 80, 150));
        const n = Math.floor(this.rng() * 90 + 10);
        this.spawnNpc('warden', 'union', `Garde ${n}`, pos, 0.7, w.zone.playerSpawn.clone(), w.zone.station.position);
      }
    }

    let hostiles = 0;
    for (const s of w.ships.values()) if (s.faction === 'raiders') hostiles++;
    if (hostiles > 0) return;
    this.waveTimer -= dt;
    if (this.waveTimer > 0) return;

    this.wave++;
    this.waveTimer = 8;
    // More pilots online, bigger waves (capped to keep the server and clients light).
    const extra = Math.min(Math.max(0, this.onlineCount - 1), 6);
    const raiders = Math.min(2 + this.wave + extra, 12);
    const marauders = Math.min(Math.floor(this.wave / 2) + Math.floor(extra / 3), 4);
    // Pirates jump in from open space ~3 km out and converge on the station.
    const station = w.zone.station.position;
    const center = this.findOpenSpawn();
    const home = station.clone().lerp(w.zone.playerSpawn, 0.6);
    for (let i = 0; i < raiders + marauders; i++) {
      const pos = center.clone().add(new Vector3((this.rng() - 0.5) * 500, (this.rng() - 0.5) * 200, (this.rng() - 0.5) * 500));
      const cls: ShipClassId = i < raiders ? 'raider' : 'marauder';
      const label = cls === 'raider' ? 'Raider' : 'Marauder';
      this.spawnNpc(cls, 'raiders', `${label}-${String(this.wave).padStart(2, '0')}${String.fromCharCode(65 + i)}`, pos, Math.min(0.45 + this.wave * 0.06, 0.9), home, station);
    }
    this.broadcast({
      t: 'notice',
      text: `VAGUE ${this.wave} — ${raiders + marauders} pirates en approche`,
      tone: 'warn',
    });
  }
}
