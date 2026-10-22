import { Quaternion, Vector3 } from 'three';
import { AIPilot } from '../shared/sim/ai';
import { mulberry32 } from '../shared/rng';
import { SHIP_CLASSES } from '../shared/sim/shipClasses';
import type { EntityId, ShipClassId, SimEvent } from '../shared/sim/types';
import { TICK_DT, TICK_RATE, World } from '../shared/sim/world';
import { buildZone } from '../shared/sim/zone';
import type { ClientMessage, PlayerStats, ServerMessage } from '../shared/net/protocol';
import { PROTOCOL_VERSION, sanitizeInput, snapshotShip } from '../shared/net/protocol';

/** Anything able to deliver server messages to one client (in-process, WebSocket...). */
export interface ClientLink {
  send(msg: ServerMessage): void;
}

interface Session {
  id: string;
  name: string;
  link: ClientLink;
  shipId: EntityId | null;
  respawnAt: number;
  lastSeq: number;
  stats: PlayerStats;
}

export interface GameServerOptions {
  seed?: number;
  /** Send a snapshot every N ticks (1 in-process, ~3 over a real network). */
  snapshotEvery?: number;
  /** Spawn NPC waves and wingmen. Disabled in some tests. */
  npcs?: boolean;
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

  constructor(opts: GameServerOptions = {}) {
    const seed = opts.seed ?? 1337;
    this.world = new World(buildZone(seed));
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    this.snapshotEvery = opts.snapshotEvery ?? 1;
    this.npcs = opts.npcs ?? true;
  }

  connect(link: ClientLink, name = 'Pilote'): string {
    const id = `p${this.nextSession++}`;
    const session: Session = {
      id,
      name: name.slice(0, 24) || 'Pilote',
      link,
      shipId: null,
      respawnAt: 0,
      lastSeq: 0,
      stats: { kills: 0, deaths: 0, credits: 0 },
    };
    this.sessions.set(id, session);
    link.send({ t: 'welcome', playerId: id, zoneSeed: this.world.zone.seed, tickRate: TICK_RATE });
    this.spawnPlayer(session);
    return id;
  }

  disconnect(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.shipId !== null) {
      this.world.removeShip(s.shipId);
      this.shipOwner.delete(s.shipId);
    }
    this.sessions.delete(id);
  }

  receive(sessionId: string, msg: ClientMessage) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (msg.t === 'input') {
      if (msg.seq <= s.lastSeq) return; // stale or duplicated packet
      const input = sanitizeInput(msg.input);
      if (!input) return;
      s.lastSeq = msg.seq;
      if (s.shipId !== null) this.world.setInput(s.shipId, input);
    } else if (msg.t === 'hello') {
      if (msg.version !== PROTOCOL_VERSION) {
        s.link.send({ t: 'notice', text: 'Version du client incompatible', tone: 'warn' });
      }
      s.name = String(msg.name).slice(0, 24) || s.name;
    }
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
    for (const pilot of this.pilots.values()) {
      const input = pilot.update(w, TICK_DT);
      w.setInput(pilot.shipId, input);
    }
    w.step(TICK_DT);
    const events = w.drainEvents();
    this.handleEvents(events);
    if (this.npcs) this.directWaves(TICK_DT);

    for (const s of this.sessions.values()) {
      if (s.shipId === null && s.respawnAt > 0 && w.time >= s.respawnAt) this.spawnPlayer(s);
    }

    if (events.length) this.broadcast({ t: 'events', tick: w.tick, events });
    if (w.tick % this.snapshotEvery === 0) {
      const snap = { tick: w.tick, time: w.time, ships: [...w.ships.values()].map(snapshotShip) };
      for (const s of this.sessions.values()) {
        s.link.send({
          t: 'snapshot',
          snap,
          ackSeq: s.lastSeq,
          you: s.shipId,
          stats: s.stats,
          wave: this.wave,
          respawnIn: s.shipId === null ? Math.max(0, s.respawnAt - w.time) : 0,
        });
      }
    }
  }

  private broadcast(msg: ServerMessage) {
    for (const s of this.sessions.values()) s.link.send(msg);
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
        }
      }
      if (e.faction === 'union' && !ownerSession) {
        this.wingmenTimers.push(20);
      }
      if (e.by !== null) {
        const killer = this.shipOwner.get(e.by);
        const ks = killer ? this.sessions.get(killer) : undefined;
        if (ks) {
          ks.stats.kills++;
          const bounty = SHIP_CLASSES[e.classId].bounty;
          ks.stats.credits += bounty;
          ks.link.send({ t: 'notice', text: `${e.name} détruit  +${bounty} cr`, tone: 'good' });
        }
      }
    }
  }

  private spawnPlayer(s: Session) {
    const z = this.world.zone;
    const offset = _v.set((this.rng() - 0.5) * 120, (this.rng() - 0.5) * 40, (this.rng() - 0.5) * 60);
    const ship = this.world.spawnShip({
      classId: 'falcon',
      faction: 'union',
      name: s.name,
      ownerId: s.id,
      position: z.playerSpawn.clone().add(offset),
    });
    s.shipId = ship.id;
    s.respawnAt = 0;
    this.shipOwner.set(ship.id, s.id);
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
    const raiders = Math.min(2 + this.wave, 9);
    const marauders = Math.min(Math.floor(this.wave / 2), 3);
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
