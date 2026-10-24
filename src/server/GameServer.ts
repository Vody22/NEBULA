import { Quaternion, Vector3 } from 'three';
import { addCargo, cargoTotal, ITEMS, ITEM_IDS, removeCargo, type Cargo, type ItemId } from '../shared/economy/items';
import { createMarket, quote, REPAIR_COST, repairCost, stepMarket, trade, TRADE_REFUSALS, type MarketState, type StationId } from '../shared/economy/market';
import { BOARD_RENEW, BOARD_SIZE, boardKinds, crates, MAX_ACTIVE, makeOffer, missionTitle, OFFER_REFILL, type Mission } from '../shared/missions';
import { restoreSector, SAVE_VERSION, sectorSave, validateSave, type PilotSave, type SectorSave } from '../shared/save';
import { effectiveStats, noMods, offerOf, SHIPYARD_STATION, UPGRADES, upgradeCost, type ShipStats, type UpgradeSlot } from '../shared/sim/upgrades';
import { AIPilot } from '../shared/sim/ai';
import { oreOf } from '../shared/sim/mining';
import { mulberry32 } from '../shared/rng';
import { SHIP_CLASSES } from '../shared/sim/shipClasses';
import type { EntityId, ShipClassId, SimEvent } from '../shared/sim/types';
import { TICK_DT, TICK_RATE, World } from '../shared/sim/world';
import { buildSector, DOCK_MAX_SPEED, UNDOCK_DISTANCE, UNDOCK_SPEED, type StationDef } from '../shared/sim/zone';
import { isSectorId, JUMP_CHARGE, JUMP_CLEARANCE, JUMP_COOLDOWN, JUMP_ENERGY, SECTOR_HUB, SECTOR_NAMES, STATION_SECTOR, type SectorId } from '../shared/sectors';
import type { ChatLine, ClientMessage, JumpView, MarketView, PilotState, PlayerInfo, PlayerStats, ServerMessage } from '../shared/net/protocol';
import { PROTOCOL_VERSION, sanitizeChat, sanitizeInput, sanitizeName, snapshotShip } from '../shared/net/protocol';
import type { ShipInput } from '../shared/sim/types';
import { intactParts, neutralInput } from '../shared/sim/types';
import { allIntact, componentRepairCost } from '../shared/physics/damage';
import type { ComponentId } from '../shared/physics/hitboxes';

/** Anything able to deliver server messages to one client (in-process, WebSocket...). */
export interface ClientLink {
  send(msg: ServerMessage): void;
  /** Optional fast path: an already-serialised ServerMessage (shared snapshot JSON). */
  sendRaw?(json: string): void;
  /** Optional: drop the connection (WebSocket links). */
  close?(): void;
}

/** Who is connecting: an account (online) or a guest (tests, older tools). */
export interface PilotProfile {
  /** Stable account id. A second connection of the same account takes its session over. Null: a guest. */
  accountId: string | null;
  name: string;
  /**
   * Progress to resume (raw: a database row, localStorage; validated here): the
   * pilot starts docked at its station. Absent: a new pilot, in space next to the hub.
   */
  save?: unknown;
}

interface Session {
  id: string;
  token: string;
  /** The account behind this session (null for guests): its progress is reported through `onSave`. */
  accountId: string | null;
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
  stored: { hull: number; shield: number; energy: number; parts: Record<ComponentId, number> } | null;
  /** Credits, cargo or docking changed: send a `pilot` message at the end of the tick. */
  pilotDirty: boolean;
  holdFullNotified: boolean;
  /** Last station docked at: where the pilot comes back next session. */
  home: StationId;
  /** Something worth saving changed (credits, cargo, docking, score). */
  saveDirty: boolean;
  /** The ship flown, and every ship owned with its upgrades (the flown ship's hull lives in `stored` or in space). */
  ship: ShipClassId;
  fleet: PilotSave['fleet'];
  /** Contracts in progress (v0.6). */
  missions: Mission[];
  /** The sector the pilot is in (v0.7): its ship, if any, lives in this sector's world. */
  sector: Sector;
  /** Hyperspace drive charging toward `to`, jumping at sim time `at`. */
  jump: { to: SectorId; at: number } | null;
  /** Sim time from which the drive may charge again. */
  jumpReadyAt: number;
}

/**
 * One region of space (v0.7): its World, who flies which ship there, its NPC
 * pilots and its raid director. Every sector's world steps on every tick, so
 * their clocks stay equal; entity ids are only unique within a sector.
 */
interface Sector {
  id: SectorId;
  world: World;
  shipOwner: Map<EntityId, string>;
  pilots: Map<EntityId, AIPilot>;
  /** Spawns and raids (Aurora's is the stream the server used before sectors existed). */
  rng: () => number;
  /** Raids launched since the sector was last empty (sent to clients as `wave`). */
  wave: number;
  waveTimer: number;
  wingmenTimers: number[];
}

/** A station's contract board: empty slots are refilled after OFFER_REFILL seconds. */
interface Board {
  offers: (Mission | null)[];
  refillAt: number[];
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
  /**
   * Progress of an account pilot changed (at most once per tick), or its session ended (`final`).
   * The caller stores it (database online, localStorage in solo).
   */
  onSave?: (accountId: string, save: PilotSave, final: boolean) => void;
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
/** Quiet time after a raid is beaten, in seconds: the sector is not an endless arena. */
export const RAID_CALM_MIN = 45;
export const RAID_CALM_MAX = 90;
const PVP_KILL_BOUNTY = 0;
/** Credits of a new pilot. */
export const STARTING_CREDITS = 500;
export { REPAIR_COST };
/** Every new pilot's ship. */
const STARTER_SHIP: ShipClassId = 'falcon';

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
  /** Every sector by id (v0.7). */
  readonly sectors: Record<SectorId, Sector>;
  private sessions = new Map<string, Session>();
  private accumulator = 0;
  private nextSession = 1;
  private snapshotEvery: number;
  private npcs: boolean;
  readonly maxPlayers: number;
  private reconnectGrace: number;
  private now: () => number;
  private chatLog: ChatLine[] = [];
  private nextChatId = 1;
  private playersDirty = true;
  readonly markets: Record<StationId, MarketState> = {
    aurora: createMarket('aurora'),
    ferro: createMarket('ferro'),
    kepler: createMarket('kepler'),
    vesta: createMarket('vesta'),
  };
  private marketClock = 0;
  readonly boards: Record<StationId, Board>;
  private boardRenewAt = BOARD_RENEW;
  private nextMission = 1;
  /** Contract offers (their own random stream, like loot). */
  private missionRng;
  /** Platinum finds (kept apart from the wave director's random stream). */
  private lootRng;
  private onSave: GameServerOptions['onSave'];

  constructor(opts: GameServerOptions = {}) {
    const seed = opts.seed ?? 1337;
    const sector = (id: SectorId): Sector => {
      const world = new World(buildSector(id, seed));
      return {
        id,
        world,
        shipOwner: new Map(),
        pilots: new Map(),
        rng: mulberry32(world.zone.seed ^ 0x9e3779b9),
        wave: 0,
        waveTimer: 4,
        wingmenTimers: [2, 2.5],
      };
    };
    this.sectors = { aurora: sector('aurora'), kepler: sector('kepler') };
    this.lootRng = mulberry32(seed ^ 0x51ed270b);
    this.missionRng = mulberry32(seed ^ 0x2545f491);
    this.boards = { aurora: this.newBoard('aurora'), ferro: this.newBoard('ferro'), kepler: this.newBoard('kepler'), vesta: this.newBoard('vesta') };
    this.snapshotEvery = opts.snapshotEvery ?? 1;
    this.npcs = opts.npcs ?? true;
    this.maxPlayers = opts.maxPlayers ?? 30;
    this.reconnectGrace = opts.reconnectGrace ?? 20;
    this.now = opts.now ?? Date.now;
    this.onSave = opts.onSave;
  }

  get snapshotRate() {
    return TICK_RATE / this.snapshotEvery;
  }

  /** The Aurora sector's world: where new pilots start (tools and tests that predate sectors read it). */
  get world(): World {
    return this.sectors.aurora.world;
  }

  /** Raids launched in the Aurora sector since it was last empty. */
  get wave() {
    return this.sectors.aurora.wave;
  }

  /** Server sim time (every sector's world steps together). */
  get time() {
    return this.sectors.aurora.world.time;
  }

  /** The sector a session is in, its ship there (null when docked or destroyed) and its station (tests, tools). */
  whereIs(sessionId: string): { sector: SectorId; shipId: EntityId | null; docked: StationId | null } | null {
    const s = this.sessions.get(sessionId);
    return s ? { sector: s.sector.id, shipId: s.shipId, docked: s.docked } : null;
  }

  /** Who is where, for the server's status page. */
  sectorStatus() {
    return Object.values(this.sectors).map((sector) => ({ id: sector.id, name: sector.world.zone.name, online: this.onlineIn(sector), wave: sector.wave }));
  }

  private sessionsIn(sector: Sector) {
    let n = 0;
    for (const s of this.sessions.values()) if (s.sector === sector) n++;
    return n;
  }

  /** Pilots with a live connection in a sector (raids grow with them). */
  private onlineIn(sector: Sector) {
    let n = 0;
    for (const s of this.sessions.values()) if (s.link && s.sector === sector) n++;
    return n;
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
   * Opens a player session, or resumes one: the same account (online), or the
   * same session token (a guest reconnecting). Returns the session id, or ''
   * when the server is full (an error is sent first).
   */
  connect(link: ClientLink, who: PilotProfile | string = 'Pilote', token?: string): string {
    const profile: PilotProfile = typeof who === 'string' ? { accountId: null, name: who } : who;
    for (const s of this.sessions.values()) {
      const same = profile.accountId !== null ? s.accountId === profile.accountId : token !== undefined && s.accountId === null && s.token === token;
      if (!same) continue;
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
    if (this.sessions.size >= this.maxPlayers) {
      link.send({ t: 'error', code: 'full', text: `Secteur complet (${this.maxPlayers} pilotes maximum).` });
      link.close?.();
      return '';
    }
    const id = `p${this.nextSession++}`;
    const save = profile.save != null ? validateSave(profile.save) : null;
    const fleet: PilotSave['fleet'] = save ? save.fleet : { [STARTER_SHIP]: { mods: noMods(), hull: effectiveStats(STARTER_SHIP, noMods()).hull } };
    const shipClass = save ? save.ship : STARTER_SHIP;
    const cls = effectiveStats(shipClass, fleet[shipClass]!.mods);
    const session: Session = {
      id,
      token: randomToken(),
      accountId: profile.accountId,
      name: this.uniqueName(sanitizeName(profile.name) || 'Pilote'),
      link,
      shipId: null,
      respawnAt: 0,
      lastSeq: 0,
      ackSeq: 0,
      inputs: [],
      lastInputAt: 0,
      stats: { kills: save?.kills ?? 0, deaths: save?.deaths ?? 0, credits: save ? save.credits : STARTING_CREDITS },
      pvp: false,
      pvpChangedAt: -999,
      ping: 0,
      offlineSince: -1,
      chatTimes: [],
      lastChat: '',
      lastChatAt: -999,
      cargo: save ? { ...save.cargo } : {},
      sector: this.sectors[save ? STATION_SECTOR[save.station] : 'aurora'],
      jump: null,
      jumpReadyAt: 0,
      // A returning pilot is back at its station, ship in the hangar; a new one starts in space.
      docked: save ? save.station : null,
      stored: save ? { hull: Math.min(cls.hull, fleet[shipClass]!.hull), shield: cls.shield, energy: cls.energy, parts: { ...(fleet[shipClass]!.parts ?? intactParts()) } } : null,
      pilotDirty: true,
      holdFullNotified: false,
      home: save?.station ?? 'aurora',
      saveDirty: profile.accountId !== null && !save,
      ship: shipClass,
      fleet,
      missions: save ? save.missions.map((m) => ({ ...m, id: this.nextMission++ })) : [],
    };
    this.sessions.set(id, session);
    this.welcome(session, false);
    if (session.docked) this.notice(session, `Progression chargée : amarré à ${this.station(session.docked).name}`, 'good');
    else this.spawnPlayer(session);
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
      sector: s.sector.id,
      zoneSeed: s.sector.world.zone.seed,
      tickRate: TICK_RATE,
      snapshotRate: this.snapshotRate,
      resumed,
    });
    if (this.chatLog.length) s.link?.send({ t: 'chatHistory', lines: this.chatLog.slice() });
    s.pilotDirty = true;
    this.sendMarket(s);
    this.sendBoard(s);
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
    s.offlineSince = this.time;
    s.inputs.length = 0;
    s.jump = null;
    if (s.shipId !== null) s.sector.world.setInput(s.shipId, neutralInput());
    this.playersDirty = true;
  }

  /** Removes a session and its ship immediately (an account pilot's progress is saved first, unless `save` is false). */
  disconnect(id: string, save = true) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (save && s.accountId !== null) this.onSave?.(s.accountId, this.pilotSave(s), true);
    if (s.shipId !== null) {
      s.sector.world.removeShip(s.shipId);
      s.sector.shipOwner.delete(s.shipId);
    }
    this.sessions.delete(id);
    this.playersDirty = true;
    if (this.sessions.size > 0) this.system(`${s.name} a quitté le secteur`);
    if (!this.sessionsIn(s.sector)) this.resetSector(s.sector);
  }

  /** Ends an account's session without saving it: the account is now played elsewhere. */
  dropAccount(accountId: string, text: string) {
    for (const s of this.sessions.values()) {
      if (s.accountId !== accountId) continue;
      s.link?.send({ t: 'error', code: 'kicked', text });
      s.link?.close?.();
      this.disconnect(s.id, false);
    }
  }

  /** Last pilot left the sector: clear the pirates so the next visitor meets a small raid first. */
  private resetSector(sector: Sector) {
    for (const ship of [...sector.world.ships.values()]) {
      if (ship.faction !== 'raiders') continue;
      sector.world.removeShip(ship.id);
      sector.pilots.delete(ship.id);
    }
    sector.wave = 0;
    sector.waveTimer = 4;
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
        s.lastInputAt = this.time;
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
      case 'buyShip':
        this.buyShip(s, msg.ship);
        break;
      case 'useShip':
        this.useShip(s, msg.ship);
        break;
      case 'upgrade':
        this.upgrade(s, msg.slot);
        break;
      case 'mission':
        if (msg.op === 'accept') this.acceptMission(s, msg.id);
        else this.abandonMission(s, msg.id);
        break;
      case 'jump':
        if (msg.to === null) this.cancelJump(s, 'Saut annulé.');
        else this.startJump(s, msg.to);
        break;
    }
  }

  private notice(s: Session, text: string, tone: 'info' | 'warn' | 'good' = 'info') {
    s.link?.send({ t: 'notice', text, tone });
  }

  private station(id: StationId): StationDef {
    const zone = this.sectors[STATION_SECTOR[id]].world.zone;
    return zone.stations.find((st) => st.id === id) ?? zone.station;
  }

  /** The pilot's ship in space, if any. */
  private shipOf(s: Session) {
    return s.shipId !== null ? s.sector.world.ships.get(s.shipId) : undefined;
  }

  /** A ship slow enough at a hangar mouth leaves space and waits at the station. */
  private dock(s: Session) {
    const w = s.sector.world;
    const ship = this.shipOf(s);
    if (s.docked || !ship || !ship.alive) return;
    const st = w.zone.stations.find((x) => ship.position.distanceTo(x.dock.mouth) <= x.dock.radius);
    if (!st) return this.notice(s, "Amarrage : approchez-vous de l'entrée d'un hangar.", 'warn');
    if (ship.velocity.length() > DOCK_MAX_SPEED) return this.notice(s, `Amarrage : ralentissez sous ${DOCK_MAX_SPEED} m/s.`, 'warn');
    if (w.time - ship.lastPvpCombat < PVP_COMBAT_LOCK) return this.notice(s, 'Amarrage refusé : combat PvP en cours.', 'warn');
    // The station recharges shield and capacitor; the hull needs a paid repair.
    const cls = this.shipStats(s);
    s.stored = { hull: ship.hull, shield: cls.shield, energy: cls.energy, parts: { ...ship.parts } };
    w.removeShip(ship.id);
    s.sector.shipOwner.delete(ship.id);
    s.shipId = null;
    s.inputs.length = 0;
    s.jump = null;
    s.docked = st.id;
    s.home = st.id;
    s.pilotDirty = true;
    this.playersDirty = true;
    this.notice(s, `Amarré à ${st.name}`, 'good');
    this.sendMarket(s);
    this.sendBoard(s);
    this.completeAtStation(s);
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
      ship.parts = { ...s.stored.parts };
    }
    s.docked = null;
    s.stored = null;
    s.pilotDirty = true;
  }

  /** What the pilot's current ship can do, upgrades included. */
  private shipStats(s: Session): ShipStats {
    return effectiveStats(s.ship, s.fleet[s.ship]!.mods);
  }

  private buyShip(s: Session, classId: ShipClassId) {
    const offer = offerOf(classId);
    if (!s.docked || !offer) return;
    if (s.docked !== SHIPYARD_STATION) return this.notice(s, `Les vaisseaux se vendent au chantier de ${this.station(SHIPYARD_STATION).name}.`, 'warn');
    if (s.fleet[classId]) return this.useShip(s, classId);
    if (s.stats.credits < offer.price) return this.notice(s, TRADE_REFUSALS.funds, 'warn');
    s.stats.credits -= offer.price;
    s.fleet[classId] = { mods: noMods(), hull: effectiveStats(classId, noMods()).hull };
    s.pilotDirty = true;
    this.notice(s, `${SHIP_CLASSES[classId].label} acheté  −${offer.price} cr`, 'good');
    this.useShip(s, classId);
  }

  /** Docked: the current ship goes to the hangar (hull kept), another one is prepared. */
  private useShip(s: Session, classId: ShipClassId) {
    const next = s.fleet[classId];
    if (!s.docked || !s.stored || !next || s.ship === classId) return;
    const cls = effectiveStats(classId, next.mods);
    if (cargoTotal(s.cargo) + this.reserved(s) > cls.cargo) return this.notice(s, `Soute trop pleine pour le ${SHIP_CLASSES[classId].label} (${cls.cargo} unités) : vendez d'abord une partie de la cargaison.`, 'warn');
    const parked = s.fleet[s.ship]!;
    parked.hull = s.stored.hull;
    if (allIntact(s.stored)) delete parked.parts;
    else parked.parts = { ...s.stored.parts };
    s.ship = classId;
    s.stored = { hull: Math.min(cls.hull, next.hull), shield: cls.shield, energy: cls.energy, parts: { ...(next.parts ?? intactParts()) } };
    s.holdFullNotified = false;
    s.pilotDirty = true;
    this.notice(s, `Aux commandes du ${SHIP_CLASSES[classId].label}`, 'good');
  }

  /** Docked: next level of an upgrade on the current ship. */
  private upgrade(s: Session, slot: UpgradeSlot) {
    if (!s.docked || !s.stored) return;
    const owned = s.fleet[s.ship]!;
    const cost = upgradeCost(s.ship, owned.mods, slot);
    if (cost === null) return this.notice(s, `${UPGRADES[slot].label} : niveau maximal atteint.`, 'warn');
    if (s.stats.credits < cost) return this.notice(s, TRADE_REFUSALS.funds, 'warn');
    const before = this.shipStats(s);
    s.stats.credits -= cost;
    owned.mods = { ...owned.mods, [slot]: owned.mods[slot] + 1 };
    const after = this.shipStats(s);
    // New plating and shield emitters are fitted intact.
    s.stored.hull = Math.min(after.hull, s.stored.hull + (after.hull - before.hull));
    s.stored.shield = after.shield;
    s.holdFullNotified = false;
    s.pilotDirty = true;
    this.notice(s, `${UPGRADES[slot].label} niveau ${owned.mods[slot]}  −${cost} cr`, 'good');
  }

  /** Hold units taken by courier crates. */
  private reserved(s: Session) {
    let n = 0;
    for (const m of s.missions) n += crates(m);
    return n;
  }

  /** What the hold can take in cargo, crates set aside (trade() and addCargo() compare it with the cargo total). */
  private holdSpace(s: Session) {
    return this.shipStats(s).cargo - this.reserved(s);
  }

  private newBoard(station: StationId): Board {
    return {
      offers: boardKinds(this.missionRng, BOARD_SIZE).map((kind) => makeOffer(this.missionRng, station, this.nextMission++, kind)),
      refillAt: new Array(BOARD_SIZE).fill(0),
    };
  }

  /** Once a second: refill taken slots, and renew every board now and then so offers do not go stale. */
  private stepBoards() {
    const t = this.time;
    const changed = new Set<StationId>();
    if (t >= this.boardRenewAt) {
      this.boardRenewAt = t + BOARD_RENEW;
      for (const id of Object.keys(this.boards) as StationId[]) {
        this.boards[id] = this.newBoard(id);
        changed.add(id);
      }
    }
    for (const [id, b] of Object.entries(this.boards) as [StationId, Board][]) {
      b.offers.forEach((o, i) => {
        if (o || t < b.refillAt[i]) return;
        b.offers[i] = makeOffer(this.missionRng, id, this.nextMission++);
        changed.add(id);
      });
    }
    for (const s of this.sessions.values()) if (s.docked && changed.has(s.docked)) this.sendBoard(s);
  }

  private sendBoard(s: Session) {
    if (!s.docked || !s.link) return;
    s.link.send({ t: 'board', station: s.docked, offers: this.boards[s.docked].offers.filter((o): o is Mission => o !== null) });
  }

  private stationName = (id: StationId) => this.station(id).name;

  private acceptMission(s: Session, id: number) {
    if (!s.docked) return;
    const board = this.boards[s.docked];
    const i = board.offers.findIndex((o) => o?.id === id);
    // Gone already (taken by another pilot, renewed): the client gets the current board back.
    if (i < 0) return this.sendBoard(s);
    const offer = board.offers[i]!;
    if (s.missions.length >= MAX_ACTIVE) return this.notice(s, `Contrats : ${MAX_ACTIVE} au maximum en même temps.`, 'warn');
    if (crates(offer) > this.holdSpace(s) - cargoTotal(s.cargo)) return this.notice(s, `Il faut ${crates(offer)} places libres en soute pour ces caisses.`, 'warn');
    board.offers[i] = null;
    board.refillAt[i] = this.time + OFFER_REFILL;
    s.missions.push({ ...offer });
    s.pilotDirty = true;
    this.notice(s, `Contrat accepté : ${missionTitle(offer)}`, 'good');
    for (const o of this.sessions.values()) if (o.docked === s.docked) this.sendBoard(o);
  }

  private abandonMission(s: Session, id: number) {
    const m = s.missions.find((x) => x.id === id);
    if (!m) return;
    s.missions = s.missions.filter((x) => x !== m);
    s.holdFullNotified = false;
    s.pilotDirty = true;
    this.notice(s, `Contrat abandonné : ${missionTitle(m)}`, 'warn');
  }

  private pay(s: Session, m: Mission) {
    s.missions = s.missions.filter((x) => x !== m);
    s.stats.credits += m.reward;
    s.holdFullNotified = false;
    s.pilotDirty = true;
    this.notice(s, `Contrat rempli : ${missionTitle(m)}  +${m.reward} cr`, 'good');
  }

  /** Docking: deliver crates and mined ore to this station. */
  private completeAtStation(s: Session) {
    for (const m of [...s.missions]) {
      if (m.target !== s.docked) continue;
      if (m.kind === 'courier') this.pay(s, m);
      else if (m.kind === 'mining' && m.progress >= m.count) {
        const have = s.cargo[m.item!] ?? 0;
        if (have < m.count) {
          this.notice(s, `Contrat de minage : il manque ${m.count - have} ${ITEMS[m.item!].label} en soute.`, 'warn');
          continue;
        }
        removeCargo(s.cargo, m.item!, m.count);
        this.pay(s, m);
      }
    }
  }

  /** One unit of ore went into the hold: it counts for the first unfinished contract asking for it. */
  private mined(s: Session, item: ItemId) {
    const m = s.missions.find((x) => x.kind === 'mining' && x.item === item && x.progress < x.count);
    if (!m) return;
    m.progress++;
    if (m.progress === m.count) this.notice(s, `Minerai réuni : rapportez-le à ${this.stationName(m.target)}`, 'good');
  }

  private pirateDown(s: Session) {
    const m = s.missions.find((x) => x.kind === 'hunt' && x.progress < x.count);
    if (!m) return;
    m.progress++;
    s.pilotDirty = true;
    if (m.progress >= m.count) this.pay(s, m);
  }

  /** The ship was destroyed: crates are gone with it, and so is the ore mined for contracts. */
  private missionsLost(s: Session) {
    for (const m of [...s.missions]) {
      if (m.kind === 'courier') {
        s.missions = s.missions.filter((x) => x !== m);
        this.notice(s, `Contrat échoué : caisses perdues avec le vaisseau (${this.stationName(m.target)})`, 'warn');
      } else if (m.kind === 'mining') m.progress = 0;
    }
    s.pilotDirty = true;
  }

  /** Docked: the hull plating, then the damaged components (v0.8), as far as the credits go. */
  private repair(s: Session) {
    if (!s.docked || !s.stored) return;
    const max = this.shipStats(s).hull;
    const missing = max - s.stored.hull;
    const partsCost = componentRepairCost(s.stored.parts, max);
    if (missing < 0.5 && partsCost === 0) return this.notice(s, 'Le vaisseau est intact.');
    let spent = 0;
    let partial = false;
    if (missing >= 0.5) {
      const fix = Math.min(missing, s.stats.credits / REPAIR_COST);
      if (fix < 0.5) return this.notice(s, TRADE_REFUSALS.funds, 'warn');
      const cost = repairCost(fix);
      s.stats.credits -= cost;
      spent += cost;
      s.stored.hull = fix >= missing ? max : s.stored.hull + fix;
      partial = fix < missing;
    }
    if (!partial && partsCost > 0) {
      if (s.stats.credits >= partsCost) {
        s.stats.credits -= partsCost;
        spent += partsCost;
        s.stored.parts = intactParts();
      } else partial = true;
    }
    s.pilotDirty = true;
    this.notice(s, `${partial ? 'Réparé en partie' : 'Vaisseau réparé'}  −${spent} cr`, spent > 0 ? 'good' : 'warn');
  }

  private trade(s: Session, item: ItemId, qty: number) {
    if (!s.docked) return;
    const r = trade(this.markets[s.docked], item, qty, s.stats, s.cargo, this.holdSpace(s));
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
    const cls = this.shipStats(s);
    const hull = s.stored ? Math.round(s.stored.hull * 10) / 10 : null;
    return {
      credits: s.stats.credits,
      cargo: { ...s.cargo },
      capacity: cls.cargo,
      docked: s.docked,
      hull,
      parts: s.stored ? { ...s.stored.parts } : null,
      hullMax: cls.hull,
      ship: s.ship,
      reserved: this.reserved(s),
      missions: s.missions.map((m) => ({ ...m })),
      fleet: (Object.entries(s.fleet) as [ShipClassId, NonNullable<PilotSave['fleet'][ShipClassId]>][]).map(([classId, o]) => ({
        classId,
        mods: { ...o.mods },
        hull: classId === s.ship && hull !== null ? hull : o.hull,
      })),
    };
  }

  /** What an account keeps of this session: wallet, hold, score, station and ships. */
  private pilotSave(s: Session): PilotSave {
    const max = this.shipStats(s).hull;
    const ship = this.shipOf(s);
    // Destroyed and waiting to respawn: the next ship comes out of the hangar intact.
    const hull = s.stored ? s.stored.hull : ship ? ship.hull : max;
    const flownHull = Math.max(1, Math.min(max, Math.round(hull * 10) / 10));
    const flownParts = s.stored ? s.stored.parts : ship ? ship.parts : intactParts();
    const fleet: PilotSave['fleet'] = {};
    for (const [id, o] of Object.entries(s.fleet) as [ShipClassId, NonNullable<PilotSave['fleet'][ShipClassId]>][]) {
      const parts = id === s.ship ? (allIntact({ parts: flownParts }) ? undefined : { ...flownParts }) : o.parts;
      fleet[id] = { mods: { ...o.mods }, hull: id === s.ship ? flownHull : o.hull, ...(parts ? { parts } : {}) };
    }
    return {
      v: SAVE_VERSION,
      credits: s.stats.credits,
      cargo: { ...s.cargo },
      kills: s.stats.kills,
      deaths: s.stats.deaths,
      station: s.docked ?? s.home,
      hull: flownHull,
      ship: s.ship,
      fleet,
      missions: s.missions.map((m) => ({ ...m })),
    };
  }

  /** Reports every account pilot's progress now (server shutdown). */
  persistAll() {
    if (!this.onSave) return;
    for (const s of this.sessions.values()) {
      if (s.accountId === null) continue;
      s.saveDirty = false;
      this.onSave(s.accountId, this.pilotSave(s), true);
    }
  }

  /** Station stocks, to survive a restart. */
  exportSector(): SectorSave {
    return sectorSave(this.markets, this.now());
  }

  /** Restores saved stocks, then lets the markets drift for the time the server was down. */
  importSector(raw: unknown) {
    const n = restoreSector(this.markets, raw);
    if (!n) return 0;
    const savedAt = (raw as SectorSave).savedAt;
    const down = typeof savedAt === 'number' && Number.isFinite(savedAt) ? (this.now() - savedAt) / 1000 : 0;
    if (down > 0) for (const m of Object.values(this.markets)) stepMarket(m, Math.min(down, 24 * 3600));
    return n;
  }

  /** Whole units of ore under the beams go into the miners' holds. */
  private collectOre() {
    for (const s of this.sessions.values()) {
      const ship = this.shipOf(s);
      if (!ship || ship.mining === null || ship.mineProgress < 1) continue;
      const zone = s.sector.world.zone;
      const ore = oreOf(zone.asteroids[ship.mining].variant);
      const units = Math.floor(ship.mineProgress);
      const cap = this.holdSpace(s);
      let added = 0;
      for (; added < units; added++) {
        // The richer Kepler belt yields more platinum.
        const item: ItemId = ore === 'ironNickel' && this.lootRng() < zone.platinum ? 'platinum' : ore;
        if (!addCargo(s.cargo, item, 1, cap)) break;
        this.mined(s, item);
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
    const t = this.time;
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
    const t = this.time;
    const ship = this.shipOf(s);
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
      sector: s.sector.id,
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
    const t0 = this.time;
    // One buffered input per player per tick, so client prediction replays the same steps.
    for (const s of this.sessions.values()) {
      const w = s.sector.world;
      const next = s.inputs.shift();
      if (!next) {
        // No input for a second (frozen or backgrounded client): cut the engines and the guns.
        if (s.shipId !== null && t0 - s.lastInputAt > INPUT_TIMEOUT && t0 - s.lastInputAt < INPUT_TIMEOUT + TICK_DT * 1.5) {
          const ship = w.ships.get(s.shipId);
          if (ship) w.setInput(s.shipId, { ...neutralInput(), flightAssist: ship.input.flightAssist });
        }
        continue;
      }
      s.ackSeq = next.seq;
      if (s.shipId !== null) w.setInput(s.shipId, next.input);
    }
    const events = new Map<Sector, SimEvent[]>();
    for (const sector of Object.values(this.sectors)) {
      const w = sector.world;
      for (const pilot of sector.pilots.values()) {
        const input = pilot.update(w, TICK_DT);
        w.setInput(pilot.shipId, input);
      }
      w.step(TICK_DT);
      const list = w.drainEvents();
      this.handleEvents(sector, list);
      events.set(sector, list);
    }
    this.collectOre();
    this.marketClock += TICK_DT;
    if (this.marketClock >= 1) {
      this.marketClock -= 1;
      for (const m of Object.values(this.markets)) stepMarket(m, 1);
      for (const s of this.sessions.values()) this.sendMarket(s);
      this.stepBoards();
    }
    if (this.npcs) for (const sector of Object.values(this.sectors)) if (this.sessionsIn(sector) > 0) this.directWaves(sector, TICK_DT);

    const t = this.time;
    for (const s of [...this.sessions.values()]) {
      if (!s.link) {
        if (t - s.offlineSince >= this.reconnectGrace) this.disconnect(s.id);
        continue;
      }
      if (s.jump) this.stepJump(s);
      if (s.shipId === null && s.respawnAt > 0 && t >= s.respawnAt) this.spawnPlayer(s);
      if (s.pilotDirty) {
        s.pilotDirty = false;
        s.saveDirty = true;
        s.link.send({ t: 'pilot', pilot: this.pilotState(s) });
      }
      if (s.saveDirty && s.accountId !== null && this.onSave) {
        s.saveDirty = false;
        this.onSave(s.accountId, this.pilotSave(s), false);
      }
    }

    // Jumps add their own events: read the lists again.
    for (const sector of Object.values(this.sectors)) {
      const list = events.get(sector)!;
      list.push(...sector.world.drainEvents());
      if (list.length) this.broadcastIn(sector, { t: 'events', tick: sector.world.tick, events: list });
    }
    const tick = this.world.tick;
    if (tick % this.snapshotEvery === 0) for (const sector of Object.values(this.sectors)) this.sendSnapshots(sector);
    if (this.playersDirty || tick % TICK_RATE === 0) {
      this.playersDirty = false;
      this.broadcast({ t: 'players', list: this.playerList(), max: this.maxPlayers });
    }
  }

  private sendSnapshots(sector: Sector) {
    const w = sector.world;
    let snap: { tick: number; time: number; ships: ReturnType<typeof snapshotShip>[] } | null = null;
    // The world part is identical for everyone in the sector: serialise it once for network links.
    let snapJson: string | null = null;
    for (const s of this.sessions.values()) {
      if (!s.link || s.sector !== sector) continue;
      snap ??= { tick: w.tick, time: w.time, ships: [...w.ships.values()].map(snapshotShip) };
      const personal = {
        ackSeq: s.ackSeq,
        you: s.shipId,
        stats: s.stats,
        wave: sector.wave,
        respawnIn: s.shipId === null ? Math.max(0, s.respawnAt - w.time) : 0,
        jump: this.jumpView(s),
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

  private broadcastIn(sector: Sector, msg: ServerMessage) {
    for (const s of this.sessions.values()) if (s.sector === sector) s.link?.send(msg);
  }

  private handleEvents(sector: Sector, events: SimEvent[]) {
    for (const e of events) {
      if (e.type !== 'destroyed') continue;
      sector.pilots.delete(e.ship);
      const ownerSession = sector.shipOwner.get(e.ship);
      if (ownerSession) {
        sector.shipOwner.delete(e.ship);
        const s = this.sessions.get(ownerSession);
        if (s) {
          s.shipId = null;
          s.stats.deaths++;
          s.saveDirty = true;
          s.respawnAt = this.time + 5;
          s.jump = null;
          this.playersDirty = true;
          if (cargoTotal(s.cargo) > 0) {
            s.cargo = {};
            s.holdFullNotified = false;
            s.pilotDirty = true;
            this.notice(s, 'Cargaison perdue avec le vaisseau.', 'warn');
          }
          this.missionsLost(s);
        }
      }
      if (e.faction === 'union' && !ownerSession) {
        sector.wingmenTimers.push(20);
      }
      if (e.by !== null) {
        const killer = sector.shipOwner.get(e.by);
        const ks = killer ? this.sessions.get(killer) : undefined;
        if (ks && ks.id !== ownerSession) {
          ks.stats.kills++;
          ks.saveDirty = true;
          // Player kills (PvP) pay nothing: two friends cannot farm credits off each other.
          const bounty = ownerSession ? PVP_KILL_BOUNTY : SHIP_CLASSES[e.classId].bounty;
          ks.stats.credits += bounty;
          if (bounty) ks.pilotDirty = true;
          ks.link?.send({ t: 'notice', text: bounty ? `${e.name} détruit  +${bounty} cr` : `${e.name} abattu en PvP`, tone: 'good' });
          if (e.faction === 'raiders') this.pirateDown(ks);
          if (ownerSession) this.system(`${ks.name} a abattu ${e.name}`);
          this.playersDirty = true;
        }
      }
    }
  }

  /** Puts the player's ship in space, in its sector: near the spawn point, or where given (undocking, jump arrival). */
  private spawnPlayer(s: Session, position?: Vector3, rotation?: Quaternion, velocity?: Vector3) {
    const sector = s.sector;
    const z = sector.world.zone;
    const offset = _v.set((sector.rng() - 0.5) * 120, (sector.rng() - 0.5) * 40, (sector.rng() - 0.5) * 60);
    const ship = sector.world.spawnShip({
      classId: s.ship,
      mods: s.fleet[s.ship]!.mods,
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
    sector.shipOwner.set(ship.id, s.id);
    return ship;
  }

  /** What the pilot's drive is doing, for its HUD. */
  private jumpView(s: Session): JumpView {
    const t = this.time;
    return {
      to: s.jump?.to ?? null,
      left: s.jump ? Math.max(0, Math.round((s.jump.at - t) * 10) / 10) : 0,
      cooldown: Math.max(0, Math.round((s.jumpReadyAt - t) * 10) / 10),
    };
  }

  /**
   * Why the drive cannot jump right now, or null: `text` refuses a new
   * charge, `cancel` explains why a charge in progress stopped.
   */
  private jumpBlocked(s: Session, to: SectorId): { text: string; cancel: string } | null {
    const ship = this.shipOf(s);
    if (s.docked || !ship || !ship.alive) return { text: 'Saut impossible : il faut être en vol.', cancel: '' };
    if (to === s.sector.id) return { text: `Saut impossible : vous êtes déjà dans le ${SECTOR_NAMES[to]}.`, cancel: '' };
    const t = this.time;
    if (t < s.jumpReadyAt) return { text: `Saut : réacteur hyperspatial en recharge (${Math.ceil(s.jumpReadyAt - t)} s).`, cancel: '' };
    for (const st of s.sector.world.zone.stations) {
      if (ship.position.distanceTo(st.position) >= JUMP_CLEARANCE) continue;
      const km = String(JUMP_CLEARANCE / 1000).replace('.', ',');
      return { text: `Saut impossible près d'une station : éloignez-vous à plus de ${km} km.`, cancel: `Saut annulé : trop près de ${st.name}.` };
    }
    if (t - ship.lastPvpCombat < PVP_COMBAT_LOCK) return { text: 'Saut impossible : combat PvP en cours.', cancel: 'Saut annulé : combat PvP en cours.' };
    if (ship.energy < this.shipStats(s).energy * JUMP_ENERGY) {
      const pct = Math.round(JUMP_ENERGY * 100);
      return { text: `Saut : énergie insuffisante (il faut ${pct} % du condensateur).`, cancel: `Saut annulé : énergie sous ${pct} %.` };
    }
    return null;
  }

  /** J: the drive charges for JUMP_CHARGE seconds, then the ship jumps (stepJump). Again while charging: cancel. */
  private startJump(s: Session, to: SectorId) {
    if (!isSectorId(to)) return;
    if (s.jump) return this.cancelJump(s, 'Saut annulé.');
    const why = this.jumpBlocked(s, to);
    if (why) return this.notice(s, why.text, 'warn');
    s.jump = { to, at: this.time + JUMP_CHARGE };
    this.notice(s, `Réacteur hyperspatial en charge : saut vers le ${SECTOR_NAMES[to]} dans ${JUMP_CHARGE} s`, 'info');
  }

  private cancelJump(s: Session, text: string) {
    if (!s.jump) return;
    s.jump = null;
    if (text) this.notice(s, text, 'warn');
  }

  /** While charging: the conditions must hold until the end, then the ship jumps. */
  private stepJump(s: Session) {
    const jump = s.jump!;
    const why = this.jumpBlocked(s, jump.to);
    if (why) return this.cancelJump(s, why.cancel);
    if (this.time >= jump.at) this.jumpNow(s, jump.to);
  }

  /**
   * The ship leaves its sector's world and appears at the destination's jump
   * point, with its hull, shield, cargo and contracts; the jump takes
   * JUMP_ENERGY of the capacitor. The client is told first (`sector`), so the
   * snapshots it gets next are from the new sector.
   */
  private jumpNow(s: Session, to: SectorId) {
    const from = s.sector;
    const dest = this.sectors[to];
    const ship = this.shipOf(s)!;
    const cls = this.shipStats(s);
    const kept = { hull: ship.hull, shield: ship.shield, energy: Math.max(0, ship.energy - cls.energy * JUMP_ENERGY), parts: { ...ship.parts } };
    from.world.emit({ type: 'jumpOut', ship: ship.id, pos: [ship.position.x, ship.position.y, ship.position.z], classId: ship.classId });
    from.world.removeShip(ship.id);
    from.shipOwner.delete(ship.id);
    s.shipId = null;
    s.jump = null;
    s.inputs.length = 0;
    s.sector = dest;
    // Logging off in this sector's space brings the pilot back to its hub, not to a station a jump away.
    s.home = SECTOR_HUB[to];
    s.jumpReadyAt = this.time + JUMP_COOLDOWN;
    s.saveDirty = true;
    s.link?.send({ t: 'sector', sector: to, zoneSeed: dest.world.zone.seed });

    const z = dest.world.zone;
    const at = z.jumpPoint.clone().add(new Vector3((dest.rng() - 0.5) * 300, (dest.rng() - 0.5) * 100, (dest.rng() - 0.5) * 300));
    const look = z.station.position.clone().sub(at).normalize();
    const arrived = this.spawnPlayer(s, at, new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), look), look.clone().multiplyScalar(60));
    arrived.hull = kept.hull;
    arrived.shield = kept.shield;
    arrived.energy = kept.energy;
    arrived.parts = kept.parts;
    dest.world.emit({ type: 'jumpIn', ship: arrived.id, pos: [at.x, at.y, at.z], classId: arrived.classId });
    s.pilotDirty = true;
    this.playersDirty = true;
    this.notice(s, `Arrivée : ${z.name}`, 'good');
    if (!this.sessionsIn(from)) this.resetSector(from);
  }

  private spawnNpc(sector: Sector, classId: ShipClassId, faction: 'union' | 'raiders', name: string, pos: Vector3, skill: number, home: Vector3, anchor = home) {
    // Face the station on arrival.
    const look = _v.copy(home).sub(pos).normalize();
    _m.setFromUnitVectors(new Vector3(0, 0, -1), look);
    const ship = sector.world.spawnShip({ classId, faction, name, position: pos, rotation: _m });
    sector.pilots.set(ship.id, new AIPilot(ship.id, mulberry32(Math.floor(sector.rng() * 2 ** 31)), skill, home.clone(), anchor.clone()));
    return ship;
  }

  /** A point ~3 km from the station, away from the asteroid belt, with no obstacle nearby. */
  private findOpenSpawn(sector: Sector): Vector3 {
    const w = sector.world;
    const rng = sector.rng;
    const station = w.zone.station.position;
    const beltDir = w.zone.beltCenter.clone().sub(station).normalize();
    const p = new Vector3();
    for (let attempt = 0; attempt < 40; attempt++) {
      const dir = new Vector3(rng() - 0.5, (rng() - 0.5) * 0.5, rng() - 0.5).normalize();
      if (dir.dot(beltDir) > 0.2) continue;
      p.copy(station).addScaledVector(dir, 2800 + rng() * 600);
      if (w.grid.query(p, 600).every((c) => c.center.distanceTo(p) > c.radius + 600)) return p;
    }
    return p.copy(station).add(new Vector3(-3000, 400, 0));
  }

  private directWaves(sector: Sector, dt: number) {
    const w = sector.world;
    const rng = sector.rng;
    // Allied wingmen defending the station.
    for (let i = sector.wingmenTimers.length - 1; i >= 0; i--) {
      sector.wingmenTimers[i] -= dt;
      if (sector.wingmenTimers[i] <= 0) {
        sector.wingmenTimers.splice(i, 1);
        const pos = w.zone.playerSpawn.clone().add(new Vector3((rng() - 0.5) * 400, 80 + rng() * 80, 150));
        const n = Math.floor(rng() * 90 + 10);
        this.spawnNpc(sector, 'warden', 'union', `Garde ${n}`, pos, 0.7, w.zone.playerSpawn.clone(), w.zone.station.position);
      }
    }

    let hostiles = 0;
    for (const s of w.ships.values()) if (s.faction === 'raiders') hostiles++;
    if (hostiles > 0) return;
    sector.waveTimer -= dt;
    if (sector.waveTimer > 0) return;

    // Pirate raids, not arcade waves: after one is beaten the sector stays calm for a while, and
    // raids grow only a little (the number of pilots online matters more than the raid count).
    // The Kepler sector (danger 1) starts a step harder.
    sector.wave++;
    sector.waveTimer = RAID_CALM_MIN + rng() * (RAID_CALM_MAX - RAID_CALM_MIN);
    const extra = Math.min(Math.max(0, this.onlineIn(sector) - 1), 6);
    const step = sector.wave + w.zone.danger;
    const threat = Math.min(step, 4 + w.zone.danger);
    const raiders = Math.min(2 + threat + extra, 12);
    const marauders = Math.min((step >= 3 ? 1 : 0) + Math.floor(extra / 3), 4);
    // Pirates jump in from open space ~3 km out and converge on the station.
    const station = w.zone.station.position;
    const center = this.findOpenSpawn(sector);
    const home = station.clone().lerp(w.zone.playerSpawn, 0.6);
    const squad = String(Math.floor(rng() * 90 + 10));
    for (let i = 0; i < raiders + marauders; i++) {
      const pos = center.clone().add(new Vector3((rng() - 0.5) * 500, (rng() - 0.5) * 200, (rng() - 0.5) * 500));
      const cls: ShipClassId = i < raiders ? 'raider' : 'marauder';
      const label = cls === 'raider' ? 'Raider' : 'Marauder';
      this.spawnNpc(sector, cls, 'raiders', `${label}-${squad}${String.fromCharCode(65 + i)}`, pos, Math.min(0.45 + threat * 0.08, 0.85), home, station);
    }
    this.broadcastIn(sector, {
      t: 'notice',
      text: `RAID PIRATE — ${raiders + marauders} contacts en approche de ${w.zone.station.name.replace(/^Station\s+/, '')}`,
      tone: 'warn',
    });
  }
}
