import { Quaternion, Vector3 } from 'three';
import type { StaticCollider } from '../sim/types';

/**
 * Collision shapes of the static world (v0.8), as exact signed distance
 * functions: the distance from a point to the surface, negative inside, with
 * the outward normal. One function per shape answers every question the
 * physics asks (contact, depth, normal) and drives the continuous sweep
 * (sphere tracing), so a fast ship cannot step over a thin wall.
 *
 * Shapes live in the collider's local frame: origin at `center`, oriented by
 * `rot`, and for the rotating parts of a habitat ring also turned by
 * `spin × time` about the world Y axis through `center`.
 */
export type Shape =
  | { t: 'sphere'; r: number }
  /** Box of half extents `h`. */
  | { t: 'box'; h: [number, number, number] }
  /** Segment a→b swept by a sphere of radius r. */
  | { t: 'capsule'; a: [number, number, number]; b: [number, number, number]; r: number }
  /** Capped cylinder along local Y: radius r, half height h. */
  | { t: 'cylinder'; r: number; h: number }
  /** Torus around local Y: ring radius R, tube radius r. */
  | { t: 'torus'; R: number; r: number };

const _q = new Vector3();
const _n = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _spin = new Quaternion();
const _inv = new Quaternion();
const Y = new Vector3(0, 1, 0);

/** Rotation of a spinning collider at `time` (identity when it does not spin). */
function spinOf(c: StaticCollider, time: number, out: Quaternion) {
  return c.spin ? out.setFromAxisAngle(Y, c.spin * time) : out.identity();
}

/**
 * Signed distance from world point `p` to collider `c` at sim time `time`.
 * Writes the outward unit normal (world frame) to `normal` when given.
 */
export function distanceTo(c: StaticCollider, p: Vector3, time: number, normal?: Vector3): number {
  const shape = c.shape;
  _q.subVectors(p, c.center);
  if (!shape) {
    // Plain sphere of the bounding radius (asteroids, planets).
    const len = _q.length();
    if (normal) {
      if (len > 1e-9) normal.copy(_q).divideScalar(len);
      else normal.set(0, 1, 0);
    }
    return len - c.radius;
  }
  const spinning = !!c.spin;
  if (spinning) _q.applyQuaternion(_inv.copy(spinOf(c, time, _spin)).invert());
  if (c.rot) _q.applyQuaternion(_inv.copy(c.rot).invert());
  const d = localDistance(shape, _q, _n);
  if (normal) {
    normal.copy(_n);
    if (c.rot) normal.applyQuaternion(c.rot);
    if (spinning) normal.applyQuaternion(spinOf(c, time, _spin));
  }
  return d;
}

/** Distance and outward normal in the shape's own frame. */
function localDistance(s: Shape, p: Vector3, n: Vector3): number {
  switch (s.t) {
    case 'sphere': {
      const len = p.length();
      if (len > 1e-9) n.copy(p).divideScalar(len);
      else n.set(0, 1, 0);
      return len - s.r;
    }
    case 'box': {
      const qx = Math.abs(p.x) - s.h[0];
      const qy = Math.abs(p.y) - s.h[1];
      const qz = Math.abs(p.z) - s.h[2];
      if (qx > 0 || qy > 0 || qz > 0) {
        const ox = Math.max(qx, 0);
        const oy = Math.max(qy, 0);
        const oz = Math.max(qz, 0);
        const len = Math.sqrt(ox * ox + oy * oy + oz * oz);
        n.set(ox * Math.sign(p.x), oy * Math.sign(p.y), oz * Math.sign(p.z)).divideScalar(len || 1);
        return len;
      }
      // Inside: out through the nearest face.
      if (qx >= qy && qx >= qz) n.set(Math.sign(p.x) || 1, 0, 0);
      else if (qy >= qz) n.set(0, Math.sign(p.y) || 1, 0);
      else n.set(0, 0, Math.sign(p.z) || 1);
      return Math.max(qx, qy, qz);
    }
    case 'capsule': {
      _a.set(s.a[0], s.a[1], s.a[2]);
      _b.set(s.b[0], s.b[1], s.b[2]).sub(_a);
      const len2 = _b.lengthSq();
      const t = len2 > 0 ? Math.min(1, Math.max(0, _a.subVectors(p, _a).dot(_b) / len2)) : 0;
      _a.set(s.a[0], s.a[1], s.a[2]).addScaledVector(_b, t);
      n.subVectors(p, _a);
      const len = n.length();
      if (len > 1e-9) n.divideScalar(len);
      else n.set(0, 1, 0);
      return len - s.r;
    }
    case 'cylinder': {
      const rxz = Math.sqrt(p.x * p.x + p.z * p.z);
      const dx = rxz - s.r;
      const dy = Math.abs(p.y) - s.h;
      const sy = Math.sign(p.y) || 1;
      const hx = rxz > 1e-9 ? p.x / rxz : 1;
      const hz = rxz > 1e-9 ? p.z / rxz : 0;
      if (dx > 0 && dy > 0) {
        const len = Math.sqrt(dx * dx + dy * dy);
        n.set(hx * dx, sy * dy, hz * dx).divideScalar(len);
        return len;
      }
      if (dx > dy) {
        n.set(hx, 0, hz);
        return dx;
      }
      n.set(0, sy, 0);
      return dy;
    }
    case 'torus': {
      const rxz = Math.sqrt(p.x * p.x + p.z * p.z);
      const hx = rxz > 1e-9 ? p.x / rxz : 1;
      const hz = rxz > 1e-9 ? p.z / rxz : 0;
      n.set(p.x - hx * s.R, p.y, p.z - hz * s.R);
      const len = n.length();
      if (len > 1e-9) n.divideScalar(len);
      else n.set(0, 1, 0);
      return len - s.r;
    }
  }
}

/** Velocity of the collider's surface at world point `p` (non-zero only for spinning parts). */
export function surfaceVelocity(c: StaticCollider, p: Vector3, out: Vector3): Vector3 {
  if (!c.spin) return out.set(0, 0, 0);
  // ω × r with ω = (0, spin, 0).
  const rx = p.x - c.center.x;
  const rz = p.z - c.center.z;
  return out.set(c.spin * rz, 0, -c.spin * rx);
}

const _p = new Vector3();
const _seg = new Vector3();

/**
 * Continuous test: a sphere of radius `s` moving from `p0` to `p1` against
 * collider `c`. Returns the fraction of the move (0..1) at first contact, or
 * -1. Sphere tracing never steps further than the distance to the surface,
 * so it cannot tunnel through a thin wall. A sphere already touching or
 * inside returns 0.
 */
export function sphereCast(c: StaticCollider, p0: Vector3, p1: Vector3, s: number, time: number, skin = 0.02): number {
  _seg.subVectors(p1, p0);
  const len = _seg.length();
  let t = 0;
  for (let i = 0; i < 64; i++) {
    _p.copy(p0).addScaledVector(_seg, t);
    const d = distanceTo(c, _p, time) - s;
    if (d < skin) return t;
    if (len < 1e-9) return -1;
    t += d / len;
    if (t > 1) return -1;
  }
  return t;
}

/** A thin ray p0→p1 (a laser bolt) against collider `c`: hit fraction or -1. */
export function rayCast(c: StaticCollider, p0: Vector3, p1: Vector3, time: number): number {
  return sphereCast(c, p0, p1, 0, time, 0.05);
}
