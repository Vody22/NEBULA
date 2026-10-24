import { Vector3 } from 'three';
import { SimplexNoise } from 'three/examples/jsm/math/SimplexNoise.js';
import { mulberry32 } from '../rng';

/**
 * Asteroid shapes (v0.8), shared by the renderer and the physics: the rock a
 * ship crashes into is the rock the player sees, bumps, hollows, flat
 * fractures and overall proportions, turning as it is drawn.
 *
 * A rock is a sphere pushed in and out along each direction (noise relief,
 * craters, lobes, planar cuts), then stretched on its axes. The renderer
 * displaces an icosphere with `relief()`; the physics reads the same radius
 * from a cube-map table (`RockCollision`) and treats the rock as a signed
 * distance function, like the stations' shapes.
 */
export type RockFamily = 'carbon' | 'rubble' | 'silicate' | 'metal';
/** Family by asteroid variant. */
export const ROCK_FAMILIES: RockFamily[] = ['carbon', 'rubble', 'silicate', 'metal'];
/** From this radius (m) a rock uses its family's detailed shape. */
export const BIG_ROCK = 140;

export interface RockRelief {
  /** Radius in that direction before the stretch (×the asteroid's radius). */
  r: number;
  /** Noise relief and crater depth there (the renderer shades hollows with them). */
  h: number;
  crater: number;
}

export class RockShape {
  readonly noise: SimplexNoise;
  /** The rock's proportions, applied after the relief. */
  readonly stretch: Vector3;
  private craters: { c: Vector3; r: number }[] = [];
  /** Silicate blocks: planar fractures give flat faces and sharp edges. */
  private cuts: { n: Vector3; d: number }[] = [];
  /** Rubble piles: a few big lobes. */
  private lobes: { c: Vector3; r: number }[] = [];
  private amp0: number;

  constructor(
    readonly family: RockFamily,
    readonly seed: number,
    readonly octaves: number,
  ) {
    // The order of the draws is the shape: keep it.
    const rand = mulberry32(seed);
    this.noise = new SimplexNoise({ random: rand });
    this.stretch =
      family === 'silicate'
        ? new Vector3(0.8 + rand() * 0.3, 0.72 + rand() * 0.2, 0.9 + rand() * 0.3)
        : new Vector3(0.88 + rand() * 0.2, 0.84 + rand() * 0.16, 0.88 + rand() * 0.2);
    const nCraters = family === 'silicate' ? 4 : family === 'metal' ? 5 : 11;
    for (let i = 0; i < nCraters; i++) {
      this.craters.push({ c: new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(), r: 0.12 + rand() * 0.32 });
    }
    if (family === 'silicate') {
      for (let i = 0; i < 9; i++) this.cuts.push({ n: new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(), d: 0.8 + rand() * 0.15 });
    }
    if (family === 'rubble') {
      for (let i = 0; i < 5; i++) this.lobes.push({ c: new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(), r: 0.5 + rand() * 0.4 });
    }
    this.amp0 = family === 'carbon' ? 0.22 : family === 'metal' ? 0.18 : family === 'rubble' ? 0.16 : 0.12;
  }

  /** The surface in unit direction `v`. Kept within 0.8–1.25 of the radius. */
  relief(v: Vector3, out: RockRelief = { r: 1, h: 0, crater: 0 }): RockRelief {
    let h = 0;
    let amp = this.amp0;
    let f = 1.1;
    for (let o = 0; o < this.octaves; o++) {
      h += this.noise.noise3d(v.x * f + this.seed, v.y * f, v.z * f) * amp;
      f *= 2.1;
      amp *= 0.48;
    }
    for (const lb of this.lobes) {
      const d = v.distanceTo(lb.c);
      if (d < lb.r) h += (1 - (d / lb.r) ** 2) * 0.12;
    }
    let crater = 0;
    for (const cr of this.craters) {
      const d = v.distanceTo(cr.c);
      if (d < cr.r) {
        const t = d / cr.r;
        h -= (1 - t * t) * 0.1 * cr.r * 2;
        if (t > 0.75) h += (t - 0.75) * 0.14;
        crater = Math.max(crater, 1 - t);
      }
    }
    let r = 1 + h;
    for (const c of this.cuts) {
      const dn = v.dot(c.n);
      if (dn > 0.05) r = Math.min(r, c.d / dn);
    }
    out.r = Math.min(1.25, Math.max(0.8, r));
    out.h = h;
    out.crater = crater;
    return out;
  }
}

const shapes = new Map<string, RockShape>();

/** The shape of an asteroid of this variant and size (one per family and size class). */
export function rockShape(variant: number, big: boolean): RockShape {
  const key = `${variant}:${big}`;
  let s = shapes.get(key);
  if (!s) shapes.set(key, (s = new RockShape(ROCK_FAMILIES[variant] ?? 'carbon', 100 + variant * 17 + (big ? 7 : 0), big ? 6 : 3)));
  return s;
}

/** Cube face of a direction and its two coordinates on it (−1..1). */
function faceOf(x: number, y: number, z: number, out: { f: number; s: number; t: number; m: number }) {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  if (ax >= ay && ax >= az) {
    out.f = x > 0 ? 0 : 1;
    out.m = ax;
    out.s = y / ax;
    out.t = z / ax;
  } else if (ay >= az) {
    out.f = y > 0 ? 2 : 3;
    out.m = ay;
    out.s = x / ay;
    out.t = z / ay;
  } else {
    out.f = z > 0 ? 4 : 5;
    out.m = az;
    out.s = x / az;
    out.t = y / az;
  }
  return out;
}

/** The direction at face coordinates (s, t) of face `f`. */
function dirOf(f: number, s: number, t: number, out: Vector3) {
  const sign = f % 2 === 0 ? 1 : -1;
  if (f < 2) out.set(sign, s, t);
  else if (f < 4) out.set(s, sign, t);
  else out.set(s, t, sign);
  return out.normalize();
}

const _face = { f: 0, s: 0, t: 0, m: 0 };
const _u = new Vector3();
const _rel: RockRelief = { r: 1, h: 0, crater: 0 };

/**
 * The collision side of a rock shape: its radius on a cube map (bilinear
 * between samples, finer than the rendered mesh), and the signed distance
 * of a point of the unit rock to its surface, with the outward normal.
 */
export class RockCollision {
  /** Samples per cube face edge. */
  readonly n: number;
  private data: Float32Array;
  private inv: Vector3;
  /** Farthest point of the surface from the centre (×radius): the bounding sphere. */
  readonly bound: number;
  /** Nearest point of the surface (×radius): everything closer is rock. */
  readonly core: number;
  /** Mean distance of the surface from the centre (×radius). */
  readonly mean: number;

  constructor(readonly shape: RockShape, n: number) {
    this.n = n;
    const side = n + 1;
    this.data = new Float32Array(6 * side * side);
    this.inv = new Vector3(1 / shape.stretch.x, 1 / shape.stretch.y, 1 / shape.stretch.z);
    let bound = 0;
    let core = Infinity;
    let sum = 0;
    for (let f = 0; f < 6; f++) {
      for (let j = 0; j <= n; j++) {
        for (let i = 0; i <= n; i++) {
          dirOf(f, (2 * i) / n - 1, (2 * j) / n - 1, _u);
          const r = shape.relief(_u, _rel).r;
          this.data[(f * side + j) * side + i] = r;
          const len = r * _u.multiply(shape.stretch).length();
          bound = Math.max(bound, len);
          core = Math.min(core, len);
          sum += len;
        }
      }
    }
    this.bound = bound * 1.01;
    this.core = core * 0.99;
    this.mean = sum / this.data.length;
  }

  /** Radius before the stretch toward (x, y, z) (any length), and its derivatives along the face coordinates. */
  private lookup(x: number, y: number, z: number, grad: { rs: number; rt: number } | null): number {
    const fc = faceOf(x, y, z, _face);
    const n = this.n;
    const side = n + 1;
    const gx = Math.min(n - 1e-6, Math.max(0, ((fc.s + 1) / 2) * n));
    const gy = Math.min(n - 1e-6, Math.max(0, ((fc.t + 1) / 2) * n));
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;
    const base = (fc.f * side + j) * side + i;
    const r00 = this.data[base];
    const r10 = this.data[base + 1];
    const r01 = this.data[base + side];
    const r11 = this.data[base + side + 1];
    if (grad) {
      grad.rs = ((1 - fy) * (r10 - r00) + fy * (r11 - r01)) * (n / 2);
      grad.rt = ((1 - fx) * (r01 - r00) + fx * (r11 - r10)) * (n / 2);
    }
    return (1 - fy) * ((1 - fx) * r00 + fx * r10) + fy * ((1 - fx) * r01 + fx * r11);
  }

  /** The point of the surface (unit rock, local frame) in unstretched direction `u` (unit), as the physics sees it. */
  surfacePoint(u: Vector3, out: Vector3): Vector3 {
    return out.copy(u).multiplyScalar(this.lookup(u.x, u.y, u.z, null)).multiply(this.shape.stretch);
  }

  /** Radius of the surface (stretched, ×the asteroid's radius) in local direction `dir`. */
  surfaceAt(dir: Vector3): number {
    const qx = dir.x * this.inv.x;
    const qy = dir.y * this.inv.y;
    const qz = dir.z * this.inv.z;
    const r = this.lookup(qx, qy, qz, null);
    // The surface point is q̂·r stretched back.
    return r / Math.sqrt(qx * qx + qy * qy + qz * qz) * dir.length();
  }

  /**
   * The field g = |q| − r(q̂) at point `p` of the unit rock (q: `p` before
   * the stretch): zero on the surface, negative inside. Writes ∇g (with
   * respect to `p`) to `grad`.
   */
  private field(p: Vector3, grad: Vector3): number {
    const inv = this.inv;
    const qx = p.x * inv.x;
    const qy = p.y * inv.y;
    const qz = p.z * inv.z;
    const ql = Math.sqrt(qx * qx + qy * qy + qz * qz);
    if (ql < 1e-6) {
      grad.set(0, 0, 0);
      return -this.core;
    }
    const r = this.lookup(qx, qy, qz, _grad);
    // ∇g before the stretch: the radial direction minus the slope of the relief.
    // Face coordinates s = b / m, t = c / m with m = ±a (the major axis): chain rule.
    const fc = _face;
    const sign = fc.f % 2 === 0 ? 1 : -1;
    const rs = _grad.rs / fc.m;
    const rt = _grad.rt / fc.m;
    const ra = -(rs * fc.s + rt * fc.t) * sign;
    let gx = qx / ql;
    let gy = qy / ql;
    let gz = qz / ql;
    if (fc.f < 2) {
      gx -= ra;
      gy -= rs;
      gz -= rt;
    } else if (fc.f < 4) {
      gy -= ra;
      gx -= rs;
      gz -= rt;
    } else {
      gz -= ra;
      gx -= rs;
      gy -= rt;
    }
    // Back to the stretched frame (q = p / stretch).
    grad.set(gx * inv.x, gy * inv.y, gz * inv.z);
    return ql - r;
  }

  /**
   * Signed distance from point `p` of the unit rock (local frame, radius 1)
   * to its surface, negative inside, with the outward normal in `n`.
   * Near the surface (where contacts are decided) it walks onto the
   * surface along the field's gradient and measures to the point reached;
   * farther out it is the field's first-order estimate, a little short so
   * sphere tracing does not step past a bump; outside the bounding sphere,
   * the distance to that sphere.
   */
  distance(p: Vector3, n: Vector3): number {
    const len = p.length();
    if (len > this.bound * 1.05) {
      n.copy(p).divideScalar(len);
      return len - this.bound;
    }
    const g0 = this.field(p, _g0);
    const gl2 = _g0.lengthSq();
    if (gl2 < 1e-18) {
      n.copy(p).divideScalar(len || 1);
      return g0;
    }
    const gl = Math.sqrt(gl2);
    const d0 = g0 / gl;
    if (Math.abs(d0) > NEAR) {
      n.copy(_g0).divideScalar(gl);
      return d0 > 0 ? d0 * 0.92 : d0;
    }
    // Newton steps onto the surface g = 0.
    _x.copy(p).addScaledVector(_g0, -g0 / gl2);
    for (let k = 0; k < 2; k++) {
      const g = this.field(_x, _g1);
      const l2 = _g1.lengthSq();
      if (l2 < 1e-18) break;
      _x.addScaledVector(_g1, -g / l2);
    }
    n.subVectors(p, _x);
    const d = n.length();
    if (d < 1e-7) {
      n.copy(_g0).divideScalar(gl);
      return 0;
    }
    n.divideScalar(g0 < 0 ? -d : d);
    return g0 < 0 ? -d : d;
  }
}

/** Within this distance of the surface (×radius) the distance is measured to the surface itself. */
const NEAR = 0.12;
const _g0 = new Vector3();
const _g1 = new Vector3();
const _x = new Vector3();
const _grad = { rs: 0, rt: 0 };
const collisions = new Map<RockShape, RockCollision>();

/** The collision table of an asteroid of this variant and size, built on first use. */
export function rockCollision(variant: number, big: boolean): RockCollision {
  const shape = rockShape(variant, big);
  let c = collisions.get(shape);
  if (!c) collisions.set(shape, (c = new RockCollision(shape, big ? 48 : 24)));
  return c;
}
