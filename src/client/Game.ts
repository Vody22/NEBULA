import * as THREE from 'three';
import { cargoTotal, ITEMS, type ItemId } from '../shared/economy/items';
import type { StationId } from '../shared/economy/market';
import { segmentSphere } from '../shared/math';
import type { ChatLine, ErrorCode, MarketView, PilotState, PlayerInfo, PlayerStats, ServerMessage } from '../shared/net/protocol';
import { MINING_MAX_SPEED, MINING_RANGE, MINING_RATE, miningTarget, oreOf, richness, richnessLabel } from '../shared/sim/mining';
import { SHIP_CLASSES } from '../shared/sim/shipClasses';
import { statsOfPacked, unpackMods } from '../shared/sim/upgrades';
import { StaticGrid } from '../shared/sim/spatialGrid';
import { neutralInput, type Ship, type ShipClassId, type ShipInput, type SimEvent } from '../shared/sim/types';
import { TICK_DT, TICK_RATE } from '../shared/sim/world';
import { buildZone, DOCK_MAX_SPEED, type ZoneDef } from '../shared/sim/zone';
import { GameAudio } from './audio/Audio';
import { Benchmark, type BenchCallbacks } from './bench/Benchmark';
import { ChaseCamera } from './camera/ChaseCamera';
import { isHostile } from './hostility';
import { Hud, type DockGuide, type MiningInfo } from './hud/Hud';
import { InputManager } from './input/Input';
import { Predictor } from './net/Predictor';
import { SnapshotBuffer, type InterpolatedShip } from './net/SnapshotBuffer';
import type { Transport } from './net/Transport';
import { Asteroids } from './render/Asteroids';
import { Effects } from './render/Effects';
import { Lasers } from './render/Lasers';
import { MiningBeams, type BeamSegment } from './render/MiningBeams';
import { Planets } from './render/Planets';
import { PostFX } from './render/PostFX';
import { updateBatches } from './render/batches';
import { OutputProbe } from './render/OutputProbe';
import { ShipView } from './render/ShipView';
import { QUALITY, type QualityLevel, type QualityProfile } from './render/quality';
import { buildSky, type SkyResult } from './render/Sky';
import { SpaceDust } from './render/SpaceDust';
import { Outpost } from './render/Outpost';
import { Station } from './render/Station';
import { keyLabel, type Settings } from './settings';
import { StationPanel, type KnownPrice } from './ui/StationPanel';

export interface GameOptions {
  quality: QualityLevel;
  /** 'direct' skips post-processing entirely (?render=direct). */
  render?: 'auto' | 'direct';
}

const UNION_BOLT = new THREE.Color(1.5, 4, 9);
const RAIDER_BOLT = new THREE.Color(9, 2.2, 0.8);
const _p = new THREE.Vector3();
const _shotOffset = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _end = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _camTarget = new THREE.Vector3();
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
  /** Touch screens at the station: open the pause menu. */
  onMenu?(): void;
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
  private probe: OutputProbe;
  /** One hidden ship of each class, so their shaders are compiled with the rest (see precompile). */
  private showroom: ShipView[] = [];
  private compileTarget: THREE.WebGLRenderTarget | null = null;
  /** Graphics diagnostics (pause menu, ?diag). */
  readonly gfx = { lastSample: -1, blackSamples: 0, fallbacks: 0, shaderErrors: 0 };
  private zone: ZoneDef | null = null;
  private sky: SkyResult | null = null;
  private station: Station | null = null;
  /** Every station model by id (Aurora-7 and the Ferro-9 depot). */
  private stationViews = new Map<StationId, Station | Outpost>();
  private planets: Planets | null = null;
  private asteroids: Asteroids | null = null;
  private lasers = new Lasers();
  private beams = new MiningBeams();
  private beamList: BeamSegment[] = [];
  private sparkClock = 0;
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
  /** Credits, hold and docking state, from the server. */
  private pilot: PilotState | null = null;
  /** Markets seen at each station, newest first: the station screen compares prices. */
  private seenMarkets = new Map<StationId, { market: MarketView; at: number }>();
  /** The pilot's ship shown on its pad while docked. */
  private parked: ShipView | null = null;
  /** Estimated progress toward the next unit of ore (the server sends whole units). */
  private mineProgress = 0;
  /** In a docking zone (touch screens show the dock button). */
  dockable = false;
  readonly stationPanel = new StationPanel(document.body, {
    trade: (item, qty) => this._transport?.send({ t: 'trade', item, qty }),
    repair: () => this._transport?.send({ t: 'repair' }),
    buyShip: (ship) => this._transport?.send({ t: 'buyShip', ship }),
    useShip: (ship) => this._transport?.send({ t: 'useShip', ship }),
    upgrade: (slot) => this._transport?.send({ t: 'upgrade', slot }),
    undock: () => this.undock(),
    menu: () => this.callbacks.onMenu?.(),
  });
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
  /** Performance test (?bench): replaces the game loop while it runs. */
  private bench: Benchmark | null = null;
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

    this.probe = new OutputProbe(this.renderer.getContext() as WebGL2RenderingContext);

    this.cam = new ChaseCamera(window.innerWidth / window.innerHeight);
    this.scene.add(this.cam.camera);
    this.post = null;
    this.renderPath = 'direct';
    this.buildPost();
    this.effects.density = this.quality.particles;
    this.input = new InputManager(canvas, settings.bindings);
    this.applySettings(settings);
    this.timer.connect(document);
    this.scene.add(this.lasers.group, this.beams.mesh, this.effects.group, this.dust.lines, this.worldRoot);

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
    this.myPvp = false;
    this.pilot = null;
    this.seenMarkets.clear();
    this.stationPanel.hide();
    this.disposeParked();
    this.dockable = false;
  }

  /** At a station: the server keeps the ship, the client shows the station screen. */
  get docked() {
    return !!this.pilot?.docked;
  }

  private toggleDock() {
    if (this.docked) this.undock();
    else this._transport?.send({ t: 'dock' });
  }

  private undock() {
    this._transport?.send({ t: 'undock' });
    // Within the click or key press: the browser only captures the mouse during a user gesture.
    if (!this.input.touchMode) this.input.requestLock();
  }

  private dockChanged(station: StationId | null) {
    if (station) {
      const def = this.zone?.stations.find((s) => s.id === station);
      this.stationPanel.show(def?.name ?? station);
      this.stationPanel.setKnownPrices(this.pricesElsewhere(station));
      // The station screen needs the mouse pointer.
      if (document.pointerLockElement) document.exitPointerLock();
      this.input.releaseKeys();
      this.input.input.throttle = 0;
      this.audio.ui();
    } else {
      this.stationPanel.hide();
      this.disposeParked();
      this.input.centerCursor();
      // Leave the hangar at a crawl rather than braking to a stop at the mouth.
      this.input.input.throttle = 0.15;
    }
  }

  /** The most recent sell price of every item at the other stations. */
  private pricesElsewhere(here: StationId): Map<ItemId, KnownPrice> {
    const out = new Map<ItemId, KnownPrice>();
    for (const [id, seen] of this.seenMarkets) {
      if (id === here) continue;
      const name = this.zone?.stations.find((s) => s.id === id)?.name.replace(/^Station\s+/, '') ?? id;
      for (const line of seen.market.items) {
        const prev = out.get(line.id);
        if (!prev || prev.at < seen.at) out.set(line.id, { station: name, buy: line.buy, sell: line.sell, at: seen.at });
      }
    }
    return out;
  }

  private disposeParked() {
    this.parked?.dispose(this.scene);
    this.parked = null;
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
      pilot: this.pilot ? { ...this.pilot, cargo: { ...this.pilot.cargo } } : null,
      dockable: this.dockable,
      stationScreen: this.stationPanel.isOpen,
      beams: this.beams.mesh.count,
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
    this.probe.cancel();
    if (this.zone && this.skySize !== this.quality.skySize) this.buildSkyFor(this.zone);
    this.asteroids?.setDetail(level !== 'low');
    this.resize();
    // A new sky size or render path changes most shaders: compile them now,
    // rather than one stall per object as each comes into view.
    if (this.zone) this.precompile();
  }

  /**
   * Compiles every shader the scene can need, so that none compiles in the
   * middle of play: on Windows (ANGLE) each one blocks the page for tens of
   * milliseconds, several at once make a visible stall. Covers every object
   * of the scene including hidden ones (effect pools, distant station detail,
   * ships waiting to respawn), one ship of each class, the pilot's engine light
   * present and absent (the number of lights is part of every lit shader),
   * for the render target the scene is really drawn into (tone mapping
   * happens in the shader only when drawing straight to the screen).
   * Also uploads every texture. Called when the world is built and whenever
   * the quality or the render path changes.
   */
  precompile() {
    if (!this.showroom.length) {
      for (const id of Object.keys(SHIP_CLASSES) as ShipClassId[]) {
        const v = new ShipView(id, this.scene, false);
        v.setVisible(false);
        this.showroom.push(v);
      }
    }
    updateBatches();
    this.effects.warmUp(true);
    const hidden: THREE.Object3D[] = [];
    const textures = new Set<THREE.Texture>();
    const collect = (v: unknown) => {
      const t = v as THREE.Texture | null;
      if (t && t.isTexture && !t.isRenderTargetTexture) textures.add(t);
    };
    this.scene.traverse((o) => {
      // Lights stay as they are: their number is part of the shaders.
      if (!o.visible && !(o as THREE.Light).isLight) {
        hidden.push(o);
        o.visible = true;
      }
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const mat of m ? (Array.isArray(m) ? m : [m]) : []) {
        for (const v of Object.values(mat)) collect(v);
        const uniforms = (mat as THREE.ShaderMaterial).uniforms;
        if (uniforms) for (const u of Object.values(uniforms)) collect(u?.value);
      }
    });
    for (const t of textures) this.renderer.initTexture(t);
    const previous = this.renderer.getRenderTarget();
    this.compileTarget ??= new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.renderer.setRenderTarget(this.post ? this.compileTarget : null);
    this.renderer.compile(this.scene, this.cam.camera);
    const own = [...this.views.values()].find((v) => v.light)?.light;
    const stand = own ? null : new THREE.PointLight(0xffffff, 0, 60, 2);
    if (own) own.visible = false;
    if (stand) this.scene.add(stand);
    this.renderer.compile(this.scene, this.cam.camera);
    if (own) own.visible = true;
    if (stand) this.scene.remove(stand);
    // The sun's lens flare draws with materials of its own from onBeforeRender,
    // out of compile()'s reach, and only when the sun is on screen: draw it
    // once now, looking straight at it, into a small target of the right type.
    const flares: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if ((o as THREE.Object3D & { isLensflare?: boolean }).isLensflare) flares.push(o);
    });
    if (flares.length) {
      const target = new THREE.WebGLRenderTarget(64, 64, { type: this.post ? THREE.HalfFloatType : THREE.UnsignedByteType });
      const eye = new THREE.PerspectiveCamera(30, 1, 0.1, 1e7);
      const at = new THREE.Vector3();
      this.renderer.setRenderTarget(target);
      for (const f of flares) {
        f.updateWorldMatrix(true, false);
        f.getWorldPosition(at);
        eye.position.copy(this.cam.camera.position).sub(at).setLength(100).add(at);
        eye.lookAt(at);
        eye.updateMatrixWorld();
        this.renderer.render(f, eye);
      }
      target.dispose();
    }
    this.renderer.setRenderTarget(previous);
    for (const o of hidden) o.visible = false;
    this.effects.warmUp(false);
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
    this.stationViews.clear();
    for (const def of zone.stations) {
      const view: Station | Outpost = def.kind === 'hub' && def.id === zone.station.id ? this.station : new Outpost(def);
      this.stationViews.set(def.id, view);
      if (view !== this.station) this.worldRoot.add(view.group);
    }
    this.asteroids = new Asteroids(zone.asteroids, zone.beltCenter);
    this.asteroids.setDetail(this.quality.level !== 'low');
    this.worldRoot.add(this.planets.group, this.station.group, this.asteroids.group);
    this.hud.setZoneName(zone.name);
    // Compile every shader now rather than stalling on the first shot, the
    // first kill or the first ship of a class.
    this.precompile();
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
        // A refused trade at the station is no alarm.
        if (m.tone === 'warn' && !this.docked) this.audio.alarm();
        break;
      case 'pilot': {
        const was = this.pilot?.docked ?? null;
        if (cargoTotal(m.pilot.cargo) > (this.pilot ? cargoTotal(this.pilot.cargo) : 0)) this.mineProgress = 0;
        this.pilot = m.pilot;
        this.stationPanel.setPilot(m.pilot);
        if (m.pilot.docked !== was) this.dockChanged(m.pilot.docked);
        break;
      }
      case 'market':
        this.seenMarkets.set(m.market.station, { market: m.market, at: performance.now() });
        this.stationPanel.setMarket(m.market);
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
    const dock = keyLabel(s.bindings.dock, s.layout);
    this.hud.setKeyLabels({ dock, mine: keyLabel(s.bindings.mine, s.layout) });
    this.stationPanel.setUndockKey(dock);
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

  /**
   * One frame. Called from requestAnimationFrame with its timestamp, which is
   * aligned on the display refresh (performance.now() jitters by a few ms).
   */
  frame(timestamp?: number) {
    this.timer.update(timestamp);
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.time += dt;
    this.fps += (1 / Math.max(dt, 1e-4) - this.fps) * 0.05;
    this.debug.frames++;

    if (!this.zone) this.buildWorld(DEFAULT_SECTOR_SEED);
    if (this.bench) {
      this.bench.frame(timestamp ?? performance.now());
      return;
    }
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
    if (this.input.consume('dock') && this.running) this.toggleDock();
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
      const send = this.paused || this.docked ? { ...neutralInput(), flightAssist: input.flightAssist } : input;
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
      predicted.velocity.copy(this.predictor.renderVelocity);
      this.myRenderPos.copy(predicted.position);
      this.hasMyPose = true;
    }

    // 4) Ship views
    for (const [id, s] of ships) {
      let view = this.views.get(id);
      if (!view) {
        // One engine light for the pilot at a time (the light count is part of every compiled shader).
        if (id === this.myShipId) this.disposeParked();
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
      const cls = statsOfPacked(s.snap.classId, s.snap.u);
      const hullFrac = s.snap.hull / cls.hull;
      view.setDamage(1 - hullFrac);
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
    this.updateBeams(ships, dt);

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
      this.cam.update(dt, me.position, me.rotation, me.snap.boosting, me.velocity, this.input.cursor, statsOfPacked(me.snap.classId, me.snap.u).radius / 9);
      this.lastMe = me;
      this.audio.engineUpdate(Math.max(0, me.snap.throttle), me.snap.boosting);
      const hullFrac = me.snap.hull / statsOfPacked(me.snap.classId, me.snap.u).hull;
      this.alarmIn -= dt;
      if (hullFrac < 0.25 && this.alarmIn <= 0) {
        this.audio.alarm();
        this.alarmIn = 1.4;
      }
      this.autoTarget(me, ships);
    } else if (this.docked) {
      this.audio.engineUpdate(0, false);
      this.dockedCamera(dt);
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
    const mining = me ? this.miningInfo(me, input, dt) : null;
    this.audio.miningUpdate(mining?.state === 'active' ? 1 : 0);
    const dock = me ? this.dockGuide(me) : null;
    this.dockable = !!dock?.inZone;

    // 7) World animation
    const camPos = this.cam.camera.position;
    this.sky?.update(this.cam.camera);
    for (const v of this.stationViews.values()) v.update(this.renderTime, this.cam.camera.position);
    this.planets?.update(this.renderTime);
    this.asteroids?.update(this.renderTime);
    this.lasers.update(this.renderTime, this.cam.camera.position);
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
        respawnIn: this.respawnIn,
        stations: this.zone.stations,
        fps: this.fps,
        net: `${Math.round(this.pixelRatio * 100)}%`,
        status: transport?.status ?? { state: 'local', rtt: 0 },
        online: transport?.online ?? false,
        players: this.playersByShip,
        playerCount: this.players.filter((p) => p.online).length,
        maxPlayers: this.maxPlayers,
        myName: this.myName,
        pilot: this.pilot,
        dock,
        mining,
      },
      dt,
    );
    this.hud.showScoreboard(this.running && !this.paused && this.input.held('scoreboard'), this.players, this.myName, transport?.online ?? false, this.stats);
    this.damageFx = Math.max(0, this.damageFx - dt * 2);
    this.adaptResolution(dt);
    this.debug.ships = ships.size;
    this.renderScene(this.damageFx);
    this.checkOutput();
  }

  private renderScene(damage: number) {
    updateBatches();
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
    if (this.paused) return;
    // The sample arrives a few frames after it was taken (no GPU stall).
    const max = this.probe.poll();
    if (max !== null) this.judgeOutput(max);
    const every = this.outputChecks < 10 ? 20 : 90;
    if (this.probe.busy || this.framesRunning < 20 || this.framesRunning % every !== 0) return;
    this.outputChecks++;
    this.renderer.setRenderTarget(null);
    this.probe.start();
  }

  private judgeOutput(max: number) {
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
      this.precompile();
    }
    this.gfx.fallbacks++;
    console.warn(`NEBULA: image noire détectée, passage au rendu de secours « ${this.renderPath} ».`);
    this.hud.notice('Mode graphique de secours activé', 'warn');
  }

  /** The graphics card as the browser names it. */
  gpuName() {
    const gl = this.renderer.getContext();
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    } catch {
      return '?';
    }
  }

  /**
   * Runs the scripted performance test at each quality level in turn. The
   * game is not connected to any server meanwhile; reload to play again.
   */
  startBenchmark(levels: QualityLevel[], cb: BenchCallbacks) {
    if (!this.zone) this.buildWorld(DEFAULT_SECTOR_SEED);
    const zone = this.zone!;
    this.hud.show(false);
    this.bench = new Benchmark(
      {
        scene: this.scene,
        camera: this.cam.camera,
        renderer: this.renderer,
        lasers: this.lasers,
        effects: this.effects,
        stationPos: zone.station.position,
        setQuality: (level) => this.setQuality(level),
        pixelRatio: () => this.pixelRatio,
        renderPath: () => this.renderPath,
        gpuName: () => this.gpuName(),
        animateWorld: (time, dt, camPos, camVel) => {
          this.sky?.update(this.cam.camera);
          for (const v of this.stationViews.values()) v.update(time, camPos);
          this.planets?.update(time);
          this.asteroids?.update(time);
          this.lasers.update(time, camPos);
          this.effects.update(dt);
          this.dust.update(camPos, camVel);
        },
        render: () => {
          this.renderScene(0);
          this.checkOutput();
        },
      },
      levels,
      cb,
    );
  }

  /** One line describing the graphics setup, shown in the pause menu (and with ?diag). */
  graphicsInfo() {
    const gpu = this.gpuName();
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
        this.effects.muzzle(_p, new THREE.Vector3(...e.vel).multiplyScalar(0.05), e.faction === 'union' ? UNION_BOLT : RAIDER_BOLT, e.shooter === this.myShipId);
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
          view?.hullHit(_p);
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

  /**
   * Mining beams of every ship whose snapshot says it mines, from the nose of
   * the drawn ship to the rock's surface, with sparks where they bite.
   */
  private updateBeams(ships: Map<number, InterpolatedShip>, dt: number) {
    const zone = this.zone!;
    const camPos = this.cam.camera.position;
    this.sparkClock += dt;
    const spark = this.sparkClock >= 0.045;
    if (spark) this.sparkClock = 0;
    let n = 0;
    for (const [id, s] of ships) {
      const m = s.snap.m;
      const rock = m !== undefined ? zone.asteroids[m] : undefined;
      const view = this.views.get(id);
      if (!rock || !view) continue;
      const seg = (this.beamList[n] ??= { from: new THREE.Vector3(), to: new THREE.Vector3() });
      _q.copy(view.group.quaternion);
      seg.from.set(0, 0, -statsOfPacked(s.snap.classId, s.snap.u).radius * 0.6).applyQuaternion(_q).add(view.group.position);
      _fwd.set(0, 0, -1).applyQuaternion(_q);
      _end.copy(seg.from).addScaledVector(_fwd, MINING_RANGE);
      const t = segmentSphere(seg.from, _end, rock.position, rock.radius);
      // Interpolation can drift the nose off the rock by a hair: aim at its nearest surface point then.
      if (t >= 0) seg.to.copy(seg.from).addScaledVector(_fwd, t * MINING_RANGE);
      else seg.to.copy(seg.from).sub(rock.position).setLength(rock.radius).add(rock.position);
      n++;
      if (spark && seg.to.distanceTo(camPos) < 2500) {
        _normal.copy(seg.to).sub(rock.position).normalize();
        this.effects.miningSpark(seg.to, _normal, Math.random() < 0.15);
      }
    }
    this.beams.update(this.time, this.beamList, n, camPos);
  }

  /** What the beam does, or would do, for the HUD. */
  private miningInfo(me: InterpolatedShip, input: ShipInput, dt: number): MiningInfo | null {
    const zone = this.zone!;
    const active = me.snap.m !== undefined;
    const probe = { classId: me.snap.classId, mods: unpackMods(me.snap.u), position: me.position, rotation: me.rotation } as unknown as Ship;
    const hit = this.grid ? miningTarget(probe, this.grid, zone.asteroids) : null;
    if (!input.mine && !active && !hit) return null;
    const index = active ? me.snap.m! : hit?.index;
    const rock = index !== undefined ? zone.asteroids[index] : undefined;
    const speed = me.velocity.length();
    const full = !!this.pilot && cargoTotal(this.pilot.cargo) >= this.pilot.capacity;
    let state: MiningInfo['state'];
    if (!input.mine && !active) {
      // A hint only when the ship could actually mine it.
      if (speed > MINING_MAX_SPEED * 2) return null;
      state = 'aim';
    } else if (full) state = 'full';
    else if (active) state = 'active';
    else if (input.fire) state = 'fire';
    else if (speed > MINING_MAX_SPEED) state = 'speed';
    else if (!hit) state = 'none';
    // Held, in range and slow: the server's answer is on its way.
    else state = 'active';
    const rate = index !== undefined ? MINING_RATE * statsOfPacked(me.snap.classId, me.snap.u).miningRate * richness(index) : 0;
    if (state === 'active') this.mineProgress = Math.min(0.98, this.mineProgress + rate * dt);
    return {
      state,
      ore: rock ? ITEMS[oreOf(rock.variant)].label : '',
      richness: index !== undefined ? richnessLabel(richness(index)) : '',
      distance: hit && hit.index === index ? hit.distance : rock ? Math.max(0, me.position.distanceTo(rock.position) - rock.radius) : 0,
      rate,
      progress: this.mineProgress,
    };
  }

  /** The nearest hangar mouth and whether the ship may dock there now. */
  private dockGuide(me: InterpolatedShip): DockGuide | null {
    let best: DockGuide | null = null;
    for (const st of this.zone!.stations) {
      const d = me.position.distanceTo(st.dock.mouth);
      if (best && best.distance <= d) continue;
      best = { name: st.name, mouth: st.dock.mouth, distance: d, inZone: d <= st.dock.radius, speed: me.velocity.length(), maxSpeed: DOCK_MAX_SPEED };
    }
    return best;
  }

  /** Docked: the ship on its pad, seen from inside the hangar. */
  private dockedCamera(dt: number) {
    const view = this.pilot?.docked ? this.stationViews.get(this.pilot.docked) : undefined;
    if (!view) return;
    // A ship swapped at the shipyard rolls onto the pad.
    const shipClass = this.pilot?.ship ?? this.lastMe?.snap.classId ?? 'falcon';
    if (this.parked && this.parked.classId !== shipClass) this.disposeParked();
    if (!this.parked) {
      this.parked = new ShipView(shipClass, this.scene, true);
      this.parked.teleported();
    }
    const c = this.cam.camera;
    view.dockedView(this.time, this.parked.group.position, c.position, _camTarget);
    view.parkedRotation(this.parked.group.quaternion);
    this.parked.update(dt, this.time, 0, false, c.position);
    c.up.set(0, 1, 0);
    c.lookAt(_camTarget);
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
    for (const v of this.stationViews.values()) v.update(this.time);
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
