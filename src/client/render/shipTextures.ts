import * as THREE from 'three';
import { mulberry32 } from '../../shared/rng';

/**
 * Generated texture sets for ship hulls: a tileable paint sheet with its normal
 * and ORM (occlusion, roughness, metalness) maps, and a decal atlas.
 * One tile of the sheet covers SHEET_METERS of hull, which gives about
 * 256 px per meter at 1024 px.
 */
export const SHEET_METERS = 4;

export interface ShipSheet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  /** R: ambient occlusion, G: roughness, B: metalness. */
  orm: THREE.Texture;
}

function canvas(size: number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return { c, ctx: c.getContext('2d', { willReadFrequently: true })! };
}

function tex(c: HTMLCanvasElement, srgb: boolean) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Height (grey canvas) → tangent-space normal map. */
function heightToNormal(height: CanvasRenderingContext2D, size: number, strength: number) {
  const src = height.getImageData(0, 0, size, size).data;
  const out = canvas(size);
  const img = out.ctx.createImageData(size, size);
  const d = img.data;
  const h = (x: number, y: number) => src[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      // Canvas rows go down while v goes up: flip the y gradient.
      d[i] = (-dx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  out.ctx.putImageData(img, 0, 0);
  return out.c;
}

/**
 * Painted armour plates: panel layout, seams, rivets, hatches, chipped edges
 * showing bare metal, grime in the seams and streaks running aft.
 * The colour stays near neutral: hull areas are tinted by vertex colour.
 */
export function makeShipSheet(opts: { seed: number; size?: number; base?: string; dark?: boolean }): ShipSheet {
  const size = opts.size ?? 1024;
  const rand = mulberry32(opts.seed);
  const col = canvas(size);
  const hgt = canvas(size);
  const orm = canvas(size);
  const base = opts.base ?? '#d8dadd';
  const paintRough = opts.dark ? 150 : 112;
  const paintMetal = opts.dark ? 150 : 46;

  col.ctx.fillStyle = base;
  col.ctx.fillRect(0, 0, size, size);
  hgt.ctx.fillStyle = 'rgb(128,128,128)';
  hgt.ctx.fillRect(0, 0, size, size);
  orm.ctx.fillStyle = `rgb(255,${paintRough},${paintMetal})`;
  orm.ctx.fillRect(0, 0, size, size);

  // Panel layout: recursive splits inside a 4×4 grid, so the sheet tiles.
  const panels: [number, number, number, number][] = [];
  const split = (x: number, y: number, w: number, h: number, depth: number) => {
    if (depth > 3 || (depth > 1 && rand() < 0.3) || w < 70 || h < 70) {
      panels.push([x, y, w, h]);
      return;
    }
    // Plates are longer fore-aft (v) than around the hull (u).
    if (w > h * 1.4 ? rand() < 0.85 : rand() < 0.3) {
      const s = Math.floor(w * (0.3 + rand() * 0.4));
      split(x, y, s, h, depth + 1);
      split(x + s, y, w - s, h, depth + 1);
    } else {
      const s = Math.floor(h * (0.3 + rand() * 0.4));
      split(x, y, w, s, depth + 1);
      split(x, y + s, w, h - s, depth + 1);
    }
  };
  const ts = size / 4;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) split(i * ts, j * ts, ts, ts, 0);

  const g = col.ctx;
  for (const [x, y, w, h] of panels) {
    // Per-plate tone and roughness variation (±0.08).
    const shade = (rand() - 0.5) * (opts.dark ? 0.06 : 0.07);
    g.fillStyle = shade > 0 ? `rgba(255,255,255,${shade})` : `rgba(0,0,0,${-shade})`;
    g.fillRect(x, y, w, h);
    const r = paintRough + Math.floor((rand() - 0.5) * 40);
    orm.ctx.fillStyle = `rgb(255,${r},${paintMetal})`;
    orm.ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
    const lift = rand();
    const level = lift < 0.15 ? 112 : lift > 0.85 ? 146 : 128;
    hgt.ctx.fillStyle = `rgb(${level},${level},${level})`;
    hgt.ctx.fillRect(x + 2, y + 2, w - 4, h - 4);

    // Seams: a groove in the height map, dark line and occlusion.
    hgt.ctx.strokeStyle = 'rgb(40,40,40)';
    hgt.ctx.lineWidth = 3;
    hgt.ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    g.strokeStyle = 'rgba(10,12,16,0.55)';
    g.lineWidth = 2;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    orm.ctx.strokeStyle = `rgb(120,${paintRough + 50},${paintMetal})`;
    orm.ctx.lineWidth = 5;
    orm.ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    // Rivet rows along the long edges.
    if (rand() < 0.35) {
      for (let k = 8; k < h - 8; k += 16) {
        for (const rx of [x + 7, x + w - 8]) {
          hgt.ctx.fillStyle = 'rgb(165,165,165)';
          hgt.ctx.fillRect(rx - 1, y + k - 1, 3, 3);
          g.fillStyle = 'rgba(0,0,0,0.1)';
          g.fillRect(rx, y + k, 2, 2);
        }
      }
    }
    // Access hatch: inset rectangle with a latch.
    if (rand() < 0.16 && w > 90 && h > 90) {
      const hw = w * (0.3 + rand() * 0.25);
      const hh = h * (0.25 + rand() * 0.2);
      const hx = x + (w - hw) / 2;
      const hy = y + (h - hh) / 2;
      hgt.ctx.strokeStyle = 'rgb(70,70,70)';
      hgt.ctx.lineWidth = 2;
      hgt.ctx.strokeRect(hx, hy, hw, hh);
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 1.5;
      g.strokeRect(hx, hy, hw, hh);
      g.fillStyle = 'rgba(0,0,0,0.4)';
      g.fillRect(hx + hw - 10, hy + hh / 2 - 4, 5, 8);
    }
    // Vent grille.
    if (rand() < 0.08 && w > 80 && h > 60) {
      const vx = x + 10;
      const vy = y + 10;
      for (let k = 0; k < 7; k++) {
        hgt.ctx.fillStyle = 'rgb(60,60,60)';
        hgt.ctx.fillRect(vx, vy + k * 6, Math.min(56, w - 20), 3);
        g.fillStyle = 'rgba(0,0,0,0.5)';
        g.fillRect(vx, vy + k * 6, Math.min(56, w - 20), 3);
      }
    }
    // Paint chips, mostly along the edges: bare metal, shiny, metallic.
    const chips = Math.floor(rand() * (opts.dark ? 2 : 4));
    for (let k = 0; k < chips; k++) {
      const edge = rand() < 0.75;
      const cx = edge ? (rand() < 0.5 ? x + 3 + rand() * 6 : x + w - 3 - rand() * 6) : x + rand() * w;
      const cy = y + rand() * h;
      const cr = 1 + rand() * (edge ? 2.5 : 1.5);
      g.fillStyle = 'rgba(196,200,206,0.85)';
      orm.ctx.fillStyle = 'rgb(255,95,170)';
      for (let n = 0; n < 3; n++) {
        const ox = (rand() - 0.5) * cr * 1.6;
        const oy = (rand() - 0.5) * cr * 2.6;
        g.beginPath();
        g.ellipse(cx + ox, cy + oy, cr * (0.5 + rand() * 0.6), cr * (0.6 + rand()), 0, 0, Math.PI * 2);
        g.fill();
        orm.ctx.beginPath();
        orm.ctx.ellipse(cx + ox, cy + oy, cr * 0.6, cr * 0.9, 0, 0, Math.PI * 2);
        orm.ctx.fill();
      }
    }
  }
  // Grime streaks running aft (+v) from seams, and soft dirt.
  for (let i = 0; i < 140; i++) {
    const sx = rand() * size;
    const sy = rand() * size;
    const len = 20 + rand() * 120;
    const grad = g.createLinearGradient(sx, sy, sx, sy + len);
    const a = (opts.dark ? 0.06 : 0.03) + rand() * 0.04;
    grad.addColorStop(0, `rgba(30,26,22,${a})`);
    grad.addColorStop(1, 'rgba(30,26,22,0)');
    g.fillStyle = grad;
    g.fillRect(sx, sy, 1.5 + rand() * 3, len);
  }
  for (let i = 0; i < 1200; i++) {
    g.fillStyle = `rgba(20,18,16,${rand() * 0.02})`;
    const s = 2 + rand() * 10;
    g.fillRect(rand() * size, rand() * size, s, s * (1 + rand() * 3));
  }
  // Fine scratches catching the light.
  g.strokeStyle = 'rgba(255,255,255,0.07)';
  g.lineWidth = 0.6;
  for (let i = 0; i < 160; i++) {
    const sx = rand() * size;
    const sy = rand() * size;
    g.beginPath();
    g.moveTo(sx, sy);
    g.lineTo(sx + (rand() - 0.5) * 30, sy + (rand() - 0.5) * 30);
    g.stroke();
  }

  return {
    map: tex(col.c, true),
    normalMap: tex(heightToNormal(hgt.ctx, size, 2.2), false),
    orm: tex(orm.c, false),
  };
}

/** Rectangles of the decal atlas, in UV space (u0, v0, u1, v1). */
export type DecalId = 'serial' | 'maker' | 'emblem' | 'nostep' | 'arrow' | 'rescue' | 'chevron' | 'model';
export interface DecalAtlas {
  texture: THREE.Texture;
  rects: Record<DecalId, [number, number, number, number]>;
}

/**
 * Markings drawn once into an atlas: serial number, fictional manufacturer,
 * faction emblem and maintenance warnings. Black or coloured on transparent.
 */
export function makeDecalAtlas(opts: { serial: string; maker: string; model: string; color: string; warn: string }): DecalAtlas {
  const W = 1024;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  const rects = {} as DecalAtlas['rects'];
  // Atlas rows are in canvas pixels (y down); stored as UV (v up).
  const put = (id: DecalId, x: number, y: number, w: number, h: number) => {
    rects[id] = [x / W, 1 - (y + h) / H, (x + w) / W, 1 - y / H];
  };
  const font = (px: number, weight = 700) => `${weight} ${px}px "Arial Narrow", "Roboto Condensed", Arial, sans-serif`;
  g.textBaseline = 'middle';

  // Serial number (fins): 512×96
  g.fillStyle = opts.color;
  g.font = font(84);
  g.textAlign = 'left';
  g.fillText(opts.serial, 12, 48, 488);
  put('serial', 0, 0, 512, 96);

  // Manufacturer: 512×64
  g.font = font(40, 600);
  g.fillText(opts.maker, 12, 96 + 32, 488);
  put('maker', 0, 96, 512, 64);

  // Model name: 512×64
  g.font = font(46, 800);
  g.fillText(opts.model, 12, 160 + 32, 488);
  put('model', 0, 160, 512, 64);

  // Faction emblem (Union of Aurora): ring, arc and star, 192×192.
  {
    const cx = 512 + 96;
    const cy = 96;
    g.strokeStyle = opts.color;
    g.lineWidth = 12;
    g.beginPath();
    g.arc(cx, cy, 78, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 9;
    g.beginPath();
    g.arc(cx, cy + 70, 92, Math.PI * 1.18, Math.PI * 1.82);
    g.stroke();
    g.fillStyle = opts.color;
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 ? 14 : 46;
      g.lineTo(cx + Math.cos(a) * r, cy - 12 + Math.sin(a) * r);
    }
    g.closePath();
    g.fill();
    put('emblem', 512, 0, 192, 192);
  }

  // NO STEP box: 256×96
  g.strokeStyle = opts.warn;
  g.fillStyle = opts.warn;
  g.lineWidth = 5;
  g.strokeRect(712, 14, 296, 68);
  g.font = font(48);
  g.textAlign = 'center';
  g.fillText('NO STEP', 860, 50, 270);
  put('nostep', 704, 6, 312, 84);

  // Rescue arrow and label: 320×96
  g.fillStyle = '#d8a21c';
  g.beginPath();
  g.moveTo(712, 120);
  g.lineTo(920, 120);
  g.lineTo(920, 104);
  g.lineTo(1012, 144);
  g.lineTo(920, 184);
  g.lineTo(920, 168);
  g.lineTo(712, 168);
  g.closePath();
  g.fill();
  g.fillStyle = '#16181c';
  g.font = font(30);
  g.fillText('RESCUE', 816, 145, 190);
  put('rescue', 704, 100, 316, 92);

  // Small arrow (refuel / panel direction): 128×64
  g.fillStyle = opts.warn;
  g.beginPath();
  g.moveTo(16, 268);
  g.lineTo(80, 268);
  g.lineTo(80, 252);
  g.lineTo(120, 288);
  g.lineTo(80, 324);
  g.lineTo(80, 308);
  g.lineTo(16, 308);
  g.closePath();
  g.fill();
  put('arrow', 0, 240, 128, 96);

  // Hazard chevrons: 512×64
  for (let i = 0; i < 9; i++) {
    g.fillStyle = i % 2 ? '#16181c' : '#d8a21c';
    g.beginPath();
    const x = 144 + i * 40;
    g.moveTo(x, 256);
    g.lineTo(x + 40, 256);
    g.lineTo(x + 70, 320);
    g.lineTo(x + 30, 320);
    g.closePath();
    g.fill();
  }
  g.clearRect(128, 240, 16, 96);
  g.clearRect(500, 240, 140, 96);
  put('chevron', 144, 256, 356, 64);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return { texture: t, rects };
}
