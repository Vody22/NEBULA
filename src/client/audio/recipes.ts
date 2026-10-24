import { mulberry32 } from '../../shared/rng';

/**
 * Sound recipes, rendered once at start-up with OfflineAudioContext into
 * buffers (several variants each), then played many times for almost no CPU.
 * Every sound is layered (transient, body, sub, tail) rather than a bare
 * oscillator: that layering is what gives weight to a procedural sound.
 * No audio file is needed or referenced.
 */

type Ctx = OfflineAudioContext;
type Rand = () => number;

export interface Recipe {
  /** Seconds. */
  duration: number;
  variants: number;
  channels?: 1 | 2;
  build(c: Ctx, out: AudioNode, r: Rand): void;
  /** Post-process (seamless loops). */
  loop?: boolean;
}

const RATE = 44100;

// ---------------------------------------------------------------- helpers

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

function noiseBuffer(c: BaseAudioContext): AudioBuffer {
  let b = noiseCache.get(c);
  if (b) return b;
  b = c.createBuffer(1, c.sampleRate * 3, c.sampleRate);
  const d = b.getChannelData(0);
  const r = mulberry32(0x5eed);
  for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
  noiseCache.set(c, b);
  return b;
}

/** Brownish noise (more low end): good for rumble and fire. */
function brownBuffer(c: BaseAudioContext): AudioBuffer {
  const b = c.createBuffer(1, c.sampleRate * 3, c.sampleRate);
  const d = b.getChannelData(0);
  const r = mulberry32(0xb40);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    last = (last + 0.02 * (r() * 2 - 1)) / 1.02;
    d[i] = last * 3.5;
  }
  return b;
}

function noise(c: Ctx, t: number, dur: number, r: Rand, brown = false): AudioBufferSourceNode {
  const s = c.createBufferSource();
  s.buffer = brown ? brownBuffer(c) : noiseBuffer(c);
  s.start(t, r() * 1.5, dur + 0.05);
  return s;
}

function gain(c: Ctx, v = 1): GainNode {
  const g = c.createGain();
  g.gain.value = v;
  return g;
}

function filter(c: Ctx, type: BiquadFilterType, f: number, q = 0.7): BiquadFilterNode {
  const b = c.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  return b;
}

function osc(c: Ctx, type: OscillatorType, f: number, t: number, dur: number): OscillatorNode {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}

/** Percussive envelope: fast attack, exponential decay to silence. */
function perc(g: GainNode, t: number, peak: number, attack: number, decay: number) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + Math.max(0.001, attack));
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function sweep(p: AudioParam, t: number, from: number, to: number, dur: number) {
  p.setValueAtTime(from, t);
  p.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
}

/** Soft saturation (tanh): adds harmonics and density without hard clipping. */
function drive(c: Ctx, amount: number): WaveShaperNode {
  const w = c.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  w.curve = curve;
  w.oversample = '2x';
  return w;
}

/** A metal resonance: a noise tick through a few narrow band-passes (modal synthesis). */
function metal(c: Ctx, out: AudioNode, t: number, r: Rand, base: number, level: number, ring: number) {
  const exc = noise(c, t, 0.03, r);
  const eg = gain(c);
  perc(eg, t, 1, 0.001, 0.02);
  exc.connect(eg);
  const ratios = [1, 1.58 + r() * 0.2, 2.31 + r() * 0.3, 3.7 + r() * 0.4];
  for (const k of ratios) {
    const bp = filter(c, 'bandpass', base * k, 25 + r() * 25);
    const g = gain(c);
    perc(g, t, level * (1.4 / k), 0.002, ring / Math.sqrt(k));
    eg.connect(bp).connect(g).connect(out);
  }
}

/** Sub-bass punch: what the pilot "feels" through the seat. */
function thump(c: Ctx, out: AudioNode, t: number, from: number, to: number, level: number, dur: number) {
  const o = osc(c, 'sine', from, t, dur);
  sweep(o.frequency, t, from, to, dur * 0.7);
  const g = gain(c);
  perc(g, t, level, 0.004, dur);
  o.connect(g).connect(out);
}

/** A bell-like FM note for the interface. */
function bell(c: Ctx, out: AudioNode, t: number, f: number, level: number, dur: number, ratio = 2.01, index = 1.2) {
  const car = osc(c, 'sine', f, t, dur);
  const mod = osc(c, 'sine', f * ratio, t, dur);
  const mg = gain(c);
  mg.gain.setValueAtTime(f * index, t);
  mg.gain.exponentialRampToValueAtTime(f * 0.05, t + dur * 0.6);
  mod.connect(mg).connect(car.frequency);
  const g = gain(c);
  perc(g, t, level, 0.004, dur);
  car.connect(g).connect(out);
}

// ---------------------------------------------------------------- weapons

/**
 * Energy cannon shot. Each class gets its own voice: pitch, sweep, grit and
 * weight. Layers: muzzle crack, swept electrical body (FM), resonance tail,
 * and a sub kick for the pilot's own heavy guns.
 */
function laser(p: { f0: number; f1: number; len: number; grit: number; sub: number; fm: number; wave: OscillatorType }): Recipe {
  return {
    duration: p.len + 0.25,
    variants: 4,
    build(c, out, r) {
      const t = 0.005;
      const master = gain(c, 0.9);
      master.connect(out);
      // Crack
      const n = noise(c, t, 0.02, r);
      const hp = filter(c, 'highpass', 2500 + r() * 1500);
      const ng = gain(c);
      perc(ng, t, 0.5, 0.001, 0.018);
      n.connect(hp).connect(ng).connect(master);
      // Body: swept oscillator with an FM buzz, through a moving band-pass and a little drive.
      const f0 = p.f0 * (0.94 + r() * 0.12);
      const body = osc(c, p.wave, f0, t, p.len);
      sweep(body.frequency, t, f0, p.f1, p.len);
      const mod = osc(c, 'sine', 70 + r() * 60, t, p.len);
      const mg = gain(c, f0 * p.fm);
      mod.connect(mg).connect(body.frequency);
      const body2 = osc(c, 'sine', f0 * 1.5, t, p.len);
      sweep(body2.frequency, t, f0 * 1.5, p.f1 * 1.2, p.len * 0.8);
      const bp = filter(c, 'bandpass', f0 * 1.6, 1.2);
      sweep(bp.frequency, t, f0 * 2, Math.max(200, p.f1 * 2), p.len);
      const d = drive(c, 1 + p.grit * 4);
      const bg = gain(c);
      perc(bg, t, 0.55, 0.002, p.len);
      body.connect(bp);
      body2.connect(bp);
      bp.connect(d).connect(bg).connect(master);
      // Resonance of the firing system: a short low band-passed noise tail.
      const tail = noise(c, t, p.len + 0.2, r);
      const tl = filter(c, 'bandpass', 500 + r() * 300, 3);
      const tg = gain(c);
      perc(tg, t + 0.01, 0.12 + p.grit * 0.1, 0.01, p.len + 0.15);
      tail.connect(tl).connect(tg).connect(master);
      if (p.sub > 0) thump(c, master, t, 150, 45, p.sub, 0.12 + p.len * 0.3);
    },
  };
}

// ---------------------------------------------------------------- impacts and destruction

function explosion(size: number): Recipe {
  return {
    duration: 1.4 + size * 1.2,
    variants: 3,
    build(c, out, r) {
      const t = 0.005;
      const dur = 1.2 + size * 1.1;
      const master = gain(c, 0.9);
      master.connect(out);
      // Crack: the first instant, bright.
      const crack = noise(c, t, 0.06, r);
      const ch = filter(c, 'highpass', 1800);
      const cg = gain(c);
      perc(cg, t, 0.7, 0.001, 0.05);
      crack.connect(ch).connect(cg).connect(master);
      // Fireball: brown noise, low-passed from bright to dark, driven.
      const fire = noise(c, t, dur, r, true);
      const lp = filter(c, 'lowpass', 3500, 0.9);
      sweep(lp.frequency, t, 2500 + size * 1500, 140, dur * 0.85);
      const fg = gain(c);
      perc(fg, t, 0.9, 0.012, dur);
      fire.connect(lp).connect(drive(c, 2.5)).connect(fg).connect(master);
      // Sub: the shock felt through the hull.
      thump(c, master, t, 95 - size * 15, 24, 0.9, 0.6 + size * 0.5);
      // Electrical crackle as systems short out.
      for (let i = 0; i < 6 + size * 6; i++) {
        const at = t + 0.05 + r() * 0.5 * (1 + size);
        const z = noise(c, at, 0.012, r);
        const zf = filter(c, 'bandpass', 2000 + r() * 5000, 4);
        const zg = gain(c);
        perc(zg, at, 0.12 + r() * 0.15, 0.001, 0.01 + r() * 0.02);
        z.connect(zf).connect(zg).connect(master);
      }
      // Debris: metal pieces ringing.
      for (let i = 0; i < 3 + size * 5; i++) metal(c, master, t + 0.15 + r() * dur * 0.6, r, 300 + r() * 1500, 0.08 + r() * 0.1, 0.25 + r() * 0.4);
      // Large hulls go up in several stages.
      for (let k = 1; k < 1 + Math.floor(size * 1.5); k++) {
        const at = t + 0.35 * k + r() * 0.3;
        const sec = noise(c, at, 0.9, r, true);
        const sl = filter(c, 'lowpass', 1600);
        sweep(sl.frequency, at, 1800, 120, 0.8);
        const sg = gain(c);
        perc(sg, at, 0.55, 0.01, 0.9);
        sec.connect(sl).connect(sg).connect(master);
        thump(c, master, at, 70, 28, 0.5, 0.6);
      }
    },
  };
}

const shieldHit: Recipe = {
  duration: 0.5,
  variants: 4,
  build(c, out, r) {
    const t = 0.005;
    // Energy absorption: a bright inharmonic shimmer through a short comb, over a filtered hiss.
    const delay = c.createDelay(0.05);
    delay.delayTime.value = 0.002 + r() * 0.003;
    const fb = gain(c, 0.55);
    delay.connect(fb).connect(delay);
    const dg = gain(c, 0.6);
    delay.connect(dg).connect(out);
    for (const f of [1900, 2870, 4130]) {
      const o = osc(c, 'sine', f * (0.9 + r() * 0.2), t, 0.4);
      sweep(o.frequency, t, f, f * 0.6, 0.35);
      const g = gain(c);
      perc(g, t, 0.12, 0.002, 0.3);
      o.connect(g);
      g.connect(delay);
      g.connect(out);
    }
    const n = noise(c, t, 0.35, r);
    const bp = filter(c, 'bandpass', 5000, 2);
    sweep(bp.frequency, t, 6000, 1500, 0.3);
    const ng = gain(c);
    perc(ng, t, 0.3, 0.001, 0.28);
    n.connect(bp).connect(ng).connect(out);
  },
};

function hullHit(heavy: boolean): Recipe {
  return {
    duration: heavy ? 0.9 : 0.6,
    variants: 4,
    build(c, out, r) {
      const t = 0.005;
      // Hit: dull transient, then the structure rings.
      const n = noise(c, t, 0.05, r);
      const lp = filter(c, 'lowpass', heavy ? 2500 : 4000);
      const ng = gain(c);
      perc(ng, t, 0.6, 0.001, 0.05);
      n.connect(lp).connect(ng).connect(out);
      metal(c, out, t, r, heavy ? 160 + r() * 80 : 350 + r() * 300, heavy ? 0.5 : 0.35, heavy ? 0.6 : 0.35);
      thump(c, out, t, heavy ? 110 : 160, 40, heavy ? 0.8 : 0.35, heavy ? 0.3 : 0.15);
      if (heavy) {
        // Rattle of loose panels.
        for (let i = 0; i < 5; i++) metal(c, out, t + 0.05 + r() * 0.3, r, 800 + r() * 1500, 0.06, 0.08);
      }
    },
  };
}

const collision: Recipe = {
  duration: 1.1,
  variants: 3,
  build(c, out, r) {
    const t = 0.005;
    const n = noise(c, t, 0.7, r, true);
    const lp = filter(c, 'lowpass', 1400, 1.5);
    sweep(lp.frequency, t, 1800, 200, 0.6);
    const g = gain(c);
    perc(g, t, 0.9, 0.003, 0.6);
    n.connect(lp).connect(drive(c, 3)).connect(g).connect(out);
    // Scrape
    const s = noise(c, t + 0.05, 0.6, r);
    const bp = filter(c, 'bandpass', 2500, 6);
    sweep(bp.frequency, t + 0.05, 3000, 900, 0.5);
    const sg = gain(c);
    perc(sg, t + 0.05, 0.25, 0.02, 0.5);
    s.connect(bp).connect(sg).connect(out);
    metal(c, out, t, r, 120 + r() * 60, 0.6, 0.8);
    thump(c, out, t, 80, 30, 1, 0.5);
  },
};

/** Our own ship destroyed: hull breach, alarm, short circuits, then the blast muffled through the dying cockpit. */
const deathOwn: Recipe = {
  duration: 3.2,
  variants: 1,
  build(c, out, r) {
    const t = 0.005;
    hullHit(true).build(c, out, r);
    // Klaxon
    for (let i = 0; i < 3; i++) {
      const at = t + 0.1 + i * 0.32;
      const o = osc(c, 'sawtooth', i % 2 ? 520 : 700, at, 0.28);
      const bp = filter(c, 'bandpass', 900, 2);
      const g = gain(c);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(0.12, at + 0.02);
      g.gain.setValueAtTime(0.12, at + 0.22);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
      o.connect(bp).connect(g).connect(out);
    }
    const muffle = filter(c, 'lowpass', 900, 0.8);
    const mg = gain(c, 0.9);
    muffle.connect(mg).connect(out);
    explosion(1.2).build(c, muffle, r);
  },
};

// ---------------------------------------------------------------- ship systems

const shieldDown: Recipe = {
  duration: 1.0,
  variants: 1,
  build(c, out, r) {
    const t = 0.005;
    for (const f of [1800, 2400, 3100]) {
      const o = osc(c, 'sawtooth', f, t, 0.8);
      sweep(o.frequency, t, f, f * 0.12, 0.75);
      const bp = filter(c, 'bandpass', f, 3);
      const g = gain(c);
      perc(g, t, 0.07, 0.005, 0.75);
      o.connect(bp).connect(g).connect(out);
    }
    for (let i = 0; i < 14; i++) {
      const at = t + r() * 0.7;
      const z = noise(c, at, 0.015, r);
      const zf = filter(c, 'highpass', 3000);
      const zg = gain(c);
      perc(zg, at, 0.15, 0.001, 0.012);
      z.connect(zf).connect(zg).connect(out);
    }
    thump(c, out, t, 120, 40, 0.5, 0.3);
  },
};

const shieldUp: Recipe = {
  duration: 1.1,
  variants: 1,
  build(c, out) {
    const t = 0.005;
    [300, 452, 601].forEach((f, i) => {
      const o = osc(c, 'sine', f, t, 1);
      sweep(o.frequency, t, f, f * 3, 0.9);
      const g = gain(c);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06, t + 0.4 + i * 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1);
      o.connect(g).connect(out);
    });
  },
};

const weaponsDown: Recipe = {
  duration: 0.6,
  variants: 1,
  build(c, out) {
    const t = 0.005;
    const o = osc(c, 'square', 900, t, 0.5);
    sweep(o.frequency, t, 900, 110, 0.45);
    const lp = filter(c, 'lowpass', 2000);
    const g = gain(c);
    perc(g, t, 0.08, 0.005, 0.45);
    o.connect(lp).connect(g).connect(out);
  },
};

const weaponsReady: Recipe = {
  duration: 0.35,
  variants: 1,
  build(c, out) {
    bell(c, out, 0.005, 1175, 0.07, 0.12, 3, 0.6);
    bell(c, out, 0.09, 1760, 0.07, 0.2, 3, 0.6);
  },
};

const boostStart: Recipe = {
  duration: 1.3,
  variants: 2,
  build(c, out, r) {
    const t = 0.005;
    const n = noise(c, t, 1.2, r, true);
    const bp = filter(c, 'bandpass', 200, 0.8);
    sweep(bp.frequency, t, 150, 2200, 0.9);
    const g = gain(c);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    n.connect(bp).connect(drive(c, 2)).connect(g).connect(out);
    const o = osc(c, 'sawtooth', 45, t, 1.1);
    sweep(o.frequency, t, 45, 140, 0.8);
    const lp = filter(c, 'lowpass', 400);
    const og = gain(c);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.35, t + 0.45);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(lp).connect(og).connect(out);
    thump(c, out, t + 0.42, 90, 35, 0.7, 0.35);
  },
};

// ---------------------------------------------------------------- interface (tonal centre D, short, soft)

const ui = {
  click: { duration: 0.08, variants: 2, build: (c: Ctx, o: AudioNode) => bell(c, o, 0.003, 1760, 0.06, 0.05, 1.5, 0.4) },
  tab: {
    duration: 0.2,
    variants: 1,
    build: (c: Ctx, o: AudioNode) => {
      bell(c, o, 0.003, 1175, 0.05, 0.08, 2, 0.5);
      bell(c, o, 0.05, 1568, 0.05, 0.12, 2, 0.5);
    },
  },
  confirm: {
    duration: 0.5,
    variants: 1,
    build: (c: Ctx, o: AudioNode) => [587, 740, 880].forEach((f, i) => bell(c, o, 0.003 + i * 0.06, f, 0.07, 0.3, 2, 0.8)),
  },
  deny: {
    duration: 0.35,
    variants: 1,
    build: (c: Ctx, o: AudioNode) => {
      for (const [at, f] of [
        [0.003, 330],
        [0.11, 247],
      ]) {
        const x = osc(c, 'triangle', f, at, 0.15);
        const g = gain(c);
        perc(g, at, 0.12, 0.004, 0.14);
        x.connect(filter(c, 'lowpass', 1500)).connect(g).connect(o);
      }
    },
  },
  notify: { duration: 0.6, variants: 1, build: (c: Ctx, o: AudioNode) => [1318, 1760].forEach((f, i) => bell(c, o, 0.003 + i * 0.07, f, 0.05, 0.4, 3.01, 0.7)) },
  lock: {
    duration: 0.3,
    variants: 1,
    build: (c: Ctx, o: AudioNode) => [1500, 2000, 2600].forEach((f, i) => bell(c, o, 0.003 + i * 0.045, f, 0.04, 0.05, 1, 0.2)),
  },
  comms: {
    duration: 0.3,
    variants: 2,
    build: (c: Ctx, o: AudioNode, r: Rand) => {
      // Radio squelch, then a short blip.
      const n = noise(c, 0.003, 0.08, r);
      const bp = filter(c, 'bandpass', 1500, 2);
      const g = gain(c);
      perc(g, 0.003, 0.1, 0.002, 0.07);
      n.connect(bp).connect(g).connect(o);
      bell(c, o, 0.09, 2093, 0.04, 0.1, 1, 0.3);
    },
  },
  mission: {
    duration: 1.0,
    variants: 1,
    build: (c: Ctx, o: AudioNode) => [587, 880, 1175, 1760].forEach((f, i) => bell(c, o, 0.003 + i * 0.09, f, 0.06, 0.6, 2, 0.9)),
  },
  repair: {
    duration: 0.8,
    variants: 1,
    build: (c: Ctx, o: AudioNode, r: Rand) => {
      for (let i = 0; i < 7; i++) metal(c, o, 0.003 + i * 0.07, r, 2200 + r() * 400, 0.05, 0.05);
      const w = osc(c, 'sawtooth', 200, 0.003, 0.6);
      sweep(w.frequency, 0.003, 200, 600, 0.5);
      const g = gain(c);
      perc(g, 0.003, 0.04, 0.1, 0.5);
      w.connect(filter(c, 'lowpass', 1200)).connect(g).connect(o);
    },
  },
  upgrade: {
    duration: 1.0,
    variants: 1,
    build: (c: Ctx, o: AudioNode) => {
      const w = osc(c, 'sawtooth', 150, 0.003, 0.5);
      sweep(w.frequency, 0.003, 150, 900, 0.45);
      const g = gain(c);
      perc(g, 0.003, 0.05, 0.2, 0.3);
      w.connect(filter(c, 'lowpass', 2000)).connect(g).connect(o);
      [880, 1320].forEach((f, i) => bell(c, o, 0.4 + i * 0.08, f, 0.06, 0.5, 2, 1));
    },
  },
  purchase: { duration: 0.6, variants: 1, build: (c: Ctx, o: AudioNode) => [2349, 3136].forEach((f, i) => bell(c, o, 0.003 + i * 0.05, f, 0.04, 0.35, 1.41, 1.5)) },
} satisfies Record<string, Recipe>;

// ---------------------------------------------------------------- onboard alerts (four urgency levels)

function alertTone(level: 1 | 2 | 3 | 4): Recipe {
  const pattern: [number, number][] =
    level === 1
      ? [
          [0, 988],
          [0.12, 1319],
        ]
      : level === 2
        ? [
            [0, 880],
            [0.14, 880],
            [0.28, 1175],
          ]
        : level === 3
          ? [
              [0, 700],
              [0.25, 520],
              [0.5, 700],
              [0.75, 520],
            ]
          : [
              [0, 1047],
              [0.1, 1047],
              [0.2, 1047],
              [0.4, 1047],
              [0.5, 1047],
              [0.6, 1047],
            ];
  const len = level >= 3 ? 0.2 : 0.1;
  return {
    duration: pattern[pattern.length - 1][0] + len + 0.1,
    variants: 1,
    build(c, out) {
      for (const [at, f] of pattern) {
        const x = osc(c, level >= 3 ? 'sawtooth' : 'triangle', f, at + 0.003, len);
        const bp = filter(c, 'bandpass', f * 1.2, 1.2);
        const g = gain(c);
        g.gain.setValueAtTime(0.0001, at + 0.003);
        g.gain.linearRampToValueAtTime(level >= 3 ? 0.12 : 0.09, at + 0.015);
        g.gain.setValueAtTime(level >= 3 ? 0.12 : 0.09, at + len - 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, at + len);
        x.connect(bp).connect(g).connect(out);
      }
    },
  };
}

// ---------------------------------------------------------------- ambience details

const ambience = {
  hangarClank: {
    duration: 2.2,
    variants: 4,
    build: (c: Ctx, o: AudioNode, r: Rand) => {
      metal(c, o, 0.005, r, 90 + r() * 120, 0.5, 1.2);
      thump(c, o, 0.005, 70, 35, 0.4, 0.4);
      if (r() < 0.6) {
        const n = noise(c, 0.3, 1.4, r);
        const lp = filter(c, 'lowpass', 900);
        const g = gain(c);
        g.gain.setValueAtTime(0.0001, 0.3);
        g.gain.exponentialRampToValueAtTime(0.12, 0.45);
        g.gain.exponentialRampToValueAtTime(0.0001, 1.7);
        n.connect(lp).connect(g).connect(o);
      }
    },
  },
  paChime: { duration: 2.2, variants: 1, build: (c: Ctx, o: AudioNode) => [784, 988, 1175].forEach((f, i) => bell(c, o, 0.005 + i * 0.35, f, 0.05, 1.4, 1.0, 0.25)) },
  radioChatter: {
    duration: 1.6,
    variants: 4,
    build: (c: Ctx, o: AudioNode, r: Rand) => {
      // Unintelligible far-off radio: band-limited noise shaped like syllables. Not a voice.
      const n = noise(c, 0.005, 1.5, r);
      const bp = filter(c, 'bandpass', 1200, 3);
      const g = gain(c, 0);
      let at = 0.02;
      while (at < 1.4) {
        const len = 0.05 + r() * 0.15;
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(0.06 + r() * 0.05, at + 0.02);
        g.gain.linearRampToValueAtTime(0, at + len);
        bp.frequency.setValueAtTime(800 + r() * 1200, at);
        at += len + r() * 0.12;
      }
      n.connect(bp).connect(g).connect(o);
      bell(c, o, 0.005, 2637, 0.02, 0.06, 1, 0.1);
    },
  },
  nebulaChirp: {
    duration: 3,
    variants: 4,
    build: (c: Ctx, o: AudioNode, r: Rand) => {
      // Sensor artefacts from the ionised nebula: slow glides, a little FM, very quiet.
      const f = 400 + r() * 900;
      const x = osc(c, 'sine', f, 0.005, 2.8);
      sweep(x.frequency, 0.005, f, f * (r() < 0.5 ? 0.5 : 1.8), 2.6);
      const m = osc(c, 'sine', 3 + r() * 6, 0.005, 2.8);
      const mg = gain(c, f * 0.03);
      m.connect(mg).connect(x.frequency);
      const g = gain(c);
      g.gain.setValueAtTime(0.0001, 0.005);
      g.gain.exponentialRampToValueAtTime(0.05, 0.8);
      g.gain.exponentialRampToValueAtTime(0.0001, 2.8);
      x.connect(g).connect(o);
    },
  },
  proximity: { duration: 0.12, variants: 1, build: (c: Ctx, o: AudioNode) => bell(c, o, 0.003, 2200, 0.05, 0.06, 1, 0.1) },
  sensorPing: {
    duration: 1.5,
    variants: 2,
    build: (c: Ctx, o: AudioNode, r: Rand) => {
      const f = 1400 + r() * 300;
      bell(c, o, 0.005, f, 0.04, 1.2, 1.0, 0.05);
      bell(c, o, 0.25, f, 0.015, 1.0, 1.0, 0.05);
    },
  },
} satisfies Record<string, Recipe>;

// ---------------------------------------------------------------- music kit

const drums = {
  kick: { duration: 0.6, variants: 1, build: (c: Ctx, o: AudioNode, r: Rand) => {
    thump(c, o, 0.003, 130, 42, 0.95, 0.45);
    const n = noise(c, 0.003, 0.01, r);
    const g = gain(c);
    perc(g, 0.003, 0.2, 0.001, 0.008);
    n.connect(filter(c, 'highpass', 3000)).connect(g).connect(o);
  } },
  taiko: { duration: 1.4, variants: 2, build: (c: Ctx, o: AudioNode, r: Rand) => {
    thump(c, o, 0.003, 95 + r() * 10, 50, 0.9, 1.1);
    const n = noise(c, 0.003, 0.3, r, true);
    const g = gain(c);
    perc(g, 0.003, 0.5, 0.002, 0.25);
    n.connect(filter(c, 'lowpass', 600)).connect(g).connect(o);
  } },
  tom: { duration: 0.7, variants: 2, build: (c: Ctx, o: AudioNode, r: Rand) => {
    thump(c, o, 0.003, 190 + r() * 30, 95, 0.6, 0.45);
    const n = noise(c, 0.003, 0.15, r);
    const g = gain(c);
    perc(g, 0.003, 0.15, 0.002, 0.12);
    n.connect(filter(c, 'bandpass', 900, 1)).connect(g).connect(o);
  } },
  metalHit: { duration: 1.6, variants: 2, build: (c: Ctx, o: AudioNode, r: Rand) => metal(c, o, 0.003, r, 380 + r() * 200, 0.3, 1.2) },
  hat: { duration: 0.08, variants: 2, build: (c: Ctx, o: AudioNode, r: Rand) => {
    const n = noise(c, 0.003, 0.05, r);
    const g = gain(c);
    perc(g, 0.003, 0.12, 0.001, 0.04);
    n.connect(filter(c, 'highpass', 7000)).connect(g).connect(o);
  } },
  riser: { duration: 4, variants: 1, build: (c: Ctx, o: AudioNode, r: Rand) => {
    const n = noise(c, 0.003, 3.9, r);
    const bp = filter(c, 'bandpass', 300, 2);
    sweep(bp.frequency, 0.003, 300, 6000, 3.8);
    const g = gain(c);
    g.gain.setValueAtTime(0.0001, 0.003);
    g.gain.exponentialRampToValueAtTime(0.25, 3.7);
    g.gain.linearRampToValueAtTime(0, 3.9);
    n.connect(bp).connect(g).connect(o);
  } },
} satisfies Record<string, Recipe>;

// ---------------------------------------------------------------- loops for distant ships (virtualised engines)

function engineLoop(base: number, grit: number): Recipe {
  return {
    duration: 3,
    variants: 1,
    loop: true,
    build(c, out, r) {
      const t = 0;
      const a = osc(c, 'sawtooth', base, t, 3);
      const b = osc(c, 'sawtooth', base * 1.505, t, 3);
      const lp = filter(c, 'lowpass', 500 + grit * 400, 2);
      const g = gain(c, 0.25);
      a.connect(lp);
      b.connect(lp);
      lp.connect(g).connect(out);
      const n = noise(c, t, 3, r, true);
      const bp = filter(c, 'bandpass', 600, 0.8);
      const ng = gain(c, 0.5);
      n.connect(bp).connect(ng).connect(out);
    },
  };
}

// ---------------------------------------------------------------- hyperspace (v0.7)

/**
 * A ship entering hyperspace, at the moment it goes (the rise before it is the
 * live charge layer, Hyperdrive.ts): a short in-rush of air-like noise, the
 * breach (a crack and a deep thump through the frame) and a glassy shimmer.
 */
const jumpOut: Recipe = {
  duration: 2,
  variants: 2,
  build(c, out, r) {
    const t = 0.005;
    const rush = noise(c, t, 0.2, r);
    const bp = filter(c, 'bandpass', 900, 1.1);
    sweep(bp.frequency, t, 900, 7000, 0.16);
    const rg = gain(c);
    rg.gain.setValueAtTime(0.0001, t);
    rg.gain.exponentialRampToValueAtTime(0.6, t + 0.14);
    rg.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    rush.connect(bp).connect(rg).connect(out);
    const at = t + 0.14;
    const crack = noise(c, at, 0.09, r);
    const cg = gain(c);
    perc(cg, at, 0.9, 0.001, 0.08);
    crack.connect(filter(c, 'highpass', 1400)).connect(cg).connect(out);
    thump(c, out, at, 95, 24, 1, 1.1);
    const body = noise(c, at, 1.2, r, true);
    const lp = filter(c, 'lowpass', 1600, 1.2);
    sweep(lp.frequency, at, 1600, 140, 1.1);
    const bg = gain(c);
    perc(bg, at, 0.55, 0.005, 1.1);
    body.connect(lp).connect(drive(c, 2)).connect(bg).connect(out);
    for (const f of [1320, 1980, 2790]) bell(c, out, at + 0.02, f * (0.98 + r() * 0.04), 0.07, 1.6, 1.41, 0.6);
  },
};

/** Coming out of hyperspace: a fast reversed swell, the breach, then the drive spooling down. */
const jumpIn: Recipe = {
  duration: 2.2,
  variants: 2,
  build(c, out, r) {
    const t = 0.005;
    const swell = noise(c, t, 0.45, r);
    const bp = filter(c, 'bandpass', 7000, 0.9);
    sweep(bp.frequency, t, 7000, 800, 0.4);
    const sg = gain(c);
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.55, t + 0.34);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    swell.connect(bp).connect(sg).connect(out);
    const at = t + 0.36;
    thump(c, out, at, 75, 28, 0.9, 0.9);
    const rumble = noise(c, at, 1.6, r, true);
    const lp = filter(c, 'lowpass', 900);
    sweep(lp.frequency, at, 900, 110, 1.4);
    const rg = gain(c);
    perc(rg, at, 0.6, 0.01, 1.5);
    rumble.connect(lp).connect(rg).connect(out);
    const o = osc(c, 'sawtooth', 430, at, 1.5);
    sweep(o.frequency, at, 430, 70, 1.4);
    const og = gain(c);
    perc(og, at, 0.12, 0.02, 1.4);
    o.connect(filter(c, 'lowpass', 1300)).connect(og).connect(out);
  },
};

export const RECIPES = {
  laser_falcon: laser({ f0: 1700, f1: 260, len: 0.14, grit: 0.25, sub: 0.45, fm: 0.12, wave: 'sawtooth' }),
  laser_warden: laser({ f0: 1250, f1: 170, len: 0.18, grit: 0.2, sub: 0.5, fm: 0.08, wave: 'sawtooth' }),
  laser_raider: laser({ f0: 1050, f1: 300, len: 0.13, grit: 0.7, sub: 0.15, fm: 0.35, wave: 'square' }),
  laser_marauder: laser({ f0: 620, f1: 70, len: 0.32, grit: 0.55, sub: 0.7, fm: 0.2, wave: 'sawtooth' }),
  shield_hit: shieldHit,
  hull_hit: hullHit(false),
  hull_hit_own: hullHit(true),
  explosion_small: explosion(0.4),
  explosion_medium: explosion(0.9),
  explosion_large: explosion(1.6),
  death_own: deathOwn,
  collision,
  shield_down: shieldDown,
  shield_up: shieldUp,
  weapons_down: weaponsDown,
  weapons_ready: weaponsReady,
  boost_start: boostStart,
  ui_click: ui.click,
  ui_tab: ui.tab,
  ui_confirm: ui.confirm,
  ui_deny: ui.deny,
  ui_notify: ui.notify,
  ui_lock: ui.lock,
  ui_comms: ui.comms,
  ui_mission: ui.mission,
  ui_repair: ui.repair,
  ui_upgrade: ui.upgrade,
  ui_purchase: ui.purchase,
  alert_1: alertTone(1),
  alert_2: alertTone(2),
  alert_3: alertTone(3),
  alert_4: alertTone(4),
  amb_clank: ambience.hangarClank,
  amb_pa: ambience.paChime,
  amb_radio: ambience.radioChatter,
  amb_nebula: ambience.nebulaChirp,
  amb_proximity: ambience.proximity,
  amb_ping: ambience.sensorPing,
  drum_kick: drums.kick,
  drum_taiko: drums.taiko,
  drum_tom: drums.tom,
  drum_metal: drums.metalHit,
  drum_hat: drums.hat,
  drum_riser: drums.riser,
  jump_out: jumpOut,
  jump_in: jumpIn,
  loop_union: engineLoop(55, 0.3),
  loop_raider: engineLoop(68, 0.8),
} satisfies Record<string, Recipe>;

export type SoundId = keyof typeof RECIPES;

/** Renders one variant. Loops get their tail cross-faded into their head so they repeat without a seam. */
export async function renderRecipe(id: SoundId, variant: number): Promise<AudioBuffer> {
  const rec: Recipe = RECIPES[id];
  const ch = rec.channels ?? 1;
  const c = new OfflineAudioContext(ch, Math.ceil(rec.duration * RATE), RATE);
  const out = c.createGain();
  out.connect(c.destination);
  rec.build(c, out, mulberry32(0x9e37 + variant * 7919 + id.length * 131));
  const buf = await c.startRendering();
  const done = rec.loop ? seamless(buf, 1) : buf;
  normalise(done, peakOf(id));
  return done;
}

/**
 * Peak level each sound is normalised to after rendering, so that the
 * recipes can be written freely and the mix decides loudness (bus trims and
 * play gains). Family defaults, then a few exceptions.
 */
const PEAK: Partial<Record<SoundId, number>> = {
  explosion_small: 0.9,
  explosion_medium: 0.95,
  explosion_large: 0.97,
  death_own: 0.97,
  shield_down: 0.6,
  shield_up: 0.45,
  weapons_down: 0.4,
  weapons_ready: 0.3,
  boost_start: 0.7,
  ui_click: 0.25,
  ui_tab: 0.25,
  ui_lock: 0.3,
  alert_4: 0.6,
  amb_clank: 0.5,
  amb_pa: 0.35,
  amb_radio: 0.3,
  amb_nebula: 0.25,
  amb_proximity: 0.4,
  amb_ping: 0.35,
  drum_kick: 0.9,
  drum_taiko: 0.9,
  drum_tom: 0.7,
  drum_metal: 0.5,
  drum_hat: 0.3,
  drum_riser: 0.4,
  jump_out: 0.92,
  jump_in: 0.85,
};

export function peakOf(id: SoundId): number {
  const p = PEAK[id];
  if (p !== undefined) return p;
  if (id.startsWith('ui_')) return 0.35;
  if (id.startsWith('alert_')) return 0.45;
  if (id.startsWith('loop_')) return 0.7;
  return 0.8;
}

function normalise(buf: AudioBuffer, target: number) {
  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) for (const x of buf.getChannelData(ch)) peak = Math.max(peak, Math.abs(x));
  if (peak < 1e-6) return;
  const k = target / peak;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
}

/** Cross-fades the last `fade` seconds into the start (equal power) and trims them off. */
function seamless(buf: AudioBuffer, fade: number): AudioBuffer {
  const n = Math.floor(fade * buf.sampleRate);
  const len = buf.length - n;
  const out = new AudioBuffer({ length: len, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.subarray(0, len));
    for (let i = 0; i < n; i++) {
      const k = i / n;
      dst[i] = src[i] * Math.sin((k * Math.PI) / 2) + src[len + i] * Math.cos((k * Math.PI) / 2);
    }
  }
  return out;
}
