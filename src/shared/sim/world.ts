import { Quaternion, Vector3 } from 'three';
import { forwardOf, segmentSphere } from '../math';
import { BODY_DEFS, bodyProps } from '../physics/bodies';
import { applyImpulse, collidePair, collideShips, impactDamage, shipProps, type StaticContactReport } from '../physics/collide';
import { componentOf, WEAPON_WEAR, wearComponent } from '../physics/damage';
import { HITBOXES, massOf, type PartId } from '../physics/hitboxes';
import { contactOf, MATERIALS, SHIP_MATERIAL } from '../physics/materials';
import { rayCast } from '../physics/shapes';
import { mulberry32 } from '../rng';
import { LooseBodies, zoneBodies, type BodyState } from './looseBodies';
import { stepMining } from './mining';
import { stepShipPhysics } from './shipPhysics';
import { stepShipSystems } from './shipSystems';
import { StaticGrid } from './spatialGrid';
import type { Body, EntityId, FactionId, Projectile, Ship, ShipClassId, ShipInput, SimEvent } from './types';
import { canDamage, intactParts, neutralInput } from './types';
import { noMods, statsOf, type ShipMods } from './upgrades';
import type { ZoneDef } from './zone';

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
export { ENERGY_REGEN_DELAY, WEAPON_UNLOCK_FRACTION } from './shipSystems';

const _p0 = new Vector3();
const _muzzle = new Vector3();
const _dir = new Vector3();
const _rel = new Vector3();

const arr = (v: Vector3): [number, number, number] => [v.x, v.y, v.z];
const r2 = (n: number) => Math.round(n * 100) / 100;
const arr2 = (v: Vector3): [number, number, number] => [r2(v.x), r2(v.y), r2(v.z)];

/** Ships farther than this from every player collide as a single sphere (physics level of detail). */
export const PHYSICS_LOD_RANGE = 3000;
/** Grazing contacts that do no damage report at most this often per ship (s). */
const SCRAPE_EVENT_INTERVAL = 0.25;
/** A shield takes a collision's blow, but spreads a quarter of its energy. */
const SHIELD_COLLISION_ABSORB = 0.25;
/** Nose-first impacts hit the structure this much harder. */
const FRONTAL_FACTOR = 1.25;
/** Cell size of the broad phase between ships and loose bodies (m). */
const SHIP_CELL = 80;
/** Push of a bolt on a loose body, per point of damage (t·m/s). */
const BOLT_PUSH = 0.08;
/** Wreckage a destroyed ship leaves: pieces and their size. */
const WRECKAGE: Record<ShipClassId, { pieces: number; scale: number }> = {
  falcon: { pieces: 3, scale: 1 },
  warden: { pieces: 3, scale: 1.1 },
  raider: { pieces: 2, scale: 0.8 },
  marauder: { pieces: 4, scale: 1.5 },
};

/** An entry of the broad phase: a ship or a loose body, where it started this tick, how far it reaches. */
interface CellEntry {
  id: EntityId;
  ship: Ship | null;
  body: Body | null;
  from: Vector3;
}

const _fwd = new Vector3();
const _hw = new Vector3();
const _push = new Vector3();
const _r = new Vector3();

export interface SpawnOptions {
  classId: ShipClassId;
  faction: FactionId;
  name: string;
  position: Vector3;
  rotation?: Quaternion;
  velocity?: Vector3;
  ownerId?: string | null;
  mods?: ShipMods;
}

/**
 * The authoritative simulation of one zone. Contains no rendering, no DOM
 * and no networking: it advances in fixed ticks from ship inputs and emits
 * events that the server forwards to clients.
 */
export class World {
  tick = 0;
  time = 0;
  readonly ships = new Map<EntityId, Ship>();
  readonly projectiles: Projectile[] = [];
  readonly grid: StaticGrid;
  private events: SimEvent[] = [];
  private nextId = 1;
  /** Each ship's position before this tick's move: the start of its continuous collision sweep. */
  private from = new Map<EntityId, Vector3>();
  /** Ships far from every player, collided as one sphere (refreshed twice a second). */
  private coarse = new Set<EntityId>();
  private lastScrape = new Map<EntityId, number>();
  /** Same, for pairs of ships grinding against each other (key: lower id × 2²⁰ + higher id). */
  private lastPairScrape = new Map<string, number>();
  private cells = new Map<string, CellEntry[]>();
  /** Loose bodies: crates, containers, wreckage, boulders (v0.8). */
  readonly bodies: LooseBodies;

  /** `bodies`: moor the sector's loose bodies (cargo, boulders); off for bare test worlds. */
  constructor(readonly zone: ZoneDef, opts: { bodies?: boolean } = {}) {
    this.grid = new StaticGrid(zone.colliders);
    const world = this;
    this.bodies = new LooseBodies({
      get time() {
        return world.time;
      },
      grid: this.grid,
      ships: this.ships,
      newId: () => this.nextId++,
      onStaticImpact: (b, i) => this.bodyStaticImpact(b, i),
      emit: (e) => this.events.push(e),
    });
    if (opts.bodies !== false) this.bodies.populate(zoneBodies(zone, this.grid));
  }

  spawnShip(o: SpawnOptions): Ship {
    const mods = o.mods ? { ...o.mods } : noMods();
    const cls = statsOf({ classId: o.classId, mods });
    const ship: Ship = {
      id: this.nextId++,
      name: o.name,
      classId: o.classId,
      mods,
      faction: o.faction,
      ownerId: o.ownerId ?? null,
      position: o.position.clone(),
      velocity: o.velocity?.clone() ?? new Vector3(),
      rotation: o.rotation?.clone() ?? new Quaternion(),
      angularVelocity: new Vector3(),
      spin: new Vector3(),
      parts: intactParts(),
      hull: cls.hull,
      shield: cls.shield,
      energy: cls.energy,
      alive: true,
      boosting: false,
      input: neutralInput(),
      weaponCooldown: 0,
      nextHardpoint: 0,
      sinceDamage: 999,
      sinceFire: 999,
      weaponsLocked: false,
      lastAttacker: null,
      pvp: false,
      lastPvpCombat: -999,
      mining: null,
      mineProgress: 0,
    };
    this.ships.set(ship.id, ship);
    this.events.push({ type: 'spawned', ship: ship.id });
    return ship;
  }

  removeShip(id: EntityId) {
    this.ships.delete(id);
    this.from.delete(id);
    this.lastScrape.delete(id);
  }

  setInput(id: EntityId, input: ShipInput) {
    const ship = this.ships.get(id);
    if (ship) Object.assign(ship.input, input);
  }

  /** An event produced outside the simulation step (a hyperspace jump, decided by the server). */
  emit(e: SimEvent) {
    this.events.push(e);
  }

  /** Returns and clears the events produced since the last call. */
  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  step(dt = TICK_DT) {
    this.tick++;
    this.time += dt;
    this.grid.time = this.time;
    if (this.tick % 30 === 1) this.physicsLod();

    for (const ship of this.ships.values()) {
      if (!ship.alive) continue;
      let from = this.from.get(ship.id);
      if (!from) this.from.set(ship.id, (from = new Vector3()));
      from.copy(ship.position);
      stepShipPhysics(ship, dt);
      this.updateSystems(ship, dt, from);
      this.fireWeapons(ship, dt);
      stepMining(ship, dt, this.grid, this.zone.asteroids);
    }
    this.bodies.step(dt);
    this.collideSolids(dt);
    this.stepProjectiles(dt);

    for (const ship of [...this.ships.values()]) {
      if (!ship.alive) {
        this.leaveWreckage(ship);
        this.removeShip(ship.id);
      }
    }
    if (this.tick % 60 === 0) this.bodies.housekeeping(this.players());
  }

  /**
   * Physics level of detail: ships farther than PHYSICS_LOD_RANGE from every
   * player collide as a single sphere. Near a player, every ship uses its
   * full set of hit spheres.
   */
  private physicsLod() {
    this.coarse.clear();
    const players = this.players();
    const r2 = PHYSICS_LOD_RANGE * PHYSICS_LOD_RANGE;
    for (const s of this.ships.values()) {
      if (s.ownerId !== null) continue;
      if (!players.some((p) => p.position.distanceToSquared(s.position) < r2)) this.coarse.add(s.id);
    }
    this.bodies.activity(players);
  }

  private players() {
    return [...this.ships.values()].filter((s) => s.ownerId !== null && s.alive);
  }

  /** Loose bodies for a snapshot: those that move or changed, or all of them (`full`). */
  bodySnapshot(full: boolean): BodyState[] {
    return this.bodies.snapshot(full);
  }

  /** A destroyed ship leaves torn sections of its hull behind (v0.8). */
  private leaveWreckage(ship: Ship) {
    const w = WRECKAGE[ship.classId];
    this.bodies.spawnWreck(ship, w.scale, w.pieces, mulberry32(ship.id * 7919 + this.tick));
  }

  /** Ships currently on the coarse physics level (for tests and the status page). */
  get coarseShips() {
    return this.coarse.size;
  }

  private updateSystems(ship: Ship, dt: number, from: Vector3) {
    stepShipSystems(ship, dt, this.grid, from, (i) => this.staticImpact(ship, i), this.coarse.has(ship.id));
  }

  /** A ship struck the static world: damage from the velocity change, then the event for the clients. */
  private staticImpact(ship: Ship, i: StaticContactReport) {
    let damage = impactDamage(i.dv, i.hardness) * (i.frontal ? FRONTAL_FACTOR : 1);
    if (damage <= 0) {
      // A scrape: sparks and sound, rate-limited.
      if (i.speed < 1.5) return;
      const last = this.lastScrape.get(ship.id) ?? -1;
      if (this.time - last < SCRAPE_EVENT_INTERVAL) return;
    }
    this.lastScrape.set(ship.id, this.time);
    const shield = damage > 0 && ship.shield > 0;
    if (shield) damage *= 1 - SHIELD_COLLISION_ABSORB;
    this.events.push({
      type: 'collision',
      ship: ship.id,
      pos: arr2(i.point),
      damage,
      part: i.part,
      mat: i.material,
      n: arr2(i.normal),
      speed: r2(i.speed),
      shield,
    });
    if (damage > 0) this.applyDamage(ship, damage, null, i.part, 1);
  }

  private fireWeapons(ship: Ship, dt: number) {
    const w = statsOf(ship).weapon;
    ship.weaponCooldown = Math.max(0, ship.weaponCooldown - dt);
    if (!ship.input.fire || ship.weaponCooldown > 0 || ship.weaponsLocked) return;
    if (ship.energy < w.energyCost) {
      ship.weaponsLocked = true;
      return;
    }

    ship.weaponCooldown += w.interval;
    ship.energy -= w.energyCost;
    ship.sinceFire = 0;
    const hp = w.hardpoints[ship.nextHardpoint % w.hardpoints.length];
    ship.nextHardpoint++;
    _muzzle.set(hp[0], hp[1], hp[2]).applyQuaternion(ship.rotation).add(ship.position);
    _dir.set(0, 0, -1).applyQuaternion(ship.rotation);

    const proj: Projectile = {
      id: this.nextId++,
      ownerId: ship.id,
      faction: ship.faction,
      position: _muzzle.clone(),
      velocity: _dir.clone().multiplyScalar(w.speed).add(ship.velocity),
      damage: w.damage,
      life: w.life,
      pvp: ship.pvp && ship.ownerId !== null,
    };
    this.projectiles.push(proj);
    this.events.push({
      type: 'shot',
      shooter: ship.id,
      projectile: proj.id,
      faction: ship.faction,
      pos: arr(proj.position),
      vel: arr(proj.velocity),
      life: proj.life,
    });
  }

  private stepProjectiles(dt: number) {
    const list = this.projectiles;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      _p0.copy(p.position);
      p.position.addScaledVector(p.velocity, dt);
      p.life -= dt;

      let hitT = 2;
      let hitShip: Ship | null = null;
      for (const ship of this.ships.values()) {
        if (!ship.alive || !canDamage({ id: p.ownerId, faction: p.faction, pvp: p.pvp }, ship)) continue;
        const r = statsOf(ship).radius;
        const t = segmentSphere(_p0, p.position, ship.position, r);
        if (t >= 0 && t < hitT) {
          hitT = t;
          hitShip = ship;
        }
      }

      // Loose bodies: their bounding sphere, then their own spheres.
      let hitBody: Body | null = null;
      for (const b of this.bodies.list.values()) {
        if (!b.active) continue;
        const props = bodyProps(b.kind, b.scale);
        if (segmentSphere(_p0, p.position, b.position, props.reach) < 0) continue;
        for (const h of props.spheres) {
          _hw.copy(h.at).applyQuaternion(b.rotation).add(b.position);
          const t = segmentSphere(_p0, p.position, _hw, h.r);
          if (t >= 0 && t < hitT) {
            hitT = t;
            hitShip = null;
            hitBody = b;
          }
        }
      }

      let hitStatic = false;
      const segLen = _p0.distanceTo(p.position);
      _rel.addVectors(_p0, p.position).multiplyScalar(0.5);
      for (const c of this.grid.query(_rel, segLen / 2 + 1)) {
        const t = c.shape ? (segmentSphere(_p0, p.position, c.center, c.radius) < 0 ? -1 : rayCast(c, _p0, p.position, this.time)) : segmentSphere(_p0, p.position, c.center, c.radius);
        if (t >= 0 && t < hitT) {
          hitT = t;
          hitShip = null;
          hitBody = null;
          hitStatic = true;
        }
      }

      if (hitShip || hitBody || hitStatic) {
        const hitPos = _p0.clone().lerp(p.position, hitT);
        if (hitBody) {
          // The bolt shoves the body a little and damages it.
          this.bodies.wake(hitBody);
          hitBody.dirty = true;
          _push.copy(p.velocity).normalize().multiplyScalar(p.damage * BOLT_PUSH);
          applyImpulse(hitBody, bodyProps(hitBody.kind, hitBody.scale), _push, _r.subVectors(hitPos, hitBody.position));
          this.bodies.damage(hitBody, p.damage);
        }
        if (hitShip) {
          if (hitShip.faction === p.faction) {
            // Player-vs-player hit: both stay "in combat" for the PvP switch-off rule.
            hitShip.lastPvpCombat = this.time;
            const shooter = this.ships.get(p.ownerId);
            if (shooter) shooter.lastPvpCombat = this.time;
          }
          const shield = this.applyDamage(hitShip, p.damage, p.ownerId, partHit(hitShip, hitPos));
          this.events.push({
            type: 'hit',
            target: hitShip.id,
            attacker: p.ownerId,
            projectile: p.id,
            pos: arr(hitPos),
            damage: p.damage,
            shield,
          });
        } else {
          this.events.push({ type: 'impact', projectile: p.id, pos: arr(hitPos) });
        }
        list.splice(i, 1);
        continue;
      }
      if (p.life <= 0) list.splice(i, 1);
    }
  }

  /**
   * Ships and loose bodies against each other: a hash grid of the swept
   * volumes finds the pairs that may touch this tick, then each pair is swept
   * continuously (collide.ts) and shares an impulse by mass. Each side takes
   * damage from its own velocity change. Two sleeping bodies never test each
   * other; frozen bodies (far from players) take no part.
   */
  private collideSolids(dt: number) {
    const cells = this.cells;
    cells.clear();
    const cellOf = (v: number) => Math.floor(v / SHIP_CELL);
    const insert = (e: CellEntry, pos: Vector3, r: number) => {
      const f = e.from;
      const x0 = cellOf(Math.min(f.x, pos.x) - r), x1 = cellOf(Math.max(f.x, pos.x) + r);
      const y0 = cellOf(Math.min(f.y, pos.y) - r), y1 = cellOf(Math.max(f.y, pos.y) + r);
      const z0 = cellOf(Math.min(f.z, pos.z) - r), z1 = cellOf(Math.max(f.z, pos.z) + r);
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++) {
            const key = `${x},${y},${z}`;
            let list = cells.get(key);
            if (!list) cells.set(key, (list = []));
            list.push(e);
          }
    };
    for (const s of this.ships.values()) {
      if (!s.alive) continue;
      insert({ id: s.id, ship: s, body: null, from: this.from.get(s.id) ?? s.position }, s.position, massOf(s.classId).reach);
    }
    for (const b of this.bodies.list.values()) {
      if (!b.active) continue;
      insert({ id: b.id, ship: null, body: b, from: this.bodies.from.get(b.id) ?? b.position }, b.position, bodyProps(b.kind, b.scale).reach);
    }
    const tested = new Set<string>();
    for (const list of cells.values()) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const lo = list[i].id < list[j].id ? list[i] : list[j];
          const hi = lo === list[i] ? list[j] : list[i];
          const key = `${lo.id}:${hi.id}`;
          if (tested.has(key)) continue;
          tested.add(key);
          if (lo.ship && hi.ship) this.shipPair(lo.ship, hi.ship, lo.from, hi.from, key, dt);
          else if (lo.ship || hi.ship) {
            const ship = (lo.ship ?? hi.ship)!;
            const se = lo.ship ? lo : hi;
            const be = lo.ship ? hi : lo;
            this.shipBodyPair(ship, be.body!, se.from, be.from, key, dt);
          } else this.bodyPair(lo.body!, hi.body!, lo.from, hi.from, key, dt);
        }
      }
    }
    // Forget pairs that have not touched for a while.
    if (this.lastPairScrape.size > 256) {
      for (const [k, t] of this.lastPairScrape) if (this.time - t > 5) this.lastPairScrape.delete(k);
    }
  }

  /** True when a grinding contact (no damage) of this pair may report now: once per SCRAPE_EVENT_INTERVAL, from 1.5 m/s. */
  private pairScrape(key: string, speed: number) {
    if (speed < 1.5) return false;
    const last = this.lastPairScrape.get(key) ?? -1;
    return this.time - last >= SCRAPE_EVENT_INTERVAL;
  }

  private shipPair(a: Ship, b: Ship, fa: Vector3, fb: Vector3, key: string, dt: number) {
    if (!a.alive || !b.alive) return;
    const coarse = this.coarse.has(a.id) && this.coarse.has(b.id);
    const c = collideShips(a, b, fa, fb, dt, coarse);
    if (!c) return;
    // The sweeps of later pairs start where this contact left the ships.
    fa.copy(a.position);
    fb.copy(b.position);
    const hardness = contactOf(SHIP_MATERIAL, SHIP_MATERIAL).hardness;
    const damageA = impactDamage(c.dvA, hardness);
    const damageB = impactDamage(c.dvB, hardness);
    // Two hulls grinding: one pair of events now and then, both or none, so clients can pair them.
    if (damageA <= 0 && damageB <= 0 && !this.pairScrape(key, c.speed)) return;
    this.lastPairScrape.set(key, this.time);
    this.shipImpact(c.a, c.b, c.partA, damageA, c.point, c.normal, c.speed);
    this.shipImpact(c.b, c.a, c.partB, damageB, c.point, c.normal.clone().negate(), c.speed);
  }

  /** A ship and a loose body: the body is shoved (and maybe broken), the ship feels its mass. */
  private shipBodyPair(ship: Ship, body: Body, fs: Vector3, fb: Vector3, key: string, dt: number) {
    if (!ship.alive) return;
    const props = bodyProps(body.kind, body.scale);
    const c = collidePair(ship, shipProps(ship, this.coarse.has(ship.id)), body, props, fs, fb, dt);
    if (!c) return;
    fs.copy(ship.position);
    fb.copy(body.position);
    if (c.speed <= 0) return;
    this.bodies.wake(body);
    body.dirty = true;
    const mat = BODY_DEFS[body.kind].material;
    forwardOf(ship.rotation, _fwd);
    const frontal = c.partA === 'cockpit' && _fwd.dot(c.normal) < -0.6;
    let damage = impactDamage(c.dvA, MATERIALS[mat].hardness) * (frontal ? FRONTAL_FACTOR : 1);
    const bodyDamage = impactDamage(c.dvB, MATERIALS[SHIP_MATERIAL].hardness);
    if (damage > 0 || bodyDamage > 0 || this.pairScrape(key, c.speed)) {
      this.lastPairScrape.set(key, this.time);
      const shield = damage > 0 && ship.shield > 0;
      if (shield) damage *= 1 - SHIELD_COLLISION_ABSORB;
      this.events.push({
        type: 'collision',
        ship: ship.id,
        pos: arr2(c.point),
        damage,
        part: c.partA,
        mat,
        n: arr2(c.normal),
        speed: r2(c.speed),
        shield,
        body: body.id,
      });
      if (damage > 0) this.applyDamage(ship, damage, null, c.partA, 1);
    }
    this.bodies.damage(body, bodyDamage);
  }

  /** Two loose bodies knocking together (a shoved crate into the next one). */
  private bodyPair(a: Body, b: Body, fa: Vector3, fb: Vector3, key: string, dt: number) {
    if (a.asleep && b.asleep) return;
    const pa = bodyProps(a.kind, a.scale);
    const pb = bodyProps(b.kind, b.scale);
    const c = collidePair(a, pa, b, pb, fa, fb, dt);
    if (!c) return;
    fa.copy(a.position);
    fb.copy(b.position);
    if (c.speed <= 0) return;
    this.bodies.wake(a);
    this.bodies.wake(b);
    a.dirty = b.dirty = true;
    const damageA = impactDamage(c.dvA, MATERIALS[pb.material].hardness);
    const damageB = impactDamage(c.dvB, MATERIALS[pa.material].hardness);
    if (damageA > 0 || damageB > 0 || this.pairScrape(key, c.speed)) {
      this.lastPairScrape.set(key, this.time);
      this.events.push({ type: 'bodyHit', body: a.id, pos: arr2(c.point), n: arr2(c.normal), speed: r2(c.speed), mat: pb.material, own: pa.material, damage: Math.max(damageA, damageB) });
    }
    this.bodies.damage(a, damageA);
    this.bodies.damage(b, damageB);
  }

  /** A loose body struck the static world: damage from its velocity change, and an event for the clients. */
  private bodyStaticImpact(b: Body, i: StaticContactReport) {
    b.touched = this.time;
    b.dirty = true;
    const damage = impactDamage(i.dv, i.hardness);
    const key = `${b.id}:static`;
    if (damage > 0 || this.pairScrape(key, i.speed)) {
      this.lastPairScrape.set(key, this.time);
      this.events.push({ type: 'bodyHit', body: b.id, pos: arr2(i.point), n: arr2(i.normal), speed: r2(i.speed), mat: i.material, own: BODY_DEFS[b.kind].material, damage });
    }
    this.bodies.damage(b, damage);
  }

  /** One ship's side of a ship-to-ship contact (`damage`: from its own velocity change). */
  private shipImpact(ship: Ship, other: Ship, part: PartId, damage: number, point: Vector3, normal: Vector3, speed: number) {
    const shield = damage > 0 && ship.shield > 0;
    if (shield) damage *= 1 - SHIELD_COLLISION_ABSORB;
    this.events.push({
      type: 'collision',
      ship: ship.id,
      pos: arr2(point),
      damage,
      part,
      mat: 'hull',
      n: arr2(normal),
      speed: r2(speed),
      shield,
      other: other.id,
    });
    if (damage > 0) this.applyDamage(ship, damage, other.id, part, 1);
  }

  /**
   * Applies damage through shields then hull. Returns true if the shield took it.
   * `part`: where the blow landed (v0.8): what gets past the shield also wears
   * that component, at rate `wear` (collisions 1, weapons WEAPON_WEAR).
   */
  applyDamage(ship: Ship, amount: number, attacker: EntityId | null, part?: PartId, wear = WEAPON_WEAR): boolean {
    if (!ship.alive) return false;
    ship.sinceDamage = 0;
    if (attacker !== null) ship.lastAttacker = attacker;
    let absorbedByShield = false;
    if (ship.shield > 0) {
      absorbedByShield = true;
      const s = Math.min(ship.shield, amount);
      ship.shield -= s;
      amount -= s;
    }
    if (amount > 0) {
      const c = part ? componentOf(part) : null;
      if (c) {
        const state = wearComponent(ship, c, amount * wear, statsOf(ship).hull);
        if (state) this.events.push({ type: 'partDamaged', ship: ship.id, part: c, state });
      }
      ship.hull -= amount;
      if (ship.hull <= 0) {
        ship.hull = 0;
        ship.alive = false;
        this.events.push({
          type: 'destroyed',
          ship: ship.id,
          by: attacker ?? ship.lastAttacker,
          pos: arr(ship.position),
          classId: ship.classId,
          faction: ship.faction,
          name: ship.name,
        });
      }
    }
    return absorbedByShield;
  }
}

const _hs = new Vector3();
/** The part of `ship` nearest to a hit at `pos` (bolts are tested against the ship's bounding sphere). */
export function partHit(ship: Ship, pos: Vector3): PartId {
  let best: PartId = 'hull';
  let bestD = Infinity;
  for (const h of HITBOXES[ship.classId]) {
    const d = _hs.copy(h.at).applyQuaternion(ship.rotation).add(ship.position).distanceTo(pos) - h.r;
    if (d < bestD) {
      bestD = d;
      best = h.part;
    }
  }
  return best;
}
