/**
 * Pure audio logic (no Web Audio here, so it runs in unit tests): bus names
 * and levels, distance curves, the voice limiter, the music director and the
 * onboard alert monitor. The Web Audio side (AudioEngine and the layers built
 * on it) asks these classes what to play.
 */

/** Mixing buses. Each one has its own gain; the player sets six of them in the options. */
export const BUSES = ['music', 'engines', 'weapons', 'impacts', 'explosions', 'ambience', 'ui', 'voice', 'comms'] as const;
export type BusId = (typeof BUSES)[number];

/** What the options menu exposes (0..1 each), on top of the master volume. */
export interface MixLevels {
  music: number;
  effects: number;
  ambience: number;
  ui: number;
  voice: number;
}

export const DEFAULT_MIX: MixLevels = { music: 0.6, effects: 1, ambience: 0.8, ui: 0.7, voice: 0.9 };

/** Which player level drives each bus, and its fixed balance in the mix (dB-ish linear trims). */
export const BUS_ROUTING: Record<BusId, { level: keyof MixLevels; trim: number }> = {
  music: { level: 'music', trim: 0.42 },
  engines: { level: 'effects', trim: 0.75 },
  weapons: { level: 'effects', trim: 0.62 },
  impacts: { level: 'effects', trim: 0.7 },
  explosions: { level: 'effects', trim: 0.85 },
  ambience: { level: 'ambience', trim: 0.5 },
  ui: { level: 'ui', trim: 1 },
  voice: { level: 'voice', trim: 0.8 },
  comms: { level: 'voice', trim: 0.55 },
};

export function cleanMix(raw: unknown): MixLevels {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const v = (k: keyof MixLevels) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? Math.min(1, Math.max(0, o[k] as number)) : DEFAULT_MIX[k]);
  return { music: v('music'), effects: v('effects'), ambience: v('ambience'), ui: v('ui'), voice: v('voice') };
}

/**
 * Space is silent: what the pilot hears outside the hull is the ship's sensor
 * rendering of nearby events. It fades with distance, and far events lose
 * their highs (a narrower sensor band), never louder than the cockpit.
 * Returns gain 0..1 and a low-pass cutoff in Hz; gain 0 past `range`.
 */
export function sensorCurve(distance: number, ref: number, range: number): { gain: number; cutoff: number } {
  if (distance >= range) return { gain: 0, cutoff: 800 };
  const near = 1 / (1 + (Math.max(0, distance - ref * 0.25) / ref) ** 2);
  // Soft fade to zero over the last quarter of the range: no pop at the edge.
  const edge = Math.min(1, (range - distance) / (range * 0.25));
  const cutoff = 800 + 17000 / (1 + distance / (ref * 2));
  return { gain: near * edge, cutoff };
}

/** Priority of a sound: importance divided by how far it is (own ship = closest). */
export function priorityOf(importance: number, distance: number) {
  return importance / (1 + distance / 100);
}

export interface VoiceRequest {
  category: string;
  priority: number;
}

/**
 * Caps simultaneous one-shots, overall and per category. A new sound that is
 * more important than the least important one playing takes its place (the
 * old one is faded out); otherwise it is dropped (virtualised: never heard).
 */
export class VoiceLimiter<T> {
  private active: { req: VoiceRequest; handle: T; until: number }[] = [];
  /** Sounds refused since start (diagnostics). */
  dropped = 0;
  stolen = 0;

  constructor(
    readonly maxVoices: number,
    readonly perCategory: Record<string, number>,
  ) {}

  get count() {
    return this.active.length;
  }

  countOf(category: string) {
    let n = 0;
    for (const a of this.active) if (a.req.category === category) n++;
    return n;
  }

  /** Forgets voices that ended by `now`. */
  prune(now: number) {
    if (this.active.some((a) => a.until <= now)) this.active = this.active.filter((a) => a.until > now);
  }

  /**
   * Asks for a voice lasting until `until`. Returns `{ ok, steal }`: when `ok`,
   * call `commit` with the playing handle; `steal` is a voice to fade out now.
   */
  request(req: VoiceRequest, now: number): { ok: boolean; steal: T | null } {
    this.prune(now);
    const cap = this.perCategory[req.category] ?? this.maxVoices;
    const same = this.active.filter((a) => a.req.category === req.category);
    const pool = same.length >= cap ? same : this.active.length >= this.maxVoices ? this.active : null;
    if (!pool) return { ok: true, steal: null };
    let weakest = pool[0];
    for (const a of pool) if (a.req.priority < weakest.req.priority) weakest = a;
    if (weakest.req.priority >= req.priority) {
      this.dropped++;
      return { ok: false, steal: null };
    }
    this.active = this.active.filter((a) => a !== weakest);
    this.stolen++;
    return { ok: true, steal: weakest.handle };
  }

  commit(req: VoiceRequest, handle: T, until: number) {
    this.active.push({ req, handle, until });
  }

  clear() {
    this.active = [];
  }
}

/** The musical moods, from quiet to loud. */
export type MusicState = 'calm' | 'explore' | 'tension' | 'combat' | 'boss' | 'danger' | 'victory';

export interface MusicInput {
  /** Seconds since the last update. */
  dt: number;
  /** Docked or in the menus. */
  docked: boolean;
  /** No ship of our own (destroyed, waiting to respawn). */
  dead: boolean;
  /** Hostile ships within sensor range (~3 km), and within combat range (~1.2 km). */
  hostilesFar: number;
  hostilesNear: number;
  /** A heavy pirate (Marauder) within combat range. */
  boss: boolean;
  /** Seconds since we last fired or were hit. */
  sinceCombat: number;
  /** Own hull, 0..1. */
  hull: number;
}

/**
 * Picks the musical state with hysteresis: combat starts at once, but the
 * music only calms down after a quiet spell, and a won fight plays a short
 * resolution (victory) before going back to exploring.
 */
export class MusicDirector {
  state: MusicState = 'calm';
  /** Seconds in the current state. */
  held = 0;
  /** Smoothed 0..1 intensity inside a state (more hostiles, louder drums). */
  intensity = 0;
  private fought = 0;

  update(i: MusicInput): MusicState {
    this.held += i.dt;
    const fighting = i.hostilesNear > 0 && i.sinceCombat < 8;
    if (fighting) this.fought += i.dt;
    let next: MusicState;
    if (i.docked) next = 'calm';
    else if (i.dead) next = 'tension';
    else if (fighting) next = i.hull < 0.3 ? 'danger' : i.boss ? 'boss' : 'combat';
    // A fight does not stop at the first quiet second.
    else if (this.isLoud() && i.hostilesNear > 0 && i.sinceCombat < 15) next = this.state;
    // A real fight that ended with no hostile left: a short resolution.
    else if (this.isLoud() && this.fought >= 6 && i.hostilesFar === 0) next = 'victory';
    else if (this.state === 'victory' && this.held < 9 && i.hostilesFar === 0) next = 'victory';
    else next = i.hostilesFar > 0 ? 'tension' : 'explore';
    if (next !== this.state) {
      if (!['combat', 'boss', 'danger'].includes(next)) this.fought = 0;
      this.state = next;
      this.held = 0;
    }
    const target = fighting ? Math.min(1, i.hostilesNear * 0.2 + (i.boss ? 0.35 : 0) + (1 - i.hull) * 0.35) : 0;
    this.intensity += (target - this.intensity) * Math.min(1, i.dt * 0.8);
    return this.state;
  }

  private isLoud() {
    return this.state === 'combat' || this.state === 'boss' || this.state === 'danger';
  }
}

export type AlertId =
  | 'shieldsLow'
  | 'shieldsDown'
  | 'shieldsBack'
  | 'hullDamaged'
  | 'hullCritical'
  | 'energyLow'
  | 'weaponsReady'
  | 'targetDestroyed'
  | 'docked'
  | 'contractDone'
  | 'proximity'
  | 'jumpCharge'
  | 'jumpDone'
  | 'cockpitDamaged'
  | 'cockpitDestroyed'
  | 'enginesDamaged'
  | 'enginesDestroyed'
  | 'wingLDamaged'
  | 'wingLDestroyed'
  | 'wingRDamaged'
  | 'wingRDestroyed';

/** Onboard announcement lines (text for the HUD and for voice; a recorded file can replace each later). */
export const ALERT_LINES: Record<AlertId, { text: string; priority: number; cooldown: number }> = {
  shieldsLow: { text: 'Boucliers faibles', priority: 2, cooldown: 12 },
  shieldsDown: { text: 'Boucliers hors service', priority: 3, cooldown: 8 },
  shieldsBack: { text: 'Boucliers rétablis', priority: 1, cooldown: 10 },
  hullDamaged: { text: 'Coque endommagée', priority: 3, cooldown: 20 },
  hullCritical: { text: 'Coque critique', priority: 4, cooldown: 10 },
  energyLow: { text: 'Énergie épuisée : boost et armes en recharge', priority: 2, cooldown: 10 },
  weaponsReady: { text: 'Armes prêtes', priority: 0, cooldown: 6 },
  targetDestroyed: { text: 'Cible détruite', priority: 1, cooldown: 2 },
  docked: { text: 'Amarrage confirmé', priority: 1, cooldown: 5 },
  contractDone: { text: 'Contrat rempli', priority: 2, cooldown: 3 },
  proximity: { text: 'Obstacle à proximité', priority: 2, cooldown: 6 },
  jumpCharge: { text: 'Réacteur hyperspatial en charge', priority: 1, cooldown: 3 },
  jumpDone: { text: 'Saut terminé', priority: 1, cooldown: 3 },
  // A component of our ship crossed a damage threshold (v0.8).
  cockpitDamaged: { text: 'Verrière fissurée : systèmes perturbés', priority: 3, cooldown: 8 },
  cockpitDestroyed: { text: 'Avionique hors service : boucliers et énergie rechargent au ralenti', priority: 4, cooldown: 8 },
  enginesDamaged: { text: 'Moteurs endommagés : propulsion réduite', priority: 3, cooldown: 8 },
  enginesDestroyed: { text: 'Moteurs hors service : propulseurs de manœuvre seulement', priority: 4, cooldown: 8 },
  wingLDamaged: { text: 'Aile gauche endommagée : stabilité réduite', priority: 3, cooldown: 8 },
  wingLDestroyed: { text: 'Aile gauche arrachée : maniabilité réduite', priority: 4, cooldown: 8 },
  wingRDamaged: { text: 'Aile droite endommagée : stabilité réduite', priority: 3, cooldown: 8 },
  wingRDestroyed: { text: 'Aile droite arrachée : maniabilité réduite', priority: 4, cooldown: 8 },
};

/** The announcement for a component crossing a damage threshold. */
export function componentAlert(part: 'cockpit' | 'engines' | 'wingL' | 'wingR', state: 'damaged' | 'destroyed'): AlertId {
  return `${part}${state === 'damaged' ? 'Damaged' : 'Destroyed'}` as AlertId;
}

export interface ShipVitals {
  shield: number;
  shieldMax: number;
  hull: number;
  hullMax: number;
  weaponsLocked: boolean;
}

/**
 * Turns the own ship's state into announcements, each when a threshold is
 * crossed (never repeated every frame) and no more often than its cooldown.
 */
export class AlertMonitor {
  private last: ShipVitals | null = null;
  private lastAt = new Map<AlertId, number>();

  reset() {
    this.last = null;
  }

  /** Raises an alert if its cooldown allows; returns whether it fired. */
  fire(id: AlertId, now: number, out: AlertId[]) {
    const at = this.lastAt.get(id);
    if (at !== undefined && now - at < ALERT_LINES[id].cooldown) return false;
    this.lastAt.set(id, now);
    out.push(id);
    return true;
  }

  update(v: ShipVitals, now: number): AlertId[] {
    const out: AlertId[] = [];
    const p = this.last;
    this.last = { ...v };
    if (!p) return out;
    const s0 = p.shield / p.shieldMax;
    const s1 = v.shield / v.shieldMax;
    const h0 = p.hull / p.hullMax;
    const h1 = v.hull / v.hullMax;
    if (s0 > 0.01 && s1 <= 0.01) this.fire('shieldsDown', now, out);
    else if (s0 >= 0.3 && s1 < 0.3) this.fire('shieldsLow', now, out);
    if (s0 <= 0.01 && s1 > 0.05) this.fire('shieldsBack', now, out);
    if (h0 >= 0.25 && h1 < 0.25) this.fire('hullCritical', now, out);
    else if (h0 >= 0.6 && h1 < 0.6) this.fire('hullDamaged', now, out);
    if (!p.weaponsLocked && v.weaponsLocked) this.fire('energyLow', now, out);
    if (p.weaponsLocked && !v.weaponsLocked) this.fire('weaponsReady', now, out);
    return out;
  }
}
