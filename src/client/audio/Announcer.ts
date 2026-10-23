import { AudioEngine } from './AudioEngine';
import { ALERT_LINES, type AlertId } from './mix';

/**
 * Recorded announcer lines, by alert. Empty on purpose: no recording exists
 * yet. When an actor's lines are produced (see docs/AUDIO.md), put the files
 * in public/audio/voice/ and list them here, e.g. `shieldsLow: 'audio/voice/shields_low.ogg'`.
 * A listed line replaces the speech synthesis for that alert.
 */
const RECORDED_LINES: Partial<Record<AlertId, string>> = {};

/**
 * Onboard announcements: a tone whose urgency matches the alert, the line
 * shown as text, and, if the player turns it on, the line spoken by the
 * browser's own speech synthesis (its quality depends on the system voices;
 * it is no studio voice). Lines never overlap: a more urgent one cuts a
 * lesser one, a lesser one waits or is dropped.
 */
export class Announcer {
  /** Speak the lines (option "Annonces vocales"). */
  voice = false;
  /** Voice volume 0..1 (master × voice level), for the speech synthesis which bypasses Web Audio. */
  volume = 0.6;
  private busyUntil = 0;
  private busyPriority = -1;
  private queue: AlertId[] = [];
  private recorded = new Map<AlertId, AudioBuffer>();
  private frVoice: SpeechSynthesisVoice | null = null;

  constructor(
    private a: AudioEngine,
    private showText: (text: string, priority: number, id: AlertId) => void,
  ) {
    void this.loadRecorded();
    if (typeof speechSynthesis !== 'undefined') {
      const pick = () => {
        const list = speechSynthesis.getVoices();
        this.frVoice = list.find((v) => v.lang.startsWith('fr') && v.localService) ?? list.find((v) => v.lang.startsWith('fr')) ?? null;
      };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }

  private async loadRecorded() {
    for (const [id, url] of Object.entries(RECORDED_LINES) as [AlertId, string][]) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        this.recorded.set(id, await this.a.ctx!.decodeAudioData(await res.arrayBuffer()));
      } catch {
        /* a missing line falls back to synthesis */
      }
    }
  }

  say(id: AlertId) {
    const line = ALERT_LINES[id];
    const now = this.a.now;
    if (now < this.busyUntil) {
      if (line.priority > this.busyPriority) {
        if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
      } else {
        if (this.queue.length < 2 && !this.queue.includes(id)) this.queue.push(id);
        return;
      }
    }
    this.speak(id);
  }

  /** Plays queued lines once the channel is free. */
  update() {
    if (this.queue.length && this.a.now >= this.busyUntil) this.speak(this.queue.shift()!);
  }

  clear() {
    this.queue = [];
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }

  private speak(id: AlertId) {
    const line = ALERT_LINES[id];
    const tone = (['alert_1', 'alert_1', 'alert_2', 'alert_3', 'alert_4'] as const)[Math.min(4, line.priority)];
    this.a.play(tone, { bus: 'voice', importance: 3 + line.priority * 0.5, category: 'voice' });
    this.showText(line.text, line.priority, id);
    let length = 0.8;
    const rec = this.recorded.get(id);
    if (rec) {
      const ctx = this.a.ctx!;
      const src = ctx.createBufferSource();
      src.buffer = rec;
      src.connect(this.a.bus.voice);
      src.onended = () => src.disconnect();
      src.start(ctx.currentTime + 0.35);
      length = rec.duration + 0.4;
    } else if (this.voice && typeof speechSynthesis !== 'undefined' && this.a.running) {
      const u = new SpeechSynthesisUtterance(line.text);
      u.lang = 'fr-FR';
      if (this.frVoice) u.voice = this.frVoice;
      u.rate = 1.08;
      u.pitch = 0.85;
      u.volume = Math.min(1, this.volume);
      speechSynthesis.speak(u);
      length = 0.5 + line.text.length * 0.06;
    }
    // Music and beds step back while a line plays; weapons stay readable.
    if (line.priority >= 2 || rec || this.voice) {
      this.a.duck('music', 0.5, length, 0.8);
      this.a.duck('ambience', 0.6, length, 0.8);
    }
    this.busyUntil = this.a.now + length;
    this.busyPriority = line.priority;
  }
}
