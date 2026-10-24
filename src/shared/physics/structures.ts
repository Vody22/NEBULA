import { Quaternion, Vector3 } from 'three';
import type { StaticCollider } from '../sim/types';
import type { StationDef } from '../sim/zone';
import type { Shape } from './shapes';

/**
 * Collision shapes of the stations (v0.8), laid over their 3D models: the
 * numbers below are the models' own (Station.ts for the hubs, Outpost.ts for
 * the depots), so the walls a ship hits are the walls it sees. Before v0.8 a
 * hub was a sphere and a row of balls; its hangar walls had no collision.
 *
 * Every shape is metal. The habitat ring turns with the model (0.02 rad/s):
 * its spokes and pods are spinning colliders, swept at the sim's time.
 */

/** The hub's ring turns this fast about its axis (Station.ts: ring.rotation.y = time × 0.02). */
export const RING_SPIN = 0.02;

/** Hub hangar (Station.ts): width, height, depth, wall thickness. */
export const HUB_HANGAR = { w: 200, h: 110, d: 160, wall: 14 };
/** Depot hangar (Outpost.ts). */
export const DEPOT_HANGAR = { w: 130, h: 76, d: 100, wall: 10 };

type V3 = [number, number, number];
const Y = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const Z = new Vector3(0, 0, 1);

/** Builds colliders in a structure's local frame, then places them in the world. */
class Builder {
  readonly out: StaticCollider[] = [];
  constructor(
    private origin: Vector3,
    private frame: Quaternion,
  ) {}

  private place(local: V3, shape: Shape, radius: number, rot?: Quaternion, spin?: number) {
    const center = new Vector3(...local).applyQuaternion(this.frame).add(this.origin);
    const r = rot ? this.frame.clone().multiply(rot) : this.frame.clone();
    const identity = r.equals(new Quaternion());
    this.out.push({ kind: 'station', center, radius, material: 'metal', shape, ...(identity ? {} : { rot: r }), ...(spin ? { spin } : {}) });
  }

  box(at: V3, h: V3, rot?: Quaternion) {
    this.place(at, { t: 'box', h }, Math.hypot(h[0], h[1], h[2]), rot);
  }

  cylinder(at: V3, r: number, h: number, rot?: Quaternion) {
    this.place(at, { t: 'cylinder', r, h }, Math.hypot(r, h), rot);
  }

  sphere(at: V3, r: number) {
    this.place(at, { t: 'sphere', r }, r);
  }

  /** Capsule between two local points. */
  capsule(a: V3, b: V3, r: number) {
    const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const ha: V3 = [a[0] - mid[0], a[1] - mid[1], a[2] - mid[2]];
    const hb: V3 = [b[0] - mid[0], b[1] - mid[1], b[2] - mid[2]];
    this.place(mid, { t: 'capsule', a: ha, b: hb, r }, Math.hypot(...ha) + r);
  }

  /** A capsule turning with the ring: defined around the structure's origin, so it spins in place. */
  spinningCapsule(a: V3, b: V3, r: number, spin: number) {
    const reach = Math.max(Math.hypot(...a), Math.hypot(...b)) + r;
    this.place([0, 0, 0], { t: 'capsule', a, b, r }, reach, undefined, spin);
  }

  torus(at: V3, R: number, r: number, spin?: number) {
    this.place(at, { t: 'torus', R, r }, R + r, undefined, spin);
  }

  /** The five walls of a hangar shell open on +Z, centred at `z`. */
  hangarShell(z: number, g: { w: number; h: number; d: number; wall: number }) {
    const { w, h, d, wall } = g;
    this.box([0, h / 2 - wall / 2, z], [w / 2, wall / 2, d / 2]);
    this.box([0, -h / 2 + wall / 2, z], [w / 2, wall / 2, d / 2]);
    this.box([-w / 2 + wall / 2, 0, z], [wall / 2, h / 2, d / 2]);
    this.box([w / 2 - wall / 2, 0, z], [wall / 2, h / 2, d / 2]);
    this.box([0, 0, z - d / 2 + wall / 2], [w / 2, h / 2, wall / 2]);
  }
}

const rotX = (a: number) => new Quaternion().setFromAxisAngle(X, a);
const rotZ = (a: number) => new Quaternion().setFromAxisAngle(Z, a);

/** A hub station (the Aurora-7 model, also Kepler-4). */
export function hubColliders(st: StationDef): StaticCollider[] {
  const b = new Builder(st.position, new Quaternion().setFromAxisAngle(Y, st.yaw));
  const R = st.coreRadius;
  // Core: a lathe 1.08 R wide at the equator, ±1.25 R tall at the axis.
  b.sphere([0, 0, 0], R * 1.06);
  // Spine (radius 42) and its machinery modules (radius 70 to 75, from 1.3 R to 1.3 R + 4 × 85, and 50 m tall).
  const half = st.spineLength / 2;
  b.capsule([0, -half, 0], [0, half, 0], 44);
  for (const sgn of [-1, 1]) {
    b.cylinder([0, sgn * (R * 1.3 + 170), 0], 75, 170 + 30);
    // End cap (a cone, 70 m at its base) and the antenna mast.
    b.capsule([0, sgn * (half + 10), 0], [0, sgn * (half + 70), 0], 40);
    b.capsule([0, sgn * (half + 100), 0], [0, sgn * (half + 362), 0], 4);
    // Solar arrays on the upper spine (three tilted panels and their trusses), radiators below.
    for (let k = 0; k < 3; k++) {
      b.box([sgn * 200, 380 + k * 55, 0], [110, 1.5, 24], rotX(0.35));
      b.capsule([sgn * 44, 380 + k * 55, 0], [sgn * 300, 380 + k * 55, 0], 4.5);
    }
    for (let k = 0; k < 2; k++) {
      const y = -380 - k * 70;
      b.box([0, y + 28, sgn * 140], [1.5, 23, 90]);
      b.capsule([0, y, sgn * 44], [0, y, sgn * 230], 3.5);
    }
  }
  // Habitat ring, its spokes, walkways and pods: turning with the model.
  b.torus([0, 0, 0], st.ringRadius, st.ringTube + 1, RING_SPIN);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const from = R * 0.98;
    const to = st.ringRadius - st.ringTube * 0.8;
    b.spinningCapsule([c * from, 0, s * from], [c * to, 0, s * to], 11, RING_SPIN);
    // Walkway tube beside the truss, 18 m to the side.
    const sx = -s * 18;
    const sz = c * 18;
    b.spinningCapsule([c * from + sx, 0, s * from + sz], [c * to + sx, 0, s * to + sz], 6, RING_SPIN);
    // Pressure pod lying along the ring, 0.26 rad further on.
    const pa = a + 0.26;
    const px = Math.cos(pa) * st.ringRadius;
    const pz = Math.sin(pa) * st.ringRadius;
    const tx = Math.sin(pa) * 45;
    const tz = -Math.cos(pa) * 45;
    b.spinningCapsule([px - tx, 0, pz - tz], [px + tx, 0, pz + tz], st.ringTube * 1.18, RING_SPIN);
  }
  // Hangar (on +Z): the shell, the mouth frame, the side fins and the two approach arms.
  const g = HUB_HANGAR;
  const hz = R * 1.08 + g.d / 2 - g.wall + 4;
  b.hangarShell(hz, g);
  for (const sx of [-1, 1]) {
    b.box([sx * (g.w / 2 + 3), 0, hz + g.d / 2 - 2], [5, g.h / 2 + 8, 5]);
    b.box([sx * (g.w / 2 + 4), 0, hz - g.d * 0.1], [4, g.h * 0.4, g.d * 0.35]);
    b.capsule([sx * 95, -58, hz + g.d / 2], [sx * 95, -58, hz + g.d / 2 + 380], 5);
  }
  b.box([0, g.h / 2 + 3, hz + g.d / 2 - 2], [g.w / 2 + 8, 5, 5]);
  b.box([0, -g.h / 2 - 3, hz + g.d / 2 - 2], [g.w / 2 + 8, 5, 5]);
  return b.out;
}

/** A mining depot (the Ferro-9 model, also Vesta-2), hangar mouth on local +Z at `mouthZ`. */
export function depotColliders(st: StationDef, mouthZ: number): StaticCollider[] {
  const b = new Builder(st.position, new Quaternion().setFromAxisAngle(Y, st.yaw));
  // Habitat stack: a wide drum, two narrower ones above and below with their domes, the mast.
  b.cylinder([0, 0, -45], 57, 37);
  b.cylinder([0, 0, -45], 43, 110);
  b.cylinder([0, 0, -45], 61, 41);
  b.capsule([0, 112, -45], [0, 176, -45], 2);
  // Hangar, its tunnel to the habitat, the mouth posts and lintels, the approach arms.
  const g = DEPOT_HANGAR;
  const hz = mouthZ - g.d / 2;
  b.hangarShell(hz, g);
  b.box([0, 0, hz - g.d / 2 - 10], [13, 11, 20]);
  for (const sx of [-1, 1]) {
    b.box([sx * (g.w / 2 + 2), 0, hz + g.d / 2 - 2], [4, g.h / 2 + 6, 4]);
    b.capsule([sx * 62, -40, hz + g.d / 2], [sx * 62, -40, hz + g.d / 2 + 200], 4);
  }
  b.box([0, g.h / 2 + 2, hz + g.d / 2 - 2], [g.w / 2 + 6, 4, 4]);
  b.box([0, -g.h / 2 - 2, hz + g.d / 2 - 2], [g.w / 2 + 6, 4, 4]);
  // Refinery block, its hopper and chimneys, and the truss to the habitat.
  b.box([-165, -10, -55], [60, 32, 48]);
  b.cylinder([-165, 42, -55], 30, 20);
  for (let i = 0; i < 3; i++) b.cylinder([-205 + i * 40, 40, -92], 6.5, 23);
  b.capsule([-105, 0, -50], [-56, 0, -45], 7);
  // Four ore silos and their truss.
  for (const [dx, dz] of [
    [-24, -24],
    [24, -24],
    [-24, 24],
    [24, 24],
  ])
    b.cylinder([140 + dx, 0, -85 + dz], 20, 54);
  b.capsule([55, 10, -55], [100, 10, -75], 7);
  // Radiators on the habitat's flanks.
  for (const sx of [-1, 1]) {
    b.box([sx * 105, 100, -45], [45, 1.5, 19], rotZ(sx * 0.42));
    b.capsule([sx * 40, 70, -45], [sx * 150, 120, -45], 3.5);
  }
  // Drill arm reaching into the belt, its housing and the bit.
  b.capsule([0, -40, -100], [0, -70, -400], 8);
  b.capsule([0, -70, -390], [0, -70, -420], 24);
  b.capsule([0, -70, -428], [0, -70, -452], 12);
  return b.out;
}
