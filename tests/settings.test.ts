import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, guessLayout, keyLabel, loadSettings, rebind, saveSettings } from '../src/client/settings';

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe('settings', () => {
  it('round-trips through storage', () => {
    const st = memory();
    const s = loadSettings(st);
    s.volume = 0.3;
    s.invertY = true;
    rebind(s.bindings, 'fire', 'KeyR');
    saveSettings(s, st);
    const back = loadSettings(st);
    expect(back.volume).toBe(0.3);
    expect(back.invertY).toBe(true);
    expect(back.bindings.fire).toBe('KeyR');
  });

  it('ignores corrupted or hostile stored data', () => {
    expect(loadSettings({ getItem: () => '{not json' }).bindings).toEqual(DEFAULT_BINDINGS);
    const s = loadSettings({ getItem: () => JSON.stringify({ volume: 9, sensitivity: -4, layout: 'dvorak', bindings: { fire: 42 } }) });
    expect(s.volume).toBe(1);
    expect(s.sensitivity).toBe(0.25);
    expect(s.layout).toBe('auto');
    expect(s.bindings.fire).toBe(DEFAULT_BINDINGS.fire);
    expect(loadSettings(null).volume).toBeGreaterThan(0);
  });

  it('rebinding to a used key swaps the two actions', () => {
    const b = { ...DEFAULT_BINDINGS };
    rebind(b, 'fire', 'KeyW');
    expect(b.fire).toBe('KeyW');
    expect(b.throttleUp).toBe('KeyF');
    expect(new Set(Object.values(b)).size).toBe(Object.values(b).length);
  });

  it('labels physical keys for AZERTY and QWERTY', () => {
    expect(keyLabel('KeyW', 'azerty')).toBe('Z');
    expect(keyLabel('KeyA', 'azerty')).toBe('Q');
    expect(keyLabel('KeyQ', 'azerty')).toBe('A');
    expect(keyLabel('KeyW', 'qwerty')).toBe('W');
    expect(keyLabel('Space', 'qwerty')).toBe('Espace');
    expect(keyLabel('KeyW', 'auto', new Map([['KeyW', 'z']]))).toBe('Z');
    expect(guessLayout(['fr-FR'])).toBe('azerty');
    expect(guessLayout(['en-US'])).toBe('qwerty');
  });
});
