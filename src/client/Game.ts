import * as THREE from 'three';
import type { ChatLine, ErrorCode, PlayerInfo, PlayerStats, ServerMessage } from '../shared/net/protocol';
import { SHIP_CLASSES } from '../shared/sim/shipClasses';
import { StaticGrid } from '../shared/sim/spatialGrid';
import { neutralInput, type SimEvent } from '../shared/sim/types';
import { TICK_DT, TICK_RATE } from '../shared/sim/world';
import { buildZone, type ZoneDef } from '../shared/sim/zone';
import { GameAudio } from './audio/Audio';
import { ChaseCamera } from './camera/ChaseCamera';
import { isHostile } from './hostility';
import { Hud } from './hud/Hud';
import { InputManager } from './input/Input';
import { Predictor } from './net/Predictor';
import { SnapshotBuffer, type InterpolatedShip } from './net/SnapshotBuffer';
import type { Transport } from './net/Transport';
import { Asteroids } from './render/Asteroids';
import { Effects } from './render/Effects';
import { Lasers } from './render/Lasers';
import { Planets } from './render/Planets';
import { PostFX } from './render/PostFX';
import { ShipView } from './render/ShipView';
import { QUALITY, type QualityLevel, type QualityProfile } from './render/quality';
import { buildSky, type SkyResult } from './render/Sky';
import { SpaceDust } from './render/SpaceDust';
import { Station } from './render/Station';
import type { Settings } from './settings';

export interface GameOptions {
  quality: QualityLevel;
  /** 'direct' skips post-processing entirely (?render=direct). */
  render?: 'auto' | 'direct';
}

const UNION_BOLT = new THREE.Color(1.5, 4, 9);
const RAIDER_BOLT = new THREE.Color(9, 2.2, 0.8);
const _p = new THREE.Vector3();
const _shotOffset = new THREE.Vector3();
/** Image-based light from the baked nebula: reflections and a hint of colour, not a fill light. */
const ENVIRONMENT_INTENSITY = 0.55;
export const DEFAULT_SECTOR_SEED = 1337;

export { isHostile };

export interface GameCallbacks {
  onChat?(line: ChatLine): void;
  onChatHistory?(lines: ChatLine[]): void;
  onFatal?(code: ErrorCode, text: string): void;
  onOpenChat?(): void;
  onToggleChat?(): void;
}

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
  private post: PostFX | null;
  private quality: QualityProfile;
  /** Render path: MSAA composer, composer without MSAA, or plain render (no post-processing). */
  renderPath: 'msaa' | 'composer' | 'direct';
  private framesRunning = 0;
  private outputChecks = 0;
  private blackSamples = 0;
  /** Graphics diagnostics (pause menu, ?diag). */
  readonly gfx = { lastSample: -1, blackSamples: 0, fallbacks: 0, shaderErrors: 0 };
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
  private _transport: Transport | null = null;
  private predictor: Predictor | null = null;
  private grid: StaticGrid | null = null;
  private inputAcc = 0;
  /** Where the server (interpolated) shows my ship, versus where prediction renders it. */
  private myServerPos = new THREE.Vector3();
  private myRenderPos = new THREE.Vector3();
  private hasMyPose = false;
  private worldRoot = new THREE.Group();
  players: PlayerInfo[] = [];
  maxPlayers = 0;
  private playersByShip = new Map<number, PlayerInfo>();
  myName = '';
  sessionId = '';
  resumed = false;
  private myPvp = false;
  callbacks: GameCallbacks = {};
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

  constructor(canvas: HTMLCanvasElement, private opts: GameOptions, settings: Settings) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.quality = QUALITY[opts.quality];
    this.maxPixelRatio = Math.min(window.devicePixelRatio, this.quality.maxPixelRatio);
    this.pixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
      this.gfx.shaderErrors++;
      console.error('NEBULA: shader en erreur', gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs));
    };

    this.cam = new ChaseCamera(window.innerWidth / window.innerHeight);
    this.scene.add(this.cam.camera);
    this.post = null;
    this.renderPath = 'direct';
    this.buildPost();
    this.effects.density = this.quality.particles;
    this.input = new InputManager(canvas, settings.bindings);
    this.applySettings(settings);
    this.timer.connect(document);
    this.scene.add(this.lasers.group, this.effects.group, this.dust.lines, this.worldRoot);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get transport() {
    return this._transport;
  }

  /** Connects the game to a server (solo LocalTransport or online WebSocketTransport). */
  attach(transport: Transport) {
    this.detach();
    this._transport = transport;
    this.buffer.delay = transport.interpolationDelay;
    transport.onMessage((m) => this.onMessage(m));
  }

  /** Leaves the current server and clears everything that came from it. */
  detach() {
    this._transport?.close();
    this._transport = null;
    this.running = false;
    this.paused = false;
    this.resetSession();
    this.players = [];
    this.playersByShip.clear();
    this.hud.show(false);
  }

  /** Forgets all server-driven state (new session, or server restarted). */
  private resetSession() {
    for (const v of this.views.values()) v.dispose(this.scene);
    this.views.clear();
    this.buffer = new SnapshotBuffer(this._transport?.interpolationDelay ?? 1.5 / TICK_RATE);
    this.eventQueue.length = 0;
    this.renderTime = -1;
    this.myShipId = null;
    this.lastMyShipId = null;
    this.lastMe = null;
    this.targetId = null;
    this.seq = 0;
    this.inputAcc = 0;
    this.predictor?.reset();
    this.lasers.clear();
    this.stats = { kills: 0, deaths: 0, credits: 0 };
    this.wave = 0;
    this.myPvp = false;
  }

  /** Network state for automated tests and debugging (window.__game.inspect()). */
  inspect() {
    const latest = this.buffer.latest;
    return {
      running: this.running,
      paused: this.paused,
      status: this._transport ? { ...this._transport.status } : null,
      myShipId: this.myShipId,
      myName: this.myName,
      sessionId: this.sessionId,
      resumed: this.resumed,
      myPvp: this.myPvp,
      stats: { ...this.stats },
      ships: latest ? latest.ships.map((s) => ({ id: s.id, name: s.name, owner: s.owner, faction: s.faction, p: s.p, hull: s.hull, pvp: s.pvp })) : [],
      players: this.players.map((p) => ({ ...p })),
      corrections: this.predictor?.corrections ?? 0,
      lastCorrection: this.predictor?.lastCorrection ?? 0,
      predicted: this.predictor?.ship ? this.predictor.ship.position.toArray() : null,
      debug: { ...this.debug },
    };
  }

  /** Online only: ask the server to switch PvP (it decides and answers with a notice). */
  togglePvp() {
    if (!this._transport?.online) {
      this.hud.notice('Le PvP n\'existe qu\'en ligne', 'info');
      return;
    }
    this._transport.send({ t: 'pvp', on: !this.myPvp });
  }

  sendChat(text: string) {
    if (this._transport?.online) this._transport.send({ t: 'chat', text });
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.post?.setSize(w, h, this.pixelRatio);
    this.cam.camera.aspect = w / h;
    this.cam.camera.updateProjectionMatrix();
    this.effects.setPixelScale(h * this.renderer.getPixelRatio(), this.cam.camera.fov);
  }

  /** Post-processing chain for the current quality level (none on Bas or with ?render=direct). */
  private buildPost() {
    this.post?.dispose();
    this.post = null;
    if (this.opts.render === 'direct' || !this.quality.post) {
      this.renderPath = 'direct';
      return;
    }
    this.post = new PostFX(this.renderer, this.scene, this.cam.camera, this.quality.msaa);
    this.renderPath = this.quality.msaa ? 'msaa' : 'composer';
  }

  private skySize = 0;
  private buildSkyFor(zone: ZoneDef) {
    if (this.sky) {
      this.worldRoot.remove(this.sky.sun);
      this.sky.dispose();
    }
    this.skySize = this.quality.skySize;
    this.sky = buildSky(this.renderer, zone.sunDirection, this.skySize);
    this.scene.background = this.sky.background;
    this.scene.environment = this.sky.environment;
    this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
    this.worldRoot.add(this.sky.sun);
  }

  /** Switches the graphics quality while running (Options menu). */
  setQuality(level: QualityLevel) {
    if (level === this.quality.level) return;
    this.quality = QUALITY[level];
    this.maxPixelRatio = Math.min(window.devicePixelRatio, this.quality.maxPixelRatio);
    this.pixelRatio = this.maxPixelRatio;
    this.effects.density = this.quality.particles;
    this.buildPost();
    this.outputChecks = 0;
    this.blackSamples = 0;
    if (this.zone && this.skySize !== this.quality.skySize) this.buildSkyFor(this.zone);
    this.asteroids?.setDetail(level !== 'low');
    this.resize();
  }

  get qualityLevel() {
    return this.quality.level;
  }

  /** Builds the static zone (identical to the server's, from the same seed). */
  private buildWorld(seed: number) {
    if (this.zone?.seed === seed) return;
    this.scene.remove(this.worldRoot);
    this.worldRoot = new THREE.Group();
    this.scene.add(this.worldRoot);
    const zone = (this.zone = buildZone(seed));
    this.grid = new StaticGrid(zone.colliders);
    this.predictor = new Predictor(this.grid);
    // Cinematic Realism: one dominant star. Shadows stay nearly black; a faint
    // cool rim from the nebula side and the baked sky reflections keep the
    // silhouettes readable without lifting them (no flat violet fill).
    const sun = new THREE.DirectionalLight(0xfff0dc, 4.2);
    sun.position.copy(zone.sunDirection).multiplyScalar(1000);
    this.worldRoot.add(sun, sun.target);
    const rim = new THREE.DirectionalLight(0x7d9cff, 0.32);
    rim.position.copy(zone.sunDirection).multiplyScalar(-1000).add(new THREE.Vector3(0, 400, 0));
    this.worldRoot.add(rim, rim.target);
    this.worldRoot.add(new THREE.HemisphereLight(0x6f86b0, 0x0c0a12, 0.07));

    this.buildSkyFor(zone);

    this.planets = new Planets(zone.planets, zone.sunDirection);
    this.station = new Station(zone.station);
    this.asteroids = new Asteroids(zone.asteroids, zone.beltCenter);
    this.asteroids.setDetail(this.quality.level !== 'low');
    this.worldRoot.add(this.planets.group, this.station.group, this.asteroids.group);
    this.hud.setZoneName(zone.name);
  }

  private onMessage(m: ServerMessage) {
    switch (m.t) {
      case 'welcome':
        if (!m.resumed || this.zone?.seed !== m.zoneSeed) this.resetSession();
        // Resumed session: the server restarts our input sequence, so prediction starts over too.
        else this.predictor?.reset();
        this.buildWorld(m.zoneSeed);
        this.myName = m.name;
        this.sessionId = m.playerId;
        this.resumed = m.resumed;
        break;
      case 'snapshot': {
        this.buffer.push(m.snap);
        this.myShipId = m.you;
        this.stats = m.stats;
        this.wave = m.wave;
        this.respawnIn = m.respawnIn;
        const mine = m.you !== null ? m.snap.ships.find((s) => s.id === m.you) : undefined;
        if (mine) {
          this.myPvp = mine.pvp;
          this.predictor?.reconcile(mine, m.ackSeq);
        } else this.predictor?.reset();
        break;
      }
      case 'players':
        this.players = m.list;
        this.maxPlayers = m.max;
        this.playersByShip.clear();
        for (const p of m.list) if (p.ship !== null) this.playersByShip.set(p.ship, p);
        break;
      case 'chat':
        this.callbacks.onChat?.(m.line);
        if (m.line.from === null) this.hud.notice(m.line.text, 'info');
        break;
      case 'chatHistory':
        this.callbacks.onChatHistory?.(m.lines);
        break;
      case 'error':
        this.hud.notice(m.text, 'warn');
        this.callbacks.onFatal?.(m.code, m.text);
        break;
      case 'pong':
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
    // Online the sector keeps running: tell the server at once that we let go of
    // the controls (the tab may be hidden next, and then no frame runs).
    if (p && !this.paused && this.running && this._transport?.online) {
      this._transport.send({ t: 'input', seq: ++this.seq, input: { ...neutralInput(), flightAssist: this.input.input.flightAssist } });
      this._transport.update(0);
    }
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

    if (!this.zone) this.buildWorld(DEFAULT_SECTOR_SEED);
    const transport = this._transport;

    // 1) Input (sent below, at the fixed tick rate)
    const input = this.input.update(dt);
    if (this.input.consume('target')) this.cycleTarget();
    if (this.input.consume('camera')) {
      this.cam.cycleMode();
      this.hud.notice(`Caméra : ${{ chase: 'poursuite', close: 'proche', cinematic: 'cinématique' }[this.cam.mode]}`, 'info');
    }
    if (this.input.consume('mute')) {
      this.audio.toggleMute();
      this.hud.notice(this.audio.muted ? 'Son coupé' : 'Son activé', 'info');
    }
    if (this.input.consume('chat')) this.callbacks.onOpenChat?.();
    if (this.input.consume('chatToggle')) this.callbacks.onToggleChat?.();
    if (this.input.consume('pvp')) this.togglePvp();
    this.input.endFrame();

    // 2) Advance the (local) server and receive messages. In solo the pause
    //    freezes the simulation and the render clock; online the sector keeps
    //    running and our ship simply cuts its engines.
    if (this.paused && !transport?.online) {
      this.renderPaused(dt);
      return;
    }
    if (transport && this.running) {
      // One input per simulation tick, predicted locally at once.
      const send = this.paused ? { ...neutralInput(), flightAssist: input.flightAssist } : input;
      this.inputAcc += dt;
      let steps = 0;
      while (this.inputAcc >= TICK_DT && steps < 8) {
        this.inputAcc -= TICK_DT;
        steps++;
        const seq = ++this.seq;
        transport.send({ t: 'input', seq, input: { ...send } });
        this.predictor?.step(seq, send);
      }
      if (this.inputAcc > TICK_DT) this.inputAcc = 0;
    }
    transport?.update(dt);
    const latest = this.buffer.latest;
    if (!latest || !this.zone) {
      this.attractCamera(dt);
      this.renderScene(0);
      return;
    }

    // 3) Render clock tracks the newest snapshot minus the interpolation delay
    const targetTime = latest.time - this.buffer.delay;
    if (this.renderTime < 0 || Math.abs(this.renderTime - targetTime) > 0.25) this.renderTime = targetTime;
    else this.renderTime += dt + (targetTime - (this.renderTime + dt)) * 0.1;
    const ships = this.buffer.sample(this.renderTime);

    // My ship is drawn where prediction puts it, not 100 ms in the past.
    this.hasMyPose = false;
    const predicted = this.myShipId !== null ? ships.get(this.myShipId) : undefined;
    if (predicted && this.predictor?.ship?.id === this.myShipId) {
      this.predictor.update(dt, this.inputAcc / TICK_DT);
      this.myServerPos.copy(predicted.position);
      predicted.position.copy(this.predictor.renderPosition);
      predicted.rotation.copy(this.predictor.renderRotation);
      predicted.velocity.copy(this.predictor.ship.velocity);
      this.myRenderPos.copy(predicted.position);
      this.hasMyPose = true;
    }

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
      view.update(dt, this.time, throttle, s.snap.boosting, this.cam.camera.position, s.snap.w);
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
        net: `${Math.round(this.pixelRatio * 100)}%`,
        status: transport?.status ?? { state: 'local', rtt: 0 },
        online: transport?.online ?? false,
        players: this.playersByShip,
        playerCount: this.players.filter((p) => p.online).length,
        maxPlayers: this.maxPlayers,
        myName: this.myName,
      },
      dt,
    );
    this.hud.showScoreboard(this.running && !this.paused && this.input.held('scoreboard'), this.players, this.myName, transport?.online ?? false);
    this.damageFx = Math.max(0, this.damageFx - dt * 2);
    this.adaptResolution(dt);
    this.debug.ships = ships.size;
    this.renderScene(this.damageFx);
    this.checkOutput();
  }

  private renderScene(damage: number) {
    if (this.post) this.post.render(this.time, damage);
    else this.renderer.render(this.scene, this.cam.camera);
  }

  /**
   * Some GPU/driver combinations render the post-processing chain as a black
   * image (the HUD keeps working). The sky is never black, so sample the frame
   * regularly while flying and step down to a simpler render path when it stays
   * black for three samples in a row.
   */
  private checkOutput() {
    this.framesRunning++;
    const every = this.outputChecks < 10 ? 20 : 90;
    if (this.paused || this.framesRunning < 20 || this.framesRunning % every !== 0) return;
    this.outputChecks++;
    this.renderer.setRenderTarget(null);
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    let max = 0;
    for (let i = 1; i < 8; i++)
      for (let j = 1; j < 8; j++) {
        gl.readPixels(Math.floor((gl.drawingBufferWidth * i) / 8), Math.floor((gl.drawingBufferHeight * j) / 8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        max = Math.max(max, px[0], px[1], px[2]);
      }
    this.gfx.lastSample = max;
    if (max > 12) {
      this.blackSamples = 0;
      return;
    }
    this.blackSamples++;
    this.gfx.blackSamples++;
    if (this.blackSamples < 3 || this.renderPath === 'direct') return;
    this.blackSamples = 0;
    this.post?.dispose();
    if (this.renderPath === 'msaa') {
      this.post = new PostFX(this.renderer, this.scene, this.cam.camera, 0);
      this.renderPath = 'composer';
      this.resize();
    } else {
      this.post = null;
      this.renderPath = 'direct';
    }
    this.gfx.fallbacks++;
    console.warn(`NEBULA: image noire détectée, passage au rendu de secours « ${this.renderPath} ».`);
    this.hud.notice('Mode graphique de secours activé', 'warn');
  }

  /** One line describing the graphics setup, shown in the pause menu (and with ?diag). */
  graphicsInfo() {
    const gl = this.renderer.getContext();
    let gpu = '';
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    } catch {
      gpu = '?';
    }
    return `${gpu} · rendu ${this.renderPath} · image ${this.gfx.lastSample}/255 · noires ${this.gfx.blackSamples} · secours ${this.gfx.fallbacks} · shaders en erreur ${this.gfx.shaderErrors}`;
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
    this.renderScene(0);
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
        _p.set(...e.pos);
        if (e.shooter === this.myShipId && this.hasMyPose) {
          // Our own bolts leave the predicted ship, not where the server had it ~RTT ago.
          _shotOffset.subVectors(this.myRenderPos, this.myServerPos);
          if (_shotOffset.lengthSq() < 200 * 200) _p.add(_shotOffset);
        }
        this.lasers.add(e.projectile, e.faction, [_p.x, _p.y, _p.z], e.vel, time, e.life);
        this.debug.bolts++;
        if (e.shooter === this.myShipId) {
          this.debug.myShots++;
          this.hud.fired();
        }
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

  /** Before take-off: a slow drift past the station (start menu backdrop). */
  private attractCamera(dt: number) {
    const z = this.zone;
    if (!z) return;
    const c = this.cam.camera;
    const a = this.time * 0.03 + 0.6;
    c.position.copy(z.playerSpawn).add(_p.set(Math.cos(a) * 160, 40 + Math.sin(this.time * 0.05) * 10, Math.sin(a) * 160));
    c.up.set(0, 1, 0);
    c.lookAt(z.station.position);
    this.sky?.update(c);
    this.station?.update(this.time);
    this.planets?.update(this.time);
    this.asteroids?.update(this.time);
    this.effects.update(dt);
  }

  /** T: cycle hostiles, nearest first. */
  private cycleTarget() {
    const latest = this.buffer.latest;
    if (!latest || this.myShipId === null) return;
    const me = latest.ships.find((s) => s.id === this.myShipId);
    if (!me) return;
    const mp = new THREE.Vector3(...me.p);
    const hostiles = latest.ships
      .filter((s) => isHostile(me, s))
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
      if (!isHostile(me.snap, s.snap)) continue;
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
