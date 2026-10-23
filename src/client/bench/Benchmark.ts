import * as THREE from 'three';
import { mulberry32 } from '../../shared/rng';
import { SHIP_CLASSES } from '../../shared/sim/shipClasses';
import type { FactionId, ShipClassId } from '../../shared/sim/types';
import type { Effects } from '../render/Effects';
import type { Lasers } from '../render/Lasers';
import { QUALITY, type QualityLevel } from '../render/quality';
import { ShipView } from '../render/ShipView';
import { estimateRefresh, summarize, type BenchReport, type FrameSample, type LevelResult } from './report';

/** What the benchmark needs from the game: its scene, renderer and world. */
export interface BenchHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  lasers: Lasers;
  effects: Effects;
  stationPos: THREE.Vector3;
  setQuality(level: QualityLevel): void;
  pixelRatio(): number;
  renderPath(): string;
  gpuName(): string;
  /** Sky, station, planets, asteroids, bolts, particles and dust for this frame. */
  animateWorld(time: number, dt: number, camPos: THREE.Vector3, camVel: THREE.Vector3): void;
  render(): void;
}

export interface BenchCallbacks {
  onProgress(text: string): void;
  onDone(report: BenchReport): void;
}

/** Unmeasured seconds at the start of each level: shaders, sky bake, buffers. */
const WARMUP = 3;
const SEGMENTS = [
  { id: 'station', label: 'Station', duration: 9 },
  { id: 'combat', label: 'Combat (poursuite)', duration: 9 },
  { id: 'overview', label: "Vue d'ensemble", duration: 9 },
] as const;
const RUN = SEGMENTS.reduce((s, x) => s + x.duration, 0);
/** After the last level, frames keep coming briefly so pending GPU timings arrive. */
const FLUSH = 0.4;

/** The fight: clear of the station ring and of the belt, with both in view. */
const FIGHT = new THREE.Vector3(-900, 150, 900);
const UNION_BOLT = new THREE.Color(1.5, 4, 9);
const RAIDER_BOLT = new THREE.Color(9, 2.2, 0.8);
const UNION_SHIELD = new THREE.Color(0.6, 1.6, 4);
const RAIDER_SHIELD = new THREE.Color(4, 1.2, 0.5);
/** Wingmen in the leader's frame (x right, y up, z behind). */
const WING = [new THREE.Vector3(-22, -2, 6), new THREE.Vector3(22, -2, 6), new THREE.Vector3(0, 9, -45)];

type Mode = 'station' | 'combat' | 'overview';

interface Pilot {
  view: ShipView;
  cls: ShipClassId;
  faction: FactionId;
  centre: THREE.Vector3;
  radius: number;
  speed: number;
  dir: number;
  phase: number;
  tilt: THREE.Quaternion;
  target: number;
  interval: number;
  burstPhase: number;
  nextShot: number;
  gun: number;
  hiddenUntil: number;
  damaged: boolean;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  vel: THREE.Vector3;
  turn: number;
}

interface Impact {
  time: number;
  target: number;
  from: THREE.Vector3;
  hull: boolean;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** Nose (-Z) along `vel`, banked toward `up`. */
function orient(out: THREE.Quaternion, vel: THREE.Vector3, up: THREE.Vector3) {
  const fwd = _a.copy(vel).normalize();
  const right = _b.crossVectors(fwd, up).normalize();
  const u = _c.crossVectors(right, fwd);
  _m.makeBasis(right, u, fwd.negate());
  out.setFromRotationMatrix(_m);
}

/**
 * A fixed, repeatable combat scene rendered for about 30 s per quality level,
 * measuring frame times, JavaScript time, GPU time (when the browser has timer
 * queries), draw calls and triangles. Nothing is simulated or sent to a
 * server: every ship follows a scripted path, every shot is scheduled, so two
 * runs on the same machine draw the same frames.
 */
export class Benchmark {
  private pilots: Pilot[] = [];
  private impacts: Impact[] = [];
  private levelIndex = -1;
  private t = 0;
  private prevTs: number | null = null;
  private samples: FrameSample[][][] = [];
  private gpu: number[][][] = [];
  private intervals: number[] = [];
  private results: { level: QualityLevel; renderPath: string; pixelRatio: number; width: number; height: number }[] = [];
  private boltId = 1_000_000;
  private shots = 0;
  private nextExplosion = 1;
  private explodeIndex = 0;
  private flushIn = -1;
  private done = false;
  private lastMode: Mode | null = null;
  private progressIn = 0;
  private camVel = new THREE.Vector3();
  private rng = mulberry32(2026);
  private timer: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private pending: { q: WebGLQuery; level: number; seg: number }[] = [];
  /** Shader programs linked so far, and during each level's measured scenes. */
  private links = 0;
  private compiles: number[] = [];
  private unhook: (() => void) | null = null;

  constructor(
    private host: BenchHost,
    private levels: QualityLevel[],
    private cb: BenchCallbacks,
  ) {
    const gl = host.renderer.getContext();
    if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    // Count every pass of a frame, not only the last one.
    host.renderer.info.autoReset = false;
    // A shader compiled during the measure is a stall a player would feel.
    const link = gl.linkProgram;
    gl.linkProgram = (p: WebGLProgram) => {
      this.links++;
      link.call(gl, p);
    };
    this.unhook = () => {
      gl.linkProgram = link;
    };
    this.spawn();
  }

  private spawn() {
    const roster: [ShipClassId, FactionId][] = [
      ['falcon', 'union'],
      ['falcon', 'union'],
      ['warden', 'union'],
      ['warden', 'union'],
      ...Array.from({ length: 3 }, (): [ShipClassId, FactionId] => ['falcon', 'union']),
      ...Array.from({ length: 3 }, (): [ShipClassId, FactionId] => ['warden', 'union']),
      ...Array.from({ length: 11 }, (): [ShipClassId, FactionId] => ['raider', 'raiders']),
      ...Array.from({ length: 3 }, (): [ShipClassId, FactionId] => ['marauder', 'raiders']),
    ];
    const r = this.rng;
    const union = roster.map((x, i) => (x[1] === 'union' ? i : -1)).filter((i) => i >= 0);
    const pirates = roster.map((x, i) => (x[1] === 'raiders' ? i : -1)).filter((i) => i >= 0);
    roster.forEach(([cls, faction], i) => {
      const heavy = cls === 'marauder';
      const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler((r() - 0.5) * 0.7, r() * Math.PI * 2, (r() - 0.5) * 0.7));
      const enemies = faction === 'union' ? pirates : union;
      const view = new ShipView(cls, this.host.scene, i === 0);
      const p: Pilot = {
        view,
        cls,
        faction,
        centre: new THREE.Vector3((r() - 0.5) * 260, (r() - 0.5) * 120, (r() - 0.5) * 260).add(FIGHT),
        radius: heavy ? 160 + r() * 60 : 70 + r() * 160,
        speed: heavy ? 38 + r() * 10 : 60 + r() * 45,
        dir: r() < 0.5 ? -1 : 1,
        phase: r() * Math.PI * 2,
        tilt,
        target: enemies[(i * 7) % enemies.length],
        interval: heavy ? 0.3 : 0.16 + r() * 0.1,
        burstPhase: r() * 2.6,
        nextShot: 0,
        gun: 0,
        hiddenUntil: -1,
        damaged: i === 5 || i === 13 || i === 19,
        pos: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        vel: new THREE.Vector3(),
        turn: 0,
      };
      if (p.damaged) view.setDamage(0.75);
      this.pilots.push(p);
    });
  }

  private mode(): Mode {
    if (this.t < WARMUP) return 'overview';
    let s = this.t - WARMUP;
    for (const seg of SEGMENTS) {
      if (s < seg.duration) return seg.id;
      s -= seg.duration;
    }
    return 'overview';
  }

  /** Index of the measured segment, or -1 during warm-up and flush. */
  private segment() {
    if (this.t < WARMUP || this.t >= WARMUP + RUN) return -1;
    let s = this.t - WARMUP;
    for (let i = 0; i < SEGMENTS.length; i++) {
      if (s < SEGMENTS[i].duration) return i;
      s -= SEGMENTS[i].duration;
    }
    return -1;
  }

  private orbit(p: Pilot, t: number) {
    const w = (p.speed / p.radius) * p.dir;
    const th = p.phase + w * t;
    p.pos.set(Math.cos(th) * p.radius, 0, Math.sin(th) * p.radius).applyQuaternion(p.tilt).add(p.centre);
    p.vel.set(-Math.sin(th) * p.speed * p.dir, 0, Math.cos(th) * p.speed * p.dir).applyQuaternion(p.tilt);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(p.tilt);
    const inward = new THREE.Vector3().subVectors(p.centre, p.pos).normalize();
    up.addScaledVector(inward, Math.min(0.9, (p.speed * p.speed) / (p.radius * 40)));
    orient(p.quat, p.vel, up);
    p.turn = w;
  }

  /** A path given by position over time; velocity and banking from its derivatives. */
  private path(p: Pilot, t: number, at: (t: number, out: THREE.Vector3) => THREE.Vector3) {
    const h = 1 / 120;
    const p0 = at(t - h, new THREE.Vector3());
    const p2 = at(t + h, new THREE.Vector3());
    at(t, p.pos);
    p.vel.subVectors(p2, p0).divideScalar(2 * h);
    const acc = p2.add(p0).addScaledVector(p.pos, -2).divideScalar(h * h);
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(acc, 1 / 40);
    orient(p.quat, p.vel, up);
    p.turn = 0;
  }

  private leadAt = (t: number, out: THREE.Vector3) => {
    const w = 0.22;
    return out.set(300 * Math.sin(w * t), 30 * Math.sin(2 * w * t + 0.5), 200 * Math.sin(2 * w * t)).add(FIGHT);
  };

  private stationAt = (t: number, out: THREE.Vector3) => {
    const th = 2.6 - 0.17 * (t - WARMUP);
    return out.set(Math.cos(th) * 750, 60, Math.sin(th) * 750).add(this.host.stationPos);
  };

  private place(mode: Mode) {
    const t = this.t;
    const lead = this.pilots[0];
    if (mode === 'station') this.path(lead, t, this.stationAt);
    else this.path(lead, t, this.leadAt);
    for (let i = 1; i < this.pilots.length; i++) {
      const p = this.pilots[i];
      if (mode === 'station' && i <= WING.length) {
        p.pos.copy(WING[i - 1]).applyQuaternion(lead.quat).add(lead.pos);
        p.quat.copy(lead.quat);
        p.vel.copy(lead.vel);
        p.turn = 0;
      } else this.orbit(p, t);
    }
    // A cut between scenes: the moved ships must not drag a contrail across.
    if (this.lastMode !== null && this.lastMode !== mode) for (let i = 0; i <= WING.length; i++) this.pilots[i].view.teleported();
    this.lastMode = mode;
  }

  private fire(mode: Mode) {
    const t = this.t;
    const fx = this.host.effects;
    this.pilots.forEach((p, i) => {
      // The formation in front of the station is not fighting.
      const flying = mode === 'station' && i <= WING.length;
      const target = this.pilots[p.target];
      if (p.nextShot > t) return;
      if (flying || p.hiddenUntil > t || target.hiddenUntil > t || (t + p.burstPhase) % 2.6 > 1.5) {
        p.nextShot = t + p.interval;
        return;
      }
      const weapon = SHIP_CLASSES[p.cls].weapon;
      while (p.nextShot <= t) {
        const t0 = p.nextShot;
        p.nextShot += p.interval;
        const hp = weapon.hardpoints[p.gun++ % weapon.hardpoints.length];
        const muzzle = new THREE.Vector3(...hp).applyQuaternion(p.quat).add(p.pos);
        const dist = muzzle.distanceTo(target.pos);
        const hit = this.shots++ % 3 === 0;
        const aim = target.pos.clone().addScaledVector(target.vel, dist / weapon.speed);
        if (!hit) aim.add(new THREE.Vector3(this.rng() - 0.5, this.rng() - 0.5, this.rng() - 0.5).multiplyScalar(40));
        const vel = aim.sub(muzzle).normalize().multiplyScalar(weapon.speed);
        this.host.lasers.add(this.boltId++, p.faction, [muzzle.x, muzzle.y, muzzle.z], [vel.x, vel.y, vel.z], t0, hit ? dist / weapon.speed : 1.2);
        fx.muzzle(muzzle, p.vel.clone().multiplyScalar(0.05), p.faction === 'union' ? UNION_BOLT : RAIDER_BOLT, false);
        if (hit) this.impacts.push({ time: t0 + dist / weapon.speed, target: p.target, from: muzzle, hull: this.shots % 4 === 1 });
      }
    });
    for (let k = this.impacts.length - 1; k >= 0; k--) {
      const imp = this.impacts[k];
      if (imp.time > t) continue;
      this.impacts.splice(k, 1);
      const tg = this.pilots[imp.target];
      if (tg.hiddenUntil > t) continue;
      const dir = new THREE.Vector3().subVectors(tg.pos, imp.from).normalize();
      if (imp.hull) {
        const point = tg.pos.clone().addScaledVector(dir, -2);
        tg.view.hullHit(point);
        fx.hullHit(point);
      } else {
        const point = tg.pos.clone().addScaledVector(dir, -tg.view.model.shieldScale.z * 0.7);
        tg.view.shieldHit(point, t);
        fx.shieldSparks(point, tg.faction === 'union' ? UNION_SHIELD : RAIDER_SHIELD);
      }
    }
  }

  /** Every 2.4 s in the fight a pirate blows up; it comes back 3.5 s later. */
  private explosions(mode: Mode) {
    const t = this.t;
    for (const p of this.pilots) {
      if (p.hiddenUntil > 0 && p.hiddenUntil <= t) {
        p.hiddenUntil = -1;
        p.view.setVisible(true);
      }
    }
    if (mode === 'station' || t < this.nextExplosion) return;
    this.nextExplosion = t + 2.4;
    const pirates = this.pilots.filter((p) => p.faction === 'raiders');
    for (let k = 0; k < pirates.length; k++) {
      const p = pirates[this.explodeIndex++ % pirates.length];
      if (p.hiddenUntil > t) continue;
      this.host.effects.explosion(p.pos, p.cls === 'marauder' ? 1.6 : 1, p.vel.clone().multiplyScalar(0.3));
      p.hiddenUntil = t + 3.5;
      p.view.setVisible(false);
      break;
    }
  }

  private camera(mode: Mode) {
    const cam = this.host.camera;
    const lead = this.pilots[0];
    if (mode === 'overview') {
      const a = 0.6 + 0.06 * this.t;
      if (cam.fov !== 55) {
        cam.fov = 55;
        cam.updateProjectionMatrix();
      }
      cam.position.set(Math.cos(a) * 520, 170, Math.sin(a) * 520).add(FIGHT);
      cam.up.set(0, 1, 0);
      cam.lookAt(FIGHT);
      this.camVel.set(0, 0, 0);
    } else {
      if (cam.fov !== 62) {
        cam.fov = 62;
        cam.updateProjectionMatrix();
      }
      cam.position.set(0, 7, 38).applyQuaternion(lead.quat).add(lead.pos);
      cam.up.set(0, 1, 0).applyQuaternion(lead.quat);
      cam.lookAt(new THREE.Vector3(0, 0, -70).applyQuaternion(lead.quat).add(lead.pos));
      this.camVel.copy(lead.vel);
    }
    cam.updateMatrixWorld();
  }

  private startLevel() {
    this.levelIndex++;
    if (this.levelIndex >= this.levels.length) {
      this.flushIn = FLUSH;
      return;
    }
    const level = this.levels[this.levelIndex];
    this.host.setQuality(level);
    this.samples[this.levelIndex] = SEGMENTS.map(() => []);
    this.compiles[this.levelIndex] = 0;
    this.gpu[this.levelIndex] = SEGMENTS.map(() => []);
    // Every level replays the same scene from the start.
    this.t = 0;
    this.nextExplosion = 1;
    this.explodeIndex = 0;
    this.shots = 0;
    this.impacts.length = 0;
    this.rng = mulberry32(2026);
    this.host.lasers.clear();
    for (const p of this.pilots) {
      p.nextShot = 0;
      p.gun = 0;
      if (p.hiddenUntil > 0) p.view.setVisible(true);
      p.hiddenUntil = -1;
    }
  }

  private pollGpu() {
    if (!this.timer || !this.pending.length) return;
    const gl = this.host.renderer.getContext() as WebGL2RenderingContext;
    const disjoint = gl.getParameter(this.timer.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const head = this.pending[0];
      if (!gl.getQueryParameter(head.q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) this.gpu[head.level][head.seg].push(gl.getQueryParameter(head.q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(head.q);
      this.pending.shift();
    }
  }

  /** One frame, from requestAnimationFrame's timestamp. */
  frame(timestamp: number) {
    if (this.done) return;
    const cpu0 = performance.now();
    const interval = this.prevTs === null ? 1000 / 60 : timestamp - this.prevTs;
    this.prevTs = timestamp;
    const dt = Math.min(Math.max(interval, 0) / 1000, 0.1);
    this.pollGpu();

    if (this.flushIn >= 0) {
      this.flushIn -= dt;
      if (this.flushIn < 0 || !this.pending.length) return this.finish();
    } else if (this.levelIndex < 0 || this.t >= WARMUP + RUN) {
      if (this.levelIndex >= 0) this.results.push(this.levelInfo());
      this.startLevel();
      if (this.flushIn >= 0) return;
    }
    if (this.flushIn < 0) this.t += dt;
    const mode = this.mode();
    const seg = this.flushIn >= 0 ? -1 : this.segment();

    this.place(mode);
    this.fire(mode);
    this.explosions(mode);
    this.camera(mode);
    const camPos = this.host.camera.position;
    const fx = this.host.effects;
    for (const p of this.pilots) {
      if (p.hiddenUntil > this.t) continue;
      p.view.group.position.copy(p.pos);
      p.view.group.quaternion.copy(p.quat);
      p.view.update(dt, this.t, 0.75, false, camPos, [0.15 * p.turn, p.turn, 0.4 * p.turn]);
      if (p.damaged) fx.damageTrail(new THREE.Vector3(0, 0, p.view.model.shieldScale.z * 0.4).applyQuaternion(p.quat).add(p.pos), p.vel, 0.5);
    }
    this.host.animateWorld(this.t, dt, camPos, this.camVel);

    const gl = this.host.renderer.getContext() as WebGL2RenderingContext;
    const timing = this.timer && seg >= 0 && this.pending.length < 8;
    let q: WebGLQuery | null = null;
    if (timing) {
      q = gl.createQuery();
      if (q) gl.beginQuery(this.timer!.TIME_ELAPSED_EXT, q);
    }
    this.host.renderer.info.reset();
    const links = this.links;
    this.host.render();
    if (seg >= 0) this.compiles[this.levelIndex] += this.links - links;
    if (q) {
      gl.endQuery(this.timer!.TIME_ELAPSED_EXT);
      this.pending.push({ q, level: this.levelIndex, seg });
    }
    const cpu = performance.now() - cpu0;
    if (seg >= 0) {
      const info = this.host.renderer.info.render;
      this.samples[this.levelIndex][seg].push({ ms: interval, cpu, calls: info.calls, tris: info.triangles });
      this.intervals.push(interval);
    }

    this.progressIn -= dt;
    if (this.progressIn <= 0 && this.levelIndex < this.levels.length) {
      this.progressIn = 0.25;
      const level = QUALITY[this.levels[this.levelIndex]].label;
      const left = (this.levels.length - this.levelIndex - 1) * (WARMUP + RUN) + Math.max(0, WARMUP + RUN - this.t);
      const what = seg >= 0 ? SEGMENTS[seg].label : 'préparation';
      this.cb.onProgress(`Niveau ${level} (${this.levelIndex + 1}/${this.levels.length}) · ${what} · encore ${Math.ceil(left)} s`);
    }
  }

  private levelInfo() {
    const size = this.host.renderer.getDrawingBufferSize(new THREE.Vector2());
    return {
      level: this.levels[this.levelIndex],
      renderPath: this.host.renderPath(),
      pixelRatio: this.host.pixelRatio(),
      width: size.x,
      height: size.y,
    };
  }

  private finish() {
    this.done = true;
    const levels: LevelResult[] = this.results.map((r, li) => {
      const segments = SEGMENTS.map((s, si) => summarize(s.id, s.label, this.samples[li][si], this.gpu[li][si]));
      const total = summarize('total', 'Ensemble', this.samples[li].flat(), this.gpu[li].flat());
      return { ...r, label: QUALITY[r.level].label, compiles: this.compiles[li] ?? 0, segments, total };
    });
    this.unhook?.();
    this.cb.onDone({
      gpu: this.host.gpuName(),
      userAgent: navigator.userAgent,
      screen: `${screen.width}×${screen.height}, fenêtre ${innerWidth}×${innerHeight}, densité ${devicePixelRatio}`,
      refreshHz: estimateRefresh(this.intervals),
      levels,
    });
  }
}
