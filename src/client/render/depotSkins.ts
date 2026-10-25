import * as THREE from 'three';
import { mulberry32 } from '../../shared/rng';
import { hazard, painter, plates, stencil, texture, wear, type Painter } from './hangarKit';

/*
 * Painted skins for the working parts of the stations: ore silos, cargo
 * containers and solar arrays. Like hullSkin, generated canvases; the colour
 * map doubles as a bump map so seams and ribs catch the sun.
 */

/** Rust and grime running down from a line (meters). */
function drips(p: Painter, rand: () => number, x0: number, x1: number, y: number, count: number, strength: number) {
  const { g, k } = p;
  for (let i = 0; i < count; i++) {
    const x = x0 + rand() * (x1 - x0);
    const len = 2 + rand() * rand() * 14;
    const w = 0.15 + rand() * 0.6;
    const grad = g.createLinearGradient(0, y * k, 0, (y + len) * k);
    const rust = rand() < 0.6;
    const a = (0.12 + rand() * 0.25) * strength;
    grad.addColorStop(0, rust ? `rgba(96,48,22,${a})` : `rgba(18,16,14,${a})`);
    grad.addColorStop(1, 'rgba(60,40,25,0)');
    g.fillStyle = grad;
    g.fillRect(x * k, y * k, w * k, len * k);
  }
}

/**
 * An ore silo's wall, unrolled: staggered welded plates, painted hoop bands
 * with rust running below, a service ladder, the silo's code in big stencil
 * letters, a hazard band at the foot and soot rising from it.
 * `bands`: hoop positions in meters from the top.
 */
export function siloSkin(o: { circumference: number; height: number; code: string; cargo: string; accent: string; bands: number[]; seed: number }) {
  const { circumference: w, height: h } = o;
  const rand = mulberry32(o.seed);
  const p = painter(w, h, 1024);
  const { g, k } = p;
  // Plates 6 × 3 m, every other row shifted by half a plate.
  for (let row = 0; row * 3 < h; row++) {
    const off = row % 2 ? 3 : 0;
    plates(p, rand, -off, row * 3, w + 6, 3, 6, 3, [132, 130, 124], 0.08, 0.22);
  }
  // Weld beads along each ring seam.
  g.fillStyle = 'rgba(255,255,255,0.08)';
  for (let y = 3; y < h; y += 3) g.fillRect(0, y * k - 1, w * k, Math.max(1, 0.06 * k));
  // Hoop bands in the depot's colour, rust below each.
  for (const y of o.bands) {
    g.fillStyle = o.accent;
    g.fillRect(0, (y - 1.5) * k, w * k, 3 * k);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(0, (y + 1.5) * k, w * k, Math.max(1, 0.12 * k));
    drips(p, rand, 0, w, y + 1.5, Math.round(w / 2.5), 1);
  }
  // Rust from the roof edge.
  drips(p, rand, 0, w, 0, Math.round(w / 1.5), 1.3);
  // Service ladder with a safety cage.
  const lx = w * 0.62;
  g.fillStyle = 'rgba(40,42,46,0.9)';
  g.fillRect((lx - 0.4) * k, 0, 0.08 * k, h * k);
  g.fillRect((lx + 0.4) * k, 0, 0.08 * k, h * k);
  for (let y = 0.3; y < h; y += 0.35) g.fillRect((lx - 0.4) * k, y * k, 0.88 * k, Math.max(1, 0.05 * k));
  g.strokeStyle = 'rgba(40,42,46,0.6)';
  g.lineWidth = Math.max(1, 0.05 * k);
  g.strokeRect((lx - 0.8) * k, 0, 1.68 * k, h * k);
  // Code twice around, between the bands, and small warnings.
  for (const u of [0.12, 0.62 - 0.25]) {
    stencil(p, o.code, w * u + 6, h * 0.36, 9, 'rgba(30,32,36,0.85)');
    stencil(p, `${o.cargo} · NE PAS PRESSURISER`, w * u + 6, h * 0.36 + 7.5, 1.1, 'rgba(30,32,36,0.8)');
  }
  // Inspection hatches.
  for (let i = 0; i < 6; i++) {
    const x = rand() * (w - 3);
    const y = 6 + rand() * (h - 14);
    g.strokeStyle = 'rgba(20,22,26,0.75)';
    g.lineWidth = Math.max(1, 0.1 * k);
    g.strokeRect(x * k, y * k, 1.8 * k, 1.2 * k);
  }
  // Hazard band and soot at the foot.
  hazard(p, 0, h - 2.4, w, 2.4, 1.6);
  const soot = g.createLinearGradient(0, (h - 18) * k, 0, (h - 2.4) * k);
  soot.addColorStop(0, 'rgba(20,18,16,0)');
  soot.addColorStop(1, 'rgba(20,18,16,0.45)');
  g.fillStyle = soot;
  g.fillRect(0, (h - 18) * k, w * k, 15.6 * k);
  wear(p, rand, 0.8);
  const map = texture(p, true);
  return new THREE.MeshStandardMaterial({ map, bumpMap: map, bumpScale: 1.4, roughness: 0.7, metalness: 0.35 });
}

/**
 * Cargo container sides: corrugated ribs, a top rail, a code plate and some
 * rust. Neutral grey so each instance's colour tints it.
 */
export function containerSkin(seed: number) {
  const rand = mulberry32(seed);
  const p = painter(12, 2.6, 512);
  const { g, k, c } = p;
  g.fillStyle = 'rgb(205,205,205)';
  g.fillRect(0, 0, c.width, c.height);
  // Corrugation: alternating light and shaded ribs every 0.3 m.
  for (let x = 0; x < 12; x += 0.3) {
    const grad = g.createLinearGradient(x * k, 0, (x + 0.3) * k, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0.18)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.16)');
    grad.addColorStop(1, 'rgba(255,255,255,0.18)');
    g.fillStyle = grad;
    g.fillRect(x * k, 0, 0.3 * k, c.height);
  }
  // Frame rails and corner posts.
  g.fillStyle = 'rgba(30,30,32,0.55)';
  g.fillRect(0, 0, c.width, 0.14 * k);
  g.fillRect(0, (2.6 - 0.14) * k, c.width, 0.14 * k);
  g.fillRect(0, 0, 0.16 * k, c.height);
  g.fillRect((12 - 0.16) * k, 0, 0.16 * k, c.height);
  // Code plate.
  g.fillStyle = 'rgba(240,240,240,0.85)';
  g.fillRect(0.8 * k, 0.4 * k, 2.6 * k, 0.6 * k);
  stencil(p, `NFX ${String(100000 + Math.floor(rand() * 899999))}`, 2.1, 0.7, 0.32, 'rgba(20,20,22,0.95)');
  drips(p, rand, 0.2, 11.8, 0.14, 26, 0.8);
  wear(p, rand, 1.2);
  const map = texture(p, true);
  return new THREE.MeshStandardMaterial({ map, bumpMap: map, bumpScale: 0.6, roughness: 0.6, metalness: 0.4 });
}

/**
 * Solar array: dark blue cells in a silver grid with thin busbars, a few
 * cells a shade off. One tile covers `tileM` meters (cells of 1.5 m).
 */
export function solarSkin(seed: number, tileM: number) {
  const rand = mulberry32(seed);
  const p = painter(tileM, tileM, 1024);
  const { g, k, c } = p;
  g.fillStyle = '#9aa2ac';
  g.fillRect(0, 0, c.width, c.height);
  const cell = 1.5;
  for (let y = 0; y < tileM - 1e-6; y += cell) {
    for (let x = 0; x < tileM - 1e-6; x += cell) {
      const t = 0.88 + rand() * 0.24;
      const grad = g.createLinearGradient(x * k, y * k, (x + cell) * k, (y + cell) * k);
      grad.addColorStop(0, `rgb(${Math.round(26 * t)},${Math.round(44 * t)},${Math.round(86 * t)})`);
      grad.addColorStop(1, `rgb(${Math.round(12 * t)},${Math.round(22 * t)},${Math.round(48 * t)})`);
      g.fillStyle = grad;
      g.fillRect((x + 0.05) * k, (y + 0.05) * k, (cell - 0.1) * k, (cell - 0.1) * k);
      // Fine fingers and two busbars per cell.
      g.fillStyle = 'rgba(190,200,215,0.18)';
      for (let f = 0.1; f < cell - 0.1; f += 0.12) g.fillRect((x + 0.05) * k, (y + f) * k, (cell - 0.1) * k, Math.max(1, 0.012 * k));
      g.fillStyle = 'rgba(200,208,220,0.55)';
      for (const b of [0.5, 1.0]) g.fillRect((x + b) * k, (y + 0.05) * k, Math.max(1, 0.03 * k), (cell - 0.1) * k);
    }
  }
  const map = texture(p, true);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return new THREE.MeshStandardMaterial({ map, metalness: 0.35, roughness: 0.28, envMapIntensity: 1.1 });
}

/**
 * Radiator panel: white-painted sheets crossed by heat pipes, the paint
 * yellowed along the hottest pipes, seams between sheets.
 */
export function radiatorSkin(seed: number) {
  const rand = mulberry32(seed);
  const w = 180;
  const h = 46;
  const p = painter(w, h, 1024);
  const { g, k } = p;
  plates(p, rand, 0, 0, w, h, 15, 11.5, [196, 198, 200], 0.06, 0.3);
  for (let x = 1.5; x < w; x += 3) {
    const hot = rand();
    const grad = g.createLinearGradient((x - 1) * k, 0, (x + 1) * k, 0);
    grad.addColorStop(0, 'rgba(180,150,90,0)');
    grad.addColorStop(0.5, `rgba(180,150,90,${0.04 + hot * 0.1})`);
    grad.addColorStop(1, 'rgba(180,150,90,0)');
    g.fillStyle = grad;
    g.fillRect((x - 1) * k, 0, 2 * k, h * k);
    g.fillStyle = 'rgba(60,62,66,0.35)';
    g.fillRect((x - 0.08) * k, 0, Math.max(1, 0.16 * k), h * k);
  }
  // Header pipes along both edges.
  g.fillStyle = 'rgba(70,72,76,0.7)';
  g.fillRect(0, 0, w * k, 0.8 * k);
  g.fillRect(0, (h - 0.8) * k, w * k, 0.8 * k);
  wear(p, rand, 0.5);
  const map = texture(p, true);
  return new THREE.MeshStandardMaterial({ map, bumpMap: map, bumpScale: 0.8, metalness: 0.2, roughness: 0.65, side: THREE.DoubleSide });
}
