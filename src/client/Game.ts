import * as THREE from 'three';
import type { PlayerStats, ServerMessage } from '../shared/net/protocol';
import { SHIP_CLASSES } from '../shared/sim/shipClasses';
import type { SimEvent } from '../shared/sim/types';
import { TICK_RATE } from '../shared/sim/world';
import { buildZone, type ZoneDef } from '../shared/sim/zone';
import { GameAudio } from './audio/Audio';
import { ChaseCamera } from './camera/ChaseCamera';
import { Hud } from './hud/Hud';
import { InputManager } from './input/Input';
import { SnapshotBuffer, type InterpolatedShip } from './net/SnapshotBuffer';
import type { Transport } from './net/Transport';
import { Asteroids } from './render/Asteroids';
import { Effects } from './render/Effects';
import { Lasers } from './render/Lasers';
import { Planets } from './render/Planets';
import { PostFX } from './render/PostFX';
import { ShipView } from './render/ShipView';
import { buildSky, type SkyResult } from './render/Sky';
import { SpaceDust } from './render/SpaceDust';
import { Station } from './render/Station';
import type { Settings } from './settings';

export interface GameOptions {
  quality: 'low' | 'high';
}

const UNION_BOLT = new THREE.Color(1.5, 4, 9);
const RAIDER_BOLT = new THREE.Color(9, 2.2, 0.8);
const _p = new THREE.Vector3();

/**
 * The game client: renders interpolated server snapshots, plays events as
 * effects, and sends player input through the Transport. It holds no
 * authoritative state.
 */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cam: ChaseCamera;
  readonly input: InputManager;
  readonly hud = new Hud();
  readonly audio = new GameAudio();
  private post: PostFX;
  private zone: ZoneDef | null = null;
  private sky: SkyResult | null = null;
  private station: Station | null = null;
  private planets: Planets | null = null;
  private asteroids: Asteroids | null = null;
  private lasers = new Lasers();
  private effects = new Effects();
  private dust = new SpaceDust();
  private views = new Map<number, ShipView>();
  private buffer = new SnapshotBuffer(1.5 / TICK_RATE);
  private eventQueue: { time: number; e: SimEvent }[] = [];
  private renderTime = -1;
  private myShipId: number | null = null;
  private lastMyShipId: number | null = null;
  private stats: PlayerStats = { kills: 0, deaths: 0, credits: 0 };
  private wave = 0;
  private respawnIn = 0;
  private seq = 0;
  private targetId: number | null = null;
  private timer = new THREE.Timer();
  private fps = 60;
  private alarmIn = 0;
  private time = 0;
  running = false;
  /** Pause menu open: the local simulation does not advance. */
  paused = false;
  private lastMe: InterpolatedShip | null = null;
  private damageFx = 0;
  private maxPixelRatio: number;
  private pixelRatio: number;
  private perfTimer = 0;
  private perfFrames = 0;
  /** Exposed for automated smoke tests. */
  readonly debug = { frames: 0, ships: 0, bolts: 0, events: 0, explosions: 0, myShots: 0, myHits: 0, myKills: 0, hitsTaken: 0 };

  constructor(canvas: HTMLCanvasElement, private transport: Transport, private opts: GameOptions, settings: Settings) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.maxPixelRatio = Math.min(window.devicePixelRatio, opts.quality === 'high' ? 1.5 : 1);
    this.pixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.cam = new ChaseCamera(window.innerWidth / window.innerHeight);
    this.scene.add(this.cam.camera);
    this.post = new PostFX(this.renderer, this.scene, this.cam.camera, opts.quality === 'high' ? 4 : 0);
    this.input = new InputManager(canvas, settings.bindings);
    this.applySettings(settings);
    this.timer.connect(document);
    this.scene.add(this.lasers.group, this.effects.group, this.dust.lines);

    window.addEventListener('resize', () => this.resize());
    this.resize();
    transport.onMessage((m) => this.onMessage(m));
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h, this.pixelRatio);
    this.cam.camera.aspect = w / h;
    this.cam.camera.updateProjectionMatrix();
    this.effects.setPixelScale(h * this.renderer.getPixelRatio(), this.cam.camera.fov);
  }

  /** Builds the static zone (identical to the server's, from the same seed). */
  private buildWorld(seed: number) {
    const zone = (this.zone = buildZone(seed));
    const sun = new THREE.DirectionalLight(0xfff1e0, 3.4);
    sun.position.copy(zone.sunDirection).multiplyScalar(1000);
    this.scene.add(sun, sun.target);
    // Cool fill from the nebula side so hulls in shadow still read.
    const fill = new THREE.DirectionalLight(0x8a7cff, 0.9);
    fill.position.copy(zone.sunDirection).multiplyScalar(-1000).add(new THREE.Vector3(0, 400, 0));
    this.scene.add(fill, fill.target);
    this.scene.add(new THREE.HemisphereLight(0x5a7ab0, 0x3a2040, 0.6));

    this.sky = buildSky(this.renderer, zone.sunDirection, this.opts.quality === 'high' ? 1024 : 512);
    this.scene.background = this.sky.background;
    this.scene.environment = this.sky.environment;
    this.scene.environmentIntensity = 1.1;
    this.scene.add(this.sky.sun);

    this.planets = new Planets(zone.planets, zone.sunDirection);
    this.station = new Station(zone.station);
    this.asteroids = new Asteroids(zone.asteroids, zone.beltCenter);
    this.scene.add(this.planets.group, this.station.group, this.asteroids.group);
    this.hud.setZoneName(zone.name);
  }

  private onMessage(m: ServerMessage) {
    switch (m.t) {
      case 'welcome':
        this.buildWorld(m.zoneSeed);
        break;
      case 'snapshot':
        this.buffer.push(m.snap);
        this.myShipId = m.you;
        this.stats = m.stats;
        this.wave = m.wave;
        this.respawnIn = m.respawnIn;
        break;
      case 'events':
        for (const e of m.events) this.eventQueue.push({ time: m.tick / TICK_RATE, e });
        break;
      case 'notice':
        this.hud.notice(m.text, m.tone);
        if (m.tone === 'warn') this.audio.alarm();
        break;
    }
  }

  start() {
    this.running = true;
    this.hud.show(true);
    this.audio.start();
  }

  applySettings(s: Settings) {
    this.input.bindings = s.bindings;
    this.input.invertY = s.invertY;
    this.input.sensitivity = s.sensitivity;
    this.audio.setVolume(s.volume, s.muted);
    this.hud.setBindings(s.bindings);
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.input.enabled = !p;
    this.input.releaseAll();
    this.audio.setPaused(p);
    this.hud.setPaused(p);
  }

  /** One frame. Called from requestAnimationFrame. */
  frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.time += dt;
    this.fps += (1 / Math.max(dt, 1e-4) - this.fps) * 0.05;
    this.debug.frames++;

    // 1) Input → server
    const input = this.input.update(dt);
    if (this.running && !this.paused) {
      this.transport.send({ t: 'input', seq: ++this.seq, input });
    }
    if (this.input.consume('target')) this.cycleTarget();
    if (this.input.consume('camera')) {
      this.cam.cycleMode();
      this.hud.notice(`Caméra : ${{ chase: 'poursuite', close: 'proche', cinematic: 'cinématique' }[this.cam.mode]}`, 'info');
    }
    if (this.input.consume('mute')) {
      this.audio.toggleMute();
      this.hud.notice(this.audio.muted ? 'Son coupé' : 'Son activé', 'info');
    }
    this.input.endFrame();

    // 2) Advance the (local) server and receive messages. While paused the
    //    simulation is frozen and the render clock stops with it.
    if (this.paused) {
      this.renderPaused(dt);
      return;
    }
    this.transport.update(dt);
    const latest = this.buffer.latest;
    if (!latest || !this.zone) {
      this.renderer.render(this.scene, this.cam.camera);
      return;
    }

    // 3) Render clock tracks the newest snapshot minus the interpolation delay
    const targetTime = latest.time - this.buffer.delay;
    if (this.renderTime < 0 || Math.abs(this.renderTime - targetTime) > 0.25) this.renderTime = targetTime;
    else this.renderTime += dt + (targetTime - (this.renderTime + dt)) * 0.1;
    const ships = this.buffer.sample(this.renderTime);

    // 4) Ship views
    for (const [id, s] of ships) {
      let view = this.views.get(id);
      if (!view) {
        view = new ShipView(s.snap.classId, this.scene, id === this.myShipId);
        this.views.set(id, view);
        view.group.position.copy(s.position);
        view.group.quaternion.copy(s.rotation);
        view.teleported();
      }
      view.group.position.copy(s.position);
      view.group.quaternion.copy(s.rotation);
      const throttle = s.snap.boosting ? 1 : Math.max(0, s.snap.throttle);
      view.update(dt, this.time, throttle, s.snap.boosting, this.cam.camera.position);
      const cls = SHIP_CLASSES[s.snap.classId];
      const hullFrac = s.snap.hull / cls.hull;
      if (hullFrac < 0.5) {
        _p.set((Math.random() - 0.5) * cls.radius * 0.6, 0, cls.radius * 0.4).applyQuaternion(s.rotation).add(s.position);
        this.effects.damageTrail(_p, s.velocity, (0.5 - hullFrac) * 2);
      }
    }
    for (const [id, view] of this.views) {
      if (!ships.has(id)) {
        view.dispose(this.scene);
        this.views.delete(id);
      }
    }

    // 5) Events whose time has come
    this.eventQueue.sort((a, b) => a.time - b.time);
    while (this.eventQueue.length && this.eventQueue[0].time <= this.renderTime) {
      const item = this.eventQueue.shift()!;
      this.handleEvent(item.e, item.time);
    }

    // 6) Camera follows my ship (or orbits the wreck while respawning)
    const me = this.myShipId !== null ? ships.get(this.myShipId) ?? null : null;
    if (me) {
      if (this.lastMyShipId !== this.myShipId) {
        this.cam.snap();
        this.lastMyShipId = this.myShipId;
        this.targetId = null;
      }
      this.cam.update(dt, me.position, me.rotation, me.snap.boosting, me.velocity.length(), this.input.cursor, SHIP_CLASSES[me.snap.classId].radius / 9);
      this.lastMe = me;
      this.audio.engineUpdate(Math.max(0, me.snap.throttle), me.snap.boosting);
      const hullFrac = me.snap.hull / SHIP_CLASSES[me.snap.classId].hull;
      this.alarmIn -= dt;
      if (hullFrac < 0.25 && this.alarmIn <= 0) {
        this.audio.alarm();
        this.alarmIn = 1.4;
      }
      this.autoTarget(me, ships);
    } else {
      this.audio.engineUpdate(0, false);
      const c = this.cam.camera;
      if (this.lastMe) {
        // Slow orbit around the destruction site.
        const a = this.time * 0.2;
        c.position.set(this.lastMe.position.x + Math.cos(a) * 120, this.lastMe.position.y + 40, this.lastMe.position.z + Math.sin(a) * 120);
        c.up.set(0, 1, 0);
        c.lookAt(this.lastMe.position);
      }
    }
    if (this.targetId !== null && !ships.has(this.targetId)) this.targetId = null;

    // 7) World animation
    const camPos = this.cam.camera.position;
    this.sky?.update(this.cam.camera);
    this.station?.update(this.renderTime);
    this.planets?.update(this.renderTime);
    this.asteroids?.update(this.renderTime);
    this.lasers.update(this.renderTime);
    this.effects.update(dt);
    this.dust.update(camPos, me ? me.velocity : _p.set(0, 0, 0));

    // 8) HUD + render
    this.hud.update(
      {
        me,
        ships,
        camera: this.cam.camera,
        input,
        cursor: this.input.cursor,
        targetId: this.targetId,
        stats: this.stats,
        wave: this.wave,
        respawnIn: this.respawnIn,
        stationPos: this.zone.station.position,
        stationName: this.zone.station.name,
        fps: this.fps,
        net: `${this.transport.label} · ${Math.round(this.pixelRatio * 100)}%`,
      },
      dt,
    );
    this.damageFx = Math.max(0, this.damageFx - dt * 2);
    this.adaptResolution(dt);
    this.debug.ships = ships.size;
    this.post.render(this.time, this.damageFx);
  }

  /** Paused frame: same scene, no simulation, no clock advance. */
  private renderPaused(dt: number) {
    if (!this.zone) {
      this.renderer.render(this.scene, this.cam.camera);
      return;
    }
    this.sky?.update(this.cam.camera);
    this.effects.update(0);
    this.hud.updatePaused(dt);
    this.post.render(this.time, 0);
  }

  /**
   * Dynamic resolution: every 2 s, lower the render scale when the frame rate
   * stays under 45 FPS and raise it again above 58 FPS.
   */
  private adaptResolution(dt: number) {
    if (!this.running) return;
    this.perfTimer += dt;
    this.perfFrames++;
    if (this.perfTimer < 2) return;
    const fps = this.perfFrames / this.perfTimer;
    this.perfTimer = 0;
    this.perfFrames = 0;
    let next = this.pixelRatio;
    if (fps < 45) next = Math.max(0.6, this.pixelRatio * 0.85);
    else if (fps > 58) next = Math.min(this.maxPixelRatio, this.pixelRatio * 1.1);
    if (Math.abs(next - this.pixelRatio) > 0.02) {
      this.pixelRatio = next;
      this.resize();
    }
  }

  /** Current render scale (for the HUD / diagnostics). */
  get renderScale() {
    return this.pixelRatio;
  }

  private handleEvent(e: SimEvent, time: number) {
    this.debug.events++;
    const camPos = this.cam.camera.position;
    switch (e.type) {
      case 'shot': {
        this.lasers.add(e.projectile, e.faction, e.pos, e.vel, time, e.life);
        this.debug.bolts++;
        if (e.shooter === this.myShipId) {
          this.debug.myShots++;
          this.hud.fired();
        }
        _p.set(...e.pos);
        this.effects.muzzle(_p, new THREE.Vector3(...e.vel).multiplyScalar(0.05), e.faction === 'union' ? UNION_BOLT : RAIDER_BOLT);
        this.audio.laser(_p.distanceTo(camPos), e.faction !== 'union');
        break;
      }
      case 'hit': {
        this.lasers.remove(e.projectile);
        _p.set(...e.pos);
        const view = this.views.get(e.target);
        if (e.shield) {
          view?.shieldHit(_p, this.time);
          this.effects.shieldSparks(_p, view && (view.classId === 'falcon' || view.classId === 'warden') ? new THREE.Color(0.6, 1.6, 4) : new THREE.Color(4, 1.2, 0.5));
          this.audio.shieldHit(_p.distanceTo(camPos));
        } else {
          this.effects.hullHit(_p);
          this.audio.hullHit(_p.distanceTo(camPos));
        }
        if (e.target === this.myShipId) {
          this.debug.hitsTaken++;
          this.hud.damageTaken(e.damage, e.shield);
          this.cam.addShake(e.shield ? 0.12 : 0.3);
          if (!e.shield) this.damageFx = Math.min(1, this.damageFx + 0.3);
        }
        if (e.attacker === this.myShipId) {
          this.debug.myHits++;
          this.hud.hitConfirm(e.shield);
          this.audio.hitMarker();
          if (this.targetId === null) this.targetId = e.target;
        }
        break;
      }
      case 'impact':
        this.lasers.remove(e.projectile);
        this.effects.impact(_p.set(...e.pos), new THREE.Color(3, 2, 1.2));
        break;
      case 'collision':
        if (e.ship === this.myShipId) {
          this.cam.addShake(Math.min(1.2, e.damage / 30));
          this.hud.damageTaken(e.damage, false);
        }
        this.effects.hullHit(_p.set(...e.pos));
        break;
      case 'destroyed': {
        _p.set(...e.pos);
        const big = e.classId === 'marauder';
        const vel = new THREE.Vector3();
        this.effects.explosion(_p, big ? 1.8 : 1, vel);
        this.debug.explosions++;
        const d = _p.distanceTo(camPos);
        this.audio.explosion(d, big);
        this.cam.addShake(Math.max(0, 1 - d / 900) * (big ? 1.2 : 0.8));
        if (e.by !== null && e.by === this.myShipId) {
          this.debug.myKills++;
          this.hud.killConfirm();
        }
        if (e.ship === this.myShipId) {
          this.cam.addShake(1.5);
          this.hud.notice('Coque détruite — éjection', 'warn');
        }
        break;
      }
      case 'spawned':
        break;
    }
  }

  /** T: cycle hostiles, nearest first. */
  private cycleTarget() {
    const latest = this.buffer.latest;
    if (!latest || this.myShipId === null) return;
    const me = latest.ships.find((s) => s.id === this.myShipId);
    if (!me) return;
    const mp = new THREE.Vector3(...me.p);
    const hostiles = latest.ships
      .filter((s) => s.faction !== me.faction)
      .map((s) => ({ id: s.id, d: mp.distanceTo(_p.set(...s.p)) }))
      .sort((a, b) => a.d - b.d);
    if (!hostiles.length) return;
    const i = hostiles.findIndex((h) => h.id === this.targetId);
    this.targetId = hostiles[(i + 1) % hostiles.length].id;
    this.audio.ui();
  }

  /** Without a target, lock onto the hostile closest to the gun line. */
  private autoTarget(me: InterpolatedShip, ships: Map<number, InterpolatedShip>) {
    if (this.targetId !== null) return;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(me.rotation);
    let best: number | null = null;
    let bestDot = Math.cos((14 * Math.PI) / 180);
    for (const s of ships.values()) {
      if (s.snap.faction === me.snap.faction) continue;
      const to = _p.copy(s.position).sub(me.position);
      const d = to.length();
      if (d > 3500) continue;
      const dot = to.divideScalar(d).dot(fwd);
      if (dot > bestDot) {
        bestDot = dot;
        best = s.snap.id;
      }
    }
    this.targetId = best;
  }
}
