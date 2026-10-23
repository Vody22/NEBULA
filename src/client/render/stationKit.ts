import * as THREE from 'three';
import { mulberry32 } from '../../shared/rng';

/* Building blocks shared by the station models (Aurora-7, Ferro-9). */

/** One texture tile of station plating covers this many meters (panels of a few meters). */
export const STATION_TILE = 24;

/** Rescales primitive UVs (0..1) to the station plating density. */
export function plating(geo: THREE.BufferGeometry, uMeters: number, vMeters: number) {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * uMeters) / STATION_TILE, (uv.getY(i) * vMeters) / STATION_TILE);
  return geo;
}

/**
 * Lit windows, grouped by deck: rows of small amber panes, some decks dark,
 * some blocks off. Tiles over STATION_TILE meters like the plating, so a
 * window is about 1.2 × 0.8 m: the human-scale cue of the station.
 */
export function makeWindowTexture(seed: number) {
  const size = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  const rand = mulberry32(seed);
  const px = size / STATION_TILE; // pixels per meter
  const deck = 4 * px;
  for (let row = 0; row < size / deck; row++) {
    // Most decks are dark (machinery, storage): windows come in a few lit rows.
    if (rand() < 0.6) continue;
    const y = row * deck + deck * 0.4;
    let x = px;
    while (x < size - px) {
      // Blocks of 4–10 windows, then a structural gap.
      const n = 4 + Math.floor(rand() * 7);
      const blockOn = rand() < 0.55;
      for (let k = 0; k < n && x < size - px; k++) {
        if (blockOn && rand() < 0.7) {
          const warm = 0.75 + rand() * 0.25;
          g.fillStyle = `rgb(${Math.round(255 * warm)},${Math.round(186 * warm)},${Math.round(110 * warm)})`;
          g.fillRect(x, y, 1.2 * px, 0.8 * px);
        }
        x += 2 * px;
      }
      x += (3 + Math.floor(rand() * 6)) * px;
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** A beam between two points (box section). */
export function beam(a: THREE.Vector3, b: THREE.Vector3, r: number) {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.CylinderGeometry(r, r, d.length(), 4, 1);
  g.rotateY(Math.PI / 4);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/**
 * A square lattice truss from a to b: four longerons, rings and diagonal
 * braces every `bay` meters. Returns geometries to add with one material.
 */
export function truss(a: THREE.Vector3, b: THREE.Vector3, width: number, bay: number, r: number) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  dir.normalize();
  const side = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(dir, side).normalize().multiplyScalar(width / 2);
  const v = new THREE.Vector3().crossVectors(dir, u).normalize().multiplyScalar(width / 2);
  const corners = [u.clone().add(v), u.clone().sub(v), u.clone().negate().sub(v), u.clone().negate().add(v)];
  const out: THREE.BufferGeometry[] = [];
  for (const c of corners) out.push(beam(a.clone().add(c), b.clone().add(c), r));
  const bays = Math.max(1, Math.round(len / bay));
  for (let i = 0; i <= bays; i++) {
    const p = a.clone().addScaledVector(dir, (len * i) / bays);
    const q = a.clone().addScaledVector(dir, (len * Math.min(bays, i + 1)) / bays);
    for (let k = 0; k < 4; k++) {
      const c0 = corners[k];
      const c1 = corners[(k + 1) % 4];
      out.push(beam(p.clone().add(c0), p.clone().add(c1), r * 0.7));
      if (i < bays) out.push(beam(p.clone().add(c0), q.clone().add(c1), r * 0.55));
    }
  }
  return out;
}

