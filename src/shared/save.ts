import { ITEM_IDS, type Cargo } from './economy/items';
import { isStationId, type MarketState, type StationId } from './economy/market';
import { cleanMissions, crates, type Mission } from './missions';
import { cleanParts } from './physics/damage';
import type { ComponentId } from './physics/hitboxes';
import type { ShipClassId } from './sim/types';
import { cleanMods, effectiveStats, noMods, offerOf, type ShipMods } from './sim/upgrades';

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
  /** Hull points of the ship flown (the v0.4 field, kept so a v0.4 server can still read the save). */
  hull: number;
  /** The ship flown (always one of `fleet`). Added in v0.5. */
  ship: ShipClassId;
  /** Every ship the pilot owns, with its upgrades and hull points. The Falcon is always there. */
  fleet: Partial<Record<ShipClassId, OwnedShip>>;
  /** Contracts in progress (v0.6; absent in older saves). Their ids are reassigned on load. */
  missions: Mission[];
}

export interface OwnedShip {
  mods: ShipMods;
  hull: number;
  /** Damaged components (v0.8), absent when all are intact. Older servers ignore it. */
  parts?: Record<ComponentId, number>;
}

/**
 * v0.5 added `ship` and `fleet` without changing the version: a v0.4 server
 * (a rollback) still reads the credits, hold, score and hull. A save without
 * a fleet (written by v0.4) is a pilot with one Falcon.
 */
export const SAVE_VERSION = 1;
const SECTOR_SAVE_VERSION = 1;
/** Upper bounds that no honest save reaches (keeps a corrupted value from breaking the game). */
const MAX_CREDITS = 1e9;
const MAX_COUNT = 1e7;

const int = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0);

/** A clean save from untrusted data, or null when it is not a save at all. */
export function validateSave(raw: unknown): PilotSave | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== SAVE_VERSION) return null;
  const hullOf = (v: unknown, max: number) => Math.round((typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(1, v)) : max) * 10) / 10;

  const fleet: PilotSave['fleet'] = {};
  if (!o.fleet || typeof o.fleet !== 'object') {
    fleet.falcon = { mods: noMods(), hull: hullOf(o.hull, effectiveStats('falcon', noMods()).hull) };
  } else {
    const src = o.fleet as Record<string, unknown>;
    for (const [id, entry] of Object.entries(src)) {
      // Only ships that can be bought (a save cannot grant a pirate Marauder).
      if (!offerOf(id as ShipClassId) || !entry || typeof entry !== 'object') continue;
      const mods = cleanMods((entry as Record<string, unknown>).mods);
      const parts = cleanParts((entry as Record<string, unknown>).parts);
      fleet[id as ShipClassId] = { mods, hull: hullOf((entry as Record<string, unknown>).hull, effectiveStats(id as ShipClassId, mods).hull), ...(parts ? { parts } : {}) };
    }
  }
  fleet.falcon ??= { mods: noMods(), hull: effectiveStats('falcon', noMods()).hull };
  const ship: ShipClassId = typeof o.ship === 'string' && fleet[o.ship as ShipClassId] ? (o.ship as ShipClassId) : 'falcon';

  // Courier crates take hold space first; contracts that no longer fit are dropped.
  const hold = effectiveStats(ship, fleet[ship]!.mods).cargo;
  const missions: Mission[] = [];
  let reserved = 0;
  for (const m of cleanMissions(o.missions)) {
    if (reserved + crates(m) > hold) continue;
    reserved += crates(m);
    missions.push(m);
  }
  const capacity = hold - reserved;
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
  return {
    v: SAVE_VERSION,
    credits: int(o.credits, MAX_CREDITS),
    cargo,
    kills: int(o.kills, MAX_COUNT),
    deaths: int(o.deaths, MAX_COUNT),
    station: isStationId(o.station) ? o.station : 'aurora',
    hull: fleet[ship]!.hull,
    ship,
    fleet,
    missions,
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
  return { v: SECTOR_SAVE_VERSION, savedAt: now, stocks };
}

/** Puts saved stocks back into live markets (unknown stations and items are ignored, stocks clamped). Returns how many lines were restored. */
export function restoreSector(markets: Record<StationId, MarketState>, raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const o = raw as Record<string, unknown>;
  if (o.v !== SECTOR_SAVE_VERSION || !o.stocks || typeof o.stocks !== 'object') return 0;
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
