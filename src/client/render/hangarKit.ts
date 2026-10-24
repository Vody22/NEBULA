import * as THREE from 'three';
import { mulberry32 } from '../../shared/rng';

/*
 * The inside of a station hangar (Aurora-7, Kepler-4, the Ferro-9 depot):
 * painted deck with landing pads, walls of panels, ducts and stencils, ceiling
 * light troughs, I-beam ribs and a control room on the back wall. Everything
 * is painted into generated textures or sits flush with the collision walls
 * (physics/structures.ts), so nothing the eye sees stands in the flight volume
 * apart from the ribs (as before). The light is baked: the troughs light the
 * deck and the walls through the emissive maps, whatever the sun does outside.
 */

export interface HangarSpec {
  /** Outer size and wall thickness, as in physics/structures.ts. */
  w: number;
  h: number;
  d: number;
  wall: number;
  /** Station accent (signal stripes, stencils). */
  accent: string;
  /** Glow of the light troughs (linear, may exceed 1). */
  light: THREE.Color;
  /** Painted on the back wall. */
  name: string;
  /** Bay number, painted on the walls and the pads. */
  bay: string;
  /** Landing pads (x, z in the hangar's frame). */
  pads: [number, number][];
  /** Distance between ribs (m). */
  ribEvery: number;
  seed: number;
}

export interface Painter {
  c: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  /** Pixels per meter. */
  k: number;
}

/** Phones and tablets get half the texels: GPU memory and load time. */
const TEXEL_SCALE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 0.5 : 1;

export function painter(wM: number, hM: number, maxPx: number): Painter {
  const k = Math.min(maxPx / wM, maxPx / hM) * TEXEL_SCALE;
  const c = document.createElement('canvas');
  c.width = Math.round(wM * k);
  c.height = Math.round(hM * k);
  return { c, g: c.getContext('2d')!, k };
}

export function texture(p: Painter, color: boolean) {
  const t = new THREE.CanvasTexture(p.c);
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const FONT = '"Exo 2", "Arial Black", Arial, sans-serif';

/** Diagonal yellow and black hazard stripes in a rectangle (meters). */
export function hazard(p: Painter, x: number, y: number, w: number, h: number, stripe = 1.2) {
  const { g, k } = p;
  g.save();
  g.beginPath();
  g.rect(x * k, y * k, w * k, h * k);
  g.clip();
  g.fillStyle = '#d9a514';
  g.fillRect(x * k, y * k, w * k, h * k);
  g.fillStyle = '#16171a';
  const s = stripe * k;
  for (let u = -h * k; u < w * k + h * k; u += s * 2) {
    g.beginPath();
    g.moveTo(x * k + u, y * k);
    g.lineTo(x * k + u + s, y * k);
    g.lineTo(x * k + u + s - h * k, y * k + h * k);
    g.lineTo(x * k + u - h * k, y * k + h * k);
    g.fill();
  }
  g.restore();
}

/** Scuffs, chips and grime over everything painted so far. */
export function wear(p: Painter, rand: () => number, amount: number) {
  const { g, c } = p;
  const n = Math.round((c.width * c.height) / 900 * amount);
  for (let i = 0; i < n; i++) {
    const x = rand() * c.width;
    const y = rand() * c.height;
    const r = 0.5 + rand() * rand() * 6;
    g.fillStyle = rand() < 0.7 ? `rgba(10,10,12,${0.05 + rand() * 0.12})` : `rgba(220,222,226,${0.03 + rand() * 0.06})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
}

/** Plates with seams and bolts, `pw` × `ph` meters, slightly varied in tone. */
export function plates(p: Painter, rand: () => number, x0: number, y0: number, w: number, h: number, pw: number, ph: number, base: number[], vary: number, seam = 0.55) {
  const { g, k } = p;
  for (let y = y0; y < y0 + h - 1e-6; y += ph) {
    for (let x = x0; x < x0 + w - 1e-6; x += pw) {
      const t = 1 + (rand() - 0.5) * vary;
      g.fillStyle = `rgb(${base.map((v) => Math.round(Math.min(255, v * t))).join(',')})`;
      g.fillRect(x * k, y * k, Math.min(pw, x0 + w - x) * k, Math.min(ph, y0 + h - y) * k);
      g.strokeStyle = `rgba(0,0,0,${seam})`;
      g.lineWidth = Math.max(1, 0.08 * k);
      g.strokeRect(x * k, y * k, Math.min(pw, x0 + w - x) * k, Math.min(ph, y0 + h - y) * k);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      const b = Math.max(1, 0.07 * k);
      for (const [bx, by] of [[0.25, 0.25], [pw - 0.25, 0.25], [0.25, ph - 0.25], [pw - 0.25, ph - 0.25]]) g.fillRect((x + bx) * k - b / 2, (y + by) * k - b / 2, b, b);
    }
  }
}

export function stencil(p: Painter, text: string, x: number, y: number, sizeM: number, color: string, align: CanvasTextAlign = 'center', angle = 0) {
  const { g, k } = p;
  g.save();
  g.translate(x * k, y * k);
  g.rotate(angle);
  g.font = `900 ${Math.round(sizeM * k)}px ${FONT}`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillStyle = color;
  g.fillText(text, 0, 0);
  g.restore();
}

/**
 * Light falling from the troughs: soft bright bands across the deck (or down
 * the walls), drawn into an emissive canvas over a dim copy of the colour.
 */
function bakeLight(src: Painter, rows: number[], along: 'x' | 'y', reach: number, strength: number, floor: number, scale = 0.5) {
  // Light is soft: the emissive map can be coarser than the colour map.
  const e = painter(src.c.width / src.k, src.c.height / src.k, (Math.max(src.c.width, src.c.height) * scale) / TEXEL_SCALE);
  const { g, k } = e;
  g.fillStyle = '#000';
  g.fillRect(0, 0, e.c.width, e.c.height);
  // Mask of light: a floor level everywhere, brighter under each trough.
  const m = document.createElement('canvas');
  m.width = e.c.width;
  m.height = e.c.height;
  const mg = m.getContext('2d')!;
  // Opaque grey mask, multiplied in: an alpha mask would be undone when the
  // canvas is uploaded without premultiplied alpha.
  mg.fillStyle = '#000';
  mg.fillRect(0, 0, m.width, m.height);
  mg.globalCompositeOperation = 'lighter';
  mg.fillStyle = `rgba(255,255,255,${floor})`;
  mg.fillRect(0, 0, m.width, m.height);
  for (const r of rows) {
    const grad = along === 'x' ? mg.createLinearGradient(0, (r - reach) * k, 0, (r + reach) * k) : mg.createLinearGradient((r - reach) * k, 0, (r + reach) * k, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, `rgba(255,255,255,${strength})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    mg.fillStyle = grad;
    if (along === 'x') mg.fillRect(0, (r - reach) * k, m.width, reach * 2 * k);
    else mg.fillRect((r - reach) * k, 0, reach * 2 * k, m.height);
  }
  g.drawImage(src.c, 0, 0, e.c.width, e.c.height);
  g.globalCompositeOperation = 'multiply';
  g.drawImage(m, 0, 0);
  g.globalCompositeOperation = 'source-over';
  return e;
}

/** Glowing dots (guide lights, indicators) drawn on an emissive canvas. */
export function dot(p: Painter, x: number, y: number, rM: number, color: string) {
  const { g, k } = p;
  const grad = g.createRadialGradient(x * k, y * k, 0, x * k, y * k, rM * 2.5 * k);
  grad.addColorStop(0, color);
  grad.addColorStop(0.35, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(x * k, y * k, rM * 2.5 * k, 0, Math.PI * 2);
  g.fill();
}

/** A plane facing +Z, `w` × `h`, with its UVs 0..1. */
function panel(w: number, h: number) {
  return new THREE.PlaneGeometry(w, h);
}

export function furnishHangar(spec: HangarSpec, beamMat: THREE.Material) {
  const group = new THREE.Group();
  const rand = mulberry32(spec.seed);
  const iw = spec.w - spec.wall * 2;
  const ih = spec.h - spec.wall * 2;
  const z0 = -spec.d / 2 + spec.wall;
  const z1 = spec.d / 2;
  const depth = z1 - z0;
  const eps = 0.05;
  // Troughs between the ribs, as distances from the back wall.
  const ribs: number[] = [];
  for (let z = spec.ribEvery; z < depth - 4; z += spec.ribEvery) ribs.push(z);
  const troughs = [spec.ribEvery / 2, ...ribs.map((r) => r + spec.ribEvery / 2)].filter((t) => t < depth - 6);
  const accent = spec.accent;
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const m = new THREE.Mesh(geo, mat);
    group.add(m);
    return m;
  };
  const surface = (map: THREE.Texture, emissive: THREE.Texture, rough: number, metal = 0.15) =>
    new THREE.MeshStandardMaterial({ map, emissiveMap: emissive, emissive: 0xffffff, roughness: rough, metalness: metal, envMapIntensity: 0.25 });

  // ── Deck: plates, walkways, hazard band at the mouth, pads, approach chevrons ──
  {
    // Canvas x = hangar x (left to right seen from the mouth), canvas y = distance from the back wall.
    const p = painter(iw, depth, 2048);
    plates(p, rand, 0, 0, iw, depth, 4, 4, [74, 79, 87], 0.12);
    wear(p, rand, 2.2);
    const { g, k } = p;
    // Oil and burn stains on the pads' approach.
    for (let i = 0; i < 40; i++) {
      const x = rand() * iw;
      const y = rand() * depth;
      const r = (1 + rand() * 4) * k;
      const grad = g.createRadialGradient(x * k, y * k, 0, x * k, y * k, r);
      grad.addColorStop(0, `rgba(12,12,14,${0.15 + rand() * 0.2})`);
      grad.addColorStop(1, 'rgba(12,12,14,0)');
      g.fillStyle = grad;
      g.fillRect(x * k - r, y * k - r, r * 2, r * 2);
    }
    // Walkways along the walls: yellow lines 5 m in, dashed.
    g.fillStyle = 'rgba(224,178,40,0.85)';
    for (const x of [5, iw - 5]) for (let y = 2; y < depth - 6; y += 3) g.fillRect((x - 0.15) * k, y * k, 0.3 * k, 1.8 * k);
    hazard(p, 0, depth - 3.2, iw, 3.2, 1.4);
    hazard(p, 0, 0, iw, 1.6, 1);
    const cx = iw / 2;
    for (const [i, [px, pz]] of spec.pads.entries()) {
      const x = cx + px;
      const y = pz - z0;
      g.strokeStyle = 'rgba(236,236,230,0.9)';
      g.lineWidth = 0.7 * k;
      g.beginPath();
      g.arc(x * k, y * k, 13.6 * k, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = `${accent}`;
      g.lineWidth = 0.35 * k;
      g.setLineDash([2 * k, 1.4 * k]);
      g.beginPath();
      g.arc(x * k, y * k, 11.8 * k, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      // Crosshair and pad number, read from the mouth.
      g.fillStyle = 'rgba(236,236,230,0.85)';
      g.fillRect((x - 6) * k, (y - 0.2) * k, 12 * k, 0.4 * k);
      g.fillRect((x - 0.2) * k, (y - 6) * k, 0.4 * k, 12 * k);
      stencil(p, `${spec.bay}-${i + 1}`, x, y + 8.6, 3.2, 'rgba(236,236,230,0.9)');
      // Approach chevrons from the mouth.
      for (let c = 0; c < 3; c++) {
        const cyy = y + 18 + c * 5;
        if (cyy > depth - 5) break;
        g.fillStyle = `rgba(224,178,40,${0.8 - c * 0.15})`;
        g.beginPath();
        g.moveTo((x - 3) * k, (cyy + 2) * k);
        g.lineTo(x * k, cyy * k);
        g.lineTo((x + 3) * k, (cyy + 2) * k);
        g.lineTo((x + 3) * k, (cyy + 3) * k);
        g.lineTo(x * k, (cyy + 1) * k);
        g.lineTo((x - 3) * k, (cyy + 3) * k);
        g.fill();
      }
    }
    wear(p, rand, 1.2);
    // Light: bands under the troughs, then the guide lights at full strength.
    const e = bakeLight(p, troughs, 'x', spec.ribEvery * 0.55, 0.32, 0.1, 0.75);
    for (const x of [5, iw - 5]) for (let y = 3; y < depth - 4; y += 6) dot(e, x, y, 0.18, 'rgba(120,220,255,1)');
    for (let x = 2; x < iw; x += 4) dot(e, x, depth - 3.6, 0.16, 'rgba(255,190,90,1)');
    for (const [px, pz] of spec.pads) for (let a = 0; a < 16; a++) dot(e, cx + px + Math.cos((a / 16) * Math.PI * 2) * 13.6, pz - z0 + Math.sin((a / 16) * Math.PI * 2) * 13.6, 0.15, 'rgba(120,220,255,1)');
    const geo = panel(iw, depth);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, -ih / 2 + eps, (z0 + z1) / 2);
    add(geo, surface(texture(p, true), texture(e, true), 0.75));
  }

  // ── Side walls: panels, ducts, an accent band with stencils, hazard at the base ──
  for (const side of [-1, 1]) {
    // Canvas y runs from the ceiling down. Canvas x runs left to right as seen
    // from inside: back → mouth on the right wall, mouth → back on the left one,
    // so `at` turns a distance from the back wall into a canvas x.
    const p = painter(depth, ih, 1536);
    const at = (fromBack: number) => (side > 0 ? fromBack : depth - fromBack);
    plates(p, rand, 0, 0, depth, ih, 6, 4, [92, 98, 107], 0.1);
    const { g, k } = p;
    // Vertical service ducts between the ribs: shaded like cylinders.
    for (const r of ribs) {
      const x = at(r - 3.5);
      const grad = g.createLinearGradient((x - 0.8) * k, 0, (x + 0.8) * k, 0);
      grad.addColorStop(0, '#2d3036');
      grad.addColorStop(0.45, '#8a9099');
      grad.addColorStop(1, '#25282d');
      g.fillStyle = grad;
      g.fillRect((x - 0.8) * k, 0, 1.6 * k, ih * k);
      g.fillStyle = 'rgba(0,0,0,0.5)';
      for (let y = 2; y < ih; y += 6) g.fillRect((x - 0.9) * k, y * k, 1.8 * k, 0.25 * k);
    }
    // Accent band a third of the way up from the deck, with the bay stencils.
    const band = ih * 0.62;
    g.fillStyle = accent;
    g.fillRect(0, band * k, depth * k, 1.4 * k);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, (band + 1.4) * k, depth * k, 0.2 * k);
    for (let x = 14; x < depth - 10; x += 36) {
      stencil(p, `BAIE ${spec.bay}`, x, band - 2.6, 2.6, 'rgba(225,228,232,0.8)', 'left');
      stencil(p, side > 0 ? 'SORTIE ▶' : '◀ SORTIE', x + 16, band + 0.72, 1.0, 'rgba(20,20,22,0.85)', 'left');
    }
    // Grime: darker toward the deck, streaks under the band.
    const dirt = g.createLinearGradient(0, ih * 0.55 * k, 0, ih * k);
    dirt.addColorStop(0, 'rgba(10,10,12,0)');
    dirt.addColorStop(1, 'rgba(10,10,12,0.45)');
    g.fillStyle = dirt;
    g.fillRect(0, ih * 0.55 * k, depth * k, ih * 0.45 * k);
    for (let i = 0; i < 70; i++) {
      const x = rand() * depth;
      g.fillStyle = `rgba(14,14,16,${0.05 + rand() * 0.1})`;
      g.fillRect(x * k, (band + 1.6) * k, (0.1 + rand() * 0.4) * k, (2 + rand() * 8) * k);
    }
    hazard(p, 0, ih - 1.6, depth, 1.6, 1);
    wear(p, rand, 1.5);
    // Light: brighter under each trough, a little everywhere; indicator lights.
    const e = bakeLight(p, troughs.map(at), 'y', spec.ribEvery * 0.45, 0.26, 0.09);
    for (const r of ribs) {
      dot(e, at(r - 2), band - 5, 0.12, rand() < 0.5 ? 'rgba(90,255,140,1)' : 'rgba(255,170,60,1)');
      dot(e, at(r - 2.6), band - 5, 0.12, 'rgba(90,255,140,1)');
    }
    const map = texture(p, true);
    const em = texture(e, true);
    const geo = panel(depth, ih);
    // Left wall faces +x, right wall faces −x.
    geo.rotateY(side < 0 ? Math.PI / 2 : -Math.PI / 2);
    geo.translate(side * (iw / 2 - eps), 0, (z0 + z1) / 2);
    add(geo, surface(map, em, 0.62, 0.3));
  }

  // ── Ceiling: dark grid, vents; troughs are geometry below ──
  {
    const p = painter(iw, depth, 512);
    plates(p, rand, 0, 0, iw, depth, 8, 6, [40, 43, 48], 0.15);
    const { g, k } = p;
    for (let i = 0; i < 18; i++) {
      const x = 6 + rand() * (iw - 16);
      const y = 4 + rand() * (depth - 10);
      g.fillStyle = '#1b1d21';
      g.fillRect(x * k, y * k, 4 * k, 2 * k);
      g.fillStyle = '#3a3e45';
      for (let s = 0; s < 6; s++) g.fillRect(x * k, (y + 0.15 + s * 0.32) * k, 4 * k, 0.12 * k);
    }
    const e = bakeLight(p, troughs, 'x', 3, 0.5, 0.05);
    const geo = panel(iw, depth);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, ih / 2 - eps, (z0 + z1) / 2);
    add(geo, surface(texture(p, true), texture(e, true), 0.8, 0.4));
  }

  // ── Back wall: control room windows, the station's name, a blast door ──
  {
    const p = painter(iw, ih, 1536);
    plates(p, rand, 0, 0, iw, ih, 6, 4, [88, 94, 103], 0.1);
    const { g, k } = p;
    // Blast door in the middle, down to the deck.
    const dw = iw * 0.28;
    const dh = ih * 0.42;
    g.fillStyle = '#4b5058';
    g.fillRect((iw - dw) / 2 * k, (ih - dh) * k, dw * k, dh * k);
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect((iw / 2 - 0.15) * k, (ih - dh) * k, 0.3 * k, dh * k);
    hazard(p, (iw - dw) / 2 - 1.2, ih - dh - 1.2, dw + 2.4, 1.2, 1);
    hazard(p, (iw - dw) / 2 - 1.2, ih - dh, 1.2, dh, 1);
    hazard(p, (iw + dw) / 2, ih - dh, 1.2, dh, 1);
    // Control room: a long window band near the top.
    const wy = ih * 0.14;
    const wh = 5;
    g.fillStyle = '#07101a';
    g.fillRect(iw * 0.18 * k, wy * k, iw * 0.64 * k, wh * k);
    g.strokeStyle = '#2a2e35';
    g.lineWidth = 0.4 * k;
    for (let x = iw * 0.18; x <= iw * 0.82 + 1e-6; x += iw * 0.08) {
      g.beginPath();
      g.moveTo(x * k, wy * k);
      g.lineTo(x * k, (wy + wh) * k);
      g.stroke();
    }
    // The station's name, painted big under the windows.
    stencil(p, spec.name, iw / 2, wy + wh + 7.5, 8, 'rgba(222,225,230,0.85)');
    g.fillStyle = accent;
    g.fillRect(iw * 0.18 * k, (wy + wh + 0.8) * k, iw * 0.64 * k, 0.6 * k);
    const dirt = g.createLinearGradient(0, ih * 0.6 * k, 0, ih * k);
    dirt.addColorStop(0, 'rgba(10,10,12,0)');
    dirt.addColorStop(1, 'rgba(10,10,12,0.4)');
    g.fillStyle = dirt;
    g.fillRect(0, ih * 0.6 * k, iw * k, ih * 0.4 * k);
    wear(p, rand, 1.5);
    const e = bakeLight(p, [ih * 0.35], 'x', ih * 0.5, 0.22, 0.09);
    {
      const eg = e.g;
      const k = e.k;
      // Inside the control room: warm ceiling light, consoles, screens.
      const grad = eg.createLinearGradient(0, wy * k, 0, (wy + wh) * k);
      grad.addColorStop(0, 'rgba(255,214,160,0.85)');
      grad.addColorStop(1, 'rgba(40,60,80,0.4)');
      eg.fillStyle = grad;
      eg.fillRect(iw * 0.18 * k, wy * k, iw * 0.64 * k, wh * k);
      for (let x = iw * 0.19; x < iw * 0.81; x += 1.6 + rand() * 1.4) {
        eg.fillStyle = rand() < 0.5 ? 'rgba(90,200,255,0.95)' : 'rgba(120,255,170,0.9)';
        eg.fillRect(x * k, (wy + wh - 1.8) * k, (0.6 + rand() * 0.6) * k, 0.45 * k);
        eg.fillStyle = 'rgba(8,10,14,0.9)';
        eg.fillRect(x * k, (wy + wh - 1.2) * k, 1.2 * k, 1.2 * k);
      }
      eg.strokeStyle = '#000';
      eg.lineWidth = 0.4 * k;
      for (let x = iw * 0.18; x <= iw * 0.82 + 1e-6; x += iw * 0.08) {
        eg.beginPath();
        eg.moveTo(x * k, wy * k);
        eg.lineTo(x * k, (wy + wh) * k);
        eg.stroke();
      }
      // Door status lights.
      dot(e, (iw - dw) / 2 - 2.5, ih - dh + 1, 0.3, 'rgba(255,60,40,1)');
      dot(e, (iw + dw) / 2 + 2.5, ih - dh + 1, 0.3, 'rgba(255,60,40,1)');
    }
    const geo = panel(iw, ih);
    geo.translate(0, 0, z0 + eps);
    add(geo, surface(texture(p, true), texture(e, true), 0.6, 0.3));
  }

  // ── Ribs: I-beams on the walls and across the ceiling, 1.6 m deep ──
  const beam = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const b = new THREE.BoxGeometry(w, h, d);
    b.translate(x, y, z);
    add(b, beamMat);
  };
  const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.35, 0.12), toneMapped: false });
  for (const r of ribs) {
    const z = z0 + r;
    for (const sx of [-1, 1]) {
      const x = sx * (iw / 2 - 0.8);
      beam(0.5, ih, 1.6, x, 0, z);
      beam(1.6, ih, 0.3, x, 0, z - 0.65);
      beam(1.6, ih, 0.3, x, 0, z + 0.65);
      // Knee brace into the ceiling.
      const brace = new THREE.BoxGeometry(0.6, 9, 0.8);
      brace.rotateZ(sx * Math.PI / 4);
      brace.translate(sx * (iw / 2 - 3.6), ih / 2 - 3.6, z);
      add(brace, beamMat);
      const l = new THREE.BoxGeometry(0.25, 0.6, 0.25);
      l.translate(sx * (iw / 2 - 1.75), ih * 0.1, z);
      add(l, lamp);
    }
    beam(iw - 1.6, 0.5, 1.6, 0, ih / 2 - 0.8, z);
    beam(iw - 1.6, 1.6, 0.3, 0, ih / 2 - 0.8, z - 0.65);
    beam(iw - 1.6, 1.6, 0.3, 0, ih / 2 - 0.8, z + 0.65);
  }

  // ── Light troughs between the ribs: housings and glowing panels ──
  const glow = new THREE.MeshBasicMaterial({ color: spec.light, toneMapped: false });
  for (const t of troughs) {
    const z = z0 + t;
    for (const x of [-iw * 0.3, 0, iw * 0.3]) {
      beam(iw * 0.24, 0.9, 3, x, ih / 2 - 0.45, z);
      const g = new THREE.BoxGeometry(iw * 0.22, 0.1, 2.2);
      g.translate(x, ih / 2 - 0.95, z);
      add(g, glow);
    }
  }

  // ── Light falling through the dust: faint additive shafts under the troughs ──
  {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 256;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 256);
    const side = g.createLinearGradient(0, 0, 64, 0);
    side.addColorStop(0, 'rgba(0,0,0,1)');
    side.addColorStop(0.3, 'rgba(0,0,0,0)');
    side.addColorStop(0.7, 'rgba(0,0,0,0)');
    side.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = side;
    g.fillRect(0, 0, 64, 256);
    const map = new THREE.CanvasTexture(c);
    const haze = new THREE.MeshBasicMaterial({
      map,
      color: spec.light.clone().multiplyScalar(0.022),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    for (const t of troughs) {
      const shaft = new THREE.PlaneGeometry(iw * 0.9, ih * 0.9);
      shaft.translate(0, ih / 2 - 1 - (ih * 0.9) / 2, z0 + t);
      add(shaft, haze);
    }
  }

  // ── Mouth rim: hazard plates on the inner edges of the opening ──
  {
    const p = painter(16, 2, 512);
    hazard(p, 0, 0, 16, 2, 0.9);
    const map = texture(p, true);
    map.wrapS = THREE.RepeatWrapping;
    const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.7, metalness: 0.1, emissiveMap: map, emissive: new THREE.Color(0.08, 0.08, 0.08) });
    const rim = 2;
    const strip = (len: number, rotZ: number, x: number, y: number) => {
      const geo = new THREE.PlaneGeometry(len, rim);
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, (uv.getX(i) * len) / 16);
      // Facing the mouth (+Z), on the wall's front face.
      geo.rotateZ(rotZ);
      geo.translate(x, y, z1 + eps);
      add(geo, mat);
    };
    strip(iw + rim * 2, 0, 0, ih / 2 + rim / 2);
    strip(iw + rim * 2, 0, 0, -ih / 2 - rim / 2);
    strip(ih, Math.PI / 2, -iw / 2 - rim / 2, 0);
    strip(ih, Math.PI / 2, iw / 2 + rim / 2, 0);
  }

  for (const o of group.children) o.userData.hangar = true;
  return group;
}

/** The bay's name over the mouth, lit (a plane facing +Z, centred at the origin). */
export function bayBanner(text: string, accent: string, widthM: number) {
  const p = painter(widthM, widthM * 0.12, 1024);
  const { g, k, c } = p;
  g.fillStyle = '#0b0f14';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = accent;
  g.fillRect(0, c.height - 0.8 * k, c.width, 0.8 * k);
  stencil(p, text, widthM / 2, widthM * 0.06, widthM * 0.07, 'rgba(240,244,248,1)');
  const t = texture(p, true);
  const mat = new THREE.MeshBasicMaterial({ map: t, color: new THREE.Color(1.6, 1.6, 1.6), toneMapped: false });
  return new THREE.Mesh(new THREE.PlaneGeometry(widthM, widthM * 0.12), mat);
}
