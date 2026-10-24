/**
 * Physical materials (v0.8). Every solid thing in a sector has one: it decides
 * how a ship bounces off it, how much it slides, how hard the hit is on the
 * hull, and which sound and sparks the client plays. Shared by the server and
 * client-side prediction, so both bounce the same way.
 */
export type MaterialId = 'rock' | 'metalRock' | 'ice' | 'metal' | 'hull' | 'debris';

export interface Material {
  /** Coefficient of restitution against a ship's hull (0 = dead stop, 1 = perfect bounce). */
  restitution: number;
  /** Coulomb friction coefficient: how much a grazing hit brakes the slide. */
  friction: number;
  /** Damage multiplier of an impact at a given speed (metal plating hurts more than ice). */
  hardness: number;
  /** Density (t/m³) of loose objects made of it, for their mass. */
  density: number;
  /** Shown in the HUD and the docs. */
  label: string;
}

export const MATERIALS: Record<MaterialId, Material> = {
  // Carbonaceous and silicate rock: dull, crumbly, a fair grip.
  rock: { restitution: 0.25, friction: 0.55, hardness: 0.9, density: 2.4, label: 'roche' },
  // Iron-nickel asteroids: harder and bouncier.
  metalRock: { restitution: 0.35, friction: 0.45, hardness: 1.05, density: 5, label: 'roche métallique' },
  // Ice: soft, slippery, absorbs part of the blow.
  ice: { restitution: 0.15, friction: 0.08, hardness: 0.65, density: 0.9, label: 'glace' },
  // Station plating and structures.
  metal: { restitution: 0.4, friction: 0.3, hardness: 1.0, density: 3, label: 'métal' },
  // Another ship's hull.
  hull: { restitution: 0.35, friction: 0.35, hardness: 0.85, density: 0.4, label: 'coque' },
  // Loose wreckage and rock chips: light, they mostly get pushed away.
  debris: { restitution: 0.3, friction: 0.4, hardness: 0.6, density: 2, label: 'débris' },
};

/** A ship's own plating, the other side of every contact. */
export const SHIP_MATERIAL: MaterialId = 'hull';

/** Restitution, friction and hardness of a ship's hull (`a`) striking material `b`. */
export function contactOf(a: MaterialId, b: MaterialId) {
  const ma = MATERIALS[a];
  const mb = MATERIALS[b];
  return {
    restitution: Math.min(ma.restitution, mb.restitution),
    friction: Math.sqrt(ma.friction * mb.friction),
    hardness: mb.hardness,
  };
}

export function isMaterialId(v: unknown): v is MaterialId {
  return typeof v === 'string' && v in MATERIALS;
}
