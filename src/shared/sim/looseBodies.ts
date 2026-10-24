import { Quaternion, Vector3 } from 'three';
import { BODY_KINDS, bodyHp, bodyProps, type BodyKind } from '../physics/bodies';
import { sweepStatic, type StaticContactReport } from '../physics/collide';
import { distanceTo } from '../physics/shapes';
import { mulberry32 } from '../rng';
import type { StaticGrid } from './spatialGrid';
import type { Body, EntityId, Ship } from './types';
import type { StationDef, ZoneDef } from './zone';
import { FERRO_MOUTH_Z } from './zone';

/** A body at rest this slow (m/s and rad/s) for SLEEP_TICKS falls asleep. */
const SLEEP_SPEED = 0.05;
const SLEEP_SPIN = 0.02;
const SLEEP_TICKS = 60;
/** Bodies farther than this from every player are frozen (the active zones around players). */
export const BODY_ACTIVE_RANGE = 3000;
/** Wreckage lasts this long (s); a sector keeps at most MAX_WRECKS, the oldest go first. */
export const WRECK_LIFE = 90;
const MAX_WRECKS = 36;
/** Moored cargo that drifted this far, or was left alone this long once moved, goes back home when nobody watches. */
const RECOVER_DISTANCE = 600;
const RECOVER_IDLE = 300;
/** …"nobody watches": no player within this distance of it or of its mooring (m). */
const UNWATCHED = 400;
/** A broken moored body is replaced after this long (s), unwatched too. */
const RESPAWN_DELAY = 120;

/** Where a loose body belongs in a sector (moorings and belt boulders). */
export interface BodySpawn {
  kind: BodyKind;
  scale: number;
  position: Vector3;
  rotation: Quaternion;
}

interface Mooring extends BodySpawn {
  body: EntityId | null;
  brokenAt: number;
}

/** Snapshot of one body: id, kind index, scale, position, rotation (x, y, z, w). */
export type BodyState = [number, number, number, number, number, number, number, number, number, number];

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const Y = new Vector3(0, 1, 0);
const _q = new Quaternion();
const _axis = new Vector3();
const _L = new Vector3();
const _inv = new Quaternion();

/**
 * A cluster of cargo: one container and a few crates around `at` (local to
 * the station), turned at random but always the same way for a given seed.
 */
function cluster(out: BodySpawn[], st: StationDef, at: [number, number, number], crates: number, container: boolean, seed: number) {
  const rand = mulberry32(seed);
  const frame = new Quaternion().setFromAxisAngle(Y, st.yaw);
  const place = (kind: BodyKind, dx: number, dy: number, dz: number) => {
    const local = new Vector3(at[0] + dx, at[1] + dy, at[2] + dz);
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(), rand() * Math.PI * 2);
    out.push({ kind, scale: 1, position: local.applyQuaternion(frame).add(st.position), rotation: frame.clone().multiply(rotation) });
  };
  if (container) place('container', 0, 0, 0);
  for (let i = 0; i < crates; i++) {
    const a = (i / crates) * Math.PI * 2 + rand() * 0.6;
    const d = 9 + rand() * 7;
    place('crate', Math.cos(a) * d, (rand() - 0.5) * 8, Math.sin(a) * d);
  }
}

/** Two crates resting in the back corners of a hangar (local frame: floor top at `floorY`, back wall at `backZ`). */
function hangarCrates(out: BodySpawn[], st: StationDef, x: number, floorY: number, backZ: number) {
  const frame = new Quaternion().setFromAxisAngle(Y, st.yaw);
  for (const sx of [-1, 1]) {
    const local = new Vector3(sx * x, floorY + 1.25, backZ + 1.3);
    out.push({ kind: 'crate', scale: 1, position: local.applyQuaternion(frame).add(st.position), rotation: frame.clone() });
  }
}

/**
 * The loose bodies a sector starts with: cargo moored beside each station's
 * approach and two crates in each hangar, and boulders strewn along the
 * depot's approach lane, clear of every rock and structure.
 */
export function zoneBodies(zone: ZoneDef, grid: StaticGrid): BodySpawn[] {
  const out: BodySpawn[] = [];
  const hub = zone.station;
  // In front of the hangar, either side of the approach, inside the habitat ring.
  cluster(out, hub, [-150, 30, 420], 3, true, 11);
  cluster(out, hub, [160, -25, 450], 4, true, 12);
  // Hub hangar: floor top at −55 + 14, back wall inner face at 253.6 − 80 + 14 (structures.ts).
  hangarCrates(out, hub, 82, -41, 187.6);
  const depot = zone.stations.find((s) => s.kind === 'outpost');
  if (depot) {
    // Depot hangar: floor top at −38 + 10, back wall inner face at FERRO_MOUTH_Z − 100 + 10.
    cluster(out, depot, [-120, 20, 260], 2, true, 21);
    hangarCrates(out, depot, 50, -28, FERRO_MOUTH_Z - 90);
    // Boulders beside the lane out of the depot, 120 to 260 m off it.
    const rand = mulberry32(zone.seed ^ 0xb01d);
    const side = new Vector3().crossVectors(depot.dock.out, Y).normalize();
    for (let i = 0, tries = 0; i < 8 && tries < 60; tries++) {
      const along = 250 + rand() * 900;
      const off = (rand() < 0.5 ? -1 : 1) * (120 + rand() * 140);
      const p = depot.dock.mouth.clone().addScaledVector(depot.dock.out, along).addScaledVector(side, off).add(new Vector3(0, (rand() - 0.5) * 160, 0));
      const scale = 1.4 + rand() * 1.4;
      const reach = bodyProps('boulder', scale).reach;
      if (grid.query(p, reach + 400).some((c) => distanceTo(c, p, 0) < reach + 15)) continue;
      out.push({ kind: 'boulder', scale, position: p, rotation: new Quaternion().setFromAxisAngle(new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(), rand() * 6) });
      i++;
    }
  }
  return out;
}

/** What the body system needs from the world it lives in. */
export interface BodyHost {
  readonly time: number;
  readonly grid: StaticGrid;
  readonly ships: Map<EntityId, Ship>;
  newId(): EntityId;
  /** A body hit the static world (World turns it into damage and an event). */
  onStaticImpact(b: Body, i: StaticContactReport): void;
  emit(e: { type: 'bodyBroken'; body: EntityId; kind: BodyKind; scale: number; pos: [number, number, number] } | { type: 'bodyGone'; body: EntityId }): void;
}

/**
 * Loose bodies of one world (v0.8): spawning, drifting and tumbling (torque
 * free: the angular momentum is kept, so long bodies wobble as real ones
 * do), sweeping against the static world, sleeping at rest, freezing far
 * from players, breaking, and the housekeeping that keeps a sector tidy.
 */
export class LooseBodies {
  readonly list = new Map<EntityId, Body>();
  /** Each body's position before this tick's move. */
  readonly from = new Map<EntityId, Vector3>();
  private moorings: Mooring[] = [];
  private wrecks: EntityId[] = [];
  /** Spawned or removed since the last full snapshot list. */
  changed = true;

  constructor(private host: BodyHost) {}

  spawn(kind: BodyKind, scale: number, position: Vector3, rotation: Quaternion, velocity?: Vector3, spin?: Vector3): Body {
    const b: Body = {
      id: this.host.newId(),
      kind,
      scale,
      position: position.clone(),
      velocity: velocity?.clone() ?? new Vector3(),
      rotation: rotation.clone().normalize(),
      angularVelocity: new Vector3(),
      spin: spin?.clone() ?? new Vector3(),
      hp: bodyHp(kind, scale),
      asleep: !velocity && !spin,
      active: true,
      still: 0,
      dirty: true,
      home: null,
      expires: Infinity,
      touched: this.host.time,
    };
    this.list.set(b.id, b);
    this.changed = true;
    return b;
  }

  /** Moors the sector's bodies (see zoneBodies). */
  populate(spawns: BodySpawn[]) {
    for (const sp of spawns) {
      const m: Mooring = { ...sp, body: null, brokenAt: -Infinity };
      this.moor(m);
      this.moorings.push(m);
    }
  }

  private moor(m: Mooring) {
    const b = this.spawn(m.kind, m.scale, m.position, m.rotation);
    b.home = { position: m.position, rotation: m.rotation };
    m.body = b.id;
  }

  /** A destroyed ship leaves torn sections of hull drifting apart from where it was. */
  spawnWreck(ship: Ship, scale: number, pieces: number, rand: () => number) {
    for (let i = 0; i < pieces; i++) {
      const dir = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
      const pos = ship.position.clone().addScaledVector(dir, 2 + rand() * 4 * scale);
      const vel = ship.velocity.clone().multiplyScalar(0.7).addScaledVector(dir, 6 + rand() * 16);
      const spin = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(2.5);
      const b = this.spawn('wreck', scale * (0.75 + rand() * 0.5), pos, new Quaternion().setFromAxisAngle(dir, rand() * 6), vel, spin);
      b.expires = this.host.time + WRECK_LIFE * (0.8 + rand() * 0.4);
      this.wrecks.push(b.id);
    }
    while (this.wrecks.length > MAX_WRECKS) {
      const old = this.list.get(this.wrecks.shift()!);
      if (old) old.expires = this.host.time;
    }
  }

  wake(b: Body) {
    b.asleep = false;
    b.still = 0;
    b.touched = this.host.time;
  }

  /** Damage to a body; at zero it breaks apart. */
  damage(b: Body, amount: number) {
    if (amount <= 0 || !this.list.has(b.id)) return;
    b.hp -= amount;
    if (b.hp > 0) return;
    this.host.emit({ type: 'bodyBroken', body: b.id, kind: b.kind, scale: b.scale, pos: [r2(b.position.x), r2(b.position.y), r2(b.position.z)] });
    this.remove(b.id);
    const m = this.moorings.find((x) => x.body === b.id);
    if (m) {
      m.body = null;
      m.brokenAt = this.host.time;
    }
  }

  remove(id: EntityId) {
    if (!this.list.delete(id)) return;
    this.from.delete(id);
    this.changed = true;
    const w = this.wrecks.indexOf(id);
    if (w >= 0) this.wrecks.splice(w, 1);
  }

  /** Drift, tumble and hit the static world: only awake bodies in an active zone move. */
  step(dt: number) {
    const grid = this.host.grid;
    for (const b of this.list.values()) {
      let from = this.from.get(b.id);
      if (!from) this.from.set(b.id, (from = new Vector3()));
      from.copy(b.position);
      if (b.asleep || !b.active) continue;
      const props = bodyProps(b.kind, b.scale);
      b.position.addScaledVector(b.velocity, dt);
      // Torque-free rotation: the angular momentum L = R·I·ω is kept in the
      // world frame while the body turns, so ω changes in the body frame.
      const I = props.inertia;
      _L.set(b.spin.x * I.x, b.spin.y * I.y, b.spin.z * I.z).applyQuaternion(b.rotation);
      const w = b.spin.length();
      if (w > 1e-6) {
        _q.setFromAxisAngle(_axis.copy(b.spin).divideScalar(w), w * dt);
        b.rotation.multiply(_q).normalize();
        _L.applyQuaternion(_inv.copy(b.rotation).invert());
        b.spin.set(_L.x / I.x, _L.y / I.y, _L.z / I.z);
      }
      sweepStatic(b, props, from, dt, grid, (i) => this.host.onStaticImpact(b, i));
      if (b.velocity.lengthSq() < SLEEP_SPEED * SLEEP_SPEED && b.spin.lengthSq() < SLEEP_SPIN * SLEEP_SPIN) {
        if (++b.still >= SLEEP_TICKS) {
          b.asleep = true;
          b.velocity.set(0, 0, 0);
          b.spin.set(0, 0, 0);
          b.dirty = true;
        }
      } else b.still = 0;
    }
  }

  /** Freezes the bodies far from every player, thaws the others (twice a second). */
  activity(players: Ship[]) {
    const r2 = BODY_ACTIVE_RANGE * BODY_ACTIVE_RANGE;
    for (const b of this.list.values()) {
      const active = players.some((p) => p.position.distanceToSquared(b.position) < r2);
      if (active !== b.active) {
        b.active = active;
        b.dirty = true;
      }
    }
  }

  /** Once a second: old wreckage cleared away, drifted cargo put back, broken cargo replaced (when nobody watches). */
  housekeeping(players: Ship[]) {
    const now = this.host.time;
    const watched = (p: Vector3) => players.some((s) => s.position.distanceToSquared(p) < UNWATCHED * UNWATCHED);
    for (const b of [...this.list.values()]) {
      if (b.expires <= now) {
        this.host.emit({ type: 'bodyGone', body: b.id });
        this.remove(b.id);
        continue;
      }
      const home = b.home;
      if (!home) continue;
      const away = b.position.distanceTo(home.position);
      if ((away > RECOVER_DISTANCE || (away > 5 && now - b.touched > RECOVER_IDLE)) && !watched(b.position) && !watched(home.position)) {
        b.position.copy(home.position);
        b.rotation.copy(home.rotation);
        b.velocity.set(0, 0, 0);
        b.spin.set(0, 0, 0);
        b.hp = bodyHp(b.kind, b.scale);
        b.asleep = true;
        b.dirty = true;
        this.from.get(b.id)?.copy(b.position);
      }
    }
    for (const m of this.moorings) {
      if (m.body === null && now - m.brokenAt > RESPAWN_DELAY && !watched(m.position)) this.moor(m);
    }
  }

  /** Snapshot entries: the bodies that move or changed (all of them when `full`). */
  snapshot(full: boolean): BodyState[] {
    const out: BodyState[] = [];
    for (const b of this.list.values()) {
      const moving = !b.asleep && b.active;
      if (!full && !moving && !b.dirty) continue;
      b.dirty = false;
      const p = b.position;
      const q = b.rotation;
      out.push([b.id, BODY_KINDS.indexOf(b.kind), r2(b.scale), r2(p.x), r2(p.y), r2(p.z), r3(q.x), r3(q.y), r3(q.z), r3(q.w)]);
    }
    if (full) this.changed = false;
    return out;
  }
}
