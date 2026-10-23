import { AudioEngine } from './AudioEngine';
import type { MusicState } from './mix';
import type { SoundId } from './recipes';

/**
 * Generative adaptive score. Nothing is a recorded track: every bar is
 * written a little ahead of time (sample-accurate Web Audio scheduling) from
 * the current mood the MusicDirector picked, so the music follows the game
 * without loops repeating and without ever stalling the render loop.
 *
 * Layers: pads (detuned saws, slow filter), bass, FM bell arpeggio, and a
 * percussion kit of pre-rendered drums (taiko, kick, toms, metal, hats).
 * Mood changes land on the next bar line; a fight starting lands on the next
 * beat with an accent. Calm moods leave bars of silence on purpose.
 */

interface Score {
  bpm: number;
  /** Chords as MIDI notes; one chord lasts `barsPerChord` bars. */
  chords: number[][];
  barsPerChord: number;
  pad: number;
  /** Pad filter brightness, Hz. */
  bright: number;
  attack: number;
  bass: 'none' | 'drone' | 'pulse' | 'drive';
  /** Chance of an arpeggio note on each eighth (doubled to sixteenths in fights). */
  arp: number;
  drums: 'none' | 'soft' | 'pulse' | 'combat' | 'boss' | 'victory';
  /** Chance that a whole bar of pads is left out. */
  rest: number;
}

// D minor world. Root notes kept low so the pads sit under the effects.
const Dm9 = [50, 57, 62, 65, 69];
const Bbmaj7 = [46, 53, 58, 62, 65];
const Fmaj7 = [41, 53, 57, 60, 64];
const Cadd9 = [48, 55, 60, 62, 64];
const Dm = [50, 57, 62, 65];
const Eb = [51, 58, 63, 67];
const Bb = [46, 58, 62, 65];
const C = [48, 55, 60, 64];
const A = [45, 57, 61, 64];
const Csdim = [49, 55, 61, 64];
const Dmaj = [50, 57, 62, 66, 69];

const SCORES: Record<MusicState, Score> = {
  calm: { bpm: 64, chords: [Dm9, Bbmaj7, Fmaj7, Cadd9], barsPerChord: 2, pad: 1, bright: 900, attack: 2.5, bass: 'drone', arp: 0.12, drums: 'none', rest: 0.2 },
  explore: { bpm: 72, chords: [Dm9, Bbmaj7, Fmaj7, Cadd9], barsPerChord: 2, pad: 0.9, bright: 1300, attack: 1.8, bass: 'drone', arp: 0.3, drums: 'soft', rest: 0.15 },
  tension: { bpm: 84, chords: [Dm, Eb, Dm, Csdim], barsPerChord: 2, pad: 0.8, bright: 700, attack: 1.2, bass: 'pulse', arp: 0, drums: 'pulse', rest: 0.05 },
  combat: { bpm: 128, chords: [Dm, Bb, C, A], barsPerChord: 1, pad: 0.6, bright: 1800, attack: 0.25, bass: 'drive', arp: 0.55, drums: 'combat', rest: 0 },
  boss: { bpm: 120, chords: [Dm, Eb, Bb, A], barsPerChord: 1, pad: 0.75, bright: 1400, attack: 0.3, bass: 'drive', arp: 0.35, drums: 'boss', rest: 0 },
  danger: { bpm: 136, chords: [Dm, Eb, Dm, Eb], barsPerChord: 1, pad: 0.7, bright: 2400, attack: 0.15, bass: 'drive', arp: 0.7, drums: 'combat', rest: 0 },
  victory: { bpm: 76, chords: [Bb, C, Dmaj, Dmaj], barsPerChord: 1, pad: 1, bright: 2600, attack: 0.6, bass: 'drone', arp: 0.5, drums: 'victory', rest: 0 },
};

const LOOKAHEAD = 0.4;
const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);

export class Music {
  private out: GainNode;
  private padBus: GainNode;
  private padFilter: BiquadFilterNode;
  private drumBus: GainNode;
  private state: MusicState = 'calm';
  private pending: MusicState | null = null;
  private score = SCORES.calm;
  private step = 0;
  private nextAt = 0;
  private chordIndex = 0;
  private barInScore = 0;
  private padOn = true;
  private intensity = 0;
  private urgent = false;
  /** Live nodes still scheduled (diagnostics: must stay bounded). */
  live = 0;

  constructor(private a: AudioEngine) {
    const ctx = a.ctx!;
    this.out = ctx.createGain();
    this.out.connect(a.bus.music);
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 900;
    this.padFilter.Q.value = 0.9;
    this.padBus = ctx.createGain();
    this.padBus.connect(this.padFilter).connect(this.out);
    this.drumBus = ctx.createGain();
    this.drumBus.connect(this.out);
    this.nextAt = ctx.currentTime + 0.1;
    setInterval(() => this.pump(), 60);
  }

  get current() {
    return this.state;
  }

  /** Called every frame with the mood the director picked; writes the bars due soon. */
  update(want: MusicState, intensity: number) {
    this.intensity = intensity;
    if (want === this.state) {
      this.pending = null;
      this.urgent = false;
    } else if (want !== this.pending) {
      this.pending = want;
      // A fight starts on the next beat, not at the end of a slow bar.
      this.urgent = want === 'combat' || want === 'boss' || want === 'danger';
    }
    this.pump();
  }

  /**
   * Writes the steps due within the look-ahead. Also run from its own timer,
   * so the score keeps going when frames are slow (weak GPU, heavy scene).
   */
  private pump() {
    const ctx = this.a.ctx!;
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;
    // Stalled (hidden tab, long hitch): do not catch up by stacking notes.
    if (this.nextAt < now - 0.2) this.nextAt = now + 0.05;
    while (this.nextAt < now + LOOKAHEAD) {
      this.writeStep(this.nextAt);
      this.nextAt += 60 / this.score.bpm / 4;
      this.step++;
    }
  }


  private writeStep(t: number) {
    if (this.urgent && this.step % 4 === 0) {
      this.step = 0;
      this.urgent = false;
    }
    const s16 = this.step % 16;
    if (s16 === 0) this.barLine(t);
    const sc = this.score;
    const beat = s16 % 4 === 0;
    const chord = sc.chords[this.chordIndex % sc.chords.length];
    const fight = sc.drums === 'combat' || sc.drums === 'boss';

    // Bass
    if (sc.bass === 'pulse' && beat) this.bass(t, chord[0] - 12, 60 / sc.bpm * 0.9, 0.16);
    if (sc.bass === 'drive' && s16 % 2 === 0) this.bass(t, chord[0] - 12 + (s16 === 14 ? 7 : 0), 60 / sc.bpm / 2 * 0.8, 0.14 + this.intensity * 0.06);

    // Arpeggio
    const arpStep = fight || this.state === 'danger' ? true : s16 % 2 === 0;
    if (arpStep && sc.arp > 0 && Math.random() < sc.arp * (fight ? 0.6 + this.intensity * 0.4 : 1)) {
      const n = chord[1 + Math.floor(Math.random() * (chord.length - 1))] + 12 * (Math.random() < 0.4 ? 2 : 1);
      this.bell(t, n, fight ? 0.04 : 0.05, fight ? 0.35 : 1.4);
    }

    this.drums(t, s16);
  }

  private barLine(t: number) {
    if (this.pending) {
      const was = this.state;
      this.state = this.pending;
      this.pending = null;
      this.score = SCORES[this.state];
      this.barInScore = 0;
      this.chordIndex = 0;
      const loud = this.state === 'combat' || this.state === 'boss' || this.state === 'danger';
      if (loud && !['combat', 'boss', 'danger'].includes(was)) {
        // Entering a fight: an accent, not a fade.
        this.hit('drum_taiko', t, 0.9);
        this.hit('drum_metal', t, 0.5);
      }
      const ctx = this.a.ctx!;
      this.padFilter.frequency.setTargetAtTime(this.score.bright, ctx.currentTime, 1.2);
    } else {
      this.barInScore++;
      if (this.barInScore % this.score.barsPerChord === 0) this.chordIndex++;
    }
    const sc = this.score;
    // Victory resolves once, then holds the last chord.
    if (this.state === 'victory' && this.chordIndex >= sc.chords.length) this.chordIndex = sc.chords.length - 1;
    const newChord = this.barInScore % sc.barsPerChord === 0;
    if (newChord) {
      this.padOn = Math.random() >= sc.rest;
      const len = (60 / sc.bpm) * 4 * sc.barsPerChord;
      if (this.padOn) this.pad(t, sc.chords[this.chordIndex % sc.chords.length], len, sc.attack, sc.pad);
      if (sc.bass === 'drone') this.bass(t, sc.chords[this.chordIndex % sc.chords.length][0] - 12, len, this.padOn ? 0.12 : 0.07, sc.attack);
    }
  }

  private drums(t: number, s: number) {
    const k = this.intensity;
    switch (this.score.drums) {
      case 'soft':
        if (s === 0 && this.barInScore % 2 === 0) this.hit('drum_taiko', t, 0.35);
        break;
      case 'pulse':
        if (s === 0) this.hit('drum_taiko', t, 0.55);
        if (s === 10) this.hit('drum_tom', t, 0.25);
        if (s === 0 && this.barInScore % 4 === 3) this.hit('drum_metal', t, 0.2);
        break;
      case 'combat':
        if (s === 0 || s === 8 || (s === 10 && k > 0.4)) this.hit('drum_kick', t, 0.75);
        if (s === 4 || s === 12) this.hit('drum_taiko', t, 0.6);
        if (s % 2 === 0 || k > 0.6) this.hit('drum_hat', t, s % 4 === 2 ? 0.45 : 0.25);
        if (this.barInScore % 4 === 3 && s >= 12) this.hit('drum_tom', t, 0.5 + (s - 12) * 0.08);
        if (s === 0 && this.barInScore % 8 === 0) this.hit('drum_metal', t, 0.35);
        break;
      case 'boss':
        if (s % 4 === 0) this.hit('drum_taiko', t, s === 0 ? 0.9 : 0.6);
        if (s === 6 || s === 14) this.hit('drum_taiko', t, 0.45);
        if (s === 0) this.hit('drum_metal', t, 0.45);
        if (s % 2 === 0) this.hit('drum_hat', t, 0.2);
        if (s === 0 || s === 8) this.hit('drum_kick', t, 0.7);
        break;
      case 'victory':
        if (s === 0 && this.barInScore === 0) {
          this.hit('drum_taiko', t, 0.7);
          this.hit('drum_metal', t, 0.3);
        }
        break;
    }
  }

  // ------------------------------------------------------------ instruments

  private track(n: AudioScheduledSourceNode, ...nodes: AudioNode[]) {
    this.live++;
    n.onended = () => {
      this.live--;
      n.disconnect();
      for (const x of nodes) x.disconnect();
    };
  }

  private hit(id: SoundId, t: number, level: number) {
    const buf = this.a.buffer(id);
    if (!buf) return;
    const ctx = this.a.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = level * (0.8 + Math.random() * 0.2) * 0.7;
    src.connect(g).connect(this.drumBus);
    src.start(t);
    this.track(src, g);
  }

  private pad(t: number, chord: number[], len: number, attack: number, level: number) {
    const ctx = this.a.ctx!;
    const g = ctx.createGain();
    const peak = 0.035 * level;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + Math.max(attack, len - 0.1));
    g.gain.linearRampToValueAtTime(0, t + len + 1.8);
    g.connect(this.padBus);
    const end = t + len + 1.9;
    let first: OscillatorNode | null = null;
    for (const m of chord) {
      for (const det of [-7, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz(m);
        o.detune.value = det + (Math.random() - 0.5) * 4;
        o.connect(g);
        o.start(t);
        o.stop(end);
        if (!first) first = o;
        else this.track(o);
      }
    }
    if (first) this.track(first, g);
  }

  private bass(t: number, m: number, len: number, level: number, attack = 0.01) {
    const ctx = this.a.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = hz(m);
    const s = ctx.createOscillator();
    s.frequency.value = hz(m) / 2;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(attack > 0.1 ? 220 : 900, t);
    lp.frequency.exponentialRampToValueAtTime(160, t + Math.min(len, 0.3));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + Math.max(0.008, attack));
    g.gain.setValueAtTime(level, t + Math.max(attack, len * 0.7));
    g.gain.linearRampToValueAtTime(0, t + len + 0.15);
    o.connect(lp);
    s.connect(lp);
    lp.connect(g).connect(this.out);
    o.start(t);
    s.start(t);
    o.stop(t + len + 0.2);
    s.stop(t + len + 0.2);
    this.track(o, lp, g);
    this.track(s);
  }

  private bell(t: number, m: number, level: number, dur: number) {
    const ctx = this.a.ctx!;
    const f = hz(m);
    const car = ctx.createOscillator();
    car.frequency.value = f;
    const mod = ctx.createOscillator();
    mod.frequency.value = f * 3.5;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(f * 1.4, t);
    mg.gain.exponentialRampToValueAtTime(f * 0.05, t + dur * 0.6);
    mod.connect(mg).connect(car.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.2 - 0.6;
    car.connect(g).connect(pan).connect(this.out);
    car.start(t);
    mod.start(t);
    car.stop(t + dur + 0.05);
    mod.stop(t + dur + 0.05);
    this.track(car, g, pan);
    this.track(mod, mg);
  }
}
