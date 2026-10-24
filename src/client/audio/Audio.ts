import { impactScale } from '../../shared/physics/collide';
import { Ambience } from './Ambience';
import { Announcer } from './Announcer';
import { AudioEngine, type Occluder, type Vec3 } from './AudioEngine';
import { EngineSound, RemoteEngines, type ViewMode } from './EngineSound';
import { Hyperdrive } from './Hyperdrive';
import { AlertMonitor, DEFAULT_MIX, MusicDirector, type AlertId, type MixLevels } from './mix';
import { Music } from './Music';
import type { SoundId } from './recipes';

/**
 * The game's sound, as the rest of the client sees it: one object fed with
 * the frame's state (frame) and with gameplay events (shot, hit, explosion…).
 * Everything is procedural (see recipes.ts): there is no audio file.
 */

export type ShipClass = 'falcon' | 'warden' | 'raider' | 'marauder';

export interface OwnShipAudio {
  throttle: number;
  speed: number;
  boosting: boolean;
  thrusters: number;
  energy: number;
  shield: number;
  shieldMax: number;
  hull: number;
  hullMax: number;
  weaponsLocked: boolean;
  mining: number;
}

export interface AudioFrame {
  dt: number;
  listener: { pos: Vec3; fwd: Vec3; up: Vec3 };
  docked: boolean;
  /** Our ship in space, null when docked or destroyed. */
  me: OwnShipAudio | null;
  view: ViewMode;
  stationDist: number;
  asteroidDist: number;
  speed: number;
  hostilesFar: number;
  hostilesNear: number;
  nearestHostile: number;
  boss: boolean;
  others: { id: number; at: Vec3; raider: boolean; throttle: number; boosting: boolean }[];
  /** Hyperspace drive charge, 0..1, or null when it is not charging (v0.7). */
  jumpCharge: number | null;
  /** Between leaving a sector and the first snapshot of the next one: not a destroyed ship. */
  jumping: boolean;
}

export type UiSound = 'click' | 'tab' | 'confirm' | 'deny' | 'notify' | 'lock' | 'comms' | 'mission' | 'repair' | 'upgrade' | 'purchase';

/** What a ship can strike, as heard (rock: also iron-nickel rock and debris). */
export type ImpactSurface = 'metal' | 'hull' | 'rock' | 'ice';
const COLLISION: Record<ImpactSurface, SoundId> = { metal: 'collision', hull: 'collision_hull', rock: 'collision_rock', ice: 'collision_ice' };

const LASER: Record<ShipClass, SoundId> = { falcon: 'laser_falcon', warden: 'laser_warden', raider: 'laser_raider', marauder: 'laser_marauder' };
const EXPLOSION: Record<ShipClass, SoundId> = { falcon: 'explosion_medium', warden: 'explosion_medium', raider: 'explosion_small', marauder: 'explosion_large' };
/** Alerts also written on screen (the others already have their own notice). */
const SHOWN: AlertId[] = ['shieldsLow', 'shieldsDown', 'hullDamaged', 'hullCritical', 'energyLow', 'proximity'];

export class GameAudio {
  readonly engine = new AudioEngine();
  private ship: EngineSound | null = null;
  private remotes: RemoteEngines | null = null;
  private amb: Ambience | null = null;
  private music: Music | null = null;
  private drive: Hyperdrive | null = null;
  readonly announcer: Announcer | null = null;
  private director = new MusicDirector();
  private alerts = new AlertMonitor();
  private sinceCombat = 99;
  private hadShip = false;
  muted = false;
  volume = 0.7;
  mix: MixLevels = { ...DEFAULT_MIX };
  voice = false;
  /** Where alert lines are written (the HUD). */
  onAlertText: ((text: string, priority: number) => void) | null = null;

  /** Creates the audio graph (silent until a gesture unlocks it). Safe to call many times. */
  start() {
    if (!this.engine.init()) return;
    this.engine.unlock();
    this.apply();
  }

  /** From any click or key press: browsers only let sound start after one. */
  unlock() {
    this.start();
  }

  setOccluders(list: Occluder[]) {
    this.engine.occluders = list;
  }

  setVolume(v: number, muted: boolean, mix?: MixLevels, voice?: boolean) {
    this.volume = v;
    this.muted = muted;
    if (mix) this.mix = { ...mix };
    if (voice !== undefined) this.voice = voice;
    this.apply();
  }

  private apply() {
    this.engine.setLevels(this.volume, this.muted, this.mix);
    if (this.announcer) {
      this.announcer.voice = this.voice;
      this.announcer.volume = this.muted ? 0 : this.volume * this.mix.voice;
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    this.apply();
  }

  setPaused(p: boolean) {
    this.engine.setPaused(p);
    if (p) this.announcer?.clear();
  }

  setHidden(h: boolean) {
    this.engine.setHidden(h);
  }

  setBlurred(b: boolean) {
    this.engine.setBlurred(b);
  }

  /** Builds the layers once the sounds they use are rendered. */
  private build() {
    const e = this.engine;
    if (!e.ctx || !e.has('loop_union') || !e.has('loop_raider')) return false;
    this.ship = new EngineSound(e);
    this.remotes = new RemoteEngines(e);
    this.amb = new Ambience(e);
    this.music = new Music(e);
    this.drive = new Hyperdrive(e);
    (this as { announcer: Announcer | null }).announcer = new Announcer(e, (t, p, id) => {
      if (SHOWN.includes(id)) this.onAlertText?.(t, p);
    });
    this.apply();
    return true;
  }

  /** Every frame, also in menus (music) and at the station. */
  frame(f: AudioFrame) {
    const e = this.engine;
    if (!e.ctx) return;
    if (!this.ship && !this.build()) return;
    if (e.ctx.state !== 'running') return;
    e.setListener(f.listener.pos, f.listener.fwd, f.listener.up);
    this.sinceCombat += f.dt;
    const me = f.me;

    this.ship!.update({
      dt: f.dt,
      present: !!me,
      throttle: me?.throttle ?? 0,
      speed: me?.speed ?? 0,
      boosting: me?.boosting ?? false,
      thrusters: me?.thrusters ?? 0,
      energy: me?.energy ?? 1,
      hull: me ? me.hull / me.hullMax : 1,
      view: f.view,
      mining: me?.mining ?? 0,
    });
    this.remotes!.update(f.docked ? [] : f.others);
    this.drive!.update(f.dt, me ? f.jumpCharge : null);
    this.amb!.update({
      dt: f.dt,
      docked: f.docked,
      flying: !!me,
      stationDist: f.stationDist,
      asteroidDist: f.asteroidDist,
      speed: f.speed,
      hostiles: f.hostilesFar,
      nearestHostile: f.nearestHostile,
    });

    const state = this.director.update({
      dt: f.dt,
      docked: f.docked,
      dead: !me && !f.docked && !f.jumping && this.hadShip,
      hostilesFar: f.hostilesFar,
      hostilesNear: f.hostilesNear,
      boss: f.boss,
      sinceCombat: this.sinceCombat,
      hull: me ? me.hull / me.hullMax : 1,
    });
    this.music!.update(state, this.director.intensity);

    if (me) {
      for (const id of this.alerts.update(me, e.now)) this.alert(id);
      if (f.asteroidDist < 60 && f.speed > 80) {
        const out: AlertId[] = [];
        if (this.alerts.fire('proximity', e.now, out)) this.alert('proximity');
      }
    } else if (!f.jumping) this.alerts.reset();
    this.hadShip = !!me || (this.hadShip && !f.docked);
    this.announcer!.update();
    e.meter();
  }

  /** Menus before a flight: only the music, calm. */
  menuFrame(dt: number) {
    const e = this.engine;
    if (!e.ctx) return;
    if (!this.ship && !this.build()) return;
    if (e.ctx.state !== 'running') return;
    this.ship!.update({ dt, present: false, throttle: 0, speed: 0, boosting: false, thrusters: 0, energy: 1, hull: 1, view: 'chase', mining: 0 });
    this.remotes!.update([]);
    this.music!.update('calm', 0);
  }

  alert(id: AlertId) {
    const sys = ({ shieldsDown: 'shieldDown', shieldsBack: 'shieldUp', energyLow: 'weaponsDown', weaponsReady: 'weaponsReady' } as const)[id as string];
    if (sys) this.systems(sys);
    this.announcer?.say(id);
  }

  // ------------------------------------------------------------ gameplay events

  /** A bolt fired by a ship of class `cls` at `at`; `own` when it is ours. */
  shot(at: Vec3, cls: ShipClass, own: boolean) {
    const e = this.engine;
    if (own) {
      this.sinceCombat = 0;
      // Our guns are bolted to the hull: heard through it, centred and full.
      e.play(LASER[cls], { bus: 'weapons', gain: 0.55, importance: 3 });
      return;
    }
    e.play(LASER[cls], { at, bus: 'weapons', gain: cls === 'marauder' ? 0.9 : 0.7, ref: 90, range: 1600, importance: cls === 'marauder' ? 2 : 1 });
  }

  /** A bolt hitting a shield (`shield`) or a hull at `at`; `onMe` when we are the target. */
  hit(at: Vec3, shield: boolean, onMe: boolean, damage: number) {
    const e = this.engine;
    if (onMe) {
      this.sinceCombat = 0;
      const g = Math.min(1, 0.5 + damage / 40);
      e.play(shield ? 'shield_hit' : 'hull_hit_own', { bus: 'impacts', gain: g, importance: 4, rate: shield ? 1 : 0.9 + Math.random() * 0.2 });
      if (!shield) e.duck('music', 0.7, 0.15, 0.4);
      return;
    }
    e.play(shield ? 'shield_hit' : 'hull_hit', { at, bus: 'impacts', gain: 0.75, ref: 80, range: 1400 });
  }

  /** Our bolt landed: a short tick, separate from the impact itself. */
  hitMarker(shield: boolean) {
    this.sinceCombat = 0;
    this.engine.play('ui_lock', { bus: 'ui', gain: shield ? 0.25 : 0.4, rate: shield ? 1.25 : 1, category: 'marker', importance: 2 });
  }

  /** A ship destroyed: size follows its class; our own death is its own sound. */
  explosion(at: Vec3, cls: ShipClass, own: boolean, byMe: boolean) {
    const e = this.engine;
    if (own) {
      e.play('death_own', { bus: 'explosions', gain: 1, importance: 5 });
      e.duck('fx', 0.35, 1.2, 2);
      e.duck('music', 0.25, 1.5, 3);
      return;
    }
    const d = e.distanceTo(at);
    const big = cls === 'marauder';
    e.play(EXPLOSION[cls], { at, bus: 'explosions', gain: 1, ref: big ? 260 : 160, range: big ? 4000 : 2600, importance: big ? 4 : 3 });
    // Close enough to feel: the rest of the mix makes room for a moment.
    if (d < (big ? 700 : 350)) e.duck('fx', big ? 0.5 : 0.7, 0.25, 0.8);
    if (byMe) this.alert('targetDestroyed');
  }

  /**
   * A ship striking something (v0.8). The sound follows what was struck and
   * how hard: a muffled knock for a bump too slow to hurt, a scrape when the
   * ship slides along, a crash otherwise (station plating, rock, ice or
   * another hull), louder and lower the faster the blow. `onMe`: our ship
   * (heard through the hull, centred); otherwise placed at `at`.
   */
  collision(at: Vec3, o: { damage: number; speed: number; surface: ImpactSurface; shield: boolean; onMe: boolean }) {
    const k = impactScale(o.speed);
    const soft = o.damage <= 0;
    const id: SoundId = soft
      ? o.speed < 3.5
        ? o.surface === 'metal' || o.surface === 'hull' ? 'scrape_metal' : 'scrape_rock'
        : 'bump'
      : COLLISION[o.surface];
    const g = soft ? 0.3 + 0.4 * k : Math.min(1, 0.45 + 0.55 * k + o.damage / 80);
    // Harder blows sound heavier: played slower, so lower.
    const rate = soft ? 0.95 + Math.random() * 0.1 : 1.1 - 0.25 * k + (Math.random() - 0.5) * 0.06;
    const e = this.engine;
    if (o.onMe) {
      this.sinceCombat = Math.min(this.sinceCombat, 4);
      e.play(id, { bus: 'impacts', gain: g, rate, importance: soft ? 2 : 4 });
      if (o.shield) e.play('shield_hit', { bus: 'impacts', gain: 0.4 + 0.4 * k, importance: 3 });
      if (!soft && k > 0.55) e.duck('music', 0.6, 0.2, 0.6);
      return;
    }
    e.play(id, { at, bus: 'impacts', gain: g * 0.85, rate, ref: 60, range: soft ? 500 : 1100, importance: soft ? 1 : 2 });
  }

  /** Our shield or weapons changed state (driven by AlertMonitor too, these are the system sounds). */
  systems(kind: 'shieldDown' | 'shieldUp' | 'weaponsDown' | 'weaponsReady') {
    const id = ({ shieldDown: 'shield_down', shieldUp: 'shield_up', weaponsDown: 'weapons_down', weaponsReady: 'weapons_ready' } as const)[kind];
    this.engine.play(id, { bus: 'impacts', gain: 0.7, importance: 3 });
  }

  /** Interface sound. */
  ui(kind: UiSound = 'notify') {
    this.engine.play(`ui_${kind}` as SoundId, { bus: kind === 'comms' ? 'comms' : 'ui', gain: 0.8, importance: 2, category: 'ui' });
  }

  /**
   * A hyperspace jump. Ours (no `at`): 'out' when the drive fires, 'in' when
   * the new sector appears. Another ship's: placed where it left or arrived.
   */
  jump(kind: 'out' | 'in', at?: Vec3) {
    const e = this.engine;
    const id = kind === 'out' ? 'jump_out' : 'jump_in';
    if (at) {
      e.play(id, { at, bus: 'explosions', gain: 0.8, ref: 200, range: 3500, importance: 2 });
      return;
    }
    e.play(id, { bus: 'explosions', gain: 0.95, importance: 5 });
    if (kind === 'out') {
      e.duck('music', 0.4, 0.2, 2);
      e.duck('ambience', 0.3, 0.1, 1.5);
    } else this.alert('jumpDone');
  }

  /** A warning notice (and the repeating hull alarm). */
  alarm() {
    this.engine.play('alert_2', { bus: 'voice', gain: 0.6, importance: 3, category: 'voice' });
  }

  /** Diagnostics for tests and the ?diag overlay. */
  report() {
    return {
      ...this.engine.report(),
      music: this.music?.current ?? null,
      musicNodes: this.music?.live ?? 0,
      remotes: this.remotes?.count ?? 0,
      director: this.director.state,
    };
  }
}
