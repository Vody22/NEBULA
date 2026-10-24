import { Vector3 } from 'three';
import type { SolidProps } from './collide';
import type { HitSphere } from './hitboxes';
import type { MaterialId } from './materials';

/**
 * Loose bodies (v0.8): solid things that float free and move when struck.
 * Cargo moored around the stations, the wreckage a destroyed ship leaves,
 * boulders at the edge of the belts. The server simulates them like ships
 * (inertia, spin, collisions with the world, with ships and with each other,
 * damage) and lets them sleep when they come to rest; far from every player
 * they are frozen. Clients draw them from snapshots.
 */
export const BODY_KINDS = ['crate', 'container', 'wreck', 'boulder'] as const;
export type BodyKind = (typeof BODY_KINDS)[number];

export interface BodyDef {
  /** Shown in the HUD and the docs. */
  label: string;
  material: MaterialId;
  /** Mass at scale 1 (t). */
  mass: number;
  /** Structure points at scale 1: the damage that breaks it. */
  hp: number;
  /** Collision spheres at scale 1 (local frame). */
  spheres: HitSphere[];
  /** Half extents of the model at scale 1 (m). */
  half: [number, number, number];
}

const s = (x: number, y: number, z: number, r: number): HitSphere => ({ part: 'hull', at: new Vector3(x, y, z), r });

/** Spheres of radius r along the edges of a box of half height hy and half depth hz, at each x in `xs`. */
function edges(xs: number[], hy: number, hz: number, r: number): HitSphere[] {
  const out: HitSphere[] = [];
  for (const x of xs) for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push(s(x, sy * (hy - r), sz * (hz - r), r));
  return out;
}

export const BODY_DEFS: Record<BodyKind, BodyDef> = {
  // A 2.4 m cargo crate, loaded: light enough to be shoved aside by a fighter.
  crate: {
    label: 'caisse de fret',
    material: 'metal',
    mass: 1.5,
    hp: 50,
    spheres: [s(0, 0, 0, 1.2), ...edges([-0.7, 0.7], 1.2, 1.2, 0.5)],
    half: [1.2, 1.2, 1.2],
  },
  // A 6 m freight container: about a third of a fighter's mass.
  container: {
    label: 'conteneur',
    material: 'metal',
    mass: 10,
    hp: 400,
    spheres: [s(-1.7, 0, 0, 1.3), s(0, 0, 0, 1.3), s(1.7, 0, 0, 1.3), ...edges([-2.3, 0, 2.3], 1.3, 1.3, 0.7)],
    half: [3, 1.3, 1.3],
  },
  // A torn section of hull, left by a destroyed ship.
  wreck: {
    label: 'épave',
    material: 'debris',
    mass: 3,
    hp: 80,
    spheres: [s(-1.2, 0, -0.6, 0.9), s(1.1, 0.1, 0.4, 0.9), s(0, 0, 0.9, 0.7), s(0.2, 0, -0.8, 0.6)],
    half: [2.2, 0.6, 1.6],
  },
  // A loose rock of the belt, 1 m at scale 1 (most are 1.5 to 3 m).
  boulder: {
    label: 'rocher',
    material: 'rock',
    mass: 10,
    hp: 300,
    spheres: [s(0, 0, 0, 1)],
    half: [1, 1, 1],
  },
};

/** Spin from impacts never exceeds this for a loose body (rad/s): light things tumble fast. */
const BODY_MAX_SPIN = 10;

const cache = new Map<string, SolidProps>();

/**
 * Collision and mass properties of a body of `kind` at `scale`: mass grows
 * with the cube of the size; the inertia sums the spheres as solid balls,
 * each carrying mass in proportion to its volume.
 */
export function bodyProps(kind: BodyKind, scale: number): SolidProps {
  const key = `${kind}:${scale.toFixed(2)}`;
  let p = cache.get(key);
  if (p) return p;
  const def = BODY_DEFS[kind];
  const spheres = def.spheres.map((h) => ({ part: h.part, at: h.at.clone().multiplyScalar(scale), r: h.r * scale }));
  const mass = def.mass * scale ** 3;
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
  p = { mass, inertia, reach, spheres, material: def.material, maxSpin: BODY_MAX_SPIN };
  cache.set(key, p);
  return p;
}

/** Structure points of a body of `kind` at `scale` (grow with its surface). */
export function bodyHp(kind: BodyKind, scale: number): number {
  return BODY_DEFS[kind].hp * scale * scale;
}
