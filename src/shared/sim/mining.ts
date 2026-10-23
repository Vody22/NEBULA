import { Vector3 } from 'three';
import type { ItemId } from '../economy/items';
import { segmentSphere } from '../math';
import { SHIP_CLASSES } from './shipClasses';
import type { StaticGrid } from './spatialGrid';
import type { Ship } from './types';
import type { AsteroidDef } from './zone';

/** The mining beam reaches this far ahead of the nose (m). */
export const MINING_RANGE = 300;
/** Above this speed the beam cannot hold on a rock (m/s). */
export const MINING_MAX_SPEED = 60;
/** Units of ore per second on an asteroid of richness 1. */
export const MINING_RATE = 0.6;
/** Share of the units mined on a metallic asteroid that come out as platinum. */
export const PLATINUM_CHANCE = 0.04;

/** Ore by asteroid family (the variant shared with the client's rock families). */
const ORE: ItemId[] = ['carbon', 'regolith', 'silicates', 'ironNickel'];

export function oreOf(variant: number): ItemId {
  return ORE[((variant % ORE.length) + ORE.length) % ORE.length];
}

/** How rich an asteroid is, 0.6 to 1.5, always the same for the same rock. */
export function richness(index: number): number {
  let h = Math.imul(index + 1, 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return 0.6 + ((h >>> 0) / 0xffffffff) * 0.9;
}

export function richnessLabel(r: number): string {
  return r < 0.85 ? 'pauvre' : r < 1.2 ? 'moyen' : 'riche';
}

export interface MiningHit {
  /** Index in zone.asteroids. */
  index: number;
  /** Distance from the beam origin (m). */
  distance: number;
}

const _from = new Vector3();
const _to = new Vector3();
const _mid = new Vector3();
const _fwd = new Vector3();

/** The beam starts at the nose. */
export function beamOrigin(ship: Ship, out: Vector3): Vector3 {
  return out.set(0, 0, -SHIP_CLASSES[ship.classId].radius * 0.6).applyQuaternion(ship.rotation).add(ship.position);
}

/**
 * The asteroid straight ahead within range, if the first thing the beam meets
 * is an asteroid (a station or a planet in the way blocks it). Rocks are
 * tested at their full radius so the beam catches what the player sees.
 */
export function miningTarget(ship: Ship, grid: StaticGrid, asteroids: AsteroidDef[]): MiningHit | null {
  beamOrigin(ship, _from);
  _fwd.set(0, 0, -1).applyQuaternion(ship.rotation);
  _to.copy(_from).addScaledVector(_fwd, MINING_RANGE);
  _mid.addVectors(_from, _to).multiplyScalar(0.5);
  let best = 2;
  let index = -1;
  for (const c of grid.query(_mid, MINING_RANGE / 2 + 80)) {
    const r = c.kind === 'asteroid' && c.index !== undefined ? asteroids[c.index].radius : c.radius;
    const t = segmentSphere(_from, _to, c.center, r);
    if (t < 0 || t >= best) continue;
    best = t;
    index = c.kind === 'asteroid' && c.index !== undefined ? c.index : -1;
  }
  return index >= 0 ? { index, distance: best * MINING_RANGE } : null;
}

/** Why the beam does nothing right now (for the HUD), or null when it can mine. */
export function miningBlocked(ship: Ship): 'fire' | 'speed' | null {
  if (ship.input.fire) return 'fire';
  if (ship.velocity.length() > MINING_MAX_SPEED) return 'speed';
  return null;
}

/**
 * One tick of the beam: finds the rock, accumulates ore progress (whole units
 * are taken out by the server, which owns the cargo holds).
 */
export function stepMining(ship: Ship, dt: number, grid: StaticGrid, asteroids: AsteroidDef[]) {
  if (!ship.input.mine || miningBlocked(ship)) {
    ship.mining = null;
    return;
  }
  const hit = miningTarget(ship, grid, asteroids);
  if (!hit) {
    ship.mining = null;
    return;
  }
  if (ship.mining !== hit.index) ship.mineProgress = Math.min(ship.mineProgress, 0.999);
  ship.mining = hit.index;
  ship.mineProgress += MINING_RATE * richness(hit.index) * dt;
}
