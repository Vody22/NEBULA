import { LoopVoice, type AudioEngine } from './AudioEngine';

/**
 * The hyperspace drive charging (v0.7), driven by the server's charge
 * countdown: a whine that climbs through the drive core, a band of rushing
 * noise opening up, and a cockpit beep that speeds up toward the jump. A
 * cancelled charge winds down. Silent (and unplugged) the rest of the time.
 */
export class Hyperdrive {
  private whine: LoopVoice;
  private rush: LoopVoice;
  private level = 0;
  private beepIn = 0;

  constructor(private a: AudioEngine) {
    this.whine = new LoopVoice(a, a.buffer('loop_union')!, 'engines', { type: 'bandpass', freq: 400, q: 2 });
    this.rush = new LoopVoice(a, a.noise, 'engines', { type: 'bandpass', freq: 300, q: 1.4 });
  }

  /** `progress`: 0..1 while charging, null otherwise. */
  update(dt: number, progress: number | null) {
    const on = progress !== null;
    const p = progress ?? 0;
    // Rises with the charge; falls quickly on a cancel or the jump.
    this.level += ((on ? 1 : 0) - this.level) * Math.min(1, dt * (on ? 3 : 5));
    const k = this.level * (0.25 + 0.75 * p);
    this.whine.rate(0.6 + p * 2.2 * this.level, 0.1);
    this.whine.freq(400 + p * 2600, 0.1);
    this.whine.set(k * 0.18, 0.08);
    this.rush.freq(300 + p * p * 5000, 0.1);
    this.rush.set(k * p * 0.12, 0.08);
    if (!on) {
      this.beepIn = 0;
      return;
    }
    this.beepIn -= dt;
    if (this.beepIn <= 0) {
      // From one beep every 0.7 s to one every 0.12 s, a little higher each time.
      this.beepIn = 0.7 - p * 0.58;
      this.a.play('ui_lock', { bus: 'ui', gain: 0.35 + p * 0.25, rate: 0.8 + p * 0.9, importance: 2, category: 'ui' });
    }
  }
}
