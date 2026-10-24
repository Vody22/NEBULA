import * as THREE from 'three';
import { interceptPoint } from '../../shared/math';
import { COMPONENT_LABELS, DAMAGED_BELOW } from '../../shared/physics/damage';
import { COMPONENT_IDS, type ComponentId } from '../../shared/physics/hitboxes';
import { mulberry32 } from '../../shared/rng';
import { cargoTotal } from '../../shared/economy/items';
import { missionStatus, missionTitle } from '../../shared/missions';
import type { PilotState, PlayerInfo, PlayerStats } from '../../shared/net/protocol';
import { JUMP_CHARGE, JUMP_CLEARANCE, SECTOR_NAMES } from '../../shared/sectors';
import { statsOfPacked } from '../../shared/sim/upgrades';
import type { ShipInput } from '../../shared/sim/types';
import { isHostile } from '../hostility';
import type { InterpolatedShip } from '../net/SnapshotBuffer';
import type { NetStatus } from '../net/Transport';
import type { Action } from '../settings';
import './hud.css';

export interface HudFrame {
  me: InterpolatedShip | null;
  ships: Map<number, InterpolatedShip>;
  camera: THREE.PerspectiveCamera;
  input: ShipInput;
  cursor: { x: number; y: number };
  targetId: number | null;
  stats: PlayerStats;
  respawnIn: number;
  /** Every station of the sector, for markers and the radar. */
  stations: { position: THREE.Vector3; name: string }[];
  fps: number;
  net: string;
  status: NetStatus;
  online: boolean;
  /** Connected pilots by ship id (names over ships). */
  players: Map<number, PlayerInfo>;
  playerCount: number;
  maxPlayers: number;
  myName: string;
  /** Credits, hold and docking state from the server (null before the first update). */
  pilot: PilotState | null;
  /** The nearest hangar, while approaching it. */
  dock: DockGuide | null;
  /** What the mining beam is doing or would do. */
  mining: MiningInfo | null;
  /** The hyperspace drive (v0.7). */
  jump: JumpInfo | null;
  /** Between two sectors: no ship for a moment, and it was not destroyed. */
  jumping: boolean;
}

export interface JumpInfo {
  /** The sector a jump leads to. */
  to: string;
  /** Charging: seconds left, else null. */
  left: number | null;
  /** Seconds before the drive can charge again. */
  cooldown: number;
  /** Far enough from every station to jump. */
  clear: boolean;
}

export interface DockGuide {
  name: string;
  mouth: THREE.Vector3;
  distance: number;
  /** Inside the docking sphere. */
  inZone: boolean;
  speed: number;
  maxSpeed: number;
}

export interface MiningInfo {
  /** 'active': the server confirms ore is coming; 'aim': a rock in range, beam off; others: why nothing happens. */
  state: 'active' | 'aim' | 'fire' | 'speed' | 'none' | 'full';
  ore: string;
  richness: string;
  distance: number;
  /** Units per second on this rock. */
  rate: number;
  /** Estimated progress toward the next unit, 0..1. */
  progress: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const SEGMENTS = 20;
/** Where throttle 0 sits on the arc: reverse goes down to -0.4, forward up to 1. */
const THROTTLE_ZERO = 0.4 / 1.4;

/** Point on a circle, angle in degrees counter-clockwise from +x (SVG y points down). */
function polar(cx: number, cy: number, r: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) };
}

/** Clockwise SVG arc from angle a0 down to a1 (degrees, a0 > a1). */
function describeArc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p = polar(cx, cy, r, a0);
  const q = polar(cx, cy, r, a1);
  return `M${p.x.toFixed(2)} ${p.y.toFixed(2)} A${r} ${r} 0 ${a0 - a1 > 180 ? 1 : 0} 1 ${q.x.toFixed(2)} ${q.y.toFixed(2)}`;
}
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Cracks in the canopy glass (v0.8), seeded so they always look the same: a
 * few long cracks running from the point of impact, branches, and the rings
 * of a spider web between them. The main cracks come first: as the cockpit
 * fails, more of the list is shown. Coordinates in a 100 × 100 box.
 */
function canopyCracks(): string[] {
  const r = mulberry32(0xc4ac);
  const cx = 14;
  const cy = 12;
  const main: string[] = [];
  const minor: string[] = [];
  const rays: { x: number; y: number }[][] = [];
  for (let i = 0; i < 8; i++) {
    let a = -0.35 + (i / 7) * 2.25 + (r() - 0.5) * 0.25;
    let x = cx;
    let y = cy;
    const pts = [{ x, y }];
    const len = 45 + r() * 50;
    let d = 0;
    while (d < len) {
      const step = 3 + r() * 6;
      a += (r() - 0.5) * 0.5;
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
      d += step;
      pts.push({ x, y });
      if (r() < 0.22 && d > 8) {
        // A branch splits off and dies out.
        let b = a + (r() < 0.5 ? -1 : 1) * (0.4 + r() * 0.5);
        let bx = x;
        let by = y;
        let path = `M${bx.toFixed(1)} ${by.toFixed(1)}`;
        for (let k = 0; k < 3; k++) {
          b += (r() - 0.5) * 0.6;
          bx += Math.cos(b) * (2 + r() * 4);
          by += Math.sin(b) * (2 + r() * 4);
          path += ` L${bx.toFixed(1)} ${by.toFixed(1)}`;
        }
        minor.push(path);
      }
    }
    rays.push(pts);
    main.push('M' + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L'));
  }
  // Web rings: short links between neighbouring cracks near the impact.
  for (const ring of [2, 4, 6]) {
    for (let i = 0; i + 1 < rays.length; i++) {
      const p = rays[i][Math.min(ring, rays[i].length - 1)];
      const q = rays[i + 1][Math.min(ring, rays[i + 1].length - 1)];
      const mx = (p.x + q.x) / 2 + (r() - 0.5) * 2;
      const my = (p.y + q.y) / 2 + (r() - 0.5) * 2;
      minor.push(`M${p.x.toFixed(1)} ${p.y.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`);
    }
  }
  // Interleave so that every stage shows long cracks and some web.
  const out: string[] = [];
  while (main.length || minor.length) {
    if (main.length) out.push(main.shift()!);
    for (let k = 0; k < 2 && minor.length; k++) out.push(minor.shift()!);
  }
  return out;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: HTMLElement, html = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
}

export class Hud {
  readonly root: HTMLDivElement;
  private crosshair: HTMLDivElement;
  private cursorEl: HTMLDivElement;
  private cursorLine: SVGLineElement;
  private lead: HTMLDivElement;
  private bracket: HTMLDivElement;
  private bracketInfo: HTMLDivElement;
  private arrow: HTMLDivElement;
  private markers = new Map<number, HTMLDivElement>();
  private stationMarkers: HTMLDivElement[] = [];
  private markerLayer: HTMLDivElement;
  private speedEl: HTMLSpanElement;
  private throttleFill: SVGPathElement;
  private gauge: HTMLDivElement;
  private chips: HTMLDivElement;
  private shieldSeg: HTMLDivElement;
  private hullSeg: HTMLDivElement;
  private shieldTxt: HTMLSpanElement;
  private hullTxt: HTMLSpanElement;
  private energyBar: HTMLElement;
  private hullStat: HTMLDivElement;
  private creditsEl: HTMLSpanElement;
  private holdBox: HTMLDivElement;
  private radar: HTMLCanvasElement;
  private radarCtx: CanvasRenderingContext2D;
  private topbar: HTMLDivElement;
  private feed: HTMLDivElement;
  private vignette: HTMLDivElement;
  private shieldFlash: HTMLDivElement;
  private death: HTMLDivElement;
  private deathTimer: HTMLParagraphElement;
  private fpsEl: HTMLDivElement;
  private netEl: HTMLDivElement;
  private board: HTMLDivElement;
  private hitTimer = 0;
  private fireTimer = 0;
  private hitMarker: HTMLDivElement;
  private hitMarkerTimer = 0;
  private killTimer = 0;
  private killEl: HTMLDivElement;
  private dockMarker: HTMLDivElement;
  private prompt: HTMLDivElement;
  private miningEl: HTMLDivElement;
  private holdTxt: HTMLSpanElement;
  private jobsEl: HTMLDivElement;
  private holdBar: HTMLElement;
  private keys = { dock: 'G', mine: 'R', jump: 'J' };
  private jumpEl: HTMLDivElement;
  private warpEl: HTMLDivElement;
  /** Ship components (v0.8): the plan view, each part's last state, the damaged list. */
  private partsStat: HTMLDivElement;
  private partsList: HTMLDivElement;
  private partEls = new Map<ComponentId | 'hull', { el: SVGPathElement; state: string }>();
  private cracks: SVGSVGElement;
  private crackPaths: SVGPathElement[] = [];
  private crackShown = -1;
  private crackFlash = 0;
  private damage = 0;
  private shieldFx = 0;
  private cache = new Map<HTMLElement, string>();

  /** Writes innerHTML only when it changed (avoids re-layout every frame). */
  private html(el: HTMLElement, value: string) {
    if (this.cache.get(el) === value) return;
    this.cache.set(el, value);
    el.innerHTML = value;
  }

  constructor() {
    this.root = el('div', '', document.body) as HTMLDivElement;
    this.root.id = 'hud';
    this.root.classList.add('hidden');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'cursorLine';
    this.cursorLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    this.cursorLine.setAttribute('stroke', 'rgba(127,227,255,0.35)');
    this.cursorLine.setAttribute('stroke-width', '1');
    this.cursorLine.setAttribute('stroke-dasharray', '3 4');
    svg.appendChild(this.cursorLine);
    this.root.appendChild(svg);

    this.markerLayer = el('div', '', this.root) as HTMLDivElement;
    this.dockMarker = this.makeMarker('dock');

    this.crosshair = el('div', 'abs crosshair', this.root, '<div class="ring"></div><i class="t u"></i><i class="t d"></i><i class="t l"></i><i class="t r"></i><i class="dot"></i>') as HTMLDivElement;
    this.hitMarker = el('div', 'abs hitmarker', this.root, '<i></i><i></i><i></i><i></i>') as HTMLDivElement;
    this.hitMarker.setAttribute('aria-hidden', 'true');
    this.killEl = el('div', 'abs killconfirm', this.root, 'CIBLE DÉTRUITE') as HTMLDivElement;
    this.cursorEl = el('div', 'abs cursor', this.root) as HTMLDivElement;
    this.lead = el('div', 'abs lead', this.root) as HTMLDivElement;
    this.bracket = el('div', 'abs bracket', this.root, '<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>') as HTMLDivElement;
    this.bracketInfo = el('div', 'info', this.bracket) as HTMLDivElement;
    this.arrow = el('div', 'abs arrow', this.root) as HTMLDivElement;
    this.miningEl = el('div', 'abs mining', this.root) as HTMLDivElement;
    this.prompt = el('div', 'prompt', this.root) as HTMLDivElement;
    this.prompt.setAttribute('role', 'status');

    const zone = el('div', 'abs', this.root, '<div class="name" id="zoneName">SECTEUR AURORA</div><div class="help"><kbd>Échap</kbd> menu et aide</div>') as HTMLDivElement;
    zone.id = 'zone';
    this.netEl = el('div', 'net', zone) as HTMLDivElement;
    this.netEl.id = 'netStatus';
    this.netEl.setAttribute('role', 'status');
    // Contracts in progress, under the sector name.
    this.jumpEl = el('div', 'jump', zone) as HTMLDivElement;
    this.jobsEl = el('div', 'jobs', zone) as HTMLDivElement;
    this.fpsEl = el('div', 'abs', this.root) as HTMLDivElement;
    this.fpsEl.id = 'fps';
    // Wallet: credits and hold, top right.
    this.topbar = el('div', 'panel', this.root,
      '<div class="w cr"><span class="v"></span><span class="u">cr</span></div><i class="sep"></i>' +
      '<div class="w hold"><span class="label">Soute</span><span class="v"></span><div class="bar o"><i></i></div></div>') as HTMLDivElement;
    this.topbar.id = 'topbar';
    this.topbar.setAttribute('aria-label', 'Crédits et soute');
    this.creditsEl = this.topbar.querySelector('.cr .v')!;
    this.holdBox = this.topbar.querySelector('.hold')!;
    this.holdTxt = this.holdBox.querySelector('.v')!;
    this.holdBar = this.holdBox.querySelector('.bar i')!;

    // Flight: a throttle arc (reverse below the white tick, boost in violet) around the speed.
    const flight = el('div', 'panel', this.root) as HTMLDivElement;
    flight.id = 'flight';
    this.gauge = el('div', 'gauge', flight) as HTMLDivElement;
    const arc = describeArc(100, 96, 84, 210, -30);
    const zt = polar(100, 96, 84, 210 - THROTTLE_ZERO * 240);
    const zi = polar(100, 96, 72, 210 - THROTTLE_ZERO * 240);
    this.gauge.innerHTML =
      `<svg viewBox="0 0 200 140" preserveAspectRatio="xMidYMid meet" aria-hidden="true">` +
      `<defs><linearGradient id="thrGrad" x1="0" x2="1"><stop offset="0" stop-color="#3aa8d8"/><stop offset="1" stop-color="#9ff0ff"/></linearGradient></defs>` +
      `<path class="track" d="${arc}" pathLength="100"/><path class="fill" d="${arc}" pathLength="100" stroke-dasharray="0 100"/>` +
      `<line class="zero" x1="${zi.x.toFixed(1)}" y1="${zi.y.toFixed(1)}" x2="${zt.x.toFixed(1)}" y2="${zt.y.toFixed(1)}"/></svg>` +
      `<div class="read"><div class="big"><span></span><span class="unit">m/s</span></div><span class="label">Vitesse</span></div>`;
    this.throttleFill = this.gauge.querySelector('.fill')!;
    this.speedEl = this.gauge.querySelector('.big span')!;
    this.chips = el('div', 'chips', flight) as HTMLDivElement;

    const status = el('div', 'panel', this.root) as HTMLDivElement;
    status.id = 'status';
    const mk = (label: string, cls: string) => {
      const s = el('div', 'stat', status);
      const head = el('div', 'head', s);
      el('span', 'label', head, label);
      const txt = el('span', '', head) as HTMLSpanElement;
      const seg = el('div', `segbar ${cls}`, s) as HTMLDivElement;
      for (let i = 0; i < SEGMENTS; i++) el('i', '', seg);
      return { txt, seg };
    };
    const sh = mk('Boucliers', 's');
    this.shieldTxt = sh.txt;
    this.shieldSeg = sh.seg;
    const hu = mk('Coque', 'h');
    this.hullTxt = hu.txt;
    this.hullSeg = hu.seg;
    this.hullStat = hu.seg.parentElement as HTMLDivElement;
    const en = el('div', 'stat', status);
    el('div', 'head', en, '<span class="label">Énergie</span>');
    const eb = el('div', 'bar e', en);
    this.energyBar = el('i', '', eb);
    // Components (v0.8): a plan view of the ship, each part in the colour of
    // its health, and the damaged ones listed; shown once something is hurt.
    this.partsStat = el('div', 'stat parts', status) as HTMLDivElement;
    this.partsStat.innerHTML =
      '<svg viewBox="0 0 60 56" aria-hidden="true">' +
      '<path data-p="wingL" d="M24 22 L5 39 L5 45 L24 37 Z"/><path data-p="wingR" d="M36 22 L55 39 L55 45 L36 37 Z"/>' +
      '<path data-p="hull" d="M25 17 L35 17 L36 41 L24 41 Z"/><path data-p="cockpit" d="M30 3 L35 17 L25 17 Z"/>' +
      '<path data-p="engines" d="M24 41 L36 41 L35 52 L25 52 Z"/></svg><div class="list" role="status"></div>';
    this.partsList = this.partsStat.querySelector('.list')!;
    for (const p of this.partsStat.querySelectorAll('path')) this.partEls.set(p.dataset.p as ComponentId | 'hull', { el: p, state: '' });

    const rw = el('div', 'panel', this.root) as HTMLDivElement;
    rw.id = 'radarWrap';
    this.radar = el('canvas', '', rw) as HTMLCanvasElement;
    this.radar.id = 'radar';
    this.radar.width = 600;
    this.radar.height = 340;
    this.radarCtx = this.radar.getContext('2d')!;

    this.board = el('div', 'panel hidden', this.root) as HTMLDivElement;
    this.board.id = 'scoreboard';
    this.board.setAttribute('aria-live', 'polite');

    this.feed = el('div', '', this.root) as HTMLDivElement;
    this.feed.id = 'feed';
    this.vignette = el('div', '', document.body) as HTMLDivElement;
    this.vignette.id = 'vignette';
    this.shieldFlash = el('div', '', document.body) as HTMLDivElement;
    this.shieldFlash.id = 'shieldflash';
    this.warpEl = el('div', '', document.body) as HTMLDivElement;
    this.warpEl.id = 'warp';
    this.warpEl.setAttribute('aria-hidden', 'true');
    // Cracked canopy (v0.8), over the view while the cockpit is damaged.
    const svgNS = 'http://www.w3.org/2000/svg';
    this.cracks = document.createElementNS(svgNS, 'svg');
    this.cracks.id = 'cracks';
    this.cracks.setAttribute('viewBox', '0 0 100 100');
    this.cracks.setAttribute('preserveAspectRatio', 'xMinYMin meet');
    this.cracks.setAttribute('aria-hidden', 'true');
    for (const d of canopyCracks()) {
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', d);
      path.style.display = 'none';
      this.cracks.appendChild(path);
      this.crackPaths.push(path);
    }
    this.cracks.style.display = 'none';
    document.body.appendChild(this.cracks);
    this.death = el('div', '', document.body, '<h2>VAISSEAU DÉTRUIT</h2>') as HTMLDivElement;
    this.death.id = 'death';
    this.deathTimer = el('p', '', this.death) as HTMLParagraphElement;
  }

  show(v: boolean) {
    this.root.classList.toggle('hidden', !v);
    if (!v) {
      this.cracks.style.display = 'none';
      this.crackShown = -1;
      this.death.classList.remove('show');
      this.board.classList.add('hidden');
      this.vignette.style.opacity = this.shieldFlash.style.opacity = '0';
    }
  }

  setZoneName(name: string) {
    const z = document.getElementById('zoneName');
    if (z) z.textContent = name.toUpperCase();
  }

  private makeMarker(kind: 'hostile' | 'friend' | 'station' | 'player' | 'dock') {
    const m = el('div', `abs marker ${kind}`, this.markerLayer, '<div class="shape"></div><div class="lbl"></div>') as HTMLDivElement;
    return m;
  }

  notice(text: string, tone: 'info' | 'warn' | 'good') {
    const n = el('div', `notice ${tone}`, this.feed, text);
    setTimeout(() => n.remove(), 4600);
    while (this.feed.children.length > 4) this.feed.firstChild?.remove();
  }

  /** Our shot hit something: an X marker (blue = shield, orange = hull). */
  hitConfirm(shield = true) {
    this.hitTimer = 0.12;
    this.hitMarkerTimer = 0.18;
    this.hitMarker.classList.toggle('hull', !shield);
  }

  killConfirm() {
    this.killTimer = 1.6;
  }

  fired() {
    this.fireTimer = 0.07;
  }

  setBindings(_b: Record<Action, string>) {
    /* key names come with the layout: see setKeyLabels */
  }

  /** Key names for the on-screen hints (they follow the player's bindings and layout). */
  setKeyLabels(keys: { dock: string; mine: string; jump: string }) {
    this.keys = keys;
  }

  /**
   * The screen side of a jump: 'flash' when the ship leaves (covers the
   * change of scene), 'reveal' once the new sector is drawn.
   */
  warp(phase: 'flash' | 'reveal') {
    this.warpEl.classList.remove('charging', 'flash', 'reveal');
    // Restart the transition from a full flash.
    void this.warpEl.offsetWidth;
    this.warpEl.classList.add(phase);
  }

  setPaused(p: boolean) {
    this.root.classList.toggle('paused', p);
  }

  updatePaused(_dt: number) {
    /* HUD stays frozen behind the pause menu */
  }

  damageTaken(amount: number, shield: boolean) {
    if (shield) this.shieldFx = Math.min(1, this.shieldFx + 0.25 + amount / 60);
    else this.damage = Math.min(1, this.damage + 0.35 + amount / 40);
  }

  /** The cockpit took a blow: the cracks catch the light for a moment. */
  cockpitHit() {
    this.crackFlash = 1;
  }

  /**
   * Components of our ship (snapshot `d`: cockpit, left wing, right wing,
   * engines, in %; absent when all intact), and the hull fraction for the
   * body of the plan view.
   */
  private components(d: [number, number, number, number] | undefined, hull: number, dt: number, show: boolean) {
    this.partsStat.classList.toggle('show', !!d && show);
    const set = (k: ComponentId | 'hull', h: number) => {
      const state = h <= 0 ? 'out' : h < DAMAGED_BELOW ? 'dmg' : h < 0.995 ? 'worn' : 'ok';
      const p = this.partEls.get(k)!;
      if (p.state === state) return;
      p.state = state;
      p.el.setAttribute('class', state);
    };
    set('hull', hull >= 0.6 ? 1 : hull >= 0.3 ? 0.4 : 0);
    const items: string[] = [];
    COMPONENT_IDS.forEach((c, i) => {
      const h = d ? d[i] / 100 : 1;
      set(c, h);
      if (h < 1) items.push(`<span class="${h <= 0 ? 'out' : h < DAMAGED_BELOW ? 'dmg' : 'worn'}">${COMPONENT_LABELS[c]} ${h <= 0 ? 'HS' : Math.round(h * 100) + ' %'}</span>`);
    });
    this.html(this.partsList, items.join(''));
    // The canopy cracks a little more as the cockpit fails; under a quarter its systems flicker.
    const cockpit = d ? d[0] / 100 : 1;
    const cracked = show && cockpit < DAMAGED_BELOW;
    const n = cracked ? Math.max(4, Math.ceil(((DAMAGED_BELOW - cockpit) / DAMAGED_BELOW) * this.crackPaths.length)) : 0;
    if (n !== this.crackShown) {
      this.crackShown = n;
      this.cracks.style.display = n ? '' : 'none';
      this.crackPaths.forEach((p, i) => (p.style.display = i < n ? '' : 'none'));
    }
    this.crackFlash = Math.max(0, this.crackFlash - dt * 1.8);
    if (n) this.cracks.style.opacity = String(Math.min(1, 0.5 + 0.5 * this.crackFlash));
    this.root.classList.toggle('glitch', show && cockpit < 0.25);
  }

  /** Projects a world point; returns screen px and whether it is in front of the camera. */
  private project(p: THREE.Vector3, cam: THREE.Camera, out: { x: number; y: number; front: boolean }) {
    _v.copy(p).project(cam);
    _w.copy(p).applyMatrix4(cam.matrixWorldInverse);
    out.front = _w.z < 0;
    out.x = (_v.x * 0.5 + 0.5) * window.innerWidth;
    out.y = (-_v.y * 0.5 + 0.5) * window.innerHeight;
    return out;
  }

  /** Pilots list (held Tab). */
  showScoreboard(show: boolean, list: PlayerInfo[], myName: string, online: boolean, stats?: PlayerStats) {
    this.board.classList.toggle('hidden', !show);
    if (!show) return;
    const where = (p: PlayerInfo) => SECTOR_NAMES[p.sector]?.replace(/^Secteur\s+/, '') ?? '—';
    const mine = stats ? `<p class="mine">Vos combats : ${stats.kills} élimination${stats.kills > 1 ? 's' : ''} · ${stats.deaths} perte${stats.deaths > 1 ? 's' : ''}</p>` : '';
    if (!online) {
      this.html(this.board, `<h3>Pilotes</h3><p>Mode solo : aucun autre pilote.</p>${mine}`);
      return;
    }
    const rows = [...list]
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
      .map(
        (p) =>
          `<tr${p.name === myName ? ' class="me"' : ''}><td>${esc(p.name)}${p.name === myName ? ' (vous)' : ''}</td><td>${where(p)}</td><td>${p.kills}</td><td>${p.deaths}</td>` +
          `<td>${p.ping ? p.ping + ' ms' : '—'}</td><td>${p.pvp ? '⚔ oui' : 'non'}</td><td>${p.online ? 'en ligne' : 'déconnecté'}</td></tr>`,
      )
      .join('');
    this.html(this.board,
      `<h3>Pilotes en ligne · ${list.filter((p) => p.online).length}</h3>` +
      `<table><thead><tr><th>Pilote</th><th>Secteur</th><th>Élim.</th><th>Pertes</th><th>Ping</th><th>PvP</th><th>État</th></tr></thead><tbody>${rows}</tbody></table>${mine}`);
  }

  private netLine(f: HudFrame) {
    const st = f.status;
    const name = f.myName ? `<b>${esc(f.myName)}</b> · ` : '';
    switch (st.state) {
      case 'local':
        return `<span class="dot local"></span>SOLO · hors ligne`;
      case 'online':
        return `${name}<span class="dot ok"></span>EN LIGNE · ${f.playerCount}${f.maxPlayers ? '/' + f.maxPlayers : ''} pilote${f.playerCount > 1 ? 's' : ''} · ${st.rtt ? Math.round(st.rtt) + ' ms' : '… ms'}`;
      case 'connecting':
        return `<span class="dot warn"></span>CONNEXION…`;
      case 'reconnecting':
        return `${name}<span class="dot warn"></span>⚠ RECONNEXION…`;
      default:
        return `<span class="dot bad"></span>⚠ HORS LIGNE${st.error ? ' · ' + esc(st.error) : ''}`;
    }
  }

  update(f: HudFrame, dt: number) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const pt = { x: 0, y: 0, front: true };
    const me = f.me;
    this.html(this.fpsEl, `${f.fps.toFixed(0)} IPS · ${f.net}`);
    this.html(this.netEl, this.netLine(f));
    this.netEl.classList.toggle('warn', f.status.state !== 'online' && f.status.state !== 'local');
    this.creditsEl.textContent = (f.pilot?.credits ?? f.stats.credits).toLocaleString('fr-FR');
    if (f.pilot) {
      const used = cargoTotal(f.pilot.cargo) + f.pilot.reserved;
      const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
      const jobs = f.pilot.missions;
      this.html(
        this.jobsEl,
        jobs.length
          ? `<div class="count">${jobs.length} contrat${jobs.length > 1 ? 's' : ''} en cours</div>` +
              jobs.map((m) => `<div class="job k-${m.kind}"><b>${esc(missionTitle(m))}</b><span>${esc(missionStatus(m))}</span></div>`).join('')
          : '',
      );
      this.holdTxt.textContent = `${used} / ${f.pilot.capacity}`;
      this.holdBox.classList.toggle('full', used >= f.pilot.capacity);
      this.holdBar.style.transform = `scaleX(${f.pilot.capacity ? used / f.pilot.capacity : 0})`;
    }

    const docked = !!f.pilot?.docked;
    this.root.classList.toggle('docked', docked);
    this.jumpLine(f, docked);
    this.death.classList.toggle('show', !me && !docked && !f.jumping);
    if (!me && !docked && !f.jumping) {
      this.deathTimer.textContent = `Réapparition à la station dans ${Math.ceil(f.respawnIn)} s`;
    }

    this.hitTimer -= dt;
    this.fireTimer -= dt;
    this.hitMarkerTimer -= dt;
    this.killTimer -= dt;
    this.crosshair.classList.toggle('hit', this.hitTimer > 0);
    this.crosshair.classList.toggle('firing', this.fireTimer > 0);
    this.hitMarker.style.display = this.hitMarkerTimer > 0 ? '' : 'none';
    this.killEl.style.display = this.killTimer > 0 ? '' : 'none';
    this.killEl.style.opacity = String(Math.min(1, this.killTimer * 2));
    this.damage = Math.max(0, this.damage - dt * 1.4);
    this.shieldFx = Math.max(0, this.shieldFx - dt * 2.5);
    this.vignette.style.opacity = String(this.damage + (me && me.snap.hull < statsOfPacked(me.snap.classId, me.snap.u).hull * 0.3 ? 0.25 + 0.15 * Math.sin(performance.now() / 150) : 0));
    this.shieldFlash.style.opacity = String(this.shieldFx);

    // Virtual cursor
    const cx = W / 2 + f.cursor.x * Math.min(W, H) * 0.32;
    const cy = H / 2 + f.cursor.y * Math.min(W, H) * 0.32;

    this.components(me?.snap.d, me ? me.snap.hull / statsOfPacked(me.snap.classId, me.snap.u).hull : 1, dt, !!me && !docked);

    if (!me) {
      // Destroyed: the last state we drew can predate the blow (one violent crash from full hull).
      if (!docked && !f.jumping) {
        this.shieldTxt.textContent = this.hullTxt.textContent = '0%';
        for (let i = 0; i < SEGMENTS; i++) {
          this.shieldSeg.children[i].classList.remove('on');
          this.hullSeg.children[i].classList.remove('on');
        }
      }
      this.crosshair.style.display = this.cursorEl.style.display = this.lead.style.display = this.bracket.style.display = this.arrow.style.display = 'none';
      this.cursorLine.setAttribute('x1', '0');
      this.cursorLine.setAttribute('x2', '0');
      this.cursorLine.setAttribute('y1', '0');
      this.cursorLine.setAttribute('y2', '0');
      for (const m of this.markers.values()) m.style.display = 'none';
      for (const m of this.stationMarkers) m.style.display = 'none';
      this.dockMarker.style.display = this.miningEl.style.display = 'none';
      this.setPrompt('');
      return;
    }
    const cls = statsOfPacked(me.snap.classId, me.snap.u);

    // Gun crosshair: where the nose points, 600 m ahead.
    _q.copy(me.rotation);
    const aim = new THREE.Vector3(0, 0, -600).applyQuaternion(_q).add(me.position);
    this.project(aim, f.camera, pt);
    this.crosshair.style.display = '';
    this.crosshair.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
    this.hitMarker.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
    this.killEl.style.transform = `translate(${pt.x}px, ${pt.y + 44}px)`;
    this.cursorEl.style.display = '';
    this.cursorEl.style.transform = `translate(${cx}px, ${cy}px)`;
    this.cursorLine.setAttribute('x1', String(W / 2));
    this.cursorLine.setAttribute('y1', String(H / 2));
    this.cursorLine.setAttribute('x2', String(cx));
    this.cursorLine.setAttribute('y2', String(cy));

    // Flight panel
    const speed = me.velocity.length();
    this.speedEl.textContent = speed.toFixed(0);
    // Forward throttle fills from the zero tick upward, reverse fills back down from it.
    const t = me.snap.boosting ? 1 : f.input.throttle;
    const a = THROTTLE_ZERO * 100;
    const from = t >= 0 ? a : a + t / 0.4 * a;
    const len = t >= 0 ? t * (100 - a) : a - from;
    this.throttleFill.setAttribute('stroke-dasharray', `0 ${from.toFixed(2)} ${len.toFixed(2)} 100`);
    this.throttleFill.classList.toggle('reverse', t < 0);
    this.gauge.classList.toggle('boost', me.snap.boosting);
    this.html(this.chips,
      `<span class="chip ${f.input.flightAssist ? 'on' : 'off'}">${f.input.flightAssist ? 'ASSIST. VOL' : 'NEWTONIEN'}</span>` +
      (me.snap.boosting ? '<span class="chip boost">BOOST</span>' : '') +
      (me.snap.pvp ? '<span class="chip pvp">⚔ PvP</span>' : '') +
      (me.snap.weaponsLocked
        ? '<span class="chip off">⚠ ÉNERGIE ÉPUISÉE · RECHARGE</span>'
        : me.snap.energy < cls.energy * 0.2
          ? '<span class="chip off">⚠ ÉNERGIE BASSE</span>'
          : '') +
      `<span class="chip">${(f.input.throttle * 100).toFixed(0)}%</span>`);

    // Status panel
    const sFrac = me.snap.shield / cls.shield;
    const hFrac = me.snap.hull / cls.hull;
    const segs = (seg: HTMLDivElement, frac: number) => {
      const on = Math.ceil(frac * SEGMENTS - 0.001);
      for (let i = 0; i < SEGMENTS; i++) seg.children[i].classList.toggle('on', i < on);
    };
    segs(this.shieldSeg, sFrac);
    segs(this.hullSeg, hFrac);
    this.hullSeg.classList.toggle('crit', hFrac < 0.3);
    this.hullStat.classList.toggle('crit', hFrac < 0.3);
    this.shieldTxt.textContent = `${Math.round(sFrac * 100)}%`;
    this.hullTxt.textContent = `${hFrac < 0.3 ? '⚠ CRITIQUE ' : ''}${Math.round(hFrac * 100)}%`;
    this.energyBar.style.transform = `scaleX(${me.snap.energy / cls.energy})`;

    // Ship markers
    const seen = new Set<number>();
    for (const s of f.ships.values()) {
      if (s.snap.id === me.snap.id) continue;
      seen.add(s.snap.id);
      const hostile = isHostile(me.snap, s.snap);
      const pilot = s.snap.owner !== null ? f.players.get(s.snap.id) : undefined;
      const kind = hostile ? 'hostile' : s.snap.owner !== null ? 'player' : 'friend';
      let m = this.markers.get(s.snap.id);
      if (!m) {
        m = this.makeMarker(kind);
        this.markers.set(s.snap.id, m);
      }
      if (m.dataset.kind !== kind) {
        m.className = `abs marker ${kind}`;
        m.dataset.kind = kind;
      }
      const dist = s.position.distanceTo(me.position);
      this.project(s.position, f.camera, pt);
      // Other pilots stay labelled even when targeted, so their name is always readable.
      const visible = pt.front && pt.x > -20 && pt.x < W + 20 && pt.y > -20 && pt.y < H + 20 && (s.snap.id !== f.targetId || s.snap.owner !== null);
      m.style.display = visible ? '' : 'none';
      if (visible) {
        m.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
        const d = dist > 150 ? `${dist < 1000 ? dist.toFixed(0) + ' m' : (dist / 1000).toFixed(1) + ' km'}` : '';
        const label =
          s.snap.owner !== null
            ? `${s.snap.pvp ? '⚔ ' : ''}${s.snap.name}${pilot && !pilot.online ? ' (déconnecté)' : ''}${d ? ' · ' + d : ''}`
            : d;
        (m.lastChild as HTMLElement).textContent = label;
      }
    }
    for (const [id, m] of this.markers) {
      if (!seen.has(id)) {
        m.remove();
        this.markers.delete(id);
      }
    }
    // Station marker
    f.stations.forEach((st, i) => {
      const m = (this.stationMarkers[i] ??= this.makeMarker('station'));
      const sd = st.position.distanceTo(me.position);
      this.project(st.position, f.camera, pt);
      // Near a hangar the docking marker takes over.
      const near = f.dock && f.dock.name === st.name && f.dock.distance < 3000;
      m.style.display = pt.front && !near ? '' : 'none';
      m.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
      (m.lastChild as HTMLElement).textContent = `${st.name} · ${(sd / 1000).toFixed(1)} km`;
    });

    this.dockGuide(f, pt);
    this.jumpPrompt(f);
    this.miningReadout(f, pt);

    // Target
    const target = f.targetId !== null ? f.ships.get(f.targetId) : undefined;
    this.bracket.style.display = 'none';
    this.lead.style.display = 'none';
    this.arrow.style.display = 'none';
    if (target) {
      const tcls = statsOfPacked(target.snap.classId, target.snap.u);
      const dist = target.position.distanceTo(me.position);
      const hostile = isHostile(me.snap, target.snap);
      this.project(target.position, f.camera, pt);
      const onScreen = pt.front && pt.x > 0 && pt.x < W && pt.y > 0 && pt.y < H;
      if (onScreen) {
        const size = Math.max(34, Math.min(220, ((tcls.radius * 2.6) / Math.max(dist, 1)) * (H / (2 * Math.tan((f.camera.fov * Math.PI) / 360)))));
        this.bracket.style.display = '';
        this.bracket.classList.toggle('friendly', !hostile);
        this.bracket.style.width = this.bracket.style.height = `${size}px`;
        this.bracket.style.transform = `translate(${pt.x - size / 2}px, ${pt.y - size / 2}px)`;
        this.html(this.bracketInfo,
          `<b>${hostile ? 'HOSTILE' : target.snap.owner !== null ? 'PILOTE' : 'ALLIÉ'} · ${tcls.label.toUpperCase()}</b>${esc(target.snap.name)} — ${dist < 1000 ? dist.toFixed(0) + ' m' : (dist / 1000).toFixed(2) + ' km'}` +
          `<div class="bars"><div class="bar s"><i style="transform:scaleX(${target.snap.shield / tcls.shield})"></i></div><div class="bar h"><i style="transform:scaleX(${target.snap.hull / tcls.hull})"></i></div></div>`);
      } else {
        // Edge arrow pointing toward the off-screen target.
        _w.copy(target.position).applyMatrix4(f.camera.matrixWorldInverse);
        const ang = Math.atan2(-_w.y, _w.x);
        const r = Math.min(W, H) * 0.42;
        const ax = W / 2 + Math.cos(ang) * r;
        const ay = H / 2 + Math.sin(ang) * r;
        this.arrow.style.display = '';
        this.arrow.style.borderBottomColor = hostile ? '' : 'var(--friend)';
        this.arrow.style.transform = `translate(${ax}px, ${ay}px) rotate(${ang + Math.PI / 2}rad)`;
      }
      if (hostile && dist < 3000) {
        const lp = interceptPoint(me.position, me.velocity, target.position, target.velocity, cls.weapon.speed);
        if (lp) {
          this.project(lp, f.camera, pt);
          if (pt.front) {
            this.lead.style.display = '';
            const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(me.rotation);
            const aligned = fwd.dot(lp.clone().sub(me.position).normalize()) > 0.9985;
            this.lead.classList.toggle('aligned', aligned);
            this.lead.style.transform = `translate(${pt.x}px, ${pt.y}px) rotate(45deg)`;
          }
        }
      }
    }

    this.drawRadar(f, me);
  }

  private setPrompt(html: string, tone = '') {
    this.html(this.prompt, html);
    this.prompt.className = `prompt${html ? ' show' : ''}${tone ? ' ' + tone : ''}`;
  }

  /** Hangar mouth marker from 3 km, and what to do once close. */
  private dockGuide(f: HudFrame, pt: { x: number; y: number; front: boolean }) {
    const g = f.dock;
    this.dockMarker.style.display = 'none';
    if (!g || g.distance > 3000) {
      this.setPrompt('');
      return;
    }
    this.project(g.mouth, f.camera, pt);
    if (pt.front) {
      this.dockMarker.style.display = '';
      this.dockMarker.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
      (this.dockMarker.lastChild as HTMLElement).textContent = `${g.name.replace(/^Station\s+/, '')} · amarrage · ${g.distance < 1000 ? g.distance.toFixed(0) + ' m' : (g.distance / 1000).toFixed(1) + ' km'}`;
    }
    const k = `<kbd>${esc(this.keys.dock)}</kbd>`;
    if (g.inZone && g.speed <= g.maxSpeed) this.setPrompt(`<b>Zone d'amarrage</b> ${k} s'amarrer à ${esc(g.name)}`, 'good');
    else if (g.inZone) this.setPrompt(`<b>Ralentissez</b> ${g.speed.toFixed(0)} m/s, maximum ${g.maxSpeed} pour s'amarrer`, 'warn');
    else if (g.distance < 900) this.setPrompt(`Entrez lentement dans le hangar pour vous amarrer · ${g.distance.toFixed(0)} m`);
    else this.setPrompt('');
  }

  /** Under the sector name: whether the drive can jump from here, and how. */
  private jumpLine(f: HudFrame, docked: boolean) {
    const j = f.jump;
    const k = `<kbd>${esc(this.keys.jump)}</kbd>`;
    let line = '';
    let ready = false;
    if (j && f.me && !docked && j.left === null) {
      const to = esc(j.to.replace(/^Secteur\s+/, ''));
      if (j.cooldown > 0) line = `Réacteur hyperspatial : recharge ${Math.ceil(j.cooldown)} s`;
      else if (!j.clear) line = `Saut vers ${to} : à plus de ${String(JUMP_CLEARANCE / 1000).replace('.', ',')} km des stations`;
      else {
        line = `${k} saut hyperspatial vers ${to}`;
        ready = true;
      }
    }
    this.html(this.jumpEl, line);
    this.jumpEl.classList.toggle('ready', ready);
    // The edges of the screen close in while the drive charges.
    const charging = !!j && j.left !== null && !!f.me;
    if (charging) {
      this.warpEl.classList.remove('flash', 'reveal');
      this.warpEl.classList.add('charging');
      this.warpEl.style.setProperty('--c', (1 - j!.left! / JUMP_CHARGE).toFixed(3));
    } else this.warpEl.classList.remove('charging');
  }

  /** While charging: the countdown in the middle of the screen. */
  private jumpPrompt(f: HudFrame) {
    const j = f.jump;
    if (!j || j.left === null || this.prompt.classList.contains('show')) return;
    const p = Math.min(1, Math.max(0, 1 - j.left / JUMP_CHARGE));
    this.setPrompt(
      `<b>Saut hyperspatial</b> vers ${esc(j.to)} · ${j.left.toFixed(1).replace('.', ',')} s` +
        `<div class="bar j"><i style="transform:scaleX(${p.toFixed(3)})"></i></div><kbd>${esc(this.keys.jump)}</kbd> annuler`,
      'jump',
    );
  }

  /** Under the reticle: the rock under the beam, its ore and why the beam does nothing. */
  private miningReadout(f: HudFrame, pt: { x: number; y: number; front: boolean }) {
    const m = f.mining;
    if (!m || !f.me) {
      this.miningEl.style.display = 'none';
      return;
    }
    // Docking advice wins over the mining hint.
    if (m.state === 'aim' && this.prompt.classList.contains('show')) {
      this.miningEl.style.display = 'none';
      return;
    }
    _q.copy(f.me.rotation);
    this.project(_v.set(0, 0, -600).applyQuaternion(_q).add(f.me.position), f.camera, pt);
    this.miningEl.style.display = '';
    this.miningEl.style.transform = `translate(${pt.x + 34}px, ${pt.y + 26}px)`;
    const rock = m.ore ? `<b>${esc(m.ore.toUpperCase())}</b> · ${m.richness} · ${m.distance.toFixed(0)} m` : '';
    const k = `<kbd>${esc(this.keys.mine)}</kbd>`;
    const line = {
      active: `Extraction · ${m.rate.toFixed(1).replace('.', ',')} u/s<div class="bar o"><i style="transform:scaleX(${m.progress.toFixed(2)})"></i></div>`,
      aim: `${k} ou clic droit : miner`,
      fire: '<span class="w">Rayon coupé pendant le tir</span>',
      speed: '<span class="w">Trop rapide pour miner (60 m/s max)</span>',
      none: '<span class="w">Aucun astéroïde à moins de 300 m</span>',
      full: '<span class="w">Soute pleine : vendez à une station</span>',
    }[m.state];
    this.html(this.miningEl, `${rock}<div>${line}</div>`);
    this.miningEl.classList.toggle('on', m.state === 'active');
  }

  private drawRadar(f: HudFrame, me: InterpolatedShip) {
    const ctx = this.radarCtx;
    const W = this.radar.width;
    const H = this.radar.height;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2 + 10;
    const rx = W * 0.44;
    const ry = H * 0.36;
    const range = 4000;
    // A tinted disc that fades to the rim instead of a box, then range rings and rim ticks.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    const bg = ctx.createRadialGradient(0, 0, rx * 0.1, 0, 0, rx * 1.06);
    bg.addColorStop(0, 'rgba(10,30,48,0.62)');
    bg.addColorStop(0.85, 'rgba(6,16,28,0.5)');
    bg.addColorStop(1, 'rgba(6,16,28,0)');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(0, 0, rx * 1.06, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 1.5;
    for (const k of [1, 0.66, 0.33]) {
      ctx.strokeStyle = `rgba(143,233,255,${k === 1 ? 0.4 : 0.14})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * k, ry * k, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(143,233,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const l = i % 6 === 0 ? 0.9 : 0.95;
      ctx.moveTo(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
      ctx.lineTo(cx + Math.cos(a) * rx * l, cy + Math.sin(a) * ry * l);
    }
    ctx.stroke();
    // view cone
    const cone = ctx.createLinearGradient(0, cy, 0, cy - ry);
    cone.addColorStop(0, 'rgba(143,233,255,0.16)');
    cone.addColorStop(1, 'rgba(143,233,255,0)');
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - rx * 0.55, cy - ry);
    ctx.lineTo(cx + rx * 0.55, cy - ry);
    ctx.fill();

    const inv = _q.copy(me.rotation).invert();
    const plot = (p: THREE.Vector3, color: string, size: number, isTarget: boolean, shape: 'circle' | 'square' | 'diamond' | 'triangle' = 'circle') => {
      _v.copy(p).sub(me.position).applyQuaternion(inv);
      const d = _v.length();
      let scale = 1 / range;
      if (d > range) scale = 1 / d; // clamp to the rim
      const x = cx + _v.x * scale * rx;
      const y = cy + _v.z * scale * ry;
      const h = -_v.y * scale * ry * 1.2;
      ctx.strokeStyle = color;
      ctx.globalAlpha = d > range ? 0.45 : 1;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + h);
      ctx.stroke();
      ctx.fillStyle = color;
      if (shape === 'square') ctx.fillRect(x - size, y + h - size, size * 2, size * 2);
      else if (shape === 'triangle') {
        const s = size * 1.4;
        ctx.beginPath();
        ctx.moveTo(x, y + h - s);
        ctx.lineTo(x + s, y + h + s * 0.8);
        ctx.lineTo(x - s, y + h + s * 0.8);
        ctx.fill();
      }
      else if (shape === 'diamond') {
        const s = size * 1.35;
        ctx.beginPath();
        ctx.moveTo(x, y + h - s);
        ctx.lineTo(x + s, y + h);
        ctx.lineTo(x, y + h + s);
        ctx.lineTo(x - s, y + h);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(x, y + h, size, 0, Math.PI * 2);
        ctx.fill();
      }
      if (isTarget) {
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(x - size - 4, y + h - size - 4, size * 2 + 8, size * 2 + 8);
      }
      ctx.globalAlpha = 1;
    };
    for (const st of f.stations) plot(st.position, '#7fe3ff', 6, false, 'square');
    for (const s of f.ships.values()) {
      if (s.snap.id === me.snap.id) continue;
      const hostile = isHostile(me.snap, s.snap);
      const player = s.snap.owner !== null;
      plot(
        s.position,
        hostile ? '#ff6a4d' : player ? '#d4b8ff' : '#5cffb0',
        s.snap.classId === 'marauder' ? 6 : player ? 5 : 4,
        s.snap.id === f.targetId,
        hostile ? 'diamond' : player ? 'triangle' : 'circle',
      );
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 7);
    ctx.lineTo(cx - 5, cy + 5);
    ctx.lineTo(cx + 5, cy + 5);
    ctx.fill();
  }
}
