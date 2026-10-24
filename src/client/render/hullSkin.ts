import * as THREE from 'three';
import { mulberry32 } from '../../shared/rng';
import { dot, hazard, painter, plates, stencil, texture, wear } from './hangarKit';

/*
 * Painted outer skin for the big flat faces of a station (hangar shells,
 * cargo decks): hull plates with patched sections, hatches, vents, a livery
 * band, the station's name, a hazard band at the hangar mouth, a few lit
 * windows and navigation lights. Each face is a plane laid 5 cm over the
 * collision box, so nothing moves into the flight volume. The colour map is
 * reused as a bump map: seams and hatches catch the sun.
 */

export interface SkinStyle {
  /** Plate colour (sRGB 0..255). */
  base: number[];
  /** Livery colour (CSS). */
  accent: string;
  seed: number;
}

export interface SkinFace {
  /** Size in meters (canvas x, canvas y from the top). */
  w: number;
  h: number;
  maxPx: number;
  /** Edge of the canvas on the hangar mouth: hazard stripes there. */
  mouth?: 'left' | 'right' | 'top' | 'bottom';
  /** Livery band height as a fraction of h from the top. */
  band?: number;
  /** Painted name, and its letter height (m). */
  name?: string;
  nameSize?: number;
  /** A row of lit windows above the band. */
  windows?: boolean;
  /** Red and green navigation lights at the mouth edge. */
  lights?: boolean;
}

export function hullSkin(face: SkinFace, style: SkinStyle) {
  const { w, h } = face;
  const rand = mulberry32(style.seed);
  const p = painter(w, h, face.maxPx);
  const e = painter(w, h, face.maxPx);
  const { g, k } = p;
  e.g.fillStyle = '#000';
  e.g.fillRect(0, 0, e.c.width, e.c.height);

  plates(p, rand, 0, 0, w, h, 8, 4, style.base, 0.07, 0.28);
  // Replaced and repainted sections: big patches a shade off.
  for (let i = 0; i < Math.round((w * h) / 900); i++) {
    const pw = (1 + Math.floor(rand() * 4)) * 8;
    const ph = (1 + Math.floor(rand() * 4)) * 4;
    const x = Math.floor((rand() * w) / 8) * 8;
    const y = Math.floor((rand() * h) / 4) * 4;
    g.fillStyle = rand() < 0.6 ? `rgba(0,0,0,${0.05 + rand() * 0.08})` : `rgba(255,255,255,${0.04 + rand() * 0.06})`;
    g.fillRect(x * k, y * k, pw * k, ph * k);
  }
  // Heavy edge trim.
  g.fillStyle = 'rgba(28,30,34,0.55)';
  g.fillRect(0, 0, w * k, 1.2 * k);
  g.fillRect(0, (h - 1.2) * k, w * k, 1.2 * k);
  g.fillRect(0, 0, 1.2 * k, h * k);
  g.fillRect((w - 1.2) * k, 0, 1.2 * k, h * k);

  // Hatches and vents, each leaving a grime streak below.
  const streak = (x: number, y: number, wd: number) => {
    const len = 4 + rand() * 10;
    const grad = g.createLinearGradient(0, y * k, 0, (y + len) * k);
    grad.addColorStop(0, 'rgba(20,18,16,0.28)');
    grad.addColorStop(1, 'rgba(20,18,16,0)');
    g.fillStyle = grad;
    g.fillRect(x * k, y * k, wd * k, len * k);
  };
  for (let i = 0; i < Math.round((w * h) / 260); i++) {
    const x = 3 + rand() * (w - 8);
    const y = 3 + rand() * (h - 6);
    if (rand() < 0.55) {
      g.strokeStyle = 'rgba(20,22,26,0.8)';
      g.lineWidth = Math.max(1, 0.12 * k);
      g.strokeRect(x * k, y * k, 2.4 * k, 1.6 * k);
      g.fillStyle = 'rgba(20,22,26,0.7)';
      g.fillRect((x + 1.9) * k, (y + 0.6) * k, 0.25 * k, 0.4 * k);
      streak(x + 0.3, y + 1.6, 1.8);
    } else {
      g.fillStyle = 'rgba(30,32,36,0.85)';
      g.fillRect(x * k, y * k, 4 * k, 1.5 * k);
      g.fillStyle = 'rgba(120,124,130,0.9)';
      for (let s = 0; s < 5; s++) g.fillRect(x * k, (y + 0.15 + s * 0.27) * k, 4 * k, 0.1 * k);
      streak(x, y + 1.5, 4);
    }
  }

  // Livery band, name above it, lit windows between.
  if (face.band !== undefined) {
    const by = face.band * h;
    g.fillStyle = style.accent;
    g.fillRect(0, by * k, w * k, 1.8 * k);
    g.fillRect(0, (by + 2.6) * k, w * k, 0.4 * k);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(0, (by + 1.8) * k, w * k, 0.15 * k);
    if (face.windows) {
      const wy = by - 3;
      for (let x = 6; x < w - 6; x += 1.7) {
        if (rand() < 0.12) {
          x += 4;
          continue;
        }
        g.fillStyle = '#121a22';
        g.fillRect(x * k, wy * k, 1.1 * k, 0.7 * k);
        if (rand() < 0.7) {
          e.g.fillStyle = rand() < 0.85 ? 'rgba(255,196,128,1)' : 'rgba(170,215,255,1)';
          e.g.fillRect(x * e.k, wy * e.k, 1.1 * e.k, 0.7 * e.k);
        }
      }
    }
  }
  if (face.name) {
    const size = face.nameSize ?? 10;
    const y = face.band !== undefined ? face.band * h - (face.windows ? 5 : 1.5) - size * 0.6 : h / 2;
    stencil(p, face.name, w / 2, y, size, 'rgba(36,40,48,0.85)');
  }

  // Hazard band on the mouth edge and the navigation lights.
  const hz = 2.4;
  if (face.mouth === 'left') hazard(p, 0, 0, hz, h, 1.4);
  if (face.mouth === 'right') hazard(p, w - hz, 0, hz, h, 1.4);
  if (face.mouth === 'top') hazard(p, 0, 0, w, hz, 1.4);
  if (face.mouth === 'bottom') hazard(p, 0, h - hz, w, hz, 1.4);
  if (face.lights && face.mouth) {
    const pts: [number, number][] =
      face.mouth === 'left' || face.mouth === 'right'
        ? [
            [face.mouth === 'left' ? 4 : w - 4, 4],
            [face.mouth === 'left' ? 4 : w - 4, h - 4],
          ]
        : [
            [4, face.mouth === 'top' ? 4 : h - 4],
            [w - 4, face.mouth === 'top' ? 4 : h - 4],
          ];
    for (const [x, y] of pts) {
      g.fillStyle = '#1a1c20';
      g.fillRect((x - 0.6) * k, (y - 0.6) * k, 1.2 * k, 1.2 * k);
      dot(e, x, y, 0.35, 'rgba(255,255,255,1)');
    }
  }
  wear(p, rand, 0.7);

  const map = texture(p, true);
  const mat = new THREE.MeshStandardMaterial({
    map,
    bumpMap: map,
    bumpScale: 1.2,
    emissiveMap: texture(e, true),
    emissive: new THREE.Color(1.3, 1.2, 1.1),
    roughness: 0.6,
    metalness: 0.4,
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
}
