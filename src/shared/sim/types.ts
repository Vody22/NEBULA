import type { Quaternion, Vector3 } from 'three';
import type { ComponentId, PartId } from '../physics/hitboxes';
import type { MaterialId } from '../physics/materials';
import type { Shape } from '../physics/shapes';
import type { ShipMods } from './upgrades';

export type EntityId = number;
export type FactionId = 'union' | 'raiders';
export type ShipClassId = 'falcon' | 'raider' | 'marauder' | 'warden';

/**
 * Everything a pilot (human or AI) can command for one tick.
 * The authoritative simulation consumes only this, which keeps the client
 * thin and makes input-replay prediction possible later.
 */
export interface ShipInput {
  /** Throttle setting, -0.4 (reverse) .. 1. Absolute, held by the pilot. */
  throttle: number;
  /** Lateral thrusters, -1..1 (right / up). */
  strafeX: number;
  strafeY: number;
  /** Rotation requests, -1..1. pitch+ = nose up, yaw+ = right, roll+ = right wing down. */
  pitch: number;
  yaw: number;
  roll: number;
  boost: boolean;
  fire: boolean;
  /** Flight assist: kills drift and holds the throttle speed. Off = pure Newtonian. */
  flightAssist: boolean;
  /** Mining beam held on (straight ahead, see mining.ts). */
  mine: boolean;
}

export const neutralInput = (): ShipInput => ({
  throttle: 0,
  strafeX: 0,
  strafeY: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  boost: false,
  fire: false,
  flightAssist: true,
  mine: false,
});

export interface Ship {
  id: EntityId;
  name: string;
  classId: ShipClassId;
  /** Upgrade levels (v0.5); all zero for NPCs. Read the effective stats with statsOf(ship). */
  mods: ShipMods;
  faction: FactionId;
  /** Player session id for human-controlled ships, null for NPCs. */
  ownerId: string | null;
  position: Vector3;
  velocity: Vector3;
  rotation: Quaternion;
  /** Local-frame angular velocity (rad/s): x = pitch, y = yaw, z = roll axis. */
  angularVelocity: Vector3;
  /** Spin knocked into the ship by collisions (local frame, rad/s), on top of the piloted rotation; the stabilisers damp it (v0.8). */
  spin: Vector3;
  /** Health of the damageable components, 0..1 (v0.8). The structure is `hull`. */
  parts: Record<ComponentId, number>;
  hull: number;
  shield: number;
  energy: number;
  alive: boolean;
  boosting: boolean;
  input: ShipInput;
  /** Seconds until each weapon may fire again. */
  weaponCooldown: number;
  nextHardpoint: number;
  /** Seconds since the last damage taken (drives shield regen delay). */
  sinceDamage: number;
  /** Seconds since the last shot (energy only recharges once the guns rest). */
  sinceFire: number;
  /** Capacitor emptied: guns stay offline until energy recovers to 30 %. */
  weaponsLocked: boolean;
  /** Last entity that damaged us (kill credit). */
  lastAttacker: EntityId | null;
  /** Player opted into PvP: other PvP-flagged players can damage this ship. */
  pvp: boolean;
  /** Sim time of the last PvP damage dealt or taken (PvP cannot be switched off mid-fight). */
  lastPvpCombat: number;
  /** Index of the asteroid under the mining beam (zone.asteroids), null when not mining. */
  mining: number | null;
  /** Ore mined but not yet a whole unit. */
  mineProgress: number;
}

export interface Projectile {
  id: EntityId;
  ownerId: EntityId;
  faction: FactionId;
  position: Vector3;
  velocity: Vector3;
  damage: number;
  life: number;
  /** Fired by a PvP-flagged player: may also hit other PvP-flagged players. */
  pvp: boolean;
}

/** Who may damage whom. NPC factions fight each other; players only fight players who both opted into PvP. */
export function canDamage(attacker: { id: EntityId; faction: FactionId; pvp: boolean; ownerId?: string | null }, target: Ship): boolean {
  if (attacker.id === target.id) return false;
  if (attacker.faction !== target.faction) return true;
  return attacker.pvp && target.pvp && target.ownerId !== null;
}

export interface StaticCollider {
  kind: 'asteroid' | 'station' | 'planet';
  /** Origin of the shape (world). */
  center: Vector3;
  /** Bounding sphere around `center`: the exact shape when `shape` is absent. */
  radius: number;
  material: MaterialId;
  /** Exact shape in the collider's frame (v0.8); absent = a sphere of `radius`. */
  shape?: Shape;
  /** Orientation of the shape (absent = world axes). */
  rot?: Quaternion;
  /** Turning parts (the habitat ring): rad/s about the world Y axis through `center`. */
  spin?: number;
  /** Asteroids: index in zone.asteroids. */
  index?: number;
}

/** A fresh set of components. */
export const intactParts = (): Record<ComponentId, number> => ({ cockpit: 1, wingL: 1, wingR: 1, engines: 1 });

export type SimEvent =
  | { type: 'shot'; shooter: EntityId; projectile: EntityId; faction: FactionId; pos: [number, number, number]; vel: [number, number, number]; life: number }
  | { type: 'hit'; target: EntityId; attacker: EntityId; projectile: EntityId; pos: [number, number, number]; damage: number; shield: boolean }
  | { type: 'impact'; projectile: EntityId; pos: [number, number, number] }
  /**
   * A ship struck something (v0.8: with the part hit, the material, the contact normal,
   * the closing speed, and whether its shield took the blow). `other`: the ship it hit.
   */
  | {
      type: 'collision';
      ship: EntityId;
      pos: [number, number, number];
      damage: number;
      part?: PartId;
      mat?: MaterialId;
      n?: [number, number, number];
      speed?: number;
      shield?: boolean;
      other?: EntityId;
    }
  /** A component fell below a damage threshold (v0.8): 'damaged' under 50 %, 'destroyed' at 0. */
  | { type: 'partDamaged'; ship: EntityId; part: ComponentId; state: 'damaged' | 'destroyed' }
  | { type: 'destroyed'; ship: EntityId; by: EntityId | null; pos: [number, number, number]; classId: ShipClassId; faction: FactionId; name: string }
  | { type: 'spawned'; ship: EntityId }
  /** A ship left the sector by hyperspace jump (v0.7): it is gone from the next snapshot. */
  | { type: 'jumpOut'; ship: EntityId; pos: [number, number, number]; classId: ShipClassId }
  /** A ship arrived by hyperspace jump. */
  | { type: 'jumpIn'; ship: EntityId; pos: [number, number, number]; classId: ShipClassId };
