import * as THREE from 'three';
import { mulberry32 } from '../../shared/rng';

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return { c, ctx };
}

function toTexture(c: HTMLCanvasElement, srgb = true, repeat = 1) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Hull plating: panels, seams, rivets and wear. Returns color + roughness + emissive maps. */
export function makeHullTextures(opts: {
  base: string;
  accent: string;
  seed: number;
  size?: number;
  lights?: string;
  stripes?: boolean;
  dark?: boolean;
}) {
  const size = opts.size ?? 1024;
  const rand = mulberry32(opts.seed);
  const col = canvas(size, size);
  const rough = canvas(size, size);
  const emi = canvas(size, size);
  const { ctx } = col;
  ctx.fillStyle = opts.base;
  ctx.fillRect(0, 0, size, size);
  rough.ctx.fillStyle = '#8a8a8a';
  rough.ctx.fillRect(0, 0, size, size);
  emi.ctx.fillStyle = '#000';
  emi.ctx.fillRect(0, 0, size, size);

  // Panels: recursive subdivision gives a convincing plate layout.
  const panels: [number, number, number, number][] = [];
  const split = (x: number, y: number, w: number, h: number, d: number) => {
    if (d > 4 || (d > 1 && rand() < 0.25) || w < 40 || h < 40) {
      panels.push([x, y, w, h]);
      return;
    }
    if (w > h ? rand() < 0.8 : rand() < 0.2) {
      const s = Math.floor(w * (0.3 + rand() * 0.4));
      split(x, y, s, h, d + 1);
      split(x + s, y, w - s, h, d + 1);
    } else {
      const s = Math.floor(h * (0.3 + rand() * 0.4));
      split(x, y, w, s, d + 1);
      split(x, y + s, w, h - s, d + 1);
    }
  };
  const tiles = 4;
  const ts = size / tiles;
  for (let i = 0; i < tiles; i++) for (let j = 0; j < tiles; j++) split(i * ts, j * ts, ts, ts, 0);

  for (const [x, y, w, h] of panels) {
    const shade = (rand() - 0.5) * (opts.dark ? 14 : 22);
    ctx.fillStyle = `rgba(${shade > 0 ? 255 : 0},${shade > 0 ? 255 : 0},${shade > 0 ? 255 : 0},${Math.abs(shade) / 255})`;
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    const r = 110 + Math.floor(rand() * 60);
    rough.ctx.fillStyle = `rgb(${r},${r},${r})`;
    rough.ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    // seams
    ctx.strokeStyle = opts.dark ? 'rgba(0,0,0,0.75)' : 'rgba(20,24,30,0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 3, y + 3, w - 6, h - 6);
    // rivets
    if (rand() < 0.5) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      for (let k = 6; k < w - 6; k += 12) {
        ctx.fillRect(x + k, y + 5, 2, 2);
        ctx.fillRect(x + k, y + h - 7, 2, 2);
      }
    }
    // vents / greebles
    if (rand() < 0.12 && w > 60 && h > 40) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      for (let k = 0; k < 6; k++) ctx.fillRect(x + 10, y + 10 + k * 5, Math.min(60, w - 20), 2);
    }
    // accent plates
    if (rand() < 0.08) {
      ctx.fillStyle = opts.accent;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
      ctx.globalAlpha = 1;
    }
    // window / light strips
    if (opts.lights && rand() < 0.18) {
      emi.ctx.fillStyle = opts.lights;
      const n = Math.floor(w / 14);
      for (let k = 0; k < n; k++) if (rand() < 0.75) emi.ctx.fillRect(x + 6 + k * 14, y + h / 2 - 2, 8, 4);
    }
  }
  if (opts.stripes) {
    ctx.fillStyle = opts.accent;
    ctx.fillRect(0, size * 0.46, size, size * 0.035);
    ctx.fillRect(0, size * 0.52, size, size * 0.012);
  }
  // grime
  for (let i = 0; i < 2500; i++) {
    ctx.fillStyle = `rgba(0,0,0,${rand() * 0.06})`;
    const s = rand() * 6;
    ctx.fillRect(rand() * size, rand() * size, s, s * (1 + rand() * 4));
  }
  return {
    map: toTexture(col.c),
    roughnessMap: toTexture(rough.c, false),
    emissiveMap: opts.lights ? toTexture(emi.c) : null,
  };
}

/** Dark-blue photovoltaic cells. */
export function makeSolarTexture() {
  const { c, ctx } = canvas(512, 512);
  ctx.fillStyle = '#0b1830';
  ctx.fillRect(0, 0, 512, 512);
  for (let x = 0; x < 512; x += 32)
    for (let y = 0; y < 512; y += 32) {
      const g = ctx.createLinearGradient(x, y, x + 32, y + 32);
      g.addColorStop(0, '#1d3a6e');
      g.addColorStop(1, '#0a1630');
      ctx.fillStyle = g;
      ctx.fillRect(x + 2, y + 2, 28, 28);
    }
  return toTexture(c);
}

/** Soft radial sprite (glows, flares, particles). */
export function makeRadialTexture(stops: [number, string][], size = 256) {
  const { c, ctx } = canvas(size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Lens-flare streak / hexagon textures. */
export function makeFlareRing(size = 256) {
  const { c, ctx } = canvas(size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.32, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.6, 'rgba(160,200,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * A star seen through a camera: hundreds of fine glare rays of random length
 * around a soft core, and six faint diffraction spikes. Drawn additively.
 */
export function makeStarGlare(seed: number, size = 512) {
  const { c, ctx } = canvas(size, size);
  const rand = mulberry32(seed);
  const m = size / 2;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 140; i++) {
    const a = rand() * Math.PI * 2;
    const len = m * (0.18 + Math.pow(rand(), 3) * 0.8);
    const g = ctx.createLinearGradient(m, m, m + Math.cos(a) * len, m + Math.sin(a) * len);
    const al = 0.05 + rand() * 0.1;
    g.addColorStop(0, `rgba(255,240,220,${al})`);
    g.addColorStop(1, 'rgba(255,220,190,0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = 1 + rand() * 2;
    ctx.beginPath();
    ctx.moveTo(m, m);
    ctx.lineTo(m + Math.cos(a) * len, m + Math.sin(a) * len);
    ctx.stroke();
  }
  const a0 = rand() * Math.PI;
  for (let k = 0; k < 6; k++) {
    const a = a0 + (k * Math.PI) / 3;
    const len = m * 0.98;
    const g = ctx.createLinearGradient(m, m, m + Math.cos(a) * len, m + Math.sin(a) * len);
    g.addColorStop(0, 'rgba(255,245,230,0.5)');
    g.addColorStop(0.3, 'rgba(255,235,210,0.12)');
    g.addColorStop(1, 'rgba(255,230,200,0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(m, m);
    ctx.lineTo(m + Math.cos(a) * len, m + Math.sin(a) * len);
    ctx.stroke();
  }
  const core = ctx.createRadialGradient(m, m, 0, m, m, m * 0.45);
  core.addColorStop(0, 'rgba(255,250,240,0.4)');
  core.addColorStop(0.15, 'rgba(255,225,190,0.12)');
  core.addColorStop(1, 'rgba(255,190,140,0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Thin horizontal streak (anamorphic lens), for the sun's flare. */
export function makeFlareStreak(size = 512) {
  const { c, ctx } = canvas(size, size);
  const m = size / 2;
  const g = ctx.createLinearGradient(0, 0, size, 0);
  g.addColorStop(0, 'rgba(150,190,255,0)');
  g.addColorStop(0.5, 'rgba(200,220,255,0.9)');
  g.addColorStop(1, 'rgba(150,190,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, m - 1.5, size, 3);
  ctx.globalAlpha = 0.35;
  ctx.fillRect(0, m - 5, size, 10);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft cloud puff for nebula dust sprites. */
export function makeCloudTexture(seed: number, size = 256) {
  const { c, ctx } = canvas(size, size);
  const rand = mulberry32(seed);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 60; i++) {
    const x = size / 2 + (rand() - 0.5) * size * 0.5;
    const y = size / 2 + (rand() - 0.5) * size * 0.5;
    const r = size * (0.08 + rand() * 0.22);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${0.05 + rand() * 0.06})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
