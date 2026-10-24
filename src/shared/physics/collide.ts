import { Quaternion, Vector3 } from 'three';
import { forwardOf, segmentSphere } from '../math';
import type { StaticGrid } from '../sim/spatialGrid';
import type { Ship, StaticCollider } from '../sim/types';
import { statsOf } from '../sim/upgrades';
import { HITBOXES, massOf, type HitSphere, type PartId } from './hitboxes';
import { contactOf, SHIP_MATERIAL, type MaterialId } from './materials';
import { distanceTo, sphereCast, surfaceVelocity } from './shapes';

/**
 * Rigid-body collision response for ships (v0.8), shared by the server and
 * client-side prediction. A ship is a cluster of spheres (hitboxes.ts) with a
 * mass and an inertia; a contact applies an impulse at the contact point, so
 * the ship bounces according to the angle and the material, slides with
 * friction, and starts to spin when the blow is off its centre of mass.
 */

/** What one contact did to a ship, for damage (server) and feedback (client). */
export interface Impact {
  part: PartId;
  /** Contact point, world frame. */
  point: Vector3;
  /** Contact normal, world frame, pointing from the obstacle toward the ship. */
  normal: Vector3;
  /** Closing speed along the normal before the impact (m/s). */
  speed: number;
  /** Velocity change of the ship's centre of mass along the normal (m/s): the measure of the blow. */
  dv: number;
  material: MaterialId;
  /** Nose first into the obstacle. */
  frontal: boolean;
}

/** Contacts slower than this along the normal do not bounce (a ship resting or sliding against a wall). */
export const REST_SPEED = 2;
/** Spin from collisions never exceeds this (rad/s). */
export const MAX_SPIN = 6;
/** Damage per (m/s)² of velocity change, times the struck material's hardness. */
export const IMPACT_DAMAGE = 0.02;
/** Velocity changes below this (m/s) leave no mark. */
export const IMPACT_THRESHOLD = 7;

/** Hull damage of a blow: grows with the square of the velocity change (the energy per tonne). */
export function impactDamage(dv: number, hardness: number): number {
  return IMPACT_DAMAGE * hardness * Math.max(0, dv * dv - IMPACT_THRESHOLD * IMPACT_THRESHOLD);
}

/**
 * How violent a blow at closing speed `speed` (m/s) is, 0..1 on a log scale:
 * 5 m/s ≈ 0.15, 50 m/s ≈ 0.6, 200 m/s and more = 1. The client sizes sparks,
 * camera shake and sound with it.
 */
export function impactScale(speed: number): number {
  return Math.min(1, Math.max(0, Math.log2(1 + speed / 8) / Math.log2(26)));
}

const _r = new Vector3();
const _w = new Vector3();
const _vp = new Vector3();
const _vs = new Vector3();
const _rel = new Vector3();
const _t = new Vector3();
const _rl = new Vector3();
const _nl = new Vector3();
const _tmp = new Vector3();
const _inv = new Quaternion();
const _J = new Vector3();
const _fwd = new Vector3();

/** World velocity of the point of `ship` at world offset `r` from its centre. */
export function pointVelocity(ship: Ship, r: Vector3, out: Vector3): Vector3 {
  _w.copy(ship.angularVelocity).add(ship.spin).applyQuaternion(ship.rotation);
  return out.crossVectors(_w, r).add(ship.velocity);
}

/** 1 / effective mass of `ship` for an impulse along unit `n` applied at world offset `r`. */
export function inverseMassAlong(ship: Ship, r: Vector3, n: Vector3): number {
  const { mass, inertia } = massOf(ship.classId);
  _inv.copy(ship.rotation).invert();
  _rl.copy(r).applyQuaternion(_inv);
  _nl.copy(n).applyQuaternion(_inv);
  _tmp.crossVectors(_rl, _nl);
  _tmp.set(_tmp.x / inertia.x, _tmp.y / inertia.y, _tmp.z / inertia.z);
  return 1 / mass + _nl.dot(_tmp.cross(_rl));
}

/** Applies world impulse `J` (t·m/s) at world offset `r`: linear and angular velocity change. */
export function applyImpulse(ship: Ship, J: Vector3, r: Vector3) {
  const { mass, inertia } = massOf(ship.classId);
  ship.velocity.addScaledVector(J, 1 / mass);
  _inv.copy(ship.rotation).invert();
  _tmp.crossVectors(r, J).applyQuaternion(_inv);
  ship.spin.x += _tmp.x / inertia.x;
  ship.spin.y += _tmp.y / inertia.y;
  ship.spin.z += _tmp.z / inertia.z;
  const s = ship.spin.length();
  if (s > MAX_SPIN) ship.spin.multiplyScalar(MAX_SPIN / s);
}

/**
 * Impulse response of a contact between `ship` and an immovable obstacle
 * whose surface moves at `surfaceVel`. Returns the closing speed and the
 * velocity change, or null when the point is already separating.
 */
function resolveAgainstStatic(ship: Ship, point: Vector3, n: Vector3, surfaceVel: Vector3, material: MaterialId) {
  _r.subVectors(point, ship.position);
  pointVelocity(ship, _r, _vp);
  _rel.subVectors(_vp, surfaceVel);
  const vn = _rel.dot(n);
  if (vn >= 0) return null;
  const c = contactOf(SHIP_MATERIAL, material);
  const e = -vn < REST_SPEED ? 0 : c.restitution;
  const k = inverseMassAlong(ship, _r, n);
  const j = (-(1 + e) * vn) / k;
  applyImpulse(ship, _J.copy(n).multiplyScalar(j), _r);
  // Friction: oppose the sliding velocity, at most μ times the normal impulse.
  pointVelocity(ship, _r, _vp);
  _rel.subVectors(_vp, surfaceVel);
  _t.copy(_rel).addScaledVector(n, -_rel.dot(n));
  const vt = _t.length();
  if (vt > 1e-4) {
    _t.divideScalar(vt);
    const kt = inverseMassAlong(ship, _r, _t);
    const jt = Math.min(vt / kt, c.friction * j);
    applyImpulse(ship, _J.copy(_t).multiplyScalar(-jt), _r);
  }
  return { speed: -vn, dv: j / massOf(ship.classId).mass, hardness: c.hardness };
}

const LOD_SPHERE: HitSphere[] = [{ part: 'hull', at: new Vector3(), r: 1 }];

/**
 * The collision spheres of `ship`. `coarse`: one sphere of the class radius
 * (ships far from every player, see World.physicsLod).
 */
export function hitSpheres(ship: Ship, coarse = false): HitSphere[] {
  if (!coarse) return HITBOXES[ship.classId];
  LOD_SPHERE[0].r = statsOf(ship).radius * 0.8;
  return LOD_SPHERE;
}

export interface StaticContactReport extends Impact {
  hardness: number;
  collider: StaticCollider;
}

const _start = new Vector3();
const _end = new Vector3();
const _move = new Vector3();
const _mid = new Vector3();
const _hw = new Vector3();
const _p0 = new Vector3();
const _p1 = new Vector3();
const _pc = new Vector3();
const _n = new Vector3();
const _bestN = new Vector3();
const _bestP = new Vector3();
const _point = new Vector3();
const _c = new Vector3();

/**
 * Moves `ship` from `from` to its current position (already integrated for
 * this tick) without passing through the static world: each hit sphere is
 * swept continuously; at the first contact the ship stops there, takes the
 * impulse, and spends the rest of the tick moving with its new velocity.
 * A final pass pushes out of any overlap left by the ship's rotation.
 */
export function collideStatic(ship: Ship, from: Vector3, dt: number, grid: StaticGrid, onImpact?: (i: StaticContactReport) => void, coarse = false) {
  const reach = coarse ? statsOf(ship).radius : massOf(ship.classId).reach;
  const spheres = hitSpheres(ship, coarse);
  const time = grid.time;
  _start.copy(from);
  _end.copy(ship.position);
  let left = dt;
  for (let iter = 0; iter < 3; iter++) {
    _move.subVectors(_end, _start);
    const len = _move.length();
    if (len < 1e-6) break;
    _mid.addVectors(_start, _end).multiplyScalar(0.5);
    let bestT = 2;
    let best: StaticCollider | null = null;
    let bestH: HitSphere | null = null;
    for (const c of grid.query(_mid, len / 2 + reach + 1)) {
      // Broad test: the whole ship's bounding sphere against the collider's.
      if (_c.subVectors(_start, c.center).length() > c.radius + reach && segmentSphere(_start, _end, c.center, c.radius + reach) < 0) continue;
      for (const h of spheres) {
        _hw.copy(h.at).applyQuaternion(ship.rotation);
        _p0.addVectors(_start, _hw);
        _p1.addVectors(_end, _hw);
        const t = sphereCast(c, _p0, _p1, h.r, time);
        if (t < 0 || t >= bestT) continue;
        _pc.copy(_p0).lerp(_p1, t);
        distanceTo(c, _pc, time, _n);
        // Moving along or away from the surface: not a hit (a ship sliding along a wall).
        if (_move.dot(_n) >= 0) continue;
        bestT = t;
        best = c;
        bestH = h;
        _bestN.copy(_n);
        _bestP.copy(_pc);
      }
    }
    if (!best || !bestH) {
      ship.position.copy(_end);
      break;
    }
    ship.position.copy(_start).addScaledVector(_move, bestT);
    _point.copy(_bestP).addScaledVector(_bestN, -bestH.r);
    contact(ship, best, bestH.part, _point, _bestN, onImpact);
    left *= 1 - bestT;
    _start.copy(ship.position);
    _end.copy(ship.position).addScaledVector(ship.velocity, left);
    if (iter === 2) ship.position.copy(_start);
  }
  depenetrate(ship, grid, spheres, reach, onImpact);
}

function contact(ship: Ship, c: StaticCollider, part: PartId, point: Vector3, n: Vector3, onImpact?: (i: StaticContactReport) => void) {
  surfaceVelocity(c, point, _vs);
  const r = resolveAgainstStatic(ship, point, n, _vs, c.material);
  if (!r || !onImpact) return;
  forwardOf(ship.rotation, _fwd);
  onImpact({
    part,
    point: point.clone(),
    normal: n.clone(),
    speed: r.speed,
    dv: r.dv,
    material: c.material,
    frontal: part === 'cockpit' && _fwd.dot(n) < -0.6,
    hardness: r.hardness,
    collider: c,
  });
}

/** Pushes the ship out of any overlap (rotation into a wall, a spinning spoke sweeping into it). */
function depenetrate(ship: Ship, grid: StaticGrid, spheres: HitSphere[], reach: number, onImpact?: (i: StaticContactReport) => void) {
  const time = grid.time;
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (const c of grid.query(ship.position, reach + 1)) {
      if (_c.subVectors(ship.position, c.center).length() > c.radius + reach) continue;
      for (const h of spheres) {
        _pc.copy(h.at).applyQuaternion(ship.rotation).add(ship.position);
        const d = distanceTo(c, _pc, time, _n) - h.r;
        if (d >= 0) continue;
        ship.position.addScaledVector(_n, -d + 0.01);
        _point.copy(_pc).addScaledVector(_n, -h.r - d);
        contact(ship, c, h.part, _point, _n, onImpact);
        moved = true;
      }
    }
    if (!moved) break;
  }
}

export interface ShipContactReport {
  a: Ship;
  b: Ship;
  partA: PartId;
  partB: PartId;
  point: Vector3;
  /** From b toward a. */
  normal: Vector3;
  speed: number;
  dvA: number;
  dvB: number;
}

const _ra = new Vector3();
const _rb = new Vector3();
const _va = new Vector3();
const _vb = new Vector3();
const _da = new Vector3();
const _db = new Vector3();
const _rel0 = new Vector3();
const _rel1 = new Vector3();
const _ha = new Vector3();
const _hb = new Vector3();
const _zero = new Vector3();

/**
 * Continuous collision between two ships that moved this tick from `fromA`
 * and `fromB` to their current positions. Their spheres are swept against
 * each other in relative motion (so two ships boosting head-on cannot pass
 * through each other); at first contact both go back to that instant, share
 * an impulse according to their masses and inertia, and finish the tick with
 * their new velocities. Returns the contact (speed 0 when the ships were
 * already separating), or null when they did not touch.
 */
export function collideShips(a: Ship, b: Ship, fromA: Vector3, fromB: Vector3, dt: number, coarse = false): ShipContactReport | null {
  const ra = coarse ? statsOf(a).radius : massOf(a.classId).reach;
  const rb = coarse ? statsOf(b).radius : massOf(b.classId).reach;
  _da.subVectors(a.position, fromA);
  _db.subVectors(b.position, fromB);
  _rel0.subVectors(fromA, fromB);
  _rel1.subVectors(a.position, b.position);
  // Broad test: bounding spheres in relative motion.
  if (segmentSphere(_rel0, _rel1, _zero, ra + rb) < 0) return null;
  const sa = hitSpheres(a, coarse);
  const sb = coarse ? [{ part: 'hull' as PartId, at: new Vector3(), r: rb * 0.8 }] : HITBOXES[b.classId];
  let bestT = 2;
  let pa: HitSphere | null = null;
  let pb: HitSphere | null = null;
  for (const ha of sa) {
    _ha.copy(ha.at).applyQuaternion(a.rotation);
    for (const hb of sb) {
      _hb.copy(hb.at).applyQuaternion(b.rotation);
      _rel0.subVectors(fromA, fromB).add(_ha).sub(_hb);
      _rel1.subVectors(a.position, b.position).add(_ha).sub(_hb);
      const t = segmentSphere(_rel0, _rel1, _zero, ha.r + hb.r);
      if (t < 0 || t >= bestT) continue;
      bestT = t;
      pa = ha;
      pb = hb;
    }
  }
  if (!pa || !pb) return null;
  // Both ships back to the moment of contact.
  a.position.copy(fromA).addScaledVector(_da, bestT);
  b.position.copy(fromB).addScaledVector(_db, bestT);
  _ha.copy(pa.at).applyQuaternion(a.rotation).add(a.position);
  _hb.copy(pb.at).applyQuaternion(b.rotation).add(b.position);
  const n = new Vector3().subVectors(_ha, _hb);
  const dist = n.length();
  if (dist > 1e-6) n.divideScalar(dist);
  else n.subVectors(a.position, b.position).normalize();
  // Spheres already overlapping (t = 0): separate them, half each by mass.
  const overlap = pa.r + pb.r - dist;
  const ma = massOf(a.classId).mass;
  const mb = massOf(b.classId).mass;
  if (overlap > 0) {
    a.position.addScaledVector(n, (overlap + 0.02) * (mb / (ma + mb)));
    b.position.addScaledVector(n, -(overlap + 0.02) * (ma / (ma + mb)));
  }
  const point = _hb.clone().addScaledVector(n, pb.r);
  _ra.subVectors(point, a.position);
  _rb.subVectors(point, b.position);
  pointVelocity(a, _ra, _va);
  pointVelocity(b, _rb, _vb);
  _rel.subVectors(_va, _vb);
  const vn = _rel.dot(n);
  // Touching but already separating: no impulse, still a contact (the ships moved back to it).
  let report: ShipContactReport = { a, b, partA: pa.part, partB: pb.part, point, normal: n, speed: 0, dvA: 0, dvB: 0 };
  if (vn < 0) {
    const c = contactOf(SHIP_MATERIAL, SHIP_MATERIAL);
    const e = -vn < REST_SPEED ? 0 : c.restitution;
    const k = inverseMassAlong(a, _ra, n) + inverseMassAlong(b, _rb, n);
    const j = (-(1 + e) * vn) / k;
    applyImpulse(a, _J.copy(n).multiplyScalar(j), _ra);
    applyImpulse(b, _J.copy(n).multiplyScalar(-j), _rb);
    // Friction between the hulls.
    pointVelocity(a, _ra, _va);
    pointVelocity(b, _rb, _vb);
    _rel.subVectors(_va, _vb);
    _t.copy(_rel).addScaledVector(n, -_rel.dot(n));
    const vt = _t.length();
    if (vt > 1e-4) {
      _t.divideScalar(vt);
      const kt = inverseMassAlong(a, _ra, _t) + inverseMassAlong(b, _rb, _t);
      const jt = Math.min(vt / kt, c.friction * j);
      applyImpulse(a, _J.copy(_t).multiplyScalar(-jt), _ra);
      applyImpulse(b, _J.copy(_t).multiplyScalar(jt), _rb);
    }
    report = { a, b, partA: pa.part, partB: pb.part, point, normal: n, speed: -vn, dvA: j / ma, dvB: j / mb };
  }
  // The rest of the tick with the new velocities.
  const left = dt * (1 - bestT);
  a.position.addScaledVector(a.velocity, left);
  b.position.addScaledVector(b.velocity, left);
  return report;
}
