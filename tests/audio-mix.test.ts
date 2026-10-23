import { describe, expect, it } from 'vitest';
import { AlertMonitor, BUSES, BUS_ROUTING, cleanMix, DEFAULT_MIX, MusicDirector, sensorCurve, VoiceLimiter, type MusicInput } from '../src/client/audio/mix';
import { RECIPES, type Recipe } from '../src/client/audio/recipes';
import { loadSettings } from '../src/client/settings';

describe('audio mix', () => {
  it('routes every bus to a player level', () => {
    for (const b of BUSES) expect(DEFAULT_MIX[BUS_ROUTING[b].level]).toBeGreaterThan(0);
  });

  it('cleans stored levels', () => {
    expect(cleanMix(null)).toEqual(DEFAULT_MIX);
    expect(cleanMix({ music: 2, effects: -1, ambience: 'x', ui: 0.3 })).toEqual({ ...DEFAULT_MIX, music: 1, effects: 0, ui: 0.3 });
  });

  it('keeps old settings readable and adds the mix', () => {
    const s = loadSettings({ getItem: () => JSON.stringify({ volume: 0.4, muted: true }) });
    expect(s.volume).toBe(0.4);
    expect(s.mix).toEqual(DEFAULT_MIX);
    expect(s.voice).toBe(false);
  });

  it('fades sensor sounds with distance, darker far away, silent past range', () => {
    const near = sensorCurve(10, 100, 1000);
    const mid = sensorCurve(300, 100, 1000);
    const edge = sensorCurve(990, 100, 1000);
    expect(near.gain).toBeCloseTo(1, 1);
    expect(mid.gain).toBeLessThan(near.gain);
    expect(mid.cutoff).toBeLessThan(near.cutoff);
    expect(edge.gain).toBeLessThan(0.01);
    expect(sensorCurve(1000, 100, 1000).gain).toBe(0);
  });
});

describe('voice limiter', () => {
  it('caps a category and steals the weakest for a stronger sound', () => {
    const l = new VoiceLimiter<string>(10, { weapons: 2 });
    for (const [h, p] of [['a', 1], ['b', 2]] as const) {
      expect(l.request({ category: 'weapons', priority: p }, 0).ok).toBe(true);
      l.commit({ category: 'weapons', priority: p }, h, 1);
    }
    expect(l.request({ category: 'weapons', priority: 0.5 }, 0)).toEqual({ ok: false, steal: null });
    expect(l.request({ category: 'weapons', priority: 3 }, 0)).toEqual({ ok: true, steal: 'a' });
    expect(l.dropped).toBe(1);
    expect(l.stolen).toBe(1);
  });

  it('caps the total and forgets ended voices', () => {
    const l = new VoiceLimiter<number>(3, {});
    for (let i = 0; i < 3; i++) l.commit({ category: 'x' + i, priority: 1 }, i, 1);
    expect(l.request({ category: 'y', priority: 1 }, 0.5).ok).toBe(false);
    expect(l.request({ category: 'y', priority: 1 }, 1.5).ok).toBe(true);
    expect(l.count).toBe(0);
  });
});

describe('music director', () => {
  const base: MusicInput = { dt: 0.5, docked: false, dead: false, hostilesFar: 0, hostilesNear: 0, boss: false, sinceCombat: 99, hull: 1 };
  const run = (d: MusicDirector, i: Partial<MusicInput>, seconds: number) => {
    for (let t = 0; t < seconds; t += 0.5) d.update({ ...base, ...i });
    return d.state;
  };

  it('explores, tenses up when hostiles show, fights, resolves, calms down', () => {
    const d = new MusicDirector();
    expect(run(d, {}, 2)).toBe('explore');
    expect(run(d, { hostilesFar: 2 }, 2)).toBe('tension');
    expect(run(d, { hostilesFar: 2, hostilesNear: 2, sinceCombat: 0 }, 10)).toBe('combat');
    // A short lull mid-fight does not drop the music.
    expect(run(d, { hostilesFar: 2, hostilesNear: 2, sinceCombat: 10 }, 2)).toBe('combat');
    expect(run(d, { hostilesFar: 0, sinceCombat: 20 }, 1)).toBe('victory');
    expect(run(d, { sinceCombat: 30 }, 4)).toBe('victory');
    expect(run(d, { sinceCombat: 40 }, 8)).toBe('explore');
  });

  it('boss and danger moods, docked is calm', () => {
    const d = new MusicDirector();
    expect(run(d, { hostilesFar: 1, hostilesNear: 1, boss: true, sinceCombat: 0 }, 2)).toBe('boss');
    expect(run(d, { hostilesFar: 1, hostilesNear: 1, boss: true, sinceCombat: 0, hull: 0.2 }, 2)).toBe('danger');
    expect(run(d, { docked: true }, 1)).toBe('calm');
    expect(d.intensity).toBeLessThan(0.8);
  });

  it('a skirmish too short gets no victory', () => {
    const d = new MusicDirector();
    run(d, { hostilesFar: 1, hostilesNear: 1, sinceCombat: 0 }, 2);
    expect(run(d, { sinceCombat: 20 }, 1)).toBe('explore');
  });
});

describe('alert monitor', () => {
  const v = (shield: number, hull: number, weaponsLocked = false) => ({ shield, shieldMax: 100, hull, hullMax: 100, weaponsLocked });

  it('announces thresholds once, not every frame', () => {
    const m = new AlertMonitor();
    expect(m.update(v(100, 100), 0)).toEqual([]);
    expect(m.update(v(25, 100), 1)).toEqual(['shieldsLow']);
    expect(m.update(v(20, 100), 1.1)).toEqual([]);
    expect(m.update(v(0, 100), 2)).toEqual(['shieldsDown']);
    expect(m.update(v(0, 55), 3)).toEqual(['hullDamaged']);
    expect(m.update(v(0, 20), 4)).toEqual(['hullCritical']);
    expect(m.update(v(10, 20, true), 5)).toEqual(['shieldsBack', 'energyLow']);
    expect(m.update(v(10, 20, false), 6)).toEqual(['weaponsReady']);
  });

  it('respects cooldowns', () => {
    const m = new AlertMonitor();
    m.update(v(100, 100), 0);
    expect(m.update(v(0, 100), 1)).toEqual(['shieldsDown']);
    m.update(v(50, 100), 2);
    expect(m.update(v(0, 100), 3)).toEqual([]);
    m.update(v(50, 100), 4);
    expect(m.update(v(0, 100), 10)).toEqual(['shieldsDown']);
  });
});

describe('sound recipes', () => {
  it('every recipe is bounded and loops are marked', () => {
    for (const [id, r] of Object.entries(RECIPES) as [string, Recipe][]) {
      expect(r.duration, id).toBeGreaterThan(0.03);
      expect(r.duration, id).toBeLessThanOrEqual(5);
      expect(r.variants, id).toBeGreaterThanOrEqual(1);
      expect(!!r.loop, id).toBe(id.startsWith('loop_'));
    }
  });
});
