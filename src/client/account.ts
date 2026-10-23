import type { PilotSave, SectorSave } from '../shared/save';

/**
 * What the browser keeps between visits: the online login (name and token,
 * never the password) and the solo progress, which belongs to this device
 * only. Storage can be unavailable (private mode, blocked site data): every
 * access is guarded and the game works without it.
 */
const ACCOUNT_KEY = 'nebula-frontier.account';
const SOLO_KEY = 'nebula-frontier.solo';

export interface StoredAccount {
  name: string;
  token: string;
  /** ms since epoch. */
  expiresAt: number;
}

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function store(): KV | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(key: string, kv: KV | null = store()): unknown {
  try {
    const raw = kv?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown, kv: KV | null = store()) {
  try {
    if (value === null) kv?.removeItem(key);
    else kv?.setItem(key, JSON.stringify(value));
  } catch {
    /* full or blocked: the game goes on without it */
  }
}

export function loadAccount(kv: KV | null = store(), now = Date.now()): StoredAccount | null {
  const a = read(ACCOUNT_KEY, kv) as Partial<StoredAccount> | null;
  if (!a || typeof a.name !== 'string' || typeof a.token !== 'string' || typeof a.expiresAt !== 'number') return null;
  if (a.expiresAt <= now || !/^[A-Za-z0-9_-]{32,64}$/.test(a.token)) return null;
  return { name: a.name.slice(0, 16), token: a.token, expiresAt: a.expiresAt };
}

export function saveAccount(a: StoredAccount, kv: KV | null = store()) {
  write(ACCOUNT_KEY, a, kv);
}

export function clearAccount(kv: KV | null = store()) {
  write(ACCOUNT_KEY, null, kv);
}

export interface SoloData {
  v: 1;
  save: PilotSave;
  sector: SectorSave;
}

/** The solo progress of this browser (validated later by the game server), or null. */
export function loadSolo(kv: KV | null = store()): { save: unknown; sector: unknown } | null {
  const d = read(SOLO_KEY, kv) as Partial<SoloData> | null;
  if (!d || d.v !== 1 || !d.save) return null;
  return { save: d.save, sector: d.sector ?? null };
}

export function saveSolo(save: PilotSave, sector: SectorSave, kv: KV | null = store()) {
  write(SOLO_KEY, { v: 1, save, sector } satisfies SoloData, kv);
}

export function clearSolo(kv: KV | null = store()) {
  write(SOLO_KEY, null, kv);
}
