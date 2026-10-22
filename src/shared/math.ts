// Shared math helpers. The simulation uses three.js math classes only (no
// rendering code), so this module runs unchanged in Node for the future server.
import { Quaternion, Vector3 } from 'three';

export const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/** Ship local axes. Convention: forward = -Z, up = +Y, right = +X. */
export const LOCAL_FORWARD = new Vector3(0, 0, -1);
export const LOCAL_UP = new Vector3(0, 1, 0);
export const LOCAL_RIGHT = new Vector3(1, 0, 0);

export function forwardOf(q: Quaternion, out = new Vector3()) {
  return out.copy(LOCAL_FORWARD).applyQuaternion(q);
}
export function upOf(q: Quaternion, out = new Vector3()) {
  return out.copy(LOCAL_UP).applyQuaternion(q);
}
export function rightOf(q: Quaternion, out = new Vector3()) {
  return out.copy(LOCAL_RIGHT).applyQuaternion(q);
}

/**
 * First-order intercept: the point where a projectile fired from `shooter`
 * (inheriting shooter velocity) at `speed` meets a target moving linearly.
 * Returns null when no positive solution exists.
 */
export function interceptPoint(
  shooterPos: Vector3,
  shooterVel: Vector3,
  targetPos: Vector3,
  targetVel: Vector3,
  speed: number,
  out = new Vector3(),
): Vector3 | null {
  const rx = targetPos.x - shooterPos.x;
  const ry = targetPos.y - shooterPos.y;
  const rz = targetPos.z - shooterPos.z;
  const vx = targetVel.x - shooterVel.x;
  const vy = targetVel.y - shooterVel.y;
  const vz = targetVel.z - shooterVel.z;
  const a = vx * vx + vy * vy + vz * vz - speed * speed;
  const b = 2 * (rx * vx + ry * vy + rz * vz);
  const c = rx * rx + ry * ry + rz * rz;
  let t: number;
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) < 1e-6) return null;
    t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    const t1 = (-b - s) / (2 * a);
    const t2 = (-b + s) / (2 * a);
    t = Math.min(t1, t2);
    if (t < 0) t = Math.max(t1, t2);
  }
  if (!(t > 0)) return null;
  return out.set(targetPos.x + vx * t, targetPos.y + vy * t, targetPos.z + vz * t);
}

/**
 * Closest approach between a moving segment p0->p1 and a sphere.
 * Returns the parametric hit time in [0,1] or -1.
 */
export function segmentSphere(p0: Vector3, p1: Vector3, c: Vector3, r: number): number {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  const fx = p0.x - c.x, fy = p0.y - c.y, fz = p0.z - c.z;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (fx * dx + fy * dy + fz * dz);
  const cc = fx * fx + fy * fy + fz * fz - r * r;
  if (cc <= 0) return 0; // starts inside
  if (a < 1e-9) return -1;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}
