import type { Quaternion, Vector3 } from 'three';

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
});

export interface Ship {
  id: EntityId;
  name: string;
  classId: ShipClassId;
  faction: FactionId;
  /** Player session id for human-controlled ships, null for NPCs. */
  ownerId: string | null;
  position: Vector3;
  velocity: Vector3;
  rotation: Quaternion;
  /** Local-frame angular velocity (rad/s): x = pitch, y = yaw, z = roll axis. */
  angularVelocity: Vector3;
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
  center: Vector3;
  radius: number;
}

export type SimEvent =
  | { type: 'shot'; shooter: EntityId; projectile: EntityId; faction: FactionId; pos: [number, number, number]; vel: [number, number, number]; life: number }
  | { type: 'hit'; target: EntityId; attacker: EntityId; projectile: EntityId; pos: [number, number, number]; damage: number; shield: boolean }
  | { type: 'impact'; projectile: EntityId; pos: [number, number, number] }
  | { type: 'collision'; ship: EntityId; pos: [number, number, number]; damage: number }
  | { type: 'destroyed'; ship: EntityId; by: EntityId | null; pos: [number, number, number]; classId: ShipClassId; faction: FactionId; name: string }
  | { type: 'spawned'; ship: EntityId };
