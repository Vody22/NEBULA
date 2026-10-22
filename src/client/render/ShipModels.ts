import * as THREE from 'three';
import type { ShipClassId } from '../../shared/sim/types';
import { mergeByMaterial } from './merge';
import { makeHullTextures, makeRadialTexture } from './textures';

export interface ShipModel {
  root: THREE.Group;
  /** Nozzle exit points (local) and nozzle radius. */
  engines: { pos: THREE.Vector3; radius: number }[];
  engineColor: THREE.Color;
  boostColor: THREE.Color;
  /** Shield ellipsoid half-extents. */
  shieldScale: THREE.Vector3;
}

interface Paint {
  hull: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  darkDouble: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  glow: THREE.MeshBasicMaterial;
}

const paintCache = new Map<string, Paint>();

function paint(key: string, base: string, accent: string, glowColor: THREE.Color, seed: number, darkBase = '#2a2e35'): Paint {
  const cached = paintCache.get(key);
  if (cached) return cached;
  const t = makeHullTextures({ base, accent, seed, stripes: true, size: 1024 });
  const d = makeHullTextures({ base: darkBase, accent, seed: seed + 1, dark: true, size: 512 });
  const p: Paint = {
    hull: new THREE.MeshStandardMaterial({ map: t.map, roughnessMap: t.roughnessMap, metalness: 0.35, roughness: 0.5, envMapIntensity: 1.4 }),
    dark: new THREE.MeshStandardMaterial({ map: d.map, roughnessMap: d.roughnessMap, metalness: 0.45, roughness: 0.55 }),
    darkDouble: new THREE.MeshStandardMaterial({ map: d.map, roughnessMap: d.roughnessMap, metalness: 0.45, roughness: 0.55, side: THREE.DoubleSide }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x0b1a26,
      metalness: 0.1,
      roughness: 0.04,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      envMapIntensity: 2.4,
      emissive: new THREE.Color(0.05, 0.25, 0.35),
    }),
    glow: new THREE.MeshBasicMaterial({ color: glowColor.clone().multiplyScalar(0.45), toneMapped: false }),
  };
  paintCache.set(key, p);
  return p;
}

const navTex = () =>
  makeRadialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.2, 'rgba(255,255,255,0.6)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
let _nav: THREE.Texture | null = null;
function navLight(color: THREE.Color, size: number, pos: [number, number, number]) {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: (_nav ??= navTex()), color, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  s.position.set(...pos);
  s.scale.setScalar(size);
  s.userData.nav = true;
  return s;
}

/** Lathe a body around the Z axis with the nose at -Z. Profile: [radius, z]. */
function latheZ(profile: [number, number][], segments: number, mat: THREE.Material) {
  const pts = profile.map(([r, z]) => new THREE.Vector2(r, -z));
  const geo = new THREE.LatheGeometry(pts, segments);
  geo.rotateX(-Math.PI / 2);
  return new THREE.Mesh(geo, mat);
}

/** Extrude a planform (x, z) into a thin horizontal slab of `thickness`. */
function slab(points: [number, number][], thickness: number, mat: THREE.Material, bevel = 0.12) {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2 });
  geo.translate(0, 0, -thickness / 2);
  geo.rotateX(Math.PI / 2);
  return new THREE.Mesh(geo, mat);
}

function mirrored(mesh: THREE.Mesh) {
  const m = mesh.clone();
  m.scale.x *= -1;
  m.position.x *= -1;
  m.rotation.z *= -1;
  m.rotation.y *= -1;
  return m;
}

function nozzle(p: Paint, radius: number, length: number, pos: THREE.Vector3) {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.05, radius * 1.25, length, 24, 1, true), p.darkDouble);
  shell.rotation.x = Math.PI / 2;
  g.add(shell);
  const inner = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.95, 24), p.glow);
  inner.position.z = length * 0.3;
  g.add(inner);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.2, radius * 0.08, 6, 24), p.hull);
  lip.position.z = length / 2;
  g.add(lip);
  g.position.copy(pos);
  return g;
}

function buildFalcon(variant: 'falcon' | 'warden'): ShipModel {
  const engineColor = variant === 'falcon' ? new THREE.Color(0.5, 1.4, 4) : new THREE.Color(0.4, 3, 2);
  const p =
    variant === 'falcon'
      ? paint('falcon', '#c9ced6', '#1f6fd1', engineColor, 41)
      : paint('warden', '#a9b7ad', '#2e9b6a', engineColor, 57, '#253029');
  const root = new THREE.Group();

  // Fuselage
  const body = latheZ(
    [
      [0, -9.2], [0.35, -8.7], [0.9, -7.6], [1.5, -5.6], [1.95, -3.2], [2.2, -0.6], [2.25, 2.0],
      [2.05, 4.6], [1.75, 6.6], [1.45, 7.6], [0, 7.7],
    ],
    40,
    p.hull,
  );
  body.scale.set(1.15, 0.78, 1);
  root.add(body);
  // Dorsal spine
  const spine = slab([[-0.5, -3.5], [0.5, -3.5], [0.9, 6.5], [-0.9, 6.5]], 0.6, p.dark);
  spine.position.y = 1.6;
  root.add(spine);
  // Canopy
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), p.glass);
  canopy.scale.set(1.05, 0.75, 2.6);
  canopy.position.set(0, 1.15, -3.6);
  root.add(canopy);
  const frame = new THREE.Mesh(new THREE.TorusGeometry(1.06, 0.07, 6, 32, Math.PI), p.dark);
  frame.position.set(0, 1.15, -3.4);
  frame.scale.set(1, 0.75, 1);
  root.add(frame);

  // Main wings (swept, with a cranked tip)
  const wing = slab(
    [[1.4, -2.2], [4.0, -0.4], [7.6, 2.6], [7.8, 4.2], [6.2, 4.4], [1.4, 4.8]],
    0.32,
    p.hull,
  );
  wing.position.y = -0.55;
  wing.rotation.z = -0.06;
  root.add(wing, mirrored(wing));
  // Wing-mounted cannon pods (hardpoints at ±4.6, -0.6, -6.5)
  const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.55, 5.2, 12), p.dark);
  pod.rotation.x = Math.PI / 2;
  pod.position.set(4.6, -0.6, -1.6);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 3.4, 8), p.dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(4.6, -0.6, -5.0);
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.4, 8), p.hull);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.set(4.6, -0.6, -6.6);
  root.add(pod, mirrored(pod), barrel, mirrored(barrel), muzzle, mirrored(muzzle));

  // Engine nacelles
  for (const sx of [-1, 1]) {
    const nac = latheZ([[0.0, -1.5], [0.9, -1.2], [1.25, 0.2], [1.25, 4.2], [1.15, 5.6]], 24, p.hull);
    nac.position.set(sx * 2.25, -0.1, 2.2);
    root.add(nac);
    const intake = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.2, 2.2), p.dark);
    intake.position.set(sx * 2.4, 0.3, -0.4);
    root.add(intake);
    root.add(nozzle(p, 1.05, 1.6, new THREE.Vector3(sx * 2.25, -0.1, 8.4)));
  }
  // Canted tail fins
  const fin = slab([[0, 3.2], [0.0, 7.4], [2.8, 8.4], [2.4, 6.2]], 0.22, p.hull);
  fin.rotation.z = Math.PI / 2 - 0.35;
  fin.position.set(1.4, 1.4, 0);
  root.add(fin, mirrored(fin));
  // Greebles
  for (let i = 0; i < 6; i++) {
    const g = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.25, 0.8 + (i % 3) * 0.4), p.dark);
    g.position.set((i % 2 ? 1 : -1) * (0.9 + (i % 3) * 0.25), 1.35 - (i % 3) * 0.1, 1 + i * 0.7);
    root.add(g);
  }
  // Glow accents
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 3), p.glow);
  strip.position.set(1.95, 0.25, -1.5);
  root.add(strip, mirrored(strip));

  root.add(navLight(new THREE.Color(2.5, 0.2, 0.15), 1.0, [-7.7, -0.55, 3.6]));
  root.add(navLight(new THREE.Color(0.2, 2.5, 0.3), 1.0, [7.7, -0.55, 3.6]));
  root.add(navLight(new THREE.Color(2, 2, 2), 0.8, [0, 2.0, 6.6]));

  return {
    root,
    engines: [
      { pos: new THREE.Vector3(-2.25, -0.1, 9.2), radius: 1.0 },
      { pos: new THREE.Vector3(2.25, -0.1, 9.2), radius: 1.0 },
    ],
    engineColor,
    boostColor: new THREE.Color(2.5, 3.2, 6),
    shieldScale: new THREE.Vector3(9.5, 4.5, 11),
  };
}

function buildRaider(): ShipModel {
  const engineColor = new THREE.Color(4, 1.1, 0.3);
  const p = paint('raider', '#5c4f54', '#b3201c', engineColor, 71, '#17151a');
  const root = new THREE.Group();
  // Hexagonal dagger hull
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 2.0, 13, 6, 3), p.hull);
  hull.rotation.x = -Math.PI / 2;
  hull.rotation.y = Math.PI / 6;
  hull.scale.set(1.2, 1, 0.7);
  hull.position.z = -0.5;
  root.add(hull);
  const back = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 1.6, 3, 6), p.dark);
  back.rotation.x = -Math.PI / 2;
  back.scale.set(1.2, 1, 0.7);
  back.position.z = 7.3;
  root.add(back);
  // Cockpit slit
  const eye = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.18, 2.8), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 0.6, 0.2), toneMapped: false }));
  eye.position.set(0, 0.95, -2.2);
  eye.rotation.x = 0.12;
  root.add(eye);
  // Forward-swept blades
  const blade = slab([[1.2, 3.5], [6.8, -3.4], [7.2, -4.4], [6.0, -3.6], [1.2, 6.2]], 0.25, p.hull, 0.08);
  blade.rotation.z = 0.12;
  root.add(blade, mirrored(blade));
  const tipGun = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, 4.2, 6), p.dark);
  tipGun.rotation.x = Math.PI / 2;
  tipGun.position.set(3.2, 0, -3.2);
  root.add(tipGun, mirrored(tipGun));
  const spikes = slab([[0, -1], [0.3, 5], [2.4, 7], [0.1, 6.5]], 0.15, p.dark, 0.05);
  spikes.rotation.z = Math.PI / 2;
  spikes.position.y = 0.6;
  root.add(spikes);
  root.add(nozzle(p, 1.25, 1.6, new THREE.Vector3(0, 0, 9.2)));
  root.add(nozzle(p, 0.55, 1.2, new THREE.Vector3(-2.0, -0.2, 8.6)));
  root.add(nozzle(p, 0.55, 1.2, new THREE.Vector3(2.0, -0.2, 8.6)));
  const glowStrip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 5), p.glow);
  glowStrip.position.set(1.5, -0.2, 1.5);
  glowStrip.rotation.y = 0.15;
  root.add(glowStrip, mirrored(glowStrip));
  root.add(navLight(new THREE.Color(5, 0.5, 0.2), 1.4, [7.2, 0.6, -4.4]));
  root.add(navLight(new THREE.Color(5, 0.5, 0.2), 1.4, [-7.2, 0.6, -4.4]));
  return {
    root,
    engines: [
      { pos: new THREE.Vector3(0, 0, 10), radius: 1.2 },
      { pos: new THREE.Vector3(-2.0, -0.2, 9.2), radius: 0.5 },
      { pos: new THREE.Vector3(2.0, -0.2, 9.2), radius: 0.5 },
    ],
    engineColor,
    boostColor: new THREE.Color(6, 2.5, 1),
    shieldScale: new THREE.Vector3(8.5, 3.6, 10),
  };
}

function buildMarauder(): ShipModel {
  const engineColor = new THREE.Color(4, 0.6, 1.4);
  const p = paint('marauder', '#6e625c', '#d4721c', engineColor, 91, '#1c1a1d');
  const root = new THREE.Group();
  // Heavy armoured body: extruded hexagonal planform, thick
  const body = slab([[-3.5, -12], [3.5, -12], [6, -4], [6, 9], [3, 12], [-3, 12], [-6, 9], [-6, -4]], 4.2, p.hull, 0.6);
  root.add(body);
  const deck = slab([[-2.4, -6], [2.4, -6], [3.5, 6], [-3.5, 6]], 1.4, p.dark, 0.3);
  deck.position.y = 2.6;
  root.add(deck);
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.2, 2.4), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 2.2, 0.5), toneMapped: false }));
  bridge.position.set(0, 3.4, -4.5);
  root.add(bridge);
  // Side gun pods
  for (const sx of [-1, 1]) {
    const podm = latheZ([[0, -12.5], [0.9, -11.5], [1.6, -8], [1.8, 4], [1.4, 8]], 16, p.dark);
    podm.position.set(sx * 7.6, -1, 0);
    root.add(podm);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(3, 0.8, 5), p.hull);
    arm.position.set(sx * 6.3, -1, 0);
    root.add(arm);
    root.add(nozzle(p, 1.4, 1.8, new THREE.Vector3(sx * 3.2, 0, 12.6)));
    root.add(nozzle(p, 1.0, 1.4, new THREE.Vector3(sx * 7.6, -1, 8.8)));
  }
  const turret = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.6, 1.2, 12), p.dark);
  turret.position.set(0, 3.6, -8.5);
  root.add(turret);
  const tb = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 4, 8), p.dark);
  tb.rotation.x = Math.PI / 2;
  tb.position.set(0, 3.0, -11);
  root.add(tb);
  for (let i = 0; i < 8; i++) {
    const g = new THREE.Mesh(new THREE.BoxGeometry(1 + (i % 3) * 0.5, 0.5, 1.4), p.dark);
    g.position.set((i % 2 ? 1 : -1) * (2 + (i % 3)), 2.3, -2 + i * 1.6);
    root.add(g);
  }
  root.add(navLight(new THREE.Color(5, 0.6, 0.2), 2.2, [7.6, 1, -10]));
  root.add(navLight(new THREE.Color(5, 0.6, 0.2), 2.2, [-7.6, 1, -10]));
  return {
    root,
    engines: [
      { pos: new THREE.Vector3(-3.2, 0, 13.6), radius: 1.3 },
      { pos: new THREE.Vector3(3.2, 0, 13.6), radius: 1.3 },
      { pos: new THREE.Vector3(-7.6, -1, 9.6), radius: 0.9 },
      { pos: new THREE.Vector3(7.6, -1, 9.6), radius: 0.9 },
    ],
    engineColor,
    boostColor: new THREE.Color(6, 1.6, 3),
    shieldScale: new THREE.Vector3(12, 6, 15),
  };
}

function buildRaw(classId: ShipClassId): ShipModel {
  switch (classId) {
    case 'falcon':
      return buildFalcon('falcon');
    case 'warden':
      return buildFalcon('warden');
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
