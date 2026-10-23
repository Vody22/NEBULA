import { isQualityLevel, type QualitySetting } from './render/quality';
/**
 * Player preferences (bindings, sound, mouse) persisted in localStorage.
 * Storage can be unavailable (private mode, blocked site data): every access
 * is guarded and the game falls back to defaults.
 */

export type Action =
  | 'throttleUp'
  | 'throttleDown'
  | 'strafeLeft'
  | 'strafeRight'
  | 'strafeUp'
  | 'strafeDown'
  | 'rollLeft'
  | 'rollRight'
  | 'pitchUp'
  | 'pitchDown'
  | 'yawLeft'
  | 'yawRight'
  | 'boost'
  | 'fire'
  | 'stop'
  | 'assist'
  | 'target'
  | 'camera'
  | 'mute'
  | 'chat'
  | 'chatToggle'
  | 'pvp'
  | 'scoreboard'
  | 'dock'
  | 'mine';

export type KeyboardLayout = 'auto' | 'azerty' | 'qwerty';

export interface Settings {
  version: number;
  bindings: Record<Action, string>;
  layout: KeyboardLayout;
  volume: number;
  muted: boolean;
  invertY: boolean;
  sensitivity: number;
  /** Pilot name shown to other players. */
  name: string;
  chatVisible: boolean;
  /** Graphics quality ('auto': Bas on touch screens, Élevé elsewhere). */
  quality: QualitySetting;
}

/** Bindings are physical key positions (KeyboardEvent.code): ZQSD on AZERTY = WASD on QWERTY. */
export const DEFAULT_BINDINGS: Record<Action, string> = {
  throttleUp: 'KeyW',
  throttleDown: 'KeyS',
  strafeLeft: 'KeyA',
  strafeRight: 'KeyD',
  strafeUp: 'Space',
  strafeDown: 'KeyC',
  rollLeft: 'KeyQ',
  rollRight: 'KeyE',
  pitchUp: 'ArrowUp',
  pitchDown: 'ArrowDown',
  yawLeft: 'ArrowLeft',
  yawRight: 'ArrowRight',
  boost: 'ShiftLeft',
  fire: 'KeyF',
  stop: 'KeyX',
  assist: 'KeyZ',
  target: 'KeyT',
  camera: 'KeyV',
  mute: 'KeyM',
  chat: 'Enter',
  chatToggle: 'KeyH',
  pvp: 'KeyP',
  scoreboard: 'Tab',
  dock: 'KeyG',
  mine: 'KeyR',
};

export const ACTION_LABELS: Record<Action, string> = {
  throttleUp: 'Poussée +',
  throttleDown: 'Poussée −',
  strafeLeft: 'Translation gauche',
  strafeRight: 'Translation droite',
  strafeUp: 'Translation haut',
  strafeDown: 'Translation bas',
  rollLeft: 'Roulis gauche',
  rollRight: 'Roulis droite',
  pitchUp: 'Cabrer (nez en haut)',
  pitchDown: 'Piquer (nez en bas)',
  yawLeft: 'Lacet gauche',
  yawRight: 'Lacet droite',
  boost: 'Boost (maintenir)',
  fire: 'Tirer (avec le clic gauche)',
  stop: 'Couper les gaz',
  assist: 'Assistance de vol on/off',
  target: 'Cible suivante',
  camera: 'Changer de caméra',
  mute: 'Couper / remettre le son',
  chat: 'Écrire dans le chat',
  chatToggle: 'Afficher / masquer le chat',
  pvp: 'PvP on/off (en ligne)',
  scoreboard: 'Liste des pilotes (maintenir)',
  dock: "S'amarrer / décoller",
  mine: 'Rayon de minage (maintenir, ou clic droit)',
};

/** Keys offered to an action added in an update whose default key the player already gave to another action. */
const SPARE_KEYS = ['KeyG', 'KeyR', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyJ', 'KeyK', 'KeyL', 'KeyB', 'KeyN', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'];

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  bindings: { ...DEFAULT_BINDINGS },
  layout: 'auto',
  volume: 0.7,
  muted: false,
  invertY: false,
  sensitivity: 1,
  name: '',
  chatVisible: true,
  quality: 'auto',
};

const KEY = 'nebula-frontier.settings';

export function loadSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Settings {
  const base: Settings = { ...DEFAULT_SETTINGS, bindings: { ...DEFAULT_BINDINGS } };
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return base;
    const s = JSON.parse(raw) as Partial<Settings>;
    const bindings = { ...DEFAULT_BINDINGS };
    const missing: Action[] = [];
    if (s.bindings && typeof s.bindings === 'object') {
      for (const a of Object.keys(DEFAULT_BINDINGS) as Action[]) {
        const v = (s.bindings as Record<string, unknown>)[a];
        if (typeof v === 'string' && v.length < 32) bindings[a] = v;
        else missing.push(a);
      }
    }
    // Actions added since the settings were saved take their default key,
    // unless the player already uses it: then the first spare key.
    for (const a of missing) {
      const used = (code: string) => (Object.keys(bindings) as Action[]).some((o) => o !== a && bindings[o] === code);
      if (used(bindings[a])) bindings[a] = SPARE_KEYS.find((k) => !used(k)) ?? bindings[a];
    }
    return {
      version: 1,
      bindings,
      layout: s.layout === 'azerty' || s.layout === 'qwerty' ? s.layout : 'auto',
      volume: typeof s.volume === 'number' ? Math.min(1, Math.max(0, s.volume)) : base.volume,
      muted: s.muted === true,
      invertY: s.invertY === true,
      sensitivity: typeof s.sensitivity === 'number' ? Math.min(3, Math.max(0.25, s.sensitivity)) : 1,
      name: typeof s.name === 'string' ? s.name.slice(0, 16) : '',
      chatVisible: s.chatVisible !== false,
      quality: isQualityLevel(s.quality) ? s.quality : 'auto',
    };
  } catch {
    return base;
  }
}

export function saveSettings(s: Settings, storage: Pick<Storage, 'setItem'> | null = safeStorage()) {
  try {
    storage?.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked: preferences last for this session only */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Rebinds `action` to `code`. If another action used that key, the two
 * swap keys so no action is ever left without a binding.
 */
export function rebind(bindings: Record<Action, string>, action: Action, code: string) {
  const previous = bindings[action];
  for (const a of Object.keys(bindings) as Action[]) {
    if (a !== action && bindings[a] === code) bindings[a] = previous;
  }
  bindings[action] = code;
}

/** Physical key → printed label for an AZERTY (French) keyboard. */
const AZERTY: Record<string, string> = {
  KeyQ: 'A',
  KeyW: 'Z',
  KeyA: 'Q',
  KeyZ: 'W',
  KeyM: ',',
  Semicolon: 'M',
  Comma: ';',
  Period: ':',
  Digit1: '&',
  Digit2: 'É',
  Digit3: '"',
};

const NAMED: Record<string, string> = {
  Space: 'Espace',
  ShiftLeft: 'Maj G',
  ShiftRight: 'Maj D',
  ControlLeft: 'Ctrl G',
  ControlRight: 'Ctrl D',
  AltLeft: 'Alt',
  AltRight: 'Alt Gr',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: 'Entrée',
  Tab: 'Tab',
  Backspace: 'Retour',
  CapsLock: 'Verr. Maj',
};

/** Human label of a physical key for the chosen layout. `layoutMap` comes from navigator.keyboard when available. */
export function keyLabel(code: string, layout: KeyboardLayout, layoutMap?: Map<string, string> | null): string {
  if (NAMED[code]) return NAMED[code];
  if (layout === 'auto' && layoutMap?.get(code)) return layoutMap.get(code)!.toUpperCase();
  if (layout === 'azerty' && AZERTY[code]) return AZERTY[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Pavé ' + code.slice(6);
  return code;
}

/** Best guess of the player's layout when the Keyboard API is unavailable. */
export function guessLayout(languages: readonly string[]): 'azerty' | 'qwerty' {
  const l = (languages[0] ?? '').toLowerCase();
  return l.startsWith('fr') && !l.startsWith('fr-ca') && !l.startsWith('fr-ch') ? 'azerty' : 'qwerty';
}
