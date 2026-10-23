import * as THREE from 'three';
import type { ShipClassId } from '../../shared/sim/types';
import { mergeByMaterial } from './merge';
import { buildFalconMk2 } from './FalconMk2';
import { buildMarauder, buildRaider, buildWarden } from './FactionShips';

export interface ShipModel {
  root: THREE.Group;
  /** Nozzle exit points (local) and nozzle radius. */
  engines: { pos: THREE.Vector3; radius: number }[];
  engineColor: THREE.Color;
  boostColor: THREE.Color;
  /** Shield ellipsoid half-extents. */
  shieldScale: THREE.Vector3;
  /** Steady position lights (port red, starboard green, white aft). */
  navs?: { pos: THREE.Vector3; color: THREE.Color; size: number }[];
  /** Flashing anti-collision lights. */
  strobes?: { pos: THREE.Vector3; color: THREE.Color }[];
  /** Manoeuvring thruster nozzles: exit point and exhaust direction (local). */
  rcs?: { pos: THREE.Vector3; dir: THREE.Vector3 }[];
}

function buildRaw(classId: ShipClassId): ShipModel {
  switch (classId) {
    case 'falcon':
      return buildFalconMk2();
    case 'warden':
      return buildWarden();
    case 'raider':
      return buildRaider();
    case 'marauder':
      return buildMarauder();
  }
}

const templates = new Map<ShipClassId, ShipModel>();

/**
 * Returns a ship model. Each class is built and merged (one draw call per
 * material) once; every ship then shares the template's geometry.
 */
export function buildShipModel(classId: ShipClassId): ShipModel {
  let t = templates.get(classId);
  if (!t) {
    t = buildRaw(classId);
    mergeByMaterial(t.root);
    templates.set(classId, t);
  }
  return { ...t, root: t.root.clone() };
}
