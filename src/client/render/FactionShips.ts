import * as THREE from 'three';
import { makeKit, type Kit } from './FalconMk2';
import {
  CHINED,
  OCTA,
  box,
  cylZ,
  decal,
  loft,
  mirrorX,
  place,
  plate,
  sectionAt,
  tint,
  tube,
  type Profile,
  type RGB,
  type Section,
} from './shipKit';
import type { DecalId } from './shipTextures';
import type { ShipModel } from './ShipModels';

/**
 * The other three hulls, each with its faction's visual language.
 *
 * Union of Aurora (Falcon, Warden): regulation lights (red port, green
 * starboard, white tail, strobes), clean painted plates, an ivory or navy
 * identity band, cool blue-green engines, symmetric layouts.
 *
 * Free raiders (Raider, Marauder): they run dark (dim red markers only, no
 * strobes), fly patched hulls of scavenged plates in mismatched paint and
 * rust, bolt-on extras that break the symmetry, red visor slits and warm
 * orange-red engines.
 *
 * Gameplay anchors stay where the simulation puts them: the gun muzzles end
 * exactly on the hardpoints of `shipClasses.ts`. Procedural models, not
 * production art assets.
 */

type Part = [THREE.BufferGeometry, THREE.Material];
type RcsList = NonNullable<ShipModel['rcs']>;

const lerp3 = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const HEAT: RGB = [0.42, 0.34, 0.3];

function builder() {
  const root = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    root.add(new THREE.Mesh(geo, mat));
  };
  const both = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    add(geo, mat);
    add(mirrorX(geo), mat);
  };
  /** Adds parts moved to (x, y); `mirror` also adds their copy at -x. */
  const at = (parts: Part[], x: number, y: number, mirror = false) => {
    for (const [g, m] of parts) {
      g.translate(x, y, 0);
      if (mirror) both(g, m);
      else add(g, m);
    }
  };
  return { root, add, both, at };
}

/** Three-layer nozzle (petals, hot ring, ejection cone) whose exit is at z = `ze`. */
function nozzle(k: Kit, r: number, ze: number, glow: RGB): Part[] {
  const len = r * 1.25;
  const z0 = ze - len;
  const heat = (_x: number, _y: number, z: number): RGB => lerp3([1, 1, 1], [0.78, 0.66, 0.6], clamp01((z - z0) / len));
  const parts: Part[] = [
    [tint(cylZ(r * 1.1, r, z0, ze, 16, true), heat), k.metal],
    [tint(cylZ(r * 0.96, r * 0.9, z0 + 0.05 * r, ze - 0.05 * r, 16, true), [0.5, 0.5, 0.52]), k.dark],
    [tint(new THREE.TorusGeometry(r * 0.88, r * 0.05, 6, 28).translate(0, 0, ze - 0.5 * r), [1.4, 0.75, 0.45]), k.glow],
    [tint(new THREE.CircleGeometry(r * 0.9, 24).translate(0, 0, ze - 0.9 * r), glow), k.glow],
    [
      tint(cylZ(r * 0.46, r * 0.04, ze - 0.95 * r, ze + 0.25 * r, 14), (_x, _y, z) =>
        lerp3([0.9, 0.9, 0.9], [0.7, 0.6, 0.65], clamp01((z - (ze - 0.95 * r)) / (1.2 * r))),
      ),
      k.metal,
    ],
  ];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    parts.push([place(box(0.06 * r, 0.07 * r, 0.8 * len), [Math.cos(a) * r * 1.08, Math.sin(a) * r * 1.08, ze - 0.45 * len], [0, 0, a]), k.metal]);
  }
  return parts;
}

/** Cannon whose muzzle is exactly at z = `zm`: brake, barrel with cooling rings, painted housing. */
function gun(k: Kit, zm: number, r: number, barrel: number, housing: number, col: RGB): Part[] {
  const brake = r * 2.4;
  const zb = zm + barrel;
  const parts: Part[] = [
    [cylZ(r * 1.55, r * 1.55, zm, zm + brake, 10), k.metal],
    [cylZ(r, r, zm + brake, zb, 10), k.metal],
    [tint(cylZ(r * 1.2, r * 2.1, zb, zb + r * 2.5, 12), col), k.paint],
    [tint(cylZ(r * 2.1, r * 2.1, zb + r * 2.5, zb + r * 2.5 + housing, 12), col), k.paint],
  ];
  for (let i = 0; i < 4; i++) {
    const z = zm + brake + 0.2 + (i * (barrel - brake - 0.4)) / 4;
    parts.push([cylZ(r * 1.35, r * 1.35, z, z + 0.07, 10), k.metal]);
  }
  return parts;
}

/** A manoeuvring thruster block with one nozzle per exhaust direction. */
function rcsBlock(add: (g: THREE.BufferGeometry, m: THREE.Material) => void, k: Kit, list: RcsList, p: THREE.Vector3, dirs: THREE.Vector3[], size = 0.3) {
  add(place(box(size, size, size * 1.15), [p.x, p.y, p.z]), k.dark);
  for (const d of dirs) {
    const n = new THREE.CylinderGeometry(size * 0.17, size * 0.23, size * 0.4, 8);
    n.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d));
    n.translate(p.x + d.x * size * 0.6, p.y + d.y * size * 0.6, p.z + d.z * size * 0.6);
    add(n, k.metal);
    list.push({ pos: p.clone().addScaledVector(d, size * 0.85), dir: d.clone() });
  }
}

/** Decal on the vertical flank of a lofted body, both sides, following its taper. */
function flankDecal(add: (g: THREE.BufferGeometry, m: THREE.Material) => void, k: Kit, keys: Section[], id: DecalId, z: number, w: number, y: number, ox = 0, sides: number[] = [-1, 1]) {
  for (const sx of sides) {
    const s = sectionAt(keys, z);
    const dw = (sectionAt(keys, z + 0.2).w - sectionAt(keys, z - 0.2).w) / 0.4;
    add(place(decal(k.atlas, id, w), [sx * (s.w + ox + 0.008), y, z], [0, Math.atan2(sx, -dw), 0]), k.decal);
  }
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// ════════════════════════════════════════════════════════════════════════
// Union of Aurora — WARDEN heavy escort
// Thick armoured fuselage, short gun-pod wings with drooping winglets, one
// tall dorsal fin over two ventral fins, a wide engine block with three
// nozzles. Gun muzzles at (±4.6, -0.6, -6.5).
// ════════════════════════════════════════════════════════════════════════

// The Falcon's colours swapped: slate-blue hull with the Falcon's ivory as the band.
const WARDEN = {
  hull: [0.15, 0.21, 0.36] as RGB,
  back: [0.07, 0.08, 0.1] as RGB,
  band: [1.0, 0.95, 0.86] as RGB,
  belly: [0.27, 0.3, 0.38] as RGB,
  glow: [0.2, 1.35, 0.9] as RGB,
};

const WF: Section[] = [
  { z: -8.6, w: 0.25, ht: 0.2, hb: 0.25, y: -0.15 },
  { z: -8.0, w: 0.75, ht: 0.55, hb: 0.55, y: -0.12 },
  { z: -6.8, w: 1.25, ht: 0.85, hb: 0.75, y: -0.05 },
  { z: -5.0, w: 1.6, ht: 1.1, hb: 0.88, y: 0 },
  { z: -2.5, w: 1.85, ht: 1.3, hb: 0.95, y: 0 },
  { z: 0.5, w: 1.95, ht: 1.35, hb: 1.0, y: 0 },
  { z: 4.0, w: 1.95, ht: 1.3, hb: 1.0, y: 0 },
  { z: 6.5, w: 1.85, ht: 1.2, hb: 0.95, y: 0 },
  { z: 8.2, w: 1.65, ht: 1.05, hb: 0.85, y: 0 },
];
// Engine block, wider and lower than the fuselage (OCTA).
const WE: Section[] = [
  { z: 2.6, w: 1.9, ht: 0.6, hb: 0.9, y: -0.2 },
  { z: 4.0, w: 2.55, ht: 0.8, hb: 1.1, y: -0.2 },
  { z: 7.0, w: 2.6, ht: 0.8, hb: 1.12, y: -0.2 },
  { z: 8.3, w: 2.5, ht: 0.76, hb: 1.05, y: -0.2 },
];
const WPOD: Section[] = [
  { z: -2.6, w: 0.3, ht: 0.28, hb: 0.3 },
  { z: -1.8, w: 0.5, ht: 0.46, hb: 0.5 },
  { z: 2.6, w: 0.52, ht: 0.48, hb: 0.52 },
  { z: 3.2, w: 0.4, ht: 0.36, hb: 0.4 },
];

export function buildWarden(): ShipModel {
  const pal = WARDEN;
  const k = makeKit('warden-escort', {
    sheetSeed: 2210,
    atlas: { serial: 'WDN-2210', maker: 'AURORA FLEETWORKS', model: 'WARDEN', color: '#e9e4d4', warn: '#d8a21c' },
  });
  const { root, add, both, at } = builder();
  const rcs: RcsList = [];
  const top = (z: number) => {
    const s = sectionAt(WF, z);
    return s.y + s.ht;
  };

  // ── Fuselage: four armour sections over a dark core ──────────────────
  const fusePaint = (tag: string, _x: number, _y: number, z: number): RGB => {
    if (tag === 'cap' || z < -7.9) return pal.back;
    if (tag === 'top' || tag === 'shoulder') return pal.back;
    if (tag === 'band') return pal.band;
    if (tag === 'belly' || tag === 'chine') return pal.belly;
    return pal.hull;
  };
  const pieces: [number, number][] = [
    [-8.6, -5.04],
    [-4.96, -0.54],
    [-0.46, 3.96],
    [4.04, 8.2],
  ];
  pieces.forEach(([z0, z1], i) => add(loft({ profile: CHINED, keys: WF, z0, z1, step: 0.3, color: fusePaint, capFront: i === 0 }), k.paint));
  add(loft({ profile: CHINED, keys: WF, z0: -5.1, z1: 8.2, scale: 0.975, step: 0.6, capRear: true, color: () => [0.6, 0.6, 0.62] }), k.dark);

  // Engine block: two sections, hot towards the nozzles, dark intakes in front.
  const ebPaint = (tag: string, _x: number, _y: number, z: number): RGB => {
    if (tag === 'cap') return [0.08, 0.08, 0.09];
    const base = tag === 'top' || tag === 'shoulder' ? pal.back : tag === 'belly' || tag === 'chine' ? pal.belly : pal.hull;
    return lerp3(base, HEAT, clamp01((z - 6.6) / 1.7) * 0.8);
  };
  add(loft({ profile: OCTA, keys: WE, z0: 2.6, z1: 5.36, step: 0.3, color: ebPaint, capFront: true }), k.paint);
  add(loft({ profile: OCTA, keys: WE, z0: 5.44, z1: 8.3, step: 0.3, color: ebPaint }), k.paint);
  add(loft({ profile: OCTA, keys: WE, z0: 5.2, z1: 8.3, scale: 0.97, step: 1, capRear: true, color: () => [0.5, 0.5, 0.52] }), k.dark);
  at(nozzle(k, 1.0, 9.4, pal.glow), 0, 0.05);
  at(nozzle(k, 0.72, 9.0, pal.glow), 1.75, -0.25, true);

  // Dorsal spine with a sensor dome.
  const spine: Section[] = [
    { z: -2.6, w: 0.3, ht: 0.1, hb: 0.2 },
    { z: -1.0, w: 0.55, ht: 0.32, hb: 0.2 },
    { z: 5.0, w: 0.6, ht: 0.34, hb: 0.2 },
    { z: 7.4, w: 0.35, ht: 0.12, hb: 0.2 },
  ].map((s) => ({ ...s, y: top(s.z) - 0.02 }));
  add(loft({ profile: OCTA, keys: spine, z0: -2.6, z1: 7.4, step: 0.35, capFront: true, capRear: true, color: () => lerp3(pal.back, [0.2, 0.2, 0.22], 0.4) }), k.paint);
  const dome = new THREE.SphereGeometry(0.42, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.scale(1, 0.6, 1.3);
  dome.translate(0, top(0.4) + 0.3, 0.4);
  add(dome, k.glass);

  // ── Armoured cockpit: small canopy, heavy frames ──────────────────────
  const cz = -4.6;
  const cy = top(cz) - 0.05;
  const rx = 0.62;
  const ry = 0.52;
  const rz = 1.7;
  const canopy = new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  canopy.scale(rx, ry, rz);
  canopy.translate(0, cy, cz);
  add(canopy, k.glass);
  const arc = (dz: number) => {
    const kz = Math.sqrt(Math.max(0, 1 - (dz / rz) ** 2));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI;
      pts.push(V(Math.cos(a) * rx * kz * 1.02, cy + Math.sin(a) * ry * kz * 1.02, cz + dz));
    }
    return pts;
  };
  for (const dz of [-1.0, -0.25, 0.55]) add(tube(arc(dz), 0.045, 6), k.dark);
  const ridge: THREE.Vector3[] = [];
  const sill: THREE.Vector3[] = [];
  for (let i = 0; i <= 10; i++) {
    const dz = -rz * 0.92 + (i / 10) * rz * 1.84;
    const kz = Math.sqrt(1 - (dz / rz) ** 2);
    ridge.push(V(0, cy + ry * kz * 1.02, cz + dz));
    sill.push(V(rx * kz * 1.02, cy + 0.01, cz + dz));
  }
  add(tube(ridge, 0.035, 6), k.dark);
  both(tube(sill, 0.055, 6), k.dark);
  add(tint(new THREE.SphereGeometry(0.13, 14, 10).translate(0, cy + 0.3, cz + 0.4), [0.85, 0.84, 0.8]), k.paint);
  add(place(box(0.7, 0.16, 0.32), [0, cy + 0.12, cz - 0.7]), k.dark);
  add(tint(place(new THREE.PlaneGeometry(0.5, 0.12), [0, cy + 0.23, cz - 0.53], [-0.5, 0, 0]), [0.25, 1.2, 0.8]), k.glow);

  // ── Wings with gun pods and drooping winglets ─────────────────────────
  const WY = -0.6;
  const wing = tint(plate([[1.8, -2.6], [5.5, 0.4], [5.7, 0.7], [5.7, 3.0], [1.8, 3.8]], 0.42, 0.08), (x) => (x > 5.25 ? pal.band : pal.hull));
  wing.translate(0, WY, 0);
  both(wing, k.paint);
  const winglet = tint(plate([[0, 0.9], [0.9, 1.8], [0.95, 3.0], [0, 3.1]], 0.12, 0.03), pal.back);
  winglet.rotateZ(-Math.PI / 2);
  winglet.translate(5.68, WY, 0);
  both(winglet, k.paint);
  const podPaint = (tag: string): RGB => (tag === 'top' || tag === 'shoulder' ? pal.back : tag === 'belly' ? pal.belly : pal.hull);
  const pod = loft({ profile: OCTA, keys: WPOD, z0: -2.6, z1: 3.2, step: 0.3, color: podPaint, capFront: true, capRear: true });
  at([[pod, k.paint]], 4.6, WY, true);
  at(gun(k, -6.5, 0.13, 2.6, 1.2, pal.back), 4.6, WY, true);

  // Armour skirts along the flanks.
  const skirt = tint(plate([[0, -2.4], [0.62, -2.0], [0.62, 3.0], [0, 3.4]], 0.1, 0.03), pal.back);
  skirt.rotateZ(Math.PI / 2);
  skirt.translate(2.03, -0.45, 0);
  both(skirt, k.paint);

  // ── Tail: tall dorsal fin, two canted ventral fins ────────────────────
  const fin = tint(plate([[0, 3.6], [2.0, 6.8], [2.25, 8.3], [1.7, 8.5], [0, 8.3]], 0.2, 0.06), (x) => (x > 1.75 ? pal.band : pal.hull));
  fin.rotateZ(Math.PI / 2);
  const finY = top(6) - 0.1;
  fin.translate(0, finY, 0);
  add(fin, k.paint);
  for (const sx of [-1, 1]) add(place(decal(k.atlas, 'serial', 1.6), [sx * 0.106, finY + 1.0, 7.0], [0, (sx * Math.PI) / 2, 0]), k.decal);
  const vfin = tint(plate([[0, 5.0], [1.0, 6.8], [1.05, 8.0], [0, 8.2]], 0.14, 0.04), pal.back);
  vfin.rotateZ(-Math.PI / 2 + 0.35);
  vfin.translate(1.5, -1.25, 0);
  both(vfin, k.paint);

  // ── RCS, antennas, decals ─────────────────────────────────────────────
  for (const sx of [-1, 1]) {
    const s = sectionAt(WF, -7.0);
    rcsBlock(add, k, rcs, V(sx * (s.w - 0.05), s.y + 0.05, -7.0), [V(sx, 0, 0), V(0, 1, 0), V(0, -1, 0)]);
    rcsBlock(add, k, rcs, V(sx * 5.3, WY + 0.32, 3.3), [V(sx, 0, 0), V(0, 1, 0), V(0, -1, 0)]);
  }
  add(tube([V(0.3, top(2.5) + 0.3, 2.5), V(0.3, top(2.5) + 0.8, 2.9), V(0.3, top(2.5) + 1.1, 3.3)], 0.022, 5), k.metal);
  flankDecal(add, k, WF, 'model', -6.4, 1.4, sectionAt(WF, -6.4).y + 0.04);
  flankDecal(add, k, WE, 'maker', 6.0, 2.0, -0.3);
  for (const sx of [-1, 1]) {
    add(place(decal(k.atlas, 'emblem', 1.2), [sx * 3.2, WY + 0.214, 1.6], [-Math.PI / 2, 0, 0]), k.decal);
    add(place(decal(k.atlas, 'nostep', 0.8), [sx * 2.5, WY + 0.214, 2.9], [-Math.PI / 2, 0, 0]), k.decal);
  }

  return {
    root,
    engines: [
      { pos: V(0, 0.05, 9.4), radius: 1.0 },
      { pos: V(-1.75, -0.25, 9.0), radius: 0.72 },
      { pos: V(1.75, -0.25, 9.0), radius: 0.72 },
    ],
    engineColor: new THREE.Color(0.4, 3, 2),
    boostColor: new THREE.Color(2, 5, 3.4),
    shieldScale: new THREE.Vector3(9.5, 4.5, 11),
    navs: [
      { pos: V(-5.74, WY, 0.85), color: new THREE.Color(2.5, 0.2, 0.15), size: 0.9 },
      { pos: V(5.74, WY, 0.85), color: new THREE.Color(0.2, 2.5, 0.3), size: 0.9 },
      { pos: V(0, finY + 2.2, 8.45), color: new THREE.Color(2, 2, 2), size: 0.7 },
    ],
    strobes: [
      { pos: V(-5.74, WY - 0.92, 2.9), color: new THREE.Color(2.4, 2.4, 2.5) },
      { pos: V(5.74, WY - 0.92, 2.9), color: new THREE.Color(2.4, 2.4, 2.5) },
      { pos: V(0, -1.12, 0.5), color: new THREE.Color(2.4, 0.25, 0.2) },
    ],
    rcs,
  };
}

// ════════════════════════════════════════════════════════════════════════
// Free raiders — shared look
// ════════════════════════════════════════════════════════════════════════

const RUST: RGB = [0.17, 0.07, 0.035];
const PRIMER: RGB = [0.08, 0.085, 0.08];
const BARE: RGB = [0.36, 0.36, 0.35];
const FADED: RGB = [0.18, 0.16, 0.13];
/** Blood red, the one colour every raider crew paints on. */
const PIRATE_RED: RGB = [0.2, 0.032, 0.025];
const PIRATE_GLOW: RGB = [5, 0.5, 0.15];
const MARKER = new THREE.Color(1.5, 0.12, 0.08);

function hash(a: number, b: number, c: number) {
  const h = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * Scavenged plating: each panel (one edge of the profile, one side, about
 * 2 m long) gets its own paint, primer, bare metal or rust.
 */
function salvage(base: RGB, seed: number, panel = 2.1) {
  const pick = (h: number): RGB => {
    if (h < 0.12) return RUST;
    if (h < 0.22) return PRIMER;
    if (h < 0.27) return BARE;
    if (h < 0.35) return FADED;
    return lerp3(base, RUST, (h - 0.35) * 0.3);
  };
  return {
    loft: (tag: string, x: number, _y: number, z: number): RGB => pick(hash(seed + tag.length * 3.1 + tag.charCodeAt(0) + (x < -0.01 ? 7 : 0), Math.floor(z / panel), seed)),
    flat: (x: number, _y: number, z: number): RGB => pick(hash(seed + Math.floor(x / 1.7) * 5.3, Math.floor(z / 1.7), seed + 1)),
  };
}

function pirateKit(key: string, serial: string, model: string): Kit {
  return makeKit(key, {
    sheetSeed: key === 'raider' ? 1313 : 6666,
    darkSeed: 44,
    darkBase: '#4a4744',
    normal: 0.55,
    atlas: { serial, maker: 'NO REGISTRY', model, color: '#d9d2bf', warn: '#d8a21c', emblem: 'pirate' },
  });
}

// ════════════════════════════════════════════════════════════════════════
// RAIDER light fighter
// Razor fuselage with a sharp chine, forward-swept serrated blades, an
// armoured hood with a red visor slit, one big engine and two strapped-on
// boosters, an extra tank under one blade and a bolted-on plate on the nose.
// Gun muzzles at (±3.2, 0, -5.5).
// ════════════════════════════════════════════════════════════════════════

/** Diamond section with a sharp horizontal chine. */
const RAZOR: Profile = {
  points: [
    [0, 1],
    [0.22, 0.88],
    [1, 0],
    [0.4, -0.78],
    [0, -1],
  ],
  tags: ['ridge', 'flank', 'chine', 'belly'],
};

const RF: Section[] = [
  { z: -7.4, w: 0.05, ht: 0.05, hb: 0.05 },
  { z: -6.6, w: 0.5, ht: 0.28, hb: 0.22 },
  { z: -4.5, w: 1.05, ht: 0.55, hb: 0.42 },
  { z: -1.5, w: 1.35, ht: 0.78, hb: 0.55 },
  { z: 2.0, w: 1.4, ht: 0.8, hb: 0.6 },
  { z: 5.0, w: 1.25, ht: 0.72, hb: 0.6 },
  { z: 7.2, w: 1.0, ht: 0.62, hb: 0.55 },
];
const RENG: Section[] = [
  { z: 4.6, w: 1.1, ht: 0.6, hb: 0.55 },
  { z: 6.0, w: 1.45, ht: 0.85, hb: 0.85 },
  { z: 8.6, w: 1.4, ht: 0.82, hb: 0.82 },
  { z: 8.9, w: 1.3, ht: 0.78, hb: 0.78 },
];

export function buildRaider(): ShipModel {
  const k = pirateKit('raider', 'RX-13', 'RAIDER');
  const paint = salvage(PIRATE_RED, 13);
  const { root, add, both, at } = builder();
  const rcs: RcsList = [];
  const top = (z: number) => {
    const s = sectionAt(RF, z);
    return s.y + s.ht;
  };

  // ── Fuselage: plates missing over the engine bay show the frame ───────
  const pieces: [number, number][] = [
    [-7.4, -3.84],
    [-3.76, 0.66],
    [0.74, 3.2],
    [4.6, 7.2],
  ];
  pieces.forEach(([z0, z1], i) => add(loft({ profile: RAZOR, keys: RF, z0, z1, step: 0.3, color: paint.loft, capFront: i === 0 }), k.paint));
  add(loft({ profile: RAZOR, keys: RF, z0: -3.9, z1: 7.2, scale: 0.96, step: 0.5, capRear: true, color: () => [0.5, 0.5, 0.52] }), k.dark);
  for (const z of [3.5, 3.9, 4.3]) {
    const s = sectionAt(RF, z);
    const pts = [V(s.w, 0, z), V(0.22 * s.w, 0.88 * s.ht, z), V(0, s.ht, z), V(-0.22 * s.w, 0.88 * s.ht, z), V(-s.w, 0, z)];
    add(tube(pts, 0.05, 6), k.metal);
  }
  add(tube([V(0.35, top(3.2) - 0.05, 3.2), V(0.35, top(4.6) - 0.05, 4.6)], 0.06, 6), k.metal);
  add(tube([V(-0.4, top(3.2) - 0.08, 3.2), V(-0.5, top(3.9) - 0.15, 3.9), V(-0.4, top(4.6) - 0.08, 4.6)], 0.045, 6), k.dark);

  // Armoured hood, set off to the left, with the red visor slit.
  const HX = -0.18;
  const hood: Section[] = [
    { z: -4.2, w: 0.12, ht: 0.06, hb: 0.1 },
    { z: -3.5, w: 0.42, ht: 0.3, hb: 0.1 },
    { z: -2.0, w: 0.5, ht: 0.4, hb: 0.1 },
    { z: -0.9, w: 0.4, ht: 0.22, hb: 0.1 },
  ].map((s) => ({ ...s, y: top(s.z) - 0.06 }));
  const hoodGeo = loft({ profile: OCTA, keys: hood, z0: -4.2, z1: -0.9, step: 0.25, capFront: true, capRear: true, color: () => PRIMER });
  hoodGeo.translate(HX, 0, 0);
  add(hoodGeo, k.paint);
  add(tint(place(box(0.62, 0.06, 0.05), [HX, top(-3.3) + 0.17, -3.36], [-0.55, 0, 0]), PIRATE_GLOW), k.glow);
  for (const sx of [-1, 1]) add(tint(place(box(0.04, 0.05, 0.6), [HX + sx * 0.47, top(-2.4) + 0.18, -2.4]), PIRATE_GLOW), k.glow);

  // ── Forward-swept serrated blades with the guns on top ────────────────
  const blade = tint(
    plate(
      [
        [1.0, 0.5],
        [6.6, -3.4],
        [7.0, -3.9],
        [6.3, -2.6],
        [5.6, -0.9],
        [5.2, -1.3],
        [4.4, 0.4],
        [4.0, 0.0],
        [3.2, 1.8],
        [2.8, 1.4],
        [2.0, 3.4],
        [1.0, 4.6],
      ],
      0.24,
      0.05,
    ),
    paint.flat,
  );
  blade.rotateZ(-0.1);
  both(blade, k.paint);
  at(gun(k, -5.5, 0.11, 3.0, 2.4, PRIMER), 3.2, 0, true);
  at([[place(box(0.2, 0.25, 1.6), [0, -0.15, -0.8]), k.dark]], 3.2, 0, true);

  // ── Engines: one big, two strapped-on boosters ────────────────────────
  const engPaint = (tag: string, x: number, y: number, z: number): RGB => lerp3(paint.loft(tag, x, y, z), HEAT, clamp01((z - 7.2) / 1.7) * 0.8);
  add(loft({ profile: OCTA, keys: RENG, z0: 4.6, z1: 8.9, step: 0.3, color: engPaint, capFront: true, capRear: true }), k.paint);
  at(nozzle(k, 0.95, 10.0, [1.8, 0.45, 0.12]), 0, 0);
  const booster: Part[] = [
    [tint(cylZ(0.12, 0.5, 2.4, 3.2, 12), FADED), k.paint],
    [tint(cylZ(0.5, 0.5, 3.2, 8.65, 12), (_x, _y, z) => (z > 6.5 ? RUST : FADED)), k.paint],
    [place(box(1.0, 0.16, 0.6), [-0.55, 0.05, 5.0]), k.dark],
    [place(box(1.0, 0.16, 0.6), [-0.55, 0.05, 7.0]), k.dark],
  ];
  for (const z of [4.0, 5.8, 7.6]) booster.push([new THREE.TorusGeometry(0.53, 0.045, 6, 20).translate(0, 0, z), k.metal]);
  at(booster, 2.0, -0.2, true);
  at(nozzle(k, 0.5, 9.2, [1.8, 0.45, 0.12]), 2.0, -0.2, true);

  // ── Salvage: extra tank under the left blade, odd plate on the nose ──
  const tank: Part[] = [
    [tint(cylZ(0.08, 0.38, -1.3, -0.6, 12), BARE), k.paint],
    [tint(cylZ(0.38, 0.38, -0.6, 2.6, 12), (_x, _y, z) => (z > 0.6 && z < 1.1 ? [0.5, 0.1, 0.08] : BARE)), k.paint],
    [tint(cylZ(0.38, 0.1, 2.6, 3.1, 12), BARE), k.paint],
    [place(box(0.15, 0.4, 1.4), [0, 0.4, 1.0]), k.dark],
  ];
  for (const z of [-0.2, 2.2]) tank.push([new THREE.TorusGeometry(0.4, 0.035, 6, 20).translate(0, 0, z), k.metal]);
  at(tank, -4.0, -0.85);
  {
    const s = sectionAt(RF, -4.6);
    add(tint(place(box(0.06, 0.55, 1.7), [0.61 * s.w + 0.03, 0.44 * s.ht + 0.05, -4.6], [0.05, 0.1, 1.06]), BARE), k.paint);
  }
  // Jagged dorsal fin and a bent antenna.
  const teeth = tint(plate([[0, 0.8], [0.45, 1.6], [0.2, 1.8], [0.55, 2.8], [0.25, 3.0], [0.6, 4.0], [0, 4.4]], 0.08, 0.02), PRIMER);
  teeth.rotateZ(Math.PI / 2);
  teeth.translate(0, top(2) - 0.05, 0);
  add(teeth, k.paint);
  add(tube([V(0.5, top(5.4) - 0.1, 5.4), V(0.55, top(5.4) + 0.5, 5.6), V(0.85, top(5.4) + 0.8, 6.3)], 0.02, 5), k.metal);

  // ── RCS and markings ──────────────────────────────────────────────────
  for (const sx of [-1, 1]) {
    rcsBlock(add, k, rcs, V(sx * 0.78, 0, -5.2), [V(sx, 0, 0), V(0, 1, 0), V(0, -1, 0)], 0.24);
    rcsBlock(add, k, rcs, V(sx * 6.0, -0.6, -2.4), [V(sx, 0, 0), V(0, 1, 0), V(0, -1, 0)], 0.24);
  }
  add(place(decal(k.atlas, 'serial', 1.5), [-1.456, 0.05, 7.2], [0, -Math.PI / 2, 0]), k.decal);
  add(decal(k.atlas, 'emblem', 1.0).rotateX(-Math.PI / 2).translate(4.3, 0.124, -0.8).rotateZ(-0.1), k.decal);

  return {
    root,
    engines: [
      { pos: V(0, 0, 10), radius: 0.95 },
      { pos: V(-2.0, -0.2, 9.2), radius: 0.5 },
      { pos: V(2.0, -0.2, 9.2), radius: 0.5 },
    ],
    engineColor: new THREE.Color(4, 1.1, 0.3),
    boostColor: new THREE.Color(6, 2.5, 1),
    shieldScale: new THREE.Vector3(8.5, 3.6, 10),
    navs: [
      { pos: V(-6.97, -0.69, -3.86), color: MARKER, size: 0.5 },
      { pos: V(6.97, -0.69, -3.86), color: MARKER, size: 0.5 },
    ],
    rcs,
  };
}

// ════════════════════════════════════════════════════════════════════════
// MARAUDER heavy gunship
// Hammerhead ram prow with teeth, a bulky hull covered in welded plates,
// gun sponsons on pylons, a twin-barrel dorsal turret, a bridge tower with
// a red window band, cargo strapped on the back and four engines.
// Gun muzzles at (±7, -1, -10) and (0, 2.5, -12).
// ════════════════════════════════════════════════════════════════════════

const MF: Section[] = [
  { z: -11.5, w: 2.4, ht: 0.9, hb: 1.2, y: -0.4 },
  { z: -10, w: 3.2, ht: 1.4, hb: 1.6, y: -0.3 },
  { z: -7, w: 3.8, ht: 1.9, hb: 1.9, y: -0.1 },
  { z: -2, w: 4.2, ht: 2.2, hb: 2.0, y: 0 },
  { z: 4, w: 4.3, ht: 2.2, hb: 2.0, y: 0 },
  { z: 9, w: 4.0, ht: 2.0, hb: 1.9, y: 0 },
  { z: 11.6, w: 3.7, ht: 1.8, hb: 1.8, y: 0 },
];
const MSP: Section[] = [
  { z: -7.6, w: 0.6, ht: 0.5, hb: 0.6 },
  { z: -6.6, w: 1.2, ht: 1.0, hb: 1.1 },
  { z: -3, w: 1.45, ht: 1.25, hb: 1.3 },
  { z: 5, w: 1.45, ht: 1.25, hb: 1.3 },
  { z: 8.6, w: 1.1, ht: 0.95, hb: 1.0 },
];

export function buildMarauder(): ShipModel {
  const k = pirateKit('marauder', 'MX-66', 'MARAUDER');
  const paint = salvage([0.12, 0.11, 0.1], 66, 2.6);
  const { root, add, both, at } = builder();
  const rcs: RcsList = [];
  const top = (z: number) => {
    const s = sectionAt(MF, z);
    return s.y + s.ht;
  };

  // ── Hull ───────────────────────────────────────────────────────────────
  const pieces: [number, number][] = [
    [-11.5, -6.55],
    [-6.45, -0.05],
    [0.05, 5.95],
    [6.05, 11.6],
  ];
  pieces.forEach(([z0, z1], i) => add(loft({ profile: CHINED, keys: MF, z0, z1, step: 0.45, color: paint.loft, capFront: i === 0 }), k.paint));
  add(loft({ profile: CHINED, keys: MF, z0: -6.6, z1: 11.6, scale: 0.98, step: 1.0, capRear: true, color: () => [0.45, 0.45, 0.47] }), k.dark);
  at(nozzle(k, 1.4, 13.4, [1.8, 0.35, 0.15]), 2.4, 0, true);

  // Hammerhead ram prow with teeth.
  const prow = tint(plate([[-3.8, -10], [3.8, -10], [3.4, -12.8], [1.4, -13.6], [-1.4, -13.6], [-3.4, -12.8]], 1.6, 0.1), (x, _y, z) =>
    hash(Math.floor(x / 1.7), Math.floor(z / 1.7), 3) < 0.2 ? RUST : PIRATE_RED,
  );
  prow.translate(0, -0.6, 0);
  add(prow, k.paint);
  for (const x of [-2.4, -1.2, 0, 1.2, 2.4]) {
    const zEdge = Math.abs(x) <= 1.4 ? -13.6 : -13.6 + ((Math.abs(x) - 1.4) / 2) * 0.8;
    add(tint(plate([[-0.28, 0], [0.28, 0], [0, -1.5]], 0.32, 0.02).translate(x, -0.6, zEdge + 0.05), BARE), k.metal);
  }

  // ── Sponsons on pylons, with their guns ───────────────────────────────
  const spPaint = (tag: string, x: number, y: number, z: number): RGB => lerp3(paint.loft(tag, x, y, z), HEAT, clamp01((z - 7.4) / 1.2) * 0.7);
  for (const sx of [-1, 1]) {
    const sp = loft({ profile: OCTA, keys: MSP, z0: -7.6, z1: 8.6, step: 0.45, color: spPaint, capFront: true, capRear: true });
    sp.translate(sx * 7, -1, 0);
    add(sp, k.paint);
    for (const z of [-2, 4]) add(tint(place(box(1.8, 0.9, 2.4), [sx * 5.0, -0.9, z]), PRIMER), k.paint);
    at(gun(k, -10, 0.2, 2.0, 1.0, PRIMER), sx * 7, -1);
    at(gun(k, -9.4, 0.12, 1.6, 0.8, PRIMER), sx * 7, -1.75);
    at(nozzle(k, 0.9, 9.6, [1.8, 0.35, 0.15]), sx * 7, -1);
  }

  // ── Twin-barrel dorsal turret (muzzles meet at 0, 2.5, -12) ───────────
  {
    const tz = -7.3;
    const ty = top(tz);
    add(cylZ(1.3, 1.3, -0.25, 0.25, 20).rotateX(Math.PI / 2).translate(0, ty + 0.1, tz), k.dark);
    const body = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    body.scale(1.15, 0.75, 1.35);
    body.translate(0, ty + 0.3, tz);
    add(tint(body, PRIMER), k.paint);
    add(tint(place(box(1.2, 0.62, 0.5), [0, 2.5, -8.4]), PRIMER), k.paint);
    for (const sx of [-1, 1]) at(gun(k, -12, 0.12, 3.2, 0.2, PRIMER), sx * 0.28, 2.5);
  }

  // ── Bridge tower with its red window band ─────────────────────────────
  const tower: Section[] = [
    { z: 1.6, w: 0.9, ht: 0.6, hb: 0.2 },
    { z: 2.4, w: 1.5, ht: 1.15, hb: 0.2 },
    { z: 6.0, w: 1.6, ht: 1.2, hb: 0.2 },
    { z: 7.0, w: 1.3, ht: 0.9, hb: 0.2 },
  ].map((s) => ({ ...s, y: top(s.z) - 0.1 }));
  add(loft({ profile: OCTA, keys: tower, z0: 1.6, z1: 7.0, step: 0.35, capFront: true, capRear: true, color: () => PRIMER }), k.paint);
  const winY = top(2.4) - 0.1 + 0.75;
  add(tint(place(box(1.5, 0.16, 0.06), [0, winY, 2.12], [-0.6, 0, 0]), PIRATE_GLOW), k.glow);
  for (const sx of [-1, 1]) add(tint(place(box(0.05, 0.12, 2.6), [sx * 1.585, top(4.2) + 0.55, 4.2]), PIRATE_GLOW), k.glow);
  const mastBase = top(6.4) - 0.1 + 1.15;
  add(tube([V(0.8, mastBase, 6.4), V(0.8, mastBase + 1.4, 6.5), V(0.85, mastBase + 1.9, 6.7)], 0.05, 6), k.metal);
  const dish = new THREE.SphereGeometry(0.55, 14, 6, 0, Math.PI * 2, 0, Math.PI / 3);
  dish.rotateX(-0.9);
  dish.translate(-0.7, mastBase + 0.35, 6.2);
  add(dish, k.dark);

  // ── Welded plates, pipes, spikes, cargo ───────────────────────────────
  let seed = 9;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 11; i++) {
      const len = 1.4 + rnd() * 1.8;
      const zc = -8 + rnd() * 17;
      const h = 0.4 + rnd() * 0.6;
      const y = -0.45 + rnd() * 0.8;
      const s = sectionAt(MF, zc);
      const c = [RUST, PRIMER, BARE, FADED][Math.floor(rnd() * 4)];
      add(tint(place(box(0.08, h, len), [sx * (s.w + 0.06), y, zc], [(rnd() - 0.5) * 0.08, 0, 0]), c), k.paint);
    }
    for (const t of [0.3, 0.62]) {
      const pts: THREE.Vector3[] = [];
      for (let z = -7; z <= 9.5; z += 1.5) {
        const s = sectionAt(MF, z);
        pts.push(V(sx * (s.w - 0.5 * s.w * t + 0.12), s.y - 0.3 * s.hb - 0.7 * s.hb * t - 0.12, z));
      }
      add(tube(pts, 0.11, 6), k.metal);
    }
  }
  for (const z of [-4.6, -3.0, -1.4, 0.2]) {
    const spike = tint(plate([[0, -0.45], [0.95, 0.15], [0, 0.55]], 0.1, 0.02), BARE);
    spike.rotateZ(Math.PI / 2);
    spike.translate(0, top(z) - 0.05, z);
    add(spike, k.metal);
  }
  const cargo: [number, RGB][] = [
    [-1.35, [0.3, 0.09, 0.05]],
    [1.35, [0.08, 0.14, 0.2]],
  ];
  for (const [x, c] of cargo) {
    const ty = top(9) - 0.05;
    add(tint(place(box(2.2, 1.3, 3.4), [x, ty + 0.65, 9.0]), c), k.paint);
    for (const z of [8.0, 10.0]) add(place(box(2.3, 1.36, 0.12), [x, ty + 0.66, z]), k.dark);
  }

  // ── RCS and markings ──────────────────────────────────────────────────
  for (const sx of [-1, 1]) {
    rcsBlock(add, k, rcs, V(sx * 3.5, -0.6, -12.3), [V(sx, 0, 0), V(0, 1, 0), V(0, -1, 0)], 0.42);
    rcsBlock(add, k, rcs, V(sx * 7, 0.45, 7.4), [V(sx, 0, 0), V(0, 1, 0)], 0.42);
  }
  for (const sx of [-1, 1]) add(place(decal(k.atlas, 'serial', 2.0), [sx * 1.6, top(4.6) + 0.25, 4.6], [0, (sx * Math.PI) / 2, 0]), k.decal);
  add(place(decal(k.atlas, 'emblem', 1.6), [0, 0.204, -12.4], [-Math.PI / 2, 0, 0]), k.decal);
  flankDecal(add, k, MSP, 'model', 0.5, 2.4, -1, 7, [1]);
  both(place(decal(k.atlas, 'arrow', 0.6), [7, 0.26, -5.5], [-Math.PI / 2, 0, -Math.PI / 2]), k.decal);

  return {
    root,
    engines: [
      { pos: V(-2.4, 0, 13.4), radius: 1.4 },
      { pos: V(2.4, 0, 13.4), radius: 1.4 },
      { pos: V(-7, -1, 9.6), radius: 0.9 },
      { pos: V(7, -1, 9.6), radius: 0.9 },
    ],
    engineColor: new THREE.Color(4, 0.75, 0.45),
    boostColor: new THREE.Color(6, 1.8, 1),
    shieldScale: new THREE.Vector3(12, 6, 15),
    navs: [
      { pos: V(-7, 0.1, -7.2), color: MARKER, size: 0.9 },
      { pos: V(7, 0.1, -7.2), color: MARKER, size: 0.9 },
      { pos: V(0, top(6.5) + 1.2, 6.5), color: MARKER, size: 0.9 },
    ],
    rcs,
  };
}
