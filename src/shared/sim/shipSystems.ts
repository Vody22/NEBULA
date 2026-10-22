import { Vector3 } from 'three';
import { SHIP_CLASSES } from './shipClasses';
import type { StaticGrid } from './spatialGrid';
import type { Ship } from './types';

/** Energy recharges only after the guns have been silent this long (s). */
export const ENERGY_REGEN_DELAY = 0.6;
/** After emptying the capacitor, guns come back online at this energy fraction. */
export const WEAPON_UNLOCK_FRACTION = 0.3;

const _n = new Vector3();

/**
 * Per-tick ship systems shared by the server and client-side prediction:
 * shield and energy regeneration, weapon unlock, and static collisions
 * (push out + bounce). `onImpact` receives the hull damage of a hard hit.
 */
export function stepShipSystems(ship: Ship, dt: number, grid: StaticGrid, onImpact?: (damage: number) => void) {
  const cls = SHIP_CLASSES[ship.classId];
  ship.sinceDamage += dt;
  if (ship.sinceDamage > cls.shieldDelay) {
    ship.shield = Math.min(cls.shield, ship.shield + cls.shieldRegen * dt);
  }
  ship.sinceFire += dt;
  if (!ship.boosting && ship.sinceFire > ENERGY_REGEN_DELAY) {
    ship.energy = Math.min(cls.energy, ship.energy + cls.energyRegen * dt);
  }
  if (ship.weaponsLocked && ship.energy >= cls.energy * WEAPON_UNLOCK_FRACTION) ship.weaponsLocked = false;
  resolveStaticCollisions(ship, grid, onImpact);
}

/** Static collisions: push out along the normal and take damage from impact speed. */
export function resolveStaticCollisions(ship: Ship, grid: StaticGrid, onImpact?: (damage: number) => void) {
  const cls = SHIP_CLASSES[ship.classId];
  const nearby = grid.query(ship.position, cls.radius + 2);
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
      if (impact > 25) onImpact?.((impact - 25) * 0.9);
    }
  }
}
