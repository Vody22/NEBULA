/**
 * Procedural sound effects with WebAudio: no asset files needed.
 * Sounds are attenuated by distance to the listener.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private engine?: { osc: OscillatorNode; osc2: OscillatorNode; gain: GainNode; filter: BiquadFilterNode };
  private lastLaser = 0;
  muted = false;
  volume = 0.7;
  private paused = false;

  start() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.effectiveGain();
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // Engine drone
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 45;
    const osc2 = ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.value = 90.7;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(gain).connect(this.master);
    osc.start();
    osc2.start();
    this.engine = { osc, osc2, gain, filter };
  }

  private effectiveGain() {
    return this.muted || this.paused ? 0 : this.volume * 0.7;
  }

  private applyGain() {
    if (this.ctx) this.master.gain.setTargetAtTime(this.effectiveGain(), this.ctx.currentTime, 0.03);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyGain();
  }

  setVolume(v: number, muted: boolean) {
    this.volume = v;
    this.muted = muted;
    this.applyGain();
  }

  /** Silences everything while the pause menu is open. */
  setPaused(p: boolean) {
    this.paused = p;
    this.applyGain();
  }

  private vol(distance: number) {
    return 1 / (1 + (distance / 250) ** 2);
  }

  engineUpdate(throttle: number, boosting: boolean) {
    if (!this.ctx || !this.engine) return;
    const t = this.ctx.currentTime;
    const e = this.engine;
    const p = Math.max(0, throttle) + (boosting ? 0.8 : 0);
    e.osc.frequency.setTargetAtTime(40 + p * 35, t, 0.2);
    e.osc2.frequency.setTargetAtTime(80 + p * 70, t, 0.2);
    e.filter.frequency.setTargetAtTime(180 + p * 900, t, 0.2);
    e.gain.gain.setTargetAtTime(0.05 + p * 0.07, t, 0.3);
  }

  laser(distance: number, hostile: boolean) {
    if (!this.ctx) return;
    const v = this.vol(distance);
    if (v < 0.02) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    if (t - this.lastLaser < 0.03 && distance > 30) return;
    this.lastLaser = t;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    const f0 = hostile ? 900 : 1500;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.18, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.08 * v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1800;
    osc.connect(f).connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  private noiseBurst(distance: number, dur: number, freq: number, gain: number, q = 0.7) {
    if (!this.ctx) return;
    const v = this.vol(distance);
    if (v < 0.01) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.1), t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain * v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur);
  }

  explosion(distance: number, big: boolean) {
    this.noiseBurst(distance * 0.5, big ? 2.6 : 1.6, big ? 1800 : 1200, big ? 1.0 : 0.7);
    if (!this.ctx) return;
    // sub-bass thump
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const v = this.vol(distance * 0.5);
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(90, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.6 * v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 1);
  }

  shieldHit(distance: number) {
    this.noiseBurst(distance, 0.25, 5000, 0.25, 4);
  }

  hullHit(distance: number) {
    this.noiseBurst(distance, 0.35, 900, 0.5, 1.5);
  }

  hitMarker() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(2400, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.03, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  alarm() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(880, t + i * 0.18);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.18);
      g.gain.linearRampToValueAtTime(0.06, t + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.15);
      osc.connect(g).connect(this.master);
      osc.start(t + i * 0.18);
      osc.stop(t + i * 0.18 + 0.16);
    }
  }

  ui() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(660, t);
    osc.frequency.setValueAtTime(990, t + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.04, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.16);
  }
}
