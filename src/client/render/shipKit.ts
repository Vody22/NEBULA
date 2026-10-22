import * as THREE from 'three';
import { SHEET_METERS, type DecalAtlas, type DecalId } from './shipTextures';

/**
 * Hard-surface building blocks for ship hulls: lofted chined sections,
 * metric UVs (one texture tile per SHEET_METERS) and vertex-colour paint.
 * Ships use +Z aft, -Z nose, +Y up, +X starboard.
 */

export type RGB = [number, number, number];

export interface Section {
  z: number;
  /** Half width. */
  w: number;
  /** Height above the centre line. */
  ht: number;
  /** Depth below the centre line. */
  hb: number;
  /** Centre line height. */
  y?: number;
}

/**
 * Cross-section of the right half, from top centre to bottom centre, as
 * fractions of (w, ht) above the centre line and (w, hb) below it. The left
 * half is mirrored. Each edge carries a tag so callers can paint it.
 */
export interface Profile {
  points: [number, number][];
  tags: string[];
}

/** Fighter fuselage: flat top and belly, 45° chamfers, flat sides, a band line high on the side. */
export const CHINED: Profile = {
  points: [
    [0, 1],
    [0.42, 1],
    [1, 0.34],
    [1, 0.12],
    [1, -0.3],
    [0.5, -1],
    [0, -1],
  ],
  tags: ['top', 'shoulder', 'band', 'side', 'chine', 'belly'],
};

/** Octagonal pod (nacelles, spines). */
export const OCTA: Profile = {
  points: [
    [0, 1],
    [0.42, 1],
    [1, 0.42],
    [1, -0.42],
    [0.42, -1],
    [0, -1],
  ],
  tags: ['top', 'shoulder', 'side', 'chine', 'belly'],
};

/** Catmull-Rom through keyframes, clamped at the ends. */
export function sectionAt(keys: Section[], z: number): Required<Section> {
  if (z <= keys[0].z) return { y: 0, ...keys[0], z };
  if (z >= keys[keys.length - 1].z) return { y: 0, ...keys[keys.length - 1], z };
  let i = 0;
  while (keys[i + 1].z < z) i++;
  const k0 = keys[Math.max(0, i - 1)];
  const k1 = keys[i];
  const k2 = keys[i + 1];
  const k3 = keys[Math.min(keys.length - 1, i + 2)];
  const t = (z - k1.z) / (k2.z - k1.z);
  const cr = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  const f = (key: 'w' | 'ht' | 'hb' | 'y') => cr(k0[key] ?? 0, k1[key] ?? 0, k2[key] ?? 0, k3[key] ?? 0);
  return { z, w: Math.max(0.001, f('w')), ht: f('ht'), hb: f('hb'), y: f('y') };
}

/** Full closed loop of points (right half, then mirrored left half) and edge tags. */
function ring(profile: Profile, s: Required<Section>, scale: number): { pts: [number, number][]; tags: string[] } {
  const right = profile.points.map(([fx, fy]) => [fx * s.w * scale, s.y + (fy >= 0 ? fy * s.ht : fy * s.hb) * scale] as [number, number]);
  const left = right
    .slice(1, -1)
    .reverse()
    .map(([x, y]) => [-x, y] as [number, number]);
  const tags = [...profile.tags, ...[...profile.tags].reverse()];
  return { pts: [...right, ...left], tags };
}

export interface LoftOptions {
  profile: Profile;
  keys: Section[];
  z0: number;
  z1: number;
  /** Sampling step along Z, meters. */
  step?: number;
  scale?: number;
  /** Paint per vertex: tag of the edge, position. */
  color?: (tag: string, x: number, y: number, z: number) => RGB;
  /** Close the front or rear end. */
  capFront?: boolean;
  capRear?: boolean;
  /** Only build edges whose tag passes. */
  only?: (tag: string) => boolean;
}

/**
 * Lofts a profile along Z. Every edge of the profile becomes its own strip,
 * so normals stay hard across chines and smooth along the length.
 */
export function loft(o: LoftOptions): THREE.BufferGeometry {
  const step = o.step ?? 0.35;
  const scale = o.scale ?? 1;
  const n = Math.max(2, Math.ceil((o.z1 - o.z0) / step) + 1);
  const rings = [];
  for (let i = 0; i < n; i++) {
    const z = o.z0 + ((o.z1 - o.z0) * i) / (n - 1);
    rings.push(ring(o.profile, sectionAt(o.keys, z), scale));
  }
  const m = rings[0].pts.length;
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const paint = (tag: string, x: number, y: number, z: number) => {
    const c = o.color ? o.color(tag, x, y, z) : ([1, 1, 1] as RGB);
    col.push(c[0], c[1], c[2]);
  };
  for (let e = 0; e < m; e++) {
    const tag = rings[0].tags[e];
    if (o.only && !o.only(tag)) continue;
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const z = o.z0 + ((o.z1 - o.z0) * i) / (n - 1);
      const { pts } = rings[i];
      // Perimeter distance from the top centre to this edge, for the u coordinate.
      let u = 0;
      for (let k = 0; k < e; k++) u += Math.hypot(pts[(k + 1) % m][0] - pts[k][0], pts[(k + 1) % m][1] - pts[k][1]);
      const a = pts[e];
      const b = pts[(e + 1) % m];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      pos.push(a[0], a[1], z, b[0], b[1], z);
      uv.push(u / SHEET_METERS, -z / SHEET_METERS, (u + len) / SHEET_METERS, -z / SHEET_METERS);
      paint(tag, a[0], a[1], z);
      paint(tag, b[0], b[1], z);
      if (i < n - 1) {
        const ai = base + i * 2;
        idx.push(ai, ai + 2, ai + 1, ai + 1, ai + 2, ai + 3);
      }
    }
  }
  const strips = new THREE.BufferGeometry();
  strips.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  strips.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  strips.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  strips.setIndex(idx);
  strips.computeVertexNormals();
  const parts = [strips];
  if (o.capFront) parts.push(cap(rings[0].pts, o.z0, true, o.color?.('cap', 0, 0, o.z0)));
  if (o.capRear) parts.push(cap(rings[n - 1].pts, o.z1, false, o.color?.('cap', 0, 0, o.z1)));
  return parts.length === 1 ? strips : join(parts);
}

function cap(pts: [number, number][], z: number, front: boolean, c: RGB = [1, 1, 1]) {
  const cx = 0;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const pos: number[] = [cx, cy, z];
  const uv: number[] = [0, 0];
  for (const [x, y] of pts) {
    pos.push(x, y, z);
    uv.push(x / SHEET_METERS, y / SHEET_METERS);
  }
  const idx: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = 1 + i;
    const b = 1 + ((i + 1) % pts.length);
    // The loop runs clockwise seen from +Z: (c, a, b) faces -Z.
    if (front) idx.push(0, a, b);
    else idx.push(0, b, a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => c[i % 3]), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Joins indexed or non-indexed geometries that share position/normal/uv/color. */
export function join(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const names = ['position', 'normal', 'uv', 'color'];
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const size = name === 'uv' ? 2 : 3;
    const arrays = flat.map((g) => {
      const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
      return a ? (a.array as Float32Array) : new Float32Array(g.getAttribute('position').count * size).fill(name === 'color' ? 1 : 0);
    });
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const a of arrays) {
      merged.set(a, off);
      off += a.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(merged, size));
  }
  return out;
}

/** Rescales a primitive's UVs so the sheet keeps its texel density (meters). */
export function metricUv(geo: THREE.BufferGeometry, uMeters: number, vMeters = uMeters) {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * uMeters) / SHEET_METERS, (uv.getY(i) * vMeters) / SHEET_METERS);
  return geo;
}

/** Extruded geometries already use meters as UVs. */
export function sheetUv(geo: THREE.BufferGeometry) {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / SHEET_METERS, uv.getY(i) / SHEET_METERS);
  return geo;
}

/** Paints every vertex: a constant colour or a function of the position. */
export function tint(geo: THREE.BufferGeometry, c: RGB | ((x: number, y: number, z: number) => RGB)) {
  const p = geo.getAttribute('position');
  const out = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const v = typeof c === 'function' ? c(p.getX(i), p.getY(i), p.getZ(i)) : c;
    out.set(v, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3));
  return geo;
}

/** Extrude a planform (x, z) into a horizontal plate of `thickness`, centred on y = 0. */
export function plate(points: [number, number][], thickness: number, bevel = 0.06) {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, thickness - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
  });
  geo.translate(0, 0, -(thickness - bevel * 2) / 2);
  geo.rotateX(Math.PI / 2);
  return sheetUv(geo);
}

/** A tube through points (antennas, canopy frames, pipes). */
export function tube(points: THREE.Vector3[], radius: number, radial = 6, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed);
  return new THREE.TubeGeometry(curve, Math.max(4, points.length * 4), radius, radial, closed);
}

/** Cylinder along Z: `r0` at z0 (front), `r1` at z1 (rear). */
export function cylZ(r0: number, r1: number, z0: number, z1: number, seg = 16, open = false) {
  const g = new THREE.CylinderGeometry(r1, r0, z1 - z0, seg, 1, open);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, (z0 + z1) / 2);
  return metricUv(g, 2 * Math.PI * Math.max(r0, r1), z1 - z0);
}

export function box(w: number, h: number, d: number) {
  return metricUv(new THREE.BoxGeometry(w, h, d), Math.max(w, d), Math.max(h, d));
}

/** Mirror a geometry across X (fixes the winding). */
export function mirrorX(geo: THREE.BufferGeometry) {
  const g = geo.clone();
  g.scale(-1, 1, 1);
  if (g.index) {
    const a = g.index.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = t;
    }
  } else {
    for (const name of Object.keys(g.attributes)) {
      const attr = g.getAttribute(name) as THREE.BufferAttribute;
      const s = attr.itemSize;
      const arr = attr.array as Float32Array;
      for (let t = 0; t < attr.count; t += 3) {
        for (let k = 0; k < s; k++) {
          const i1 = (t + 1) * s + k;
          const i2 = (t + 2) * s + k;
          const tmp = arr[i1];
          arr[i1] = arr[i2];
          arr[i2] = tmp;
        }
      }
    }
  }
  return g;
}

/**
 * A flat decal quad, `w` meters wide, mapped onto one rectangle of the atlas.
 * It faces +Z with its text running along +X; callers orient it.
 */
export function decal(atlas: DecalAtlas, id: DecalId, w: number) {
  const [u0, v0, u1, v1] = atlas.rects[id];
  const aspect = ((v1 - v0) * 512) / ((u1 - u0) * 1024);
  const g = new THREE.PlaneGeometry(w, w * aspect);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  return g;
}

/** Places a geometry with a position and Euler rotation (baked). */
export function place(geo: THREE.BufferGeometry, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0]) {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
    new THREE.Vector3(1, 1, 1),
  );
  geo.applyMatrix4(m);
  return geo;
}
