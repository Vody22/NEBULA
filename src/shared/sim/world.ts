import { Quaternion, Vector3 } from 'three';
import { segmentSphere } from '../math';
import { SHIP_CLASSES } from './shipClasses';
import { stepShipPhysics } from './shipPhysics';
import { StaticGrid } from './spatialGrid';
import type { EntityId, FactionId, Projectile, Ship, ShipClassId, ShipInput, SimEvent } from './types';
import { neutralInput } from './types';
import type { ZoneDef } from './zone';

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

const _p0 = new Vector3();
const _muzzle = new Vector3();
const _dir = new Vector3();
const _n = new Vector3();
const _rel = new Vector3();

const arr = (v: Vector3): [number, number, number] => [v.x, v.y, v.z];

export interface SpawnOptions {
  classId: ShipClassId;
  faction: FactionId;
  name: string;
  position: Vector3;
  rotation?: Quaternion;
  velocity?: Vector3;
  ownerId?: string | null;
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

  constructor(readonly zone: ZoneDef) {
    this.grid = new StaticGrid(zone.colliders);
  }

  spawnShip(o: SpawnOptions): Ship {
    const cls = SHIP_CLASSES[o.classId];
    const ship: Ship = {
      id: this.nextId++,
      name: o.name,
      classId: o.classId,
      faction: o.faction,
      ownerId: o.ownerId ?? null,
      position: o.position.clone(),
      velocity: o.velocity?.clone() ?? new Vector3(),
      rotation: o.rotation?.clone() ?? new Quaternion(),
      angularVelocity: new Vector3(),
      hull: cls.hull,
      shield: cls.shield,
      energy: cls.energy,
      alive: true,
      boosting: false,
      input: neutralInput(),
      weaponCooldown: 0,
      nextHardpoint: 0,
      sinceDamage: 999,
      lastAttacker: null,
    };
    this.ships.set(ship.id, ship);
    this.events.push({ type: 'spawned', ship: ship.id });
    return ship;
  }

  removeShip(id: EntityId) {
    this.ships.delete(id);
  }

  setInput(id: EntityId, input: ShipInput) {
    const ship = this.ships.get(id);
    if (ship) Object.assign(ship.input, input);
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

    for (const ship of this.ships.values()) {
      if (!ship.alive) continue;
      stepShipPhysics(ship, dt);
      this.updateSystems(ship, dt);
      this.fireWeapons(ship, dt);
    }
    this.collideShips();
    this.stepProjectiles(dt);

    for (const ship of [...this.ships.values()]) {
      if (!ship.alive) this.ships.delete(ship.id);
    }
  }

  private updateSystems(ship: Ship, dt: number) {
    const cls = SHIP_CLASSES[ship.classId];
    ship.sinceDamage += dt;
    if (ship.sinceDamage > cls.shieldDelay) {
      ship.shield = Math.min(cls.shield, ship.shield + cls.shieldRegen * dt);
    }
    if (!ship.boosting) {
      ship.energy = Math.min(cls.energy, ship.energy + cls.energyRegen * dt);
    }

    // Static collisions: push out along the normal and take damage from impact speed.
    const nearby = this.grid.query(ship.position, cls.radius + 2);
    for (const c of nearby) {
      _n.subVectors(ship.position, c.center);
      const dist = _n.length();
      const minDist = c.radius + cls.radius;
      if (dist >= minDist || dist < 1e-6) continue;
      _n.divideScalar(dist);
      ship.position.copy(c.center).addScaledVector(_n, minDist + 0.05);
      const vn = ship.velocity.dot(_n);
      if (vn < 0) {
        // Bounce with restitution 0.35, lose some tangential speed too.
        ship.velocity.addScaledVector(_n, -vn * 1.35).multiplyScalar(0.8);
        const impact = -vn;
        if (impact > 25) {
          const damage = (impact - 25) * 0.9;
          this.events.push({ type: 'collision', ship: ship.id, pos: arr(ship.position), damage });
          this.applyDamage(ship, damage, null);
        }
      }
    }
  }

  private fireWeapons(ship: Ship, dt: number) {
    const w = SHIP_CLASSES[ship.classId].weapon;
    ship.weaponCooldown = Math.max(0, ship.weaponCooldown - dt);
    if (!ship.input.fire || ship.weaponCooldown > 0 || ship.energy < w.energyCost) return;

    ship.weaponCooldown += w.interval;
    ship.energy -= w.energyCost;
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
        if (!ship.alive || ship.id === p.ownerId || ship.faction === p.faction) continue;
        const r = SHIP_CLASSES[ship.classId].radius;
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
        const t = segmentSphere(_p0, p.position, c.center, c.radius);
        if (t >= 0 && t < hitT) {
          hitT = t;
          hitShip = null;
          hitStatic = true;
        }
      }

      if (hitShip || hitStatic) {
        const hitPos = _p0.clone().lerp(p.position, hitT);
        if (hitShip) {
          const shield = this.applyDamage(hitShip, p.damage, p.ownerId);
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

  private collideShips() {
    const ships = [...this.ships.values()];
    for (let i = 0; i < ships.length; i++) {
      const a = ships[i];
      if (!a.alive) continue;
      const ra = SHIP_CLASSES[a.classId].radius;
      for (let j = i + 1; j < ships.length; j++) {
        const b = ships[j];
        if (!b.alive) continue;
        const rb = SHIP_CLASSES[b.classId].radius;
        _n.subVectors(a.position, b.position);
        const d = _n.length();
        const min = ra + rb;
        if (d >= min || d < 1e-6) continue;
        _n.divideScalar(d);
        const push = (min - d) / 2;
        a.position.addScaledVector(_n, push);
        b.position.addScaledVector(_n, -push);
        _rel.subVectors(a.velocity, b.velocity);
        const vn = _rel.dot(_n);
        if (vn < 0) {
          a.velocity.addScaledVector(_n, -vn * 0.6);
          b.velocity.addScaledVector(_n, vn * 0.6);
          const impact = -vn;
          if (impact > 30) {
            const dmg = (impact - 30) * 0.6;
            this.applyDamage(a, dmg, b.id);
            this.applyDamage(b, dmg, a.id);
            this.events.push({ type: 'collision', ship: a.id, pos: arr(a.position), damage: dmg });
          }
        }
      }
    }
  }

  /** Applies damage through shields then hull. Returns true if the shield took it. */
  applyDamage(ship: Ship, amount: number, attacker: EntityId | null): boolean {
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
