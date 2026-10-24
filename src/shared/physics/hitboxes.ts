import { Vector3 } from 'three';
import type { ShipClassId } from '../sim/types';

/**
 * Ship collision bodies (v0.8). Each class is a cluster of spheres fitted to
 * its 3D model (local frame: forward −Z, up +Y, right +X; extents measured on
 * the models in ShipModels.ts), every sphere belonging to one damageable part.
 * The spheres hug the flat hulls far closer than the old single sphere, tell
 * which part took a hit, and give the lever arm that makes a ship spin when
 * it clips a wing.
 */
export const PART_IDS = ['cockpit', 'hull', 'wingL', 'wingR', 'engines'] as const;
export type PartId = (typeof PART_IDS)[number];
/** Parts with their own health; the structure ('hull') is the ship's hull points. */
export const COMPONENT_IDS = ['cockpit', 'wingL', 'wingR', 'engines'] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

export interface HitSphere {
  part: PartId;
  at: Vector3;
  r: number;
}

const s = (part: PartId, x: number, y: number, z: number, r: number): HitSphere => ({ part, at: new Vector3(x, y, z), r });
/** The same sphere on both sides: left wing at −x, right wing at +x. */
const wings = (x: number, y: number, z: number, r: number) => [s('wingL', -x, y, z, r), s('wingR', x, y, z, r)];

export const HITBOXES: Record<ShipClassId, HitSphere[]> = {
  // 16.4 m span, 19.7 m long, flat (−1.3..3.5 m): canards with gun pods, swept wings aft, twin engines and a tail fin.
  falcon: [
    s('cockpit', 0, 0.6, -6, 2.3),
    s('cockpit', 0, 0, -8.8, 1.3),
    s('hull', 0, 0.2, -1.5, 2.6),
    s('hull', 0, 0.4, 3, 2.6),
    ...wings(4.6, -0.4, -4.6, 1.4),
    ...wings(4.6, 0, 2.6, 1.8),
    ...wings(6.8, 0, 3.6, 1.4),
    s('engines', -2.3, 0, 7.8, 1.7),
    s('engines', 2.3, 0, 7.8, 1.7),
    s('engines', 0, 2.3, 7.6, 1.2),
  ],
  // 11.6 m span, 18.2 m long hauler: a thick body, stub wings, three engines.
  warden: [
    s('cockpit', 0, 0.5, -5.5, 2.4),
    s('cockpit', 0, 0, -7.6, 1.1),
    s('hull', 0, 0.3, -1, 3),
    s('hull', 0, 0.6, 3.5, 3),
    ...wings(4.4, 0.2, -3, 1.4),
    ...wings(4.4, 0.4, 2.5, 1.6),
    s('engines', 0, 0.4, 7.8, 2.4),
    s('engines', 0, 2.3, 7.2, 1.2),
  ],
  // 14 m span, 17.6 m long, very flat: forward-swept blades, a single engine block.
  raider: [
    s('cockpit', 0, 0.3, -5, 1.8),
    s('cockpit', 0, 0, -6.7, 0.8),
    s('hull', 0, 0, -0.5, 2.4),
    s('hull', 0, 0, 4, 2.3),
    ...wings(4.4, 0, -3.2, 1.5),
    ...wings(6.2, 0, -3.8, 1),
    ...wings(3.6, 0, 1.5, 1.4),
    s('engines', 0, 0, 8.4, 2.2),
  ],
  // 17 m span, 28.9 m long gunship: wide armoured body, four engines, a dorsal fin.
  marauder: [
    s('cockpit', 0, 1, -11.5, 2.6),
    s('cockpit', 0, 0, -14, 1.4),
    s('hull', 0, 0.5, -6, 3.4),
    s('hull', 0, 0.5, 0, 3.4),
    s('hull', 0, 0.6, 6, 3.4),
    s('hull', 0, 4, 6, 1.3),
    ...wings(6.2, 0.2, -6, 2.4),
    ...wings(6.3, 0.2, 0, 2.4),
    ...wings(6.2, 0, 5, 2.2),
    s('engines', -2.4, 0, 11.6, 2),
    s('engines', 2.4, 0, 11.6, 2),
    s('engines', -7, -1, 8.4, 1.4),
    s('engines', 7, -1, 8.4, 1.4),
  ],
};

/** Mass of each class (t). */
export const SHIP_MASS: Record<ShipClassId, number> = {
  falcon: 28,
  warden: 36,
  raider: 18,
  marauder: 70,
};

export interface MassProps {
  mass: number;
  /** Principal moments of inertia in the local frame (t·m²). */
  inertia: Vector3;
  /** Radius of the sphere around the ship's origin that holds all its hit spheres (m). */
  reach: number;
}

const massCache = new Map<ShipClassId, MassProps>();

/**
 * Mass and inertia of a class: the mass spread over its spheres in
 * proportion to their volume, each a solid ball at its offset. Long, wide
 * ships are slow to start spinning and slow to stop.
 */
export function massOf(classId: ShipClassId): MassProps {
  let m = massCache.get(classId);
  if (m) return m;
  const spheres = HITBOXES[classId];
  const mass = SHIP_MASS[classId];
  const vol = spheres.reduce((a, h) => a + h.r ** 3, 0);
  const inertia = new Vector3();
  for (const h of spheres) {
    const mi = (mass * h.r ** 3) / vol;
    const own = 0.4 * mi * h.r * h.r;
    const { x, y, z } = h.at;
    inertia.x += own + mi * (y * y + z * z);
    inertia.y += own + mi * (x * x + z * z);
    inertia.z += own + mi * (x * x + y * y);
  }
  const reach = Math.max(...spheres.map((h) => h.at.length() + h.r));
  m = { mass, inertia, reach };
  massCache.set(classId, m);
  return m;
}
