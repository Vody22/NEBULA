import type { StationId } from './economy/market';

/**
 * Sectors (v0.7): separate regions of space, each simulated by its own World
 * on the same server. Ships travel between them by hyperspace jump.
 */
export type SectorId = 'aurora' | 'kepler';

export const SECTOR_IDS: readonly SectorId[] = ['aurora', 'kepler'];

export function isSectorId(v: unknown): v is SectorId {
  return typeof v === 'string' && (SECTOR_IDS as readonly string[]).includes(v);
}

export const SECTOR_NAMES: Record<SectorId, string> = { aurora: 'Secteur Aurora', kepler: 'Secteur Kepler' };

/** The sector every station is in. */
export const STATION_SECTOR: Record<StationId, SectorId> = { aurora: 'aurora', ferro: 'aurora', kepler: 'kepler', vesta: 'kepler' };

/** Full station names (also in each sector's zone), for screens that show stations of other sectors. */
export const STATION_NAMES: Record<StationId, string> = {
  aurora: 'Station Aurora-7',
  ferro: 'Dépôt Ferro-9',
  kepler: 'Station Kepler-4',
  vesta: 'Dépôt Vesta-2',
};

/** The sector's main station: where a pilot who logged off in its space comes back. */
export const SECTOR_HUB: Record<SectorId, StationId> = { aurora: 'aurora', kepler: 'kepler' };

/** The zone seed of a sector, from the server's base seed (the client builds the same zone from it). */
export function sectorSeed(id: SectorId, base: number): number {
  return id === 'aurora' ? base : (base + 7919) | 0;
}

/** The sector a jump from `from` leads to when the pilot does not choose (two sectors: the other one). */
export function nextSector(from: SectorId): SectorId {
  return SECTOR_IDS[(SECTOR_IDS.indexOf(from) + 1) % SECTOR_IDS.length];
}

// Hyperspace jump rules (server-enforced; the client only shows them).
/** Seconds the drive charges before the jump. */
export const JUMP_CHARGE = 6;
/** The jump needs this far from every station (m): no jumping out of a hangar or a docking lane. */
export const JUMP_CLEARANCE = 1500;
/** Share of the capacitor the jump drains, checked at the start and taken at the jump. */
export const JUMP_ENERGY = 0.5;
/** Seconds after an arrival before the drive can charge again. */
export const JUMP_COOLDOWN = 20;
