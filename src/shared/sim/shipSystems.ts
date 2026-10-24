import type { Vector3 } from 'three';
import { collideStatic, type StaticContactReport } from '../physics/collide';
import { flightFactors } from '../physics/damage';
import { statsOf } from './upgrades';
import type { StaticGrid } from './spatialGrid';
import type { Ship } from './types';

/** Energy recharges only after the guns have been silent this long (s). */
export const ENERGY_REGEN_DELAY = 0.6;
/** After emptying the capacitor, guns come back online at this energy fraction. */
export const WEAPON_UNLOCK_FRACTION = 0.3;

/**
 * Per-tick ship systems shared by the server and client-side prediction:
 * shield and energy regeneration, weapon unlock, and collisions with the
 * static world (v0.8: continuous sweep from `from`, the ship's position
 * before this tick's move, with a rigid-body bounce). `onImpact` receives
 * each contact; the server turns it into damage.
 */
export function stepShipSystems(
  ship: Ship,
  dt: number,
  grid: StaticGrid,
  from: Vector3,
  onImpact?: (i: StaticContactReport) => void,
  coarse = false,
) {
  const cls = statsOf(ship);
  const f = flightFactors(ship);
  ship.sinceDamage += dt;
  if (ship.sinceDamage > cls.shieldDelay) {
    ship.shield = Math.min(cls.shield, ship.shield + cls.shieldRegen * f.shieldRegen * dt);
  }
  ship.sinceFire += dt;
  if (!ship.boosting && ship.sinceFire > ENERGY_REGEN_DELAY) {
    ship.energy = Math.min(cls.energy, ship.energy + cls.energyRegen * f.energyRegen * dt);
  }
  if (ship.weaponsLocked && ship.energy >= cls.energy * WEAPON_UNLOCK_FRACTION) ship.weaponsLocked = false;
  collideStatic(ship, from, dt, grid, onImpact, coarse);
}
