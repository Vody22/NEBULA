import * as THREE from 'three';
import { makeDecalAtlas, makeShipSheet, type DecalAtlas } from './shipTextures';
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
  type RGB,
  type Section,
} from './shipKit';
import type { ShipModel } from './ShipModels';

/**
 * Aurora Fleetworks Falcon Mk.II (and its Warden sibling), built in code:
 * armour sections with real gaps over a dark core, chined fuselage, three-layer
 * nozzles, radiators, RCS clusters, glazed cockpit with seat and console,
 * stowed landing gear doors, decals and a painted, chipped, weathered finish.
 * It is a detailed procedural model, not a production art asset.
 *
 * Gameplay anchors that must not move: cannon muzzles at (±4.6, -0.6, -6.5)
 * and engine exits at (±2.25, -0.1, 9.2).
 */

interface Palette {
  hull: RGB;
  back: RGB;
  band: RGB;
  belly: RGB;
  engine: THREE.Color;
  boost: THREE.Color;
  serial: string;
  model: string;
  ink: string;
}

const PALETTES: Record<'falcon' | 'warden', Palette> = {
  falcon: {
    hull: [1.0, 0.95, 0.86],
    back: [0.3, 0.31, 0.33],
    band: [0.03, 0.1, 0.42],
    belly: [0.8, 0.78, 0.74],
    engine: new THREE.Color(0.5, 1.4, 4),
    boost: new THREE.Color(2.5, 3.2, 6),
    serial: 'FMK2-0147',
    model: 'FALCON MK.II',
    ink: '#1b2a4a',
  },
  warden: {
    hull: [0.6, 0.66, 0.58],
    back: [0.1, 0.13, 0.11],
    band: [0.03, 0.15, 0.08],
    belly: [0.5, 0.54, 0.48],
    engine: new THREE.Color(0.4, 3, 2),
    boost: new THREE.Color(2, 5, 3.4),
    serial: 'WDN-2210',
    model: 'WARDEN',
    ink: '#18301f',
  },
};

interface Kit {
  paint: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  glow: THREE.MeshBasicMaterial;
  decal: THREE.MeshStandardMaterial;
  atlas: DecalAtlas;
}

const kits = new Map<string, Kit>();

function kit(variant: 'falcon' | 'warden'): Kit {
  const cached = kits.get(variant);
  if (cached) return cached;
  const pal = PALETTES[variant];
  const sheet = makeShipSheet({ seed: variant === 'falcon' ? 147 : 2210 });
  const darkSheet = makeShipSheet({ seed: 33, base: '#5d6168', dark: true, size: 512 });
  const atlas = makeDecalAtlas({ serial: pal.serial, maker: 'AURORA FLEETWORKS', model: pal.model, color: pal.ink, warn: '#b5241c' });
  const k: Kit = {
    paint: new THREE.MeshStandardMaterial({
      map: sheet.map,
      normalMap: sheet.normalMap,
      normalScale: new THREE.Vector2(0.4, 0.4),
      roughnessMap: sheet.orm,
      metalnessMap: sheet.orm,
      aoMap: sheet.orm,
      aoMapIntensity: 0.8,
      roughness: 1,
      metalness: 1,
      vertexColors: true,
    }),
    dark: new THREE.MeshStandardMaterial({
      map: darkSheet.map,
      normalMap: darkSheet.normalMap,
      roughnessMap: darkSheet.orm,
      metalnessMap: darkSheet.orm,
      roughness: 1,
      metalness: 1,
      color: 0x7a7e86,
      vertexColors: true,
      side: THREE.DoubleSide,
    }),
    metal: new THREE.MeshStandardMaterial({
      color: 0x7d838a,
      metalness: 0.95,
      roughness: 0.42,
      normalMap: darkSheet.normalMap,
      normalScale: new THREE.Vector2(0.3, 0.3),
      vertexColors: true,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x0d2030,
      metalness: 0,
      // Slightly rough so the sun glint spreads instead of a blinding point.
      roughness: 0.14,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
      envMapIntensity: 2.2,
      transparent: true,
      opacity: 0.55,
    }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    decal: new THREE.MeshStandardMaterial({
      map: atlas.texture,
      alphaTest: 0.5,
      roughness: 0.55,
      metalness: 0.1,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    atlas,
  };
  kits.set(variant, k);
  return k;
}

const lerp3 = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const HEAT: RGB = [0.42, 0.34, 0.3];

// Fuselage keyframes (CHINED profile).
const FUSE: Section[] = [
  { z: -9.6, w: 0.06, ht: 0.05, hb: 0.05, y: -0.1 },
  { z: -9.0, w: 0.34, ht: 0.24, hb: 0.25, y: -0.1 },
  { z: -7.8, w: 0.74, ht: 0.5, hb: 0.46, y: -0.06 },
  { z: -6.2, w: 1.08, ht: 0.72, hb: 0.6, y: 0 },
  { z: -4.4, w: 1.38, ht: 0.9, hb: 0.7, y: 0 },
  { z: -2.4, w: 1.6, ht: 1.0, hb: 0.78, y: 0 },
  { z: 0, w: 1.72, ht: 1.05, hb: 0.82, y: 0 },
  { z: 2.4, w: 1.72, ht: 1.02, hb: 0.82, y: 0 },
  { z: 4.6, w: 1.6, ht: 0.95, hb: 0.76, y: 0 },
  { z: 6.6, w: 1.4, ht: 0.85, hb: 0.66, y: 0 },
  { z: 7.9, w: 1.22, ht: 0.74, hb: 0.56, y: 0 },
];
// Nacelle keyframes (OCTA profile, centred on x = ±NAC_X).
const NAC_X = 2.3;
const NAC_Y = -0.12;
const NAC: Section[] = [
  { z: -1.75, w: 0.86, ht: 0.74, hb: 0.8 },
  { z: -0.8, w: 1.18, ht: 1.04, hb: 1.06 },
  { z: 1.0, w: 1.32, ht: 1.18, hb: 1.16 },
  { z: 5.0, w: 1.34, ht: 1.2, hb: 1.16 },
  { z: 7.0, w: 1.26, ht: 1.12, hb: 1.1 },
  { z: 8.0, w: 1.18, ht: 1.04, hb: 1.02 },
];

export function buildFalconMk2(variant: 'falcon' | 'warden'): ShipModel {
  const pal = PALETTES[variant];
  const k = kit(variant);
  const root = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => root.add(new THREE.Mesh(geo, mat));
  const both = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    add(geo, mat);
    add(mirrorX(geo), mat);
  };
  const top = (z: number) => {
    const s = sectionAt(FUSE, z);
    return s.y + s.ht;
  };

  // ── Fuselage: four armour sections over a dark core ──────────────────
  const fusePaint = (tag: string, _x: number, _y: number, z: number): RGB => {
    let c: RGB = tag === 'top' || tag === 'shoulder' ? pal.back : tag === 'band' ? pal.band : tag === 'belly' || tag === 'chine' ? pal.belly : pal.hull;
    if (z < -8.7) c = lerp3(pal.back, [0.3, 0.31, 0.33], 0.5); // radome
    if (tag === 'cap') c = pal.back;
    return c;
  };
  const pieces: [number, number][] = [
    [-9.6, -6.04],
    [-5.96, -1.34],
    [-1.26, 3.3],
    [3.38, 7.9],
  ];
  pieces.forEach(([z0, z1], i) =>
    add(loft({ profile: CHINED, keys: FUSE, z0, z1, step: 0.3, color: fusePaint, capFront: i === 0 }), k.paint),
  );
  add(loft({ profile: CHINED, keys: FUSE, z0: -6.2, z1: 7.9, scale: 0.975, step: 0.6, capRear: true, color: () => [0.6, 0.6, 0.62] }), k.dark);

  // Dorsal spine behind the cockpit (sensor and avionics bay).
  const spineKeys: Section[] = [
    { z: -1.0, w: 0.28, ht: 0.1, hb: 0.2 },
    { z: 1.0, w: 0.52, ht: 0.28, hb: 0.2 },
    { z: 4.2, w: 0.58, ht: 0.3, hb: 0.2 },
    { z: 6.6, w: 0.42, ht: 0.2, hb: 0.2 },
    { z: 7.7, w: 0.26, ht: 0.08, hb: 0.2 },
  ].map((s) => ({ ...s, y: top(s.z) - 0.02 }));
  add(loft({ profile: OCTA, keys: spineKeys, z0: -1.0, z1: 7.7, step: 0.35, capFront: true, capRear: true, color: () => lerp3(pal.back, [0.2, 0.2, 0.22], 0.4) }), k.paint);

  // ── Cockpit: canopy, frame, seat, console ─────────────────────────────
  const cz = -3.3;
  const cy = top(cz) - 0.05;
  const rx = 0.72;
  const ry = 0.66;
  const rz = 2.25;
  const canopy = new THREE.SphereGeometry(1, 36, 18, 0, Math.PI * 2, 0, Math.PI / 2);
  canopy.scale(rx, ry, rz);
  canopy.translate(0, cy, cz);
  add(canopy, k.glass);
  const arc = (dz: number, grow = 1.015) => {
    const kz = Math.sqrt(Math.max(0, 1 - (dz / rz) ** 2));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI;
      pts.push(new THREE.Vector3(Math.cos(a) * rx * kz * grow, cy + Math.sin(a) * ry * kz * grow, cz + dz));
    }
    return pts;
  };
  for (const dz of [-1.25, -0.1, 1.0]) add(tube(arc(dz), 0.03, 6), k.dark);
  const ridge: THREE.Vector3[] = [];
  const sill: THREE.Vector3[] = [];
  for (let i = 0; i <= 10; i++) {
    const dz = -rz * 0.92 + (i / 10) * rz * 1.84;
    const kz = Math.sqrt(1 - (dz / rz) ** 2);
    ridge.push(new THREE.Vector3(0, cy + ry * kz * 1.015, cz + dz));
    sill.push(new THREE.Vector3(rx * kz * 1.02, cy + 0.01, cz + dz));
  }
  add(tube(ridge, 0.028, 6), k.dark);
  both(tube(sill, 0.045, 6), k.dark);
  // Seat: cushion, back, headrest; pilot helmet; console with two screens.
  // The canopy leaves about 0.55 m above the deck: everything is scaled to fit.
  add(place(box(0.46, 0.1, 0.42), [0, cy + 0.1, cz + 0.72]), k.dark);
  add(place(box(0.48, 0.4, 0.1), [0, cy + 0.3, cz + 0.98], [-0.25, 0, 0]), k.dark);
  add(place(box(0.26, 0.12, 0.1), [0, cy + 0.48, cz + 1.05], [-0.25, 0, 0]), k.dark);
  add(tint(new THREE.SphereGeometry(0.13, 14, 10).translate(0, cy + 0.37, cz + 0.8), [0.85, 0.84, 0.8]), k.paint);
  add(place(box(0.8, 0.18, 0.36), [0, cy + 0.14, cz - 0.85]), k.dark);
  const screen = (x: number, c: RGB) => add(tint(place(new THREE.PlaneGeometry(0.24, 0.14), [x, cy + 0.27, cz - 0.66], [-0.5, 0, 0]), c), k.glow);
  screen(-0.17, [0.25, 0.9, 1.2]);
  screen(0.17, [1.3, 0.7, 0.2]);

  // Cyan trim line under the canopy.
  for (const sx of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    for (let z = -5.6; z <= -1.6; z += 0.5) {
      const s = sectionAt(FUSE, z);
      pts.push(new THREE.Vector3(sx * (s.w + 0.012), s.y + s.ht * 0.34, z));
    }
    add(tint(tube(pts, 0.022, 4), [0.45, 2.0, 2.8]), k.glow);
  }

  // Nose probe and chin sensor dome.
  add(cylZ(0.012, 0.035, -10.3, -9.5, 6), k.metal);
  const dome = new THREE.SphereGeometry(0.26, 14, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  dome.scale(1, 0.7, 1.4);
  const ds = sectionAt(FUSE, -6.9);
  dome.translate(0, ds.y - ds.hb + 0.02, -6.9);
  add(dome, k.glass);

  // ── Wings, flaps, wingtip pods ────────────────────────────────────────
  const WY = -0.55;
  const wingTint = (x: number): RGB => (Math.abs(x) > 7.6 ? pal.back : pal.hull);
  const wing = tint(plate([[1.5, -2.4], [4.2, -0.4], [7.4, 2.4], [7.9, 3.5], [7.9, 4.2], [6.4, 4.2], [1.5, 4.0]], 0.36, 0.07), (x) => wingTint(x));
  wing.translate(0, WY, 0);
  both(wing, k.paint);
  const flap = tint(plate([[1.7, 4.08], [6.3, 4.28], [6.3, 4.95], [1.7, 4.95]], 0.2, 0.04), lerp3(pal.hull, pal.belly, 0.6));
  flap.translate(0, WY - 0.03, 0);
  both(flap, k.paint);
  const fence = tint(plate([[0, 0.4], [0.32, 1.2], [0.32, 3.6], [0, 3.9]], 0.06, 0.02), pal.back);
  fence.rotateZ(Math.PI / 2);
  fence.translate(6.2, WY + 0.15, 0);
  both(fence, k.paint);
  const tipPod = tint(cylZ(0.08, 0.17, 1.75, 2.6, 10), pal.back);
  tipPod.translate(7.95, WY, 0);
  both(tipPod, k.paint);
  const tipBody = tint(cylZ(0.17, 0.15, 2.6, 4.7, 10), pal.back);
  tipBody.translate(7.95, WY, 0);
  both(tipBody, k.paint);

  // ── Cannons (muzzles at ±4.6, -0.6, -6.5) ─────────────────────────────
  const GX = 4.6;
  const GY = -0.6;
  const gun: [THREE.BufferGeometry, THREE.Material][] = [
    [tint(cylZ(0.2, 0.44, -3.9, -2.7, 12), pal.back), k.paint],
    [tint(cylZ(0.44, 0.44, -2.7, 1.3, 12), pal.back), k.paint],
    [tint(cylZ(0.44, 0.28, 1.3, 2.2, 12), pal.back), k.paint],
    [cylZ(0.2, 0.2, -5.4, -3.9, 10), k.dark],
    [cylZ(0.11, 0.11, -6.35, -5.4, 8), k.metal],
    [cylZ(0.19, 0.19, -6.66, -6.35, 10), k.metal],
  ];
  for (let i = 0; i < 5; i++) gun.push([cylZ(0.235, 0.235, -5.25 + i * 0.3, -5.19 + i * 0.3, 10), k.metal]);
  for (const [g, m] of gun) {
    g.translate(GX, GY, 0);
    both(g, m);
  }

  // ── Engine nacelles ───────────────────────────────────────────────────
  const nacPaint = (tag: string, _x: number, _y: number, z: number): RGB => {
    const base = tag === 'top' ? lerp3(pal.hull, pal.back, 0.15) : tag === 'belly' || tag === 'chine' ? pal.belly : pal.hull;
    return lerp3(base, HEAT, clamp01((z - 6.2) / 1.8) * 0.85);
  };
  const nacParts = [
    loft({ profile: OCTA, keys: NAC, z0: -1.75, z1: 2.36, step: 0.3, color: nacPaint }),
    loft({ profile: OCTA, keys: NAC, z0: 2.44, z1: 8.0, step: 0.3, color: nacPaint }),
  ];
  for (const g of nacParts) {
    g.translate(NAC_X, NAC_Y, 0);
    both(g, k.paint);
  }
  const nacCore = loft({ profile: OCTA, keys: NAC, z0: 2.2, z1: 8.0, scale: 0.975, step: 1, capRear: true, color: () => [0.5, 0.5, 0.52] });
  nacCore.translate(NAC_X, NAC_Y, 0);
  both(nacCore, k.dark);
  // Intake: dark sleeve, back plate and a fan.
  const sleeve = loft({ profile: OCTA, keys: NAC, z0: -1.76, z1: -1.15, scale: 0.9, step: 0.3, capRear: true, color: () => [0.35, 0.35, 0.37] });
  sleeve.translate(NAC_X, NAC_Y, 0);
  both(sleeve, k.dark);
  const fanParts: THREE.BufferGeometry[] = [cylZ(0.24, 0.24, -1.3, -1.12, 12)];
  for (let i = 0; i < 7; i++) fanParts.push(place(box(0.08, 1.44, 0.03), [0, 0, -1.2], [0, 0.35, (i / 7) * Math.PI]));
  for (const f of fanParts) {
    f.translate(NAC_X, NAC_Y, 0);
    both(f, k.metal);
  }
  // Nozzle, three layers: outer petals, hot inner ring, ejection cone.
  const nozzleHeat = (_x: number, _y: number, z: number): RGB => lerp3([1, 1, 1], [0.78, 0.66, 0.6], clamp01((z - 7.9) / 1.2));
  const NZX = 2.25;
  const NZY = -0.1;
  const nz: [THREE.BufferGeometry, THREE.Material][] = [
    [tint(cylZ(1.1, 1.0, 7.95, 9.2, 14, true), nozzleHeat), k.metal],
    [tint(cylZ(0.96, 0.9, 8.0, 9.15, 14, true), [0.5, 0.5, 0.52]), k.dark],
    [tint(new THREE.TorusGeometry(0.88, 0.05, 6, 28).translate(0, 0, 8.7), [1.4, 0.75, 0.45]), k.glow],
    [tint(new THREE.CircleGeometry(0.9, 24).translate(0, 0, 8.3), [0.25, 0.63, 1.8]), k.glow],
    [tint(cylZ(0.46, 0.04, 8.25, 9.45, 14), (_x, _y, z) => lerp3([0.9, 0.9, 0.9], [0.7, 0.6, 0.65], clamp01((z - 8.25) / 1.2))), k.metal],
  ];
  if (variant === 'warden') nz[3][0] = tint(new THREE.CircleGeometry(0.9, 24).translate(0, 0, 8.3), [0.2, 1.35, 0.9]);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    nz.push([place(box(0.06, 0.07, 1.0), [Math.cos(a) * 1.08, Math.sin(a) * 1.08, 8.5], [0, 0, a]), k.metal]);
  }
  for (const [g, m] of nz) {
    g.translate(NZX, NZY, 0);
    both(g, m);
  }

  // Radiators on top of the nacelles: frame and fins.
  const RTOP = NAC_Y + sectionAt(NAC, 2.2).ht;
  const rad: [THREE.BufferGeometry, THREE.Material][] = [
    [place(box(0.06, 0.2, 3.3), [-0.56, RTOP + 0.08, 2.2]), k.metal],
    [place(box(0.06, 0.2, 3.3), [0.56, RTOP + 0.08, 2.2]), k.metal],
  ];
  for (let i = 0; i < 11; i++) rad.push([place(box(1.1, 0.16, 0.05), [0, RTOP + 0.07, 0.75 + i * 0.29]), k.dark]);
  for (const [g, m] of rad) {
    g.translate(NAC_X, 0, 0);
    both(g, m);
  }

  // ── Canted tail fins (serial number on the outer faces) ───────────────
  const CANT = 0.38;
  for (const sx of [-1, 1]) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(sx * 2.0, RTOP - 0.2, 0),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -sx * CANT)),
      new THREE.Vector3(1, 1, 1),
    );
    const fin = tint(plate([[0, 4.0], [2.6, 7.4], [2.75, 8.8], [2.2, 8.9], [0, 7.9]], 0.18, 0.05), (x) => (x > 2.15 ? pal.band : pal.hull));
    fin.rotateZ(Math.PI / 2);
    fin.applyMatrix4(m);
    add(fin, k.paint);
    const serial = place(decal(k.atlas, 'serial', 1.7), [sx * 0.096, 1.25, 6.7], [0, (sx * Math.PI) / 2, 0]);
    serial.applyMatrix4(m);
    add(serial, k.decal);
  }

  // ── RCS clusters at the four corners ──────────────────────────────────
  const rcs: { pos: THREE.Vector3; dir: THREE.Vector3 }[] = [];
  const rcsBlock = (p: THREE.Vector3, dirs: THREE.Vector3[]) => {
    add(place(box(0.3, 0.3, 0.34), [p.x, p.y, p.z]), k.dark);
    for (const d of dirs) {
      const n = new THREE.CylinderGeometry(0.05, 0.07, 0.12, 8);
      n.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d));
      n.translate(p.x + d.x * 0.18, p.y + d.y * 0.18, p.z + d.z * 0.18);
      add(n, k.metal);
      rcs.push({ pos: p.clone().addScaledVector(d, 0.26), dir: d.clone() });
    }
  };
  for (const sx of [-1, 1]) {
    const s = sectionAt(FUSE, -7.3);
    rcsBlock(new THREE.Vector3(sx * (s.w - 0.05), s.y + 0.02, -7.3), [new THREE.Vector3(sx, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)]);
    rcsBlock(new THREE.Vector3(sx * 7.95, WY, 4.45), [new THREE.Vector3(sx, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)]);
  }

  // Antennas.
  add(tube([new THREE.Vector3(0, top(4.6) + 0.25, 4.6), new THREE.Vector3(0, top(4.6) + 0.7, 5.0), new THREE.Vector3(0, top(4.6) + 1.05, 5.4)], 0.022, 5), k.metal);
  add(place(plate([[0, 0], [0.5, 0.35], [0.5, 0.6], [0, 0.55]], 0.04, 0.01).rotateZ(-Math.PI / 2), [0, sectionAt(FUSE, 1).y - sectionAt(FUSE, 1).hb, 1.0]), k.dark);

  // ── Belly: stowed landing gear doors ──────────────────────────────────
  const door = (x: number, y: number, z0: number, z1: number, w: number) => {
    add(tint(place(box(w + 0.06, 0.03, z1 - z0 + 0.06), [x, y - 0.012, (z0 + z1) / 2]), [0.3, 0.3, 0.32]), k.dark);
    add(tint(place(box(w, 0.03, z1 - z0), [x, y - 0.03, (z0 + z1) / 2]), pal.belly), k.paint);
  };
  {
    const s = sectionAt(FUSE, -4.6);
    door(0, s.y - s.hb, -5.5, -3.7, 0.56);
  }
  for (const sx of [-1, 1]) door(sx * NAC_X, NAC_Y - sectionAt(NAC, 2.2).hb, 0.9, 3.5, 0.8);

  // ── Decals ────────────────────────────────────────────────────────────
  const sideDecal = (id: 'model' | 'maker' | 'rescue', z: number, w: number, yOf: (s: Required<Section>) => number, surf: (s: Required<Section>) => number, keys = FUSE, ox = 0, oy = 0) => {
    for (const sx of [-1, 1]) {
      const s = sectionAt(keys, z);
      const dw = (sectionAt(keys, z + 0.2).w - sectionAt(keys, z - 0.2).w) / 0.4;
      const yaw = Math.atan2(sx, -dw);
      add(place(decal(k.atlas, id, w), [sx * (surf(s) + ox + 0.006), yOf(s) + oy, z], [0, yaw, 0]), k.decal);
    }
  };
  sideDecal('model', -6.0, 1.5, (s) => s.y - 0.02, (s) => s.w);
  sideDecal('rescue', -2.0, 0.75, (s) => s.y - 0.12, (s) => s.w);
  sideDecal('maker', 2.6, 2.2, () => NAC_Y + 0.02, (s) => s.w, NAC, NAC_X);
  const wingTop = WY + 0.18 + 0.004;
  for (const sx of [-1, 1]) {
    add(place(decal(k.atlas, 'emblem', 1.25), [sx * 5.3, wingTop, 2.2], [-Math.PI / 2, 0, 0]), k.decal);
    add(place(decal(k.atlas, 'nostep', 0.9), [sx * 2.9, wingTop, 2.7], [-Math.PI / 2, 0, 0]), k.decal);
    add(place(decal(k.atlas, 'chevron', 0.9), [sx * NAC_X, NAC_Y + sectionAt(NAC, -0.6).ht + 0.004, -0.6], [-Math.PI / 2, 0, 0]), k.decal);
  }

  // ── Lights (sprites stay out of the merge) ───────────────────────────
  const navs: { pos: THREE.Vector3; color: THREE.Color; size: number }[] = [
    { pos: new THREE.Vector3(-7.95, WY, 1.72), color: new THREE.Color(2.5, 0.2, 0.15), size: 0.9 },
    { pos: new THREE.Vector3(7.95, WY, 1.72), color: new THREE.Color(0.2, 2.5, 0.3), size: 0.9 },
    { pos: new THREE.Vector3(0, top(7.6) + 0.12, 7.75), color: new THREE.Color(2, 2, 2), size: 0.7 },
  ];
  const strobes = [
    { pos: new THREE.Vector3(-7.95, WY, 4.75), color: new THREE.Color(2.4, 2.4, 2.5) },
    { pos: new THREE.Vector3(7.95, WY, 4.75), color: new THREE.Color(2.4, 2.4, 2.5) },
    { pos: new THREE.Vector3(0, sectionAt(FUSE, 0.5).y - sectionAt(FUSE, 0.5).hb - 0.08, 0.5), color: new THREE.Color(2.4, 0.25, 0.2) },
  ];

  return {
    root,
    engines: [
      { pos: new THREE.Vector3(-2.25, -0.1, 9.2), radius: 1.0 },
      { pos: new THREE.Vector3(2.25, -0.1, 9.2), radius: 1.0 },
    ],
    engineColor: pal.engine,
    boostColor: pal.boost,
    shieldScale: new THREE.Vector3(9.5, 4.5, 11),
    navs,
    strobes,
    rcs,
  };
}
