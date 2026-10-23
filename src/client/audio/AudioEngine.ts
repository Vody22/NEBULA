import { BUSES, BUS_ROUTING, DEFAULT_MIX, VoiceLimiter, priorityOf, sensorCurve, type BusId, type MixLevels } from './mix';
import { RECIPES, renderRecipe, type SoundId } from './recipes';

/**
 * The Web Audio side: one context, the mixing buses, the sound bank and the
 * one-shot voices with their 3D placement.
 *
 *   sources → bus (per category) → group (duck · pause) → master volume
 *           → limiter → analyser → speakers
 *   groups (world, beds, voice) ──send──→ room reverb (hangar) ──↗
 *
 * Every gain change is a short ramp (no clicks); every voice disconnects
 * itself when it ends (no leaks); the number of voices is capped by priority.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlayOptions {
  bus: BusId;
  /** World position. Absent: our own ship or the interface (centred, unfiltered). */
  at?: Vec3;
  gain?: number;
  /** Playback rate (pitch). */
  rate?: number;
  /** 0..5, decides which sound survives when too many play (default 1). */
  importance?: number;
  /** Voice-limit category (default: the bus). */
  category?: string;
  /** Distance (m) where the sensor rendering starts to fade, and where it ends. */
  ref?: number;
  range?: number;
  /** Seconds from now. */
  delay?: number;
  /** Stereo position for centred sounds, -1..1. */
  pan?: number;
}

type Group = 'fx' | 'music' | 'ambience' | 'voice' | 'ui';
const GROUP_OF: Record<BusId, Group> = {
  music: 'music',
  engines: 'fx',
  weapons: 'fx',
  impacts: 'fx',
  explosions: 'fx',
  ambience: 'ambience',
  ui: 'ui',
  voice: 'voice',
  comms: 'voice',
};

/** Sounds rendered first: what combat and flight need, then the rest. */
const LOAD_ORDER: SoundId[] = [
  'loop_union',
  'loop_raider',
  'laser_falcon',
  'laser_warden',
  'laser_raider',
  'laser_marauder',
  'shield_hit',
  'hull_hit',
  'hull_hit_own',
  'explosion_small',
  'explosion_medium',
  'explosion_large',
  'ui_click',
  'ui_lock',
  'ui_notify',
];

interface Voice {
  src: AudioBufferSourceNode;
  out: GainNode;
  hrtf: boolean;
  done: boolean;
}

const MAX_VOICES = 40;
const PER_CATEGORY: Record<string, number> = {
  weapons: 12,
  impacts: 10,
  explosions: 6,
  ui: 4,
  voice: 2,
  comms: 2,
  ambience: 5,
  engines: 6,
};
/** Full binaural rendering costs more: only for the closest important sources. */
const MAX_HRTF = 6;

export interface Occluder {
  center: Vec3;
  radius: number;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  readonly bus = {} as Record<BusId, GainNode>;
  private groups = {} as Record<Group, { duck: GainNode; state: GainNode }>;
  private master!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private analyser!: AnalyserNode;
  private scope = new Float32Array(1024);
  private room!: GainNode;
  private bank = new Map<SoundId, AudioBuffer[]>();
  private limiter_ = new VoiceLimiter<Voice>(MAX_VOICES, PER_CATEGORY);
  private hrtfInUse = 0;
  /** Static obstacles between the listener and a sound (stations, planets). */
  occluders: Occluder[] = [];
  readonly listener = { x: 0, y: 0, z: 0 };
  /** The listener's right-hand direction (for the stereo placement of distant sounds). */
  private right = { x: 1, y: 0, z: 0 };
  /** Kept so the browser loads its HRTF data at start-up, not on the first close shot. */
  private hrtfWarm: PannerNode | null = null;
  /** Shared noise for live layers (engine roar, beds). */
  noise!: AudioBuffer;
  loaded = 0;
  readonly total = Object.values(RECIPES).reduce((n, r) => n + r.variants, 0);
  ready: Promise<void> | null = null;
  private mix: MixLevels = { ...DEFAULT_MIX };
  private volume = 0.7;
  private muted = false;
  private paused = false;
  private hidden = false;
  private blurred = false;
  /** Diagnostics: voices started / ended, loudest sample seen, errors. */
  readonly stats = { started: 0, ended: 0, peak: 0, clipped: 0, errors: 0, skippedNotLoaded: 0 };

  /** Creates the context. Browsers keep it suspended until a user gesture: call `unlock` from one. */
  init(): boolean {
    if (this.ctx) return true;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return false;
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      return false;
    }
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    // Transparent safety limiter: catches stacked explosions, never pumps normal play.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -4;
    this.limiter.knee.value = 2;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.master.connect(this.limiter).connect(this.analyser).connect(ctx.destination);

    // Glue compression on the effects group keeps combat dense but readable.
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -16;
    glue.knee.value = 8;
    glue.ratio.value = 3;
    glue.attack.value = 0.006;
    glue.release.value = 0.25;
    glue.connect(this.master);

    // Room reverb (hangars), generated: no impulse file.
    const verb = ctx.createConvolver();
    verb.buffer = roomImpulse(ctx, 2.4);
    this.room = ctx.createGain();
    this.room.gain.value = 0;
    const ret = ctx.createGain();
    ret.gain.value = 0.55;
    this.room.connect(verb).connect(ret).connect(this.master);
    for (const g of ['fx', 'music', 'ambience', 'voice', 'ui'] as Group[]) {
      const duck = ctx.createGain();
      const state = ctx.createGain();
      duck.connect(state).connect(g === 'fx' ? glue : this.master);
      // Inside a hangar the world sounds (not the music or the interface) take the hall's reverb.
      if (g === 'fx' || g === 'ambience' || g === 'voice') state.connect(this.room);
      this.groups[g] = { duck, state };
    }
    for (const b of BUSES) {
      const g = ctx.createGain();
      g.connect(this.groups[GROUP_OF[b]].duck);
      this.bus[b] = g;
    }

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let s = 0x2545f491;
    for (let i = 0; i < d.length; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      d[i] = (s >>> 0) / 4294967296 - 0.5;
    }
    this.hrtfWarm = ctx.createPanner();
    this.hrtfWarm.panningModel = 'HRTF';
    this.applyLevels(0);
    this.ready = this.loadBank();
    return true;
  }

  /** From a click or key press: lets the context play. */
  unlock() {
    if (!this.init()) return;
    if (this.ctx!.state === 'suspended' && !this.hidden) this.ctx!.resume().catch(() => {});
  }

  get running() {
    return this.ctx?.state === 'running';
  }

  get now() {
    return this.ctx?.currentTime ?? 0;
  }

  /** Renders every recipe, one at a time, between frames (never a long main-thread block). */
  private async loadBank() {
    const order = [...LOAD_ORDER, ...(Object.keys(RECIPES) as SoundId[]).filter((id) => !LOAD_ORDER.includes(id))];
    for (const id of order) {
      const list: AudioBuffer[] = [];
      for (let v = 0; v < RECIPES[id].variants; v++) {
        try {
          list.push(await renderRecipe(id, v));
        } catch {
          this.stats.errors++;
        }
        this.loaded++;
        // Give the frame back between renders.
        await new Promise((r) => setTimeout(r, 0));
      }
      if (list.length) this.bank.set(id, list);
    }
  }

  has(id: SoundId) {
    return this.bank.has(id);
  }

  buffer(id: SoundId, variant = -1): AudioBuffer | null {
    const list = this.bank.get(id);
    if (!list) return null;
    return list[variant >= 0 ? variant % list.length : Math.floor(Math.random() * list.length)];
  }

  // ------------------------------------------------------------ levels

  setLevels(volume: number, muted: boolean, mix: MixLevels) {
    this.volume = volume;
    this.muted = muted;
    this.mix = { ...mix };
    this.applyLevels();
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.applyLevels();
  }

  get isMuted() {
    return this.muted;
  }

  /** Pause menu: the world goes quiet, the music steps back, the interface stays. */
  setPaused(p: boolean) {
    this.paused = p;
    this.applyLevels();
  }

  /** Window lost focus (another app in front): half volume. */
  setBlurred(b: boolean) {
    this.blurred = b;
    this.applyLevels();
  }

  /** Hidden tab: the context is suspended (no CPU, no sound); resumed when shown again. */
  setHidden(h: boolean) {
    this.hidden = h;
    if (!this.ctx) return;
    if (h) this.ctx.suspend().catch(() => {});
    else this.ctx.resume().catch(() => {});
  }

  private applyLevels(tc = 0.05) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const set = (p: AudioParam, v: number) => (tc > 0 ? p.setTargetAtTime(v, t, tc) : p.setValueAtTime(v, t));
    set(this.master.gain, this.muted ? 0 : this.volume * (this.blurred ? 0.5 : 1));
    for (const b of BUSES) set(this.bus[b].gain, this.mix[BUS_ROUTING[b].level] * BUS_ROUTING[b].trim);
    const p = this.paused;
    set(this.groups.fx.state.gain, p ? 0 : 1);
    set(this.groups.ambience.state.gain, p ? 0.25 : 1);
    set(this.groups.music.state.gain, p ? 0.45 : 1);
    set(this.groups.voice.state.gain, p ? 0 : 1);
    set(this.groups.ui.state.gain, 1);
  }

  /** Lowers a group for a moment (explosion close by, announcement over the music). */
  duck(group: Group, depth: number, hold: number, release = 0.6) {
    if (!this.ctx) return;
    const p = this.groups[group].duck.gain;
    const t = this.ctx.currentTime;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(depth, t + 0.04);
    p.setValueAtTime(depth, t + 0.04 + hold);
    p.linearRampToValueAtTime(1, t + 0.04 + hold + release);
  }

  /** Hangar reverb amount, 0 outside. */
  setRoom(amount: number, tc = 0.6) {
    if (this.ctx) this.room.gain.setTargetAtTime(amount, this.ctx.currentTime, tc);
  }


  // ------------------------------------------------------------ listener

  setListener(pos: Vec3, fwd: Vec3, up: Vec3) {
    this.listener.x = pos.x;
    this.listener.y = pos.y;
    this.listener.z = pos.z;
    // right = forward × up
    const rx = fwd.y * up.z - fwd.z * up.y;
    const ry = fwd.z * up.x - fwd.x * up.z;
    const rz = fwd.x * up.y - fwd.y * up.x;
    const rl = Math.hypot(rx, ry, rz) || 1;
    this.right.x = rx / rl;
    this.right.y = ry / rl;
    this.right.z = rz / rl;
    const l = this.ctx?.listener;
    if (!l || !this.ctx) return;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(pos.x, t);
      l.positionY.setValueAtTime(pos.y, t);
      l.positionZ.setValueAtTime(pos.z, t);
      l.forwardX.setValueAtTime(fwd.x, t);
      l.forwardY.setValueAtTime(fwd.y, t);
      l.forwardZ.setValueAtTime(fwd.z, t);
      l.upX.setValueAtTime(up.x, t);
      l.upY.setValueAtTime(up.y, t);
      l.upZ.setValueAtTime(up.z, t);
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  distanceTo(p: Vec3) {
    return Math.hypot(p.x - this.listener.x, p.y - this.listener.y, p.z - this.listener.z);
  }

  /** True when a station or planet stands between the listener and `p`. */
  occluded(p: Vec3) {
    const a = this.listener;
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    const dz = p.z - a.z;
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 < 1) return false;
    for (const o of this.occluders) {
      const ox = o.center.x - a.x;
      const oy = o.center.y - a.y;
      const oz = o.center.z - a.z;
      const k = Math.min(1, Math.max(0, (ox * dx + oy * dy + oz * dz) / len2));
      const cx = ox - dx * k;
      const cy = oy - dy * k;
      const cz = oz - dz * k;
      // The source itself sitting inside the sphere's edge (a ship by the hull) is not hidden.
      if (k > 0.02 && k < 0.98 && cx * cx + cy * cy + cz * cz < o.radius * o.radius * 0.8) return true;
    }
    return false;
  }

  /**
   * Stereo position of a world point, -1..1. Kept within ±0.75: a sensor
   * rendering is never hard-panned into one ear.
   */
  panOf(at: Vec3) {
    const dx = at.x - this.listener.x;
    const dy = at.y - this.listener.y;
    const dz = at.z - this.listener.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1) return 0;
    return ((dx * this.right.x + dy * this.right.y + dz * this.right.z) / d) * 0.75;
  }

  /** A binaural panner for a close, important source (the browser's HRTF). */
  panner(at: Vec3, hrtf: boolean): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = hrtf ? 'HRTF' : 'equalpower';
    // Distance attenuation is ours (sensorCurve): the panner only places the sound.
    p.distanceModel = 'linear';
    p.rolloffFactor = 0;
    p.refDistance = 1;
    p.maxDistance = 100000;
    if (p.positionX) {
      p.positionX.value = at.x;
      p.positionY.value = at.y;
      p.positionZ.value = at.z;
    } else p.setPosition(at.x, at.y, at.z);
    return p;
  }

  // ------------------------------------------------------------ one-shots

  /** Plays a sound from the bank. Returns false when not played (too far, out of voices, not loaded yet). */
  play(id: SoundId, o: PlayOptions): boolean {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return false;
    const buf = this.buffer(id);
    if (!buf) {
      this.stats.skippedNotLoaded++;
      return false;
    }
    let level = o.gain ?? 1;
    let cutoff = 20000;
    let dist = 0;
    if (o.at) {
      dist = this.distanceTo(o.at);
      const s = sensorCurve(dist, o.ref ?? 120, o.range ?? 1500);
      if (s.gain < 0.004) return false;
      level *= s.gain;
      cutoff = s.cutoff;
      if (this.occluded(o.at)) {
        level *= 0.35;
        cutoff = Math.min(cutoff, 700);
      }
    }
    const req = { category: o.category ?? o.bus, priority: priorityOf((o.importance ?? 1) * Math.sqrt(level + 0.01), dist) };
    const now = ctx.currentTime;
    const { ok, steal } = this.limiter_.request(req, now);
    if (!ok) return false;
    if (steal) this.release(steal, 0.03);

    const t = now + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const rate = (o.rate ?? 1) * (1 + (Math.random() - 0.5) * 0.04);
    src.playbackRate.value = rate;
    const out = ctx.createGain();
    out.gain.setValueAtTime(level, t);
    let node: AudioNode = src;
    if (cutoff < 19000) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cutoff;
      node = node.connect(lp);
    }
    node.connect(out);
    let hrtf = false;
    if (o.at) {
      hrtf = dist < 350 && (o.importance ?? 1) >= 1 && this.hrtfInUse < MAX_HRTF;
      if (hrtf) this.hrtfInUse++;
      if (hrtf) out.connect(this.panner(o.at, true)).connect(this.bus[o.bus]);
      else {
        const sp = ctx.createStereoPanner();
        sp.pan.value = this.panOf(o.at);
        out.connect(sp).connect(this.bus[o.bus]);
      }
    } else if (o.pan) {
      const sp = ctx.createStereoPanner();
      sp.pan.value = o.pan;
      out.connect(sp).connect(this.bus[o.bus]);
    } else out.connect(this.bus[o.bus]);

    const voice: Voice = { src, out, hrtf, done: false };
    src.onended = () => this.ended(voice);
    src.start(t);
    this.stats.started++;
    this.limiter_.commit(req, voice, t + buf.duration / rate);
    return true;
  }

  private ended(v: Voice) {
    if (v.done) return;
    v.done = true;
    this.stats.ended++;
    if (v.hrtf) this.hrtfInUse--;
    v.src.onended = null;
    v.src.disconnect();
    v.out.disconnect();
  }

  private release(v: Voice, fade: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setValueAtTime(v.out.gain.value, t);
    v.out.gain.linearRampToValueAtTime(0, t + fade);
    try {
      v.src.stop(t + fade + 0.01);
    } catch {
      /* already stopped */
    }
  }

  /** Voices playing now, and the counters (diagnostics, tests). */
  report() {
    this.limiter_.prune(this.now);
    return {
      state: this.ctx?.state ?? 'none',
      voices: this.limiter_.count,
      hrtf: this.hrtfInUse,
      dropped: this.limiter_.dropped,
      stolen: this.limiter_.stolen,
      loaded: this.loaded,
      total: this.total,
      ...this.stats,
    };
  }

  /** The final output (after the limiter), for recording in the audio lab. */
  get output(): AudioNode | null {
    return this.ctx ? this.analyser : null;
  }

  /** Tracks the loudest output sample (should stay under 1: the limiter holds it). */
  meter() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.analyser.getFloatTimeDomainData(this.scope);
    let m = 0;
    for (let i = 0; i < this.scope.length; i++) m = Math.max(m, Math.abs(this.scope[i]));
    if (m > this.stats.peak) this.stats.peak = m;
    if (m >= 1) this.stats.clipped++;
  }
}

/**
 * A continuous sound (engine layer, beam, bed): a looped buffer through a
 * filter and a gain, optionally placed in 3D. Parameters glide, never jump.
 */
export class LoopVoice {
  readonly src: AudioBufferSourceNode;
  readonly filter: BiquadFilterNode;
  readonly gain: GainNode;
  private pan: StereoPannerNode | null = null;
  private stopped = false;

  constructor(
    private engine: AudioEngine,
    buffer: AudioBuffer,
    bus: BusId,
    opts: { type?: BiquadFilterType; freq?: number; q?: number; at?: Vec3; offset?: number } = {},
  ) {
    const ctx = engine.ctx!;
    this.src = ctx.createBufferSource();
    this.src.buffer = buffer;
    this.src.loop = true;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = opts.type ?? 'lowpass';
    this.filter.frequency.value = opts.freq ?? 20000;
    this.filter.Q.value = opts.q ?? 0.7;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.src.connect(this.filter).connect(this.gain);
    if (opts.at) {
      this.pan = ctx.createStereoPanner();
      this.pan.pan.value = engine.panOf(opts.at);
      this.gain.connect(this.pan).connect(engine.bus[bus]);
    } else this.gain.connect(engine.bus[bus]);
    this.src.start(ctx.currentTime, opts.offset ?? Math.random() * buffer.duration);
  }

  set(gain: number, tc = 0.1) {
    if (this.stopped) return;
    this.gain.gain.setTargetAtTime(Math.max(0, gain), this.engine.now, tc);
  }

  freq(f: number, tc = 0.1) {
    if (!this.stopped) this.filter.frequency.setTargetAtTime(Math.max(20, f), this.engine.now, tc);
  }

  rate(r: number, tc = 0.1) {
    if (!this.stopped) this.src.playbackRate.setTargetAtTime(Math.max(0.05, r), this.engine.now, tc);
  }

  place(at: Vec3) {
    if (!this.pan || this.stopped) return;
    this.pan.pan.setTargetAtTime(this.engine.panOf(at), this.engine.now, 0.05);
  }


  /** Fades out, then frees every node. */
  dispose(fade = 0.3) {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.engine.now;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(0, t + fade);
    this.src.stop(t + fade + 0.02);
    this.src.onended = () => {
      this.src.disconnect();
      this.filter.disconnect();
      this.gain.disconnect();
      this.pan?.disconnect();
    };
  }
}

/** Stereo impulse of a large metal hall: early reflections, then a dark diffuse tail. */
function roomImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let s = 0x1234567 + ch * 977;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const w = (s >>> 0) / 4294967296 - 0.5;
      const k = i / n;
      // The tail darkens as it decays (steel absorbs highs first).
      const a = 0.25 + 0.7 * k;
      lp += (w - lp) * (1 - a);
      d[i] = lp * Math.pow(1 - k, 3.2) * 0.9;
    }
    // Early reflections off the hangar walls.
    for (const [ms, g] of [
      [11, 0.5],
      [23, 0.38],
      [37, 0.3],
      [52, 0.22],
      [71, 0.16],
    ] as const) {
      const i = Math.floor(((ms + ch * 3) / 1000) * ctx.sampleRate);
      if (i < n) d[i] += g * (ch ? -1 : 1);
    }
  }
  return b;
}
