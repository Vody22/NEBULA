import { AudioEngine, LoopVoice, type Vec3 } from './AudioEngine';
import { sensorCurve } from './mix';

export type ViewMode = 'chase' | 'close' | 'cinematic';

export interface EngineInput {
  dt: number;
  /** Our ship exists and flies (not docked, not destroyed). */
  present: boolean;
  /** Throttle -0.4..1 from the snapshot. */
  throttle: number;
  /** Speed over the class's cruise speed (above 1 while boosting). */
  speed: number;
  boosting: boolean;
  /** Lateral thrusters and rotation demand, 0..1. */
  thrusters: number;
  /** Energy and hull, 0..1. */
  energy: number;
  hull: number;
  view: ViewMode;
  /** Our mining beam biting into a rock, 0..1. */
  mining: number;
}

interface Osc {
  osc: OscillatorNode;
  gain: GainNode;
}

/**
 * Our own ship's drive, built from layers that each answer one part of the
 * flight model, so it never sounds like one repeating loop:
 *
 * - sub and structure: the hull vibrating around the pilot (stronger in the close view);
 * - core: the reactor loop, pitch and brightness follow the load;
 * - turbine: the whine of the pumps, rising with throttle and boost;
 * - roar: the exhaust as the cockpit sensors render it, louder when accelerating;
 * - boost: an extra burner with its own ignition and release;
 * - thrusters: puffs of the manoeuvring jets (strafe, rotation, braking);
 * - damage rattle: loose panels once the hull is below half;
 * - instability: the drive sputters when boosting on an empty capacitor.
 *
 * Starting and stopping (undocking, docking, destruction) spin the drive up and down.
 */
export class EngineSound {
  private sub: Osc;
  private struct: Osc & { osc2: OscillatorNode };
  private core: LoopVoice;
  private turbine: Osc & { osc2: OscillatorNode; bp: BiquadFilterNode };
  private roar: LoopVoice;
  private boost: LoopVoice;
  private boostTone: Osc;
  private rcs: LoopVoice;
  private rattle: LoopVoice;
  private beam: LoopVoice;
  private beamHum: Osc;
  /** 0 off .. 1 running: spins with starts and stops. */
  private power = 0;
  private boostEnv = 0;
  private accel = 0;
  private retro = 0;
  private lastThrottle = 0;
  private wasBoosting = false;
  private wasPresent = false;
  private view = { interior: 0, wide: 0 };
  private sputter = 1;
  private clock = 0;

  constructor(private a: AudioEngine) {
    const ctx = a.ctx!;
    const bus = a.bus.engines;
    const mkOsc = (type: OscillatorType, f: number): Osc => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = f;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      osc.start();
      return { osc, gain };
    };

    this.sub = mkOsc('sine', 36);
    this.sub.gain.connect(bus);

    // Two close low tones through a soft clipper: a hull that hums, not a pure tone.
    const s1 = mkOsc('sine', 23);
    const osc2 = ctx.createOscillator();
    osc2.frequency.value = 31.5;
    osc2.connect(s1.gain);
    osc2.start();
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClip(2.5);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 140;
    const structOut = ctx.createGain();
    structOut.gain.value = 0;
    s1.gain.gain.value = 0.6;
    s1.gain.connect(shaper).connect(lp).connect(structOut).connect(bus);
    this.struct = { osc: s1.osc, osc2, gain: structOut };

    this.core = new LoopVoice(a, a.buffer('loop_union')!, 'engines', { freq: 600, q: 1.2 });

    const t1 = mkOsc('triangle', 1100);
    const t2 = ctx.createOscillator();
    t2.type = 'sine';
    t2.frequency.value = 1107;
    t2.connect(t1.gain);
    t2.start();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 3;
    const turbOut = ctx.createGain();
    turbOut.gain.value = 0;
    t1.gain.gain.value = 0.5;
    t1.gain.connect(bp).connect(turbOut).connect(bus);
    this.turbine = { osc: t1.osc, osc2: t2, gain: turbOut, bp };

    this.roar = new LoopVoice(a, a.noise, 'engines', { type: 'bandpass', freq: 500, q: 0.8 });
    this.boost = new LoopVoice(a, a.noise, 'engines', { type: 'highpass', freq: 1800, q: 0.6 });
    this.boostTone = mkOsc('sawtooth', 160);
    const btLp = ctx.createBiquadFilter();
    btLp.type = 'lowpass';
    btLp.frequency.value = 900;
    this.boostTone.gain.connect(btLp).connect(bus);
    this.rcs = new LoopVoice(a, a.noise, 'engines', { type: 'bandpass', freq: 3200, q: 1.4 });
    this.rattle = new LoopVoice(a, a.noise, 'engines', { type: 'bandpass', freq: 190, q: 7 });

    // Mining beam: a buzzing hum over grinding noise (weapons bus: it is a tool of the ship).
    this.beam = new LoopVoice(a, a.noise, 'weapons', { type: 'bandpass', freq: 900, q: 1.2 });
    this.beamHum = mkOsc('square', 118);
    this.beamHum.gain.connect(this.beam.filter);
  }

  update(i: EngineInput) {
    const dt = Math.min(0.1, Math.max(0, i.dt));
    this.clock += dt;
    const t = this.a.now;

    // Start-up / shut-down: the drive spins up in ~1.2 s, winds down in ~1.8 s.
    if (i.present !== this.wasPresent) {
      this.wasPresent = i.present;
      if (i.present) this.a.play('boost_start', { bus: 'engines', gain: 0.25, rate: 0.6, importance: 2 });
    }
    this.power += ((i.present ? 1 : 0) - this.power) * Math.min(1, dt * (i.present ? 2.2 : 1.3));
    const pw = this.power;

    const thr = Math.max(0, i.throttle);
    const dThr = (i.throttle - this.lastThrottle) / Math.max(dt, 1e-3);
    this.lastThrottle = i.throttle;
    // Throttle pushed up: a burst of exhaust; pulled back: the braking jets fire.
    if (i.present && dThr > 0.4) this.accel = Math.min(1, this.accel + dThr * dt * 1.5);
    if (i.present && dThr < -0.4) this.retro = Math.min(1, this.retro + -dThr * dt * 1.5);
    this.accel *= Math.exp(-dt * 2.2);
    this.retro *= Math.exp(-dt * 3);

    if (i.boosting && !this.wasBoosting && i.present) this.a.play('boost_start', { bus: 'engines', gain: 0.7, importance: 2 });
    this.wasBoosting = i.boosting;
    this.boostEnv += ((i.boosting && i.present ? 1 : 0) - this.boostEnv) * Math.min(1, dt * (i.boosting ? 6 : 1.4));
    const boost = this.boostEnv;

    // Load: what the drive works at, 0 idle .. ~1.6 full boost.
    const load = Math.min(1.6, thr * 0.8 + Math.min(1.2, i.speed) * 0.2 + boost * 0.6 + this.accel * 0.2);

    // Empty capacitor while boosting: the drive chokes in irregular dips.
    if (i.boosting && i.energy < 0.2) {
      if (Math.random() < dt * 9) this.sputter = 0.25 + Math.random() * 0.4;
    }
    this.sputter += (1 - this.sputter) * Math.min(1, dt * 7);

    const v = this.view;
    v.interior += ((i.view === 'close' ? 1 : 0) - v.interior) * Math.min(1, dt * 3);
    v.wide += ((i.view === 'cinematic' ? 1 : 0) - v.wide) * Math.min(1, dt * 3);
    const outside = 1 - v.interior * 0.4 - v.wide * 0.25;
    const body = 0.7 + v.interior * 0.6 - v.wide * 0.3;

    const spin = 0.35 + 0.65 * pw;
    const tc = 0.12;
    this.sub.osc.frequency.setTargetAtTime((34 + load * 16) * spin, t, 0.25);
    this.sub.gain.gain.setTargetAtTime(pw * (0.05 + load * 0.15) * body, t, 0.2);
    this.struct.osc.frequency.setTargetAtTime((21 + load * 7) * spin, t, 0.3);
    this.struct.osc2.frequency.setTargetAtTime((29 + load * 9) * spin, t, 0.3);
    this.struct.gain.gain.setTargetAtTime(pw * (0.015 + load * 0.08 + boost * 0.06) * body, t, 0.2);

    this.core.rate((0.72 + load * 0.42) * spin, 0.25);
    this.core.freq((260 + load * 1900) * (1 - v.interior * 0.45) * spin, 0.2);
    this.core.set(pw * (0.06 + load * 0.28) * this.sputter, 0.06);

    const tf = (850 + load * 1300 + boost * 600) * spin;
    this.turbine.osc.frequency.setTargetAtTime(tf, t, 0.3);
    this.turbine.osc2.frequency.setTargetAtTime(tf * 1.0065 + 3, t, 0.3);
    this.turbine.bp.frequency.setTargetAtTime(tf * 1.3, t, 0.3);
    this.turbine.gain.gain.setTargetAtTime(pw * (0.004 + load * load * 0.018) * outside * this.sputter, t, tc);

    this.roar.freq(260 + load * 1000 + this.accel * 600, 0.15);
    this.roar.set(pw * (thr * 0.1 + this.accel * 0.22 + boost * 0.1) * outside, 0.08);

    this.boost.freq(1500 + boost * 2500, 0.2);
    this.boost.set(boost * 0.1 * outside * this.sputter, 0.05);
    this.boostTone.osc.frequency.setTargetAtTime(140 + boost * 120, t, 0.3);
    this.boostTone.gain.gain.setTargetAtTime(boost * 0.03 * this.sputter, t, 0.08);

    // Jets fire in short puffs, not a steady hiss.
    const puff = 0.55 + 0.45 * Math.sin(this.clock * 31) * Math.sin(this.clock * 17.3);
    const jets = Math.min(1, i.thrusters + this.retro);
    this.rcs.freq(2600 + jets * 1200, 0.05);
    this.rcs.set(pw * jets * 0.07 * puff * outside, 0.03);

    const damage = Math.max(0, 0.5 - i.hull) * 2;
    const shake = 0.4 + 0.6 * Math.abs(Math.sin(this.clock * 23) * Math.sin(this.clock * 7.7));
    this.rattle.set(pw * damage * (0.03 + load * 0.05) * shake * body, 0.03);

    this.beam.set(i.mining * 0.16, i.mining > 0 ? 0.06 : 0.15);
    this.beam.freq(700 + i.mining * 500 + Math.random() * 150, 0.1);
    this.beamHum.gain.gain.setTargetAtTime(i.mining * 0.05, t, 0.06);
  }
}

/** One nearby ship's drive, as our sensors render it. */
interface Remote {
  voice: LoopVoice;
  seen: number;
}

/**
 * Other ships' engines: only the few closest are given a voice (each is a
 * placed loop); the others are virtual (silent, no nodes) until they come close.
 */
export class RemoteEngines {
  private live = new Map<number, Remote>();
  private frame = 0;

  constructor(
    private a: AudioEngine,
    private max = 4,
  ) {}

  update(ships: { id: number; at: Vec3; raider: boolean; throttle: number; boosting: boolean }[]) {
    this.frame++;
    const near = ships
      .map((s) => ({ s, d: this.a.distanceTo(s.at) }))
      .filter((x) => x.d < 650)
      .sort((x, y) => x.d - y.d)
      .slice(0, this.max);
    for (const { s, d } of near) {
      let r = this.live.get(s.id);
      if (!r) {
        const buf = this.a.buffer(s.raider ? 'loop_raider' : 'loop_union');
        if (!buf) continue;
        r = { voice: new LoopVoice(this.a, buf, 'engines', { freq: 1200, at: s.at }), seen: 0 };
        this.live.set(s.id, r);
      }
      r.seen = this.frame;
      const c = sensorCurve(d, 70, 650);
      const load = Math.max(0, s.throttle) + (s.boosting ? 0.6 : 0);
      r.voice.place(s.at);
      r.voice.freq(c.cutoff * (0.3 + load * 0.3), 0.15);
      r.voice.rate(0.85 + load * 0.35, 0.3);
      r.voice.set(c.gain * (0.12 + load * 0.16) * (this.a.occluded(s.at) ? 0.3 : 1), 0.15);
    }
    for (const [id, r] of this.live) {
      if (r.seen !== this.frame) {
        r.voice.dispose(0.4);
        this.live.delete(id);
      }
    }
  }

  get count() {
    return this.live.size;
  }

  clear() {
    for (const r of this.live.values()) r.voice.dispose(0.2);
    this.live.clear();
  }
}

function softClip(k: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
}
