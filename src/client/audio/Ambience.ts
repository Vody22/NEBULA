import { AudioEngine, LoopVoice } from './AudioEngine';

export interface AmbienceInput {
  dt: number;
  docked: boolean;
  /** Our ship flies (not docked, not destroyed). */
  flying: boolean;
  /** Metres from the nearest station's hull, and from the nearest asteroid's surface. */
  stationDist: number;
  asteroidDist: number;
  /** Our speed, m/s. */
  speed: number;
  /** Hostiles within sensor range, and the distance of the closest (Infinity if none). */
  hostiles: number;
  nearestHostile: number;
}

/**
 * The environment around the pilot. Space itself is silent: outside the
 * hangar, every ambience is something the ship hears or senses (its own life
 * support, dust on the hull, the station's traffic channel, sensor contacts,
 * nebula interference). Deep space is kept almost silent on purpose.
 */
export class Ambience {
  private air: LoopVoice;
  private patter: LoopVoice;
  private hum: LoopVoice;
  private room: LoopVoice;
  private humTone: OscillatorNode;
  private humGain: GainNode;
  private next = { chirp: 8, radio: 5, clank: 2, pa: 12, ping: 0, prox: 0 };
  private hangar = 0;

  constructor(private a: AudioEngine) {
    const ctx = a.ctx!;
    // Cockpit life support: a soft, dark hiss, the floor under the silence.
    this.air = new LoopVoice(a, a.noise, 'ambience', { freq: 320, q: 0.5 });
    // Micro-debris on the hull near the belt: a fine crackle that follows the speed.
    this.patter = new LoopVoice(a, a.noise, 'ambience', { type: 'highpass', freq: 3500, q: 0.7 });
    // Station machinery heard through the docking beacon channel, and inside the hangar.
    this.hum = new LoopVoice(a, a.noise, 'ambience', { type: 'bandpass', freq: 110, q: 5 });
    this.humTone = ctx.createOscillator();
    this.humTone.frequency.value = 50;
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    this.humTone.connect(this.humGain).connect(a.bus.ambience);
    this.humTone.start();
    // The air of a large pressurised hall.
    this.room = new LoopVoice(a, a.noise, 'ambience', { freq: 600, q: 0.6 });
  }

  update(i: AmbienceInput) {
    const dt = Math.min(0.1, i.dt);
    const n = this.next;
    for (const k of Object.keys(n) as (keyof typeof n)[]) n[k] -= dt;
    this.hangar += ((i.docked ? 1 : 0) - this.hangar) * Math.min(1, dt * 1.5);
    this.a.setRoom(this.hangar * 0.6);

    this.air.set(i.flying ? 0.03 : 0.012 * (1 - this.hangar), 0.5);

    const belt = i.flying ? Math.max(0, 1 - i.asteroidDist / 500) : 0;
    const speed = Math.min(1, i.speed / 220);
    const crackle = 0.5 + 0.5 * Math.random();
    this.patter.set(belt * (0.01 + speed * 0.05) * crackle, 0.04);

    const near = i.flying ? Math.max(0, 1 - i.stationDist / 1400) : 0;
    const humLevel = near * 0.09 + this.hangar * 0.12;
    this.hum.set(humLevel, 0.5);
    this.humGain.gain.setTargetAtTime(near * 0.02 + this.hangar * 0.035, this.a.now, 0.5);
    this.room.set(this.hangar * 0.05, 0.6);

    if (i.docked) {
      if (n.clank <= 0) {
        this.a.play('amb_clank', { bus: 'ambience', gain: 0.35 + Math.random() * 0.4, rate: 0.85 + Math.random() * 0.3, pan: Math.random() * 1.6 - 0.8 });
        n.clank = 3 + Math.random() * 6;
      }
      if (n.pa <= 0) {
        this.a.play('amb_pa', { bus: 'ambience', gain: 0.4, pan: Math.random() - 0.5 });
        this.a.play('amb_radio', { bus: 'comms', gain: 0.4, delay: 2, pan: Math.random() - 0.5 });
        n.pa = 25 + Math.random() * 30;
      }
      return;
    }
    if (!i.flying) return;

    // Traffic control chatter when close to a station.
    if (i.stationDist < 2500 && n.radio <= 0) {
      this.a.play('amb_radio', { bus: 'comms', gain: 0.25 + near * 0.3, pan: Math.random() * 1.2 - 0.6 });
      n.radio = 7 + Math.random() * 10;
    }
    // The sector lies in a nebula: rare interference on the sensors, far from everything.
    if (n.chirp <= 0) {
      if (i.hostiles === 0 && i.stationDist > 1500)
        this.a.play('amb_nebula', { bus: 'ambience', gain: 0.5, rate: 0.8 + Math.random() * 0.4, pan: Math.random() * 1.8 - 0.9 });
      n.chirp = 12 + Math.random() * 20;
    }
    // Sensor contacts: the closer the hostile, the faster the ping.
    if (i.hostiles > 0 && n.ping <= 0) {
      this.a.play('amb_ping', { bus: 'ui', gain: 0.5, importance: 2 });
      n.ping = Math.min(4, Math.max(1.3, i.nearestHostile / 600));
    }
    // Collision warning: fast and very close to a rock.
    if (i.asteroidDist < 90 && i.speed > 60 && n.prox <= 0) {
      this.a.play('amb_proximity', { bus: 'ui', gain: 0.7, importance: 3 });
      n.prox = Math.max(0.15, i.asteroidDist / 300);
    }
  }
}
