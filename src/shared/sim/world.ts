import { Quaternion, Vector3 } from 'three';
import { segmentSphere } from '../math';
import { collideShips, impactDamage, type StaticContactReport } from '../physics/collide';
import { componentOf, WEAPON_WEAR, wearComponent } from '../physics/damage';
import { HITBOXES, massOf, type PartId } from '../physics/hitboxes';
import { contactOf, SHIP_MATERIAL } from '../physics/materials';
import { rayCast } from '../physics/shapes';
import { stepMining } from './mining';
import { stepShipPhysics } from './shipPhysics';
import { stepShipSystems } from './shipSystems';
import { StaticGrid } from './spatialGrid';
import type { EntityId, FactionId, Projectile, Ship, ShipClassId, ShipInput, SimEvent } from './types';
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
/** Cell size of the broad phase between ships (m). */
const SHIP_CELL = 80;

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
  private shipCells = new Map<string, Ship[]>();

  constructor(readonly zone: ZoneDef) {
    this.grid = new StaticGrid(zone.colliders);
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
    this.collideShips(dt);
    this.stepProjectiles(dt);

    for (const ship of [...this.ships.values()]) {
      if (!ship.alive) this.removeShip(ship.id);
    }
  }

  /**
   * Physics level of detail: ships farther than PHYSICS_LOD_RANGE from every
   * player collide as a single sphere. Near a player, every ship uses its
   * full set of hit spheres.
   */
  private physicsLod() {
    this.coarse.clear();
    const players = [...this.ships.values()].filter((s) => s.ownerId !== null);
    const r2 = PHYSICS_LOD_RANGE * PHYSICS_LOD_RANGE;
    for (const s of this.ships.values()) {
      if (s.ownerId !== null) continue;
      if (!players.some((p) => p.position.distanceToSquared(s.position) < r2)) this.coarse.add(s.id);
    }
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

      let hitStatic = false;
      const segLen = _p0.distanceTo(p.position);
      _rel.addVectors(_p0, p.position).multiplyScalar(0.5);
      for (const c of this.grid.query(_rel, segLen / 2 + 1)) {
        const t = c.shape ? (segmentSphere(_p0, p.position, c.center, c.radius) < 0 ? -1 : rayCast(c, _p0, p.position, this.time)) : segmentSphere(_p0, p.position, c.center, c.radius);
        if (t >= 0 && t < hitT) {
          hitT = t;
          hitShip = null;
          hitStatic = true;
        }
      }

      if (hitShip || hitStatic) {
        const hitPos = _p0.clone().lerp(p.position, hitT);
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
   * Ship against ship: a hash grid of the swept volumes finds the pairs that
   * may touch this tick, then each pair is swept continuously (collide.ts).
   * Both ships take damage from their own velocity change.
   */
  private collideShips(dt: number) {
    const cells = this.shipCells;
    for (const list of cells.values()) list.length = 0;
    const cellOf = (v: number) => Math.floor(v / SHIP_CELL);
    for (const s of this.ships.values()) {
      if (!s.alive) continue;
      const from = this.from.get(s.id) ?? s.position;
      const r = massOf(s.classId).reach;
      const x0 = cellOf(Math.min(from.x, s.position.x) - r), x1 = cellOf(Math.max(from.x, s.position.x) + r);
      const y0 = cellOf(Math.min(from.y, s.position.y) - r), y1 = cellOf(Math.max(from.y, s.position.y) + r);
      const z0 = cellOf(Math.min(from.z, s.position.z) - r), z1 = cellOf(Math.max(from.z, s.position.z) + r);
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++) {
            const key = `${x},${y},${z}`;
            let list = cells.get(key);
            if (!list) cells.set(key, (list = []));
            list.push(s);
          }
    }
    const tested = new Set<number>();
    for (const list of cells.values()) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i].id < list[j].id ? list[i] : list[j];
          const b = a === list[i] ? list[j] : list[i];
          const key = a.id * 1048576 + b.id;
          if (tested.has(key) || !a.alive || !b.alive) continue;
          tested.add(key);
          const fa = this.from.get(a.id) ?? a.position;
          const fb = this.from.get(b.id) ?? b.position;
          const coarse = this.coarse.has(a.id) && this.coarse.has(b.id);
          const c = collideShips(a, b, fa, fb, dt, coarse);
          if (!c) continue;
          // The sweeps of later pairs start where this contact left the ships.
          fa.copy(a.position);
          fb.copy(b.position);
          this.shipImpact(c.a, c.b, c.partA, c.dvA, c.point, c.normal, c.speed);
          this.shipImpact(c.b, c.a, c.partB, c.dvB, c.point, c.normal.clone().negate(), c.speed);
        }
      }
    }
  }

  private shipImpact(ship: Ship, other: Ship, part: PartId, dv: number, point: Vector3, normal: Vector3, speed: number) {
    let damage = impactDamage(dv, contactOf(SHIP_MATERIAL, SHIP_MATERIAL).hardness);
    if (damage <= 0 && speed < 1.5) return;
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
