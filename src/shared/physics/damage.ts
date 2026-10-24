import type { Ship } from '../sim/types';
import { COMPONENT_IDS, type ComponentId, type PartId } from './hitboxes';

/**
 * Localised damage (v0.8). A blow takes hull points (the structure, which
 * destroys the ship at zero) and wears the component that took it. Each
 * component has its own health, 0..1, and degrades the ship in flight:
 *
 * - engines: less thrust and top speed, no boost under 30 %, and at zero the
 *   main drive is out (manoeuvring thrusters only, 30 %);
 * - wings: slower turns, and an uneven pair pulls the ship into a roll and a
 *   yaw toward the damaged side (flight assist cancels most of the pull);
 * - cockpit: cracked canopy, then damaged systems: slower shield and
 *   capacitor recharge.
 *
 * Components are repaired at a station with the hull. The same factors run
 * on the server and in client-side prediction.
 */

/** Each component's health pool, as a share of the ship's maximum hull. */
export const COMPONENT_HP: Record<ComponentId, number> = {
  cockpit: 0.45,
  wingL: 0.5,
  wingR: 0.5,
  engines: 0.55,
};

/** Names shown to the player. */
export const COMPONENT_LABELS: Record<ComponentId, string> = {
  cockpit: 'Cockpit',
  wingL: 'Aile gauche',
  wingR: 'Aile droite',
  engines: 'Moteurs',
};

/** A component under this health counts as damaged (warnings, smoke). */
export const DAMAGED_BELOW = 0.5;

/** Weapon hits wear the component they strike at this rate (collisions: 1). */
export const WEAPON_WEAR = 0.5;

/** The component a hit on `part` wears; the structure has none. */
export function componentOf(part: PartId): ComponentId | null {
  return part === 'hull' ? null : part;
}

/**
 * Wears component `c` by `damage` hull points (`hullMax`: the ship's maximum
 * hull). Returns the new state when it crosses a threshold.
 */
export function wearComponent(ship: Ship, c: ComponentId, damage: number, hullMax: number): 'damaged' | 'destroyed' | null {
  const before = ship.parts[c];
  if (before <= 0 || damage <= 0) return null;
  const after = Math.max(0, before - damage / (hullMax * COMPONENT_HP[c]));
  ship.parts[c] = after;
  if (after <= 0) return 'destroyed';
  if (before >= DAMAGED_BELOW && after < DAMAGED_BELOW) return 'damaged';
  return null;
}

export interface FlightFactors {
  /** Main drive thrust and top speed multiplier. */
  thrust: number;
  boost: boolean;
  /** Turn rate multiplier. */
  turn: number;
  /** Uncommanded roll and yaw (rad/s, local frame) from an uneven pair of wings. */
  rollPull: number;
  yawPull: number;
  shieldRegen: number;
  energyRegen: number;
}

const ramp = (h: number, full: number, floor: number) => (h >= full ? 1 : floor + (1 - floor) * (h / full));

export function flightFactors(ship: Ship): FlightFactors {
  const p = ship.parts;
  const thrust = p.engines > 0 ? ramp(p.engines, 0.6, 0.45) : 0.3;
  const weakWing = Math.min(p.wingL, p.wingR);
  // Positive when the left wing is the weaker one: roll left wing down, yaw left.
  const uneven = p.wingR - p.wingL;
  const assist = ship.input.flightAssist ? 0.35 : 1;
  return {
    thrust,
    boost: p.engines >= 0.3,
    turn: ramp(weakWing, 0.7, 0.55),
    rollPull: 0.35 * uneven * assist,
    yawPull: 0.12 * uneven * assist,
    shieldRegen: ramp(p.cockpit, 0.6, 0.35),
    energyRegen: ramp(p.cockpit, 0.6, 0.6),
  };
}

/** True when every component is intact (most ships, most of the time). */
export function allIntact(ship: Pick<Ship, 'parts'>): boolean {
  const p = ship.parts;
  return p.cockpit >= 1 && p.wingL >= 1 && p.wingR >= 1 && p.engines >= 1;
}

/** Credits per hull-equivalent point of component repair (hull plating costs REPAIR_COST, 2). */
export const COMPONENT_REPAIR_COST = 1;

/** Price of restoring every component of a ship (`hullMax`: its maximum hull), in whole credits. */
export function componentRepairCost(parts: Record<ComponentId, number>, hullMax: number): number {
  let points = 0;
  for (const c of COMPONENT_IDS) points += (1 - Math.max(0, Math.min(1, parts[c]))) * hullMax * COMPONENT_HP[c];
  return Math.ceil(points * COMPONENT_REPAIR_COST - 1e-9);
}

/** Component health read back from untrusted data (a save): null when intact or not understood. */
export function cleanParts(raw: unknown): Record<ComponentId, number> | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out = {} as Record<ComponentId, number>;
  for (const c of COMPONENT_IDS) {
    const v = o[c];
    out[c] = typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000 : 1;
  }
  return allIntact({ parts: out }) ? null : out;
}
