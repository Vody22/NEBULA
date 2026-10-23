import { ITEM_IDS, type Cargo } from './economy/items';
import { isStationId, type MarketState, type StationId } from './economy/market';

/**
 * What a pilot keeps between sessions: in the accounts database online, in
 * this browser in solo. Anything read back (a database row, localStorage) goes
 * through `validateSave`, which drops what it does not understand.
 */
export interface PilotSave {
  v: 1;
  credits: number;
  cargo: Cargo;
  kills: number;
  deaths: number;
  /** The station the pilot comes back to: the last one docked at. */
  station: StationId;
  /** Hull points of the ship, carried over to the next session. */
  hull: number;
}

export const SAVE_VERSION = 1;
/** Upper bounds that no honest save reaches (keeps a corrupted value from breaking the game). */
const MAX_CREDITS = 1e9;
const MAX_COUNT = 1e7;

const int = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0);

/** A clean save from untrusted data, or null when it is not a save at all. */
export function validateSave(raw: unknown, hullMax: number, capacity: number): PilotSave | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== SAVE_VERSION) return null;
  const cargo: Cargo = {};
  let room = capacity;
  const src = o.cargo && typeof o.cargo === 'object' ? (o.cargo as Record<string, unknown>) : {};
  for (const id of ITEM_IDS) {
    const n = Math.min(int(src[id], capacity), room);
    if (n > 0) {
      cargo[id] = n;
      room -= n;
    }
  }
  const hull = typeof o.hull === 'number' && Number.isFinite(o.hull) ? Math.min(hullMax, Math.max(1, o.hull)) : hullMax;
  return {
    v: SAVE_VERSION,
    credits: int(o.credits, MAX_CREDITS),
    cargo,
    kills: int(o.kills, MAX_COUNT),
    deaths: int(o.deaths, MAX_COUNT),
    station: isStationId(o.station) ? o.station : 'aurora',
    hull: Math.round(hull * 10) / 10,
  };
}

/** The part of the sector that outlives a server restart: station stocks. */
export interface SectorSave {
  v: 1;
  /** When it was written (ms since epoch): markets drift back toward equilibrium for the time the server was down. */
  savedAt: number;
  stocks: Partial<Record<StationId, Partial<Record<string, number>>>>;
}

export function sectorSave(markets: Record<StationId, MarketState>, now: number): SectorSave {
  const stocks: SectorSave['stocks'] = {};
  for (const [id, m] of Object.entries(markets) as [StationId, MarketState][]) {
    const line: Record<string, number> = {};
    for (const item of ITEM_IDS) line[item] = Math.round(m[item].stock * 100) / 100;
    stocks[id] = line;
  }
  return { v: SAVE_VERSION, savedAt: now, stocks };
}

/** Puts saved stocks back into live markets (unknown stations and items are ignored, stocks clamped). Returns how many lines were restored. */
export function restoreSector(markets: Record<StationId, MarketState>, raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const o = raw as Record<string, unknown>;
  if (o.v !== SAVE_VERSION || !o.stocks || typeof o.stocks !== 'object') return 0;
  let n = 0;
  for (const [id, lines] of Object.entries(o.stocks as Record<string, unknown>)) {
    if (!isStationId(id) || !markets[id] || !lines || typeof lines !== 'object') continue;
    for (const item of ITEM_IDS) {
      const v = (lines as Record<string, unknown>)[item];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const l = markets[id][item];
      l.stock = Math.max(0, Math.min(v, l.ref * 10));
      n++;
    }
  }
  return n;
}
