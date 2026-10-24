import { ITEMS, type ItemId } from './economy/items';
import { isStationId, STATION_IDS, type StationId } from './economy/market';
import { SECTOR_NAMES, STATION_SECTOR } from './sectors';

/**
 * Station contracts (v0.6). Each station posts a few offers on its board; a
 * pilot takes up to MAX_ACTIVE of them. The server owns progress and payment:
 *
 * - courier: sealed crates (`count`) to carry to `target`. They take hold space
 *   and are lost with the ship (the contract fails).
 * - mining: `count` units of `item`, mined after taking the contract, brought
 *   back to `target` (the issuing station). Bought ore does not count.
 * - hunt: destroy `count` pirates; paid as soon as the last one goes down.
 */
export type MissionKind = 'courier' | 'mining' | 'hunt';

export interface Mission {
  id: number;
  kind: MissionKind;
  /** Station that posted it. */
  station: StationId;
  /** Where to complete it (courier: another station, maybe in another sector; mining: the issuer; hunt: unused, the issuer). */
  target: StationId;
  /** Ore asked for (mining only). */
  item?: ItemId;
  count: number;
  /** Ore mined or pirates destroyed so far (courier: 0). */
  progress: number;
  reward: number;
}

export const MAX_ACTIVE = 3;
/** Offers shown on each station board. */
export const BOARD_SIZE = 4;
/** A taken offer is replaced after this long (s); a whole board is renewed this often. */
export const OFFER_REFILL = 30;
export const BOARD_RENEW = 600;

/** Short station names for contract texts (the full names are in zone.ts). */
export const STATION_SHORT: Record<StationId, string> = { aurora: 'Aurora-7', ferro: 'Ferro-9', kepler: 'Kepler-4', vesta: 'Vesta-2' };

/** "secteur Kepler", for contract texts. */
const sectorOf = (id: StationId) => SECTOR_NAMES[STATION_SECTOR[id]].replace(/^Secteur/, 'secteur');

/** Share of courier contracts that go to the other sector (v0.7). */
export const CROSS_SECTOR_SHARE = 0.35;

/** The courier destination is in another sector than the pilot's: a hyperspace jump is part of the job. */
export function crossSector(m: Mission): boolean {
  return STATION_SECTOR[m.target] !== STATION_SECTOR[m.station];
}

const MINING_ORES: ItemId[] = ['carbon', 'regolith', 'silicates', 'ironNickel'];
const round10 = (n: number) => Math.round(n / 10) * 10;

const KINDS: MissionKind[] = ['courier', 'mining', 'hunt'];

/** A new offer for a station's board (of the given kind, or a random one). `rng` returns [0, 1). */
export function makeOffer(rng: () => number, station: StationId, id: number, kind?: MissionKind): Mission {
  kind ??= KINDS[Math.floor(rng() * KINDS.length)];
  if (kind === 'courier') {
    const count = 4 + Math.floor(rng() * 7);
    // Mostly the other station of the sector; now and then one beyond a jump, paid for the trip.
    const here = STATION_IDS.filter((x) => x !== station && STATION_SECTOR[x] === STATION_SECTOR[station]);
    const away = STATION_IDS.filter((x) => STATION_SECTOR[x] !== STATION_SECTOR[station]);
    const far = away.length > 0 && rng() < CROSS_SECTOR_SHARE;
    const pool = far || !here.length ? away : here;
    const target = pool[Math.floor(rng() * pool.length)];
    const reward = 120 + count * 45;
    return { id, kind: 'courier', station, target, count, progress: 0, reward: round10(far ? reward * 1.8 + 150 : reward) };
  }
  if (kind === 'mining') {
    const item = MINING_ORES[Math.floor(rng() * MINING_ORES.length)];
    const count = 6 + Math.floor(rng() * 10);
    // Well above the market: the ore itself is handed over with the contract.
    return { id, kind: 'mining', station, target: station, item, count, progress: 0, reward: round10(80 + count * ITEMS[item].base * 2.2) };
  }
  const count = 2 + Math.floor(rng() * 4);
  return { id, kind: 'hunt', station, target: station, count, progress: 0, reward: round10(count * 220) };
}

/** Hold units the contract takes (courier crates). */
export function crates(m: Mission): number {
  return m.kind === 'courier' ? m.count : 0;
}

export function missionTitle(m: Mission): string {
  const stationName = (id: StationId) => STATION_SHORT[id];
  switch (m.kind) {
    case 'courier':
      return `Livraison : ${m.count} caisses pour ${stationName(m.target)}`;
    case 'mining':
      return `Minage : ${m.count} ${ITEMS[m.item!].label} pour ${stationName(m.target)}`;
    case 'hunt':
      return `Chasse : ${m.count} pirates à abattre`;
  }
}

/** What is left to do, for the station screen and the flight HUD. */
export function missionStatus(m: Mission): string {
  const stationName = (id: StationId) => STATION_SHORT[id];
  switch (m.kind) {
    case 'courier':
      return crossSector(m)
        ? `Caisses en soute : ${stationName(m.target)}, dans le ${sectorOf(m.target)} (saut hyperspatial)`
        : `Caisses en soute : amarrez-vous à ${stationName(m.target)}`;
    case 'mining':
      return m.progress >= m.count ? `Minerai prêt : amarrez-vous à ${stationName(m.target)}` : `Extrait : ${m.progress} / ${m.count}`;
    case 'hunt':
      return `Abattus : ${m.progress} / ${m.count}`;
  }
}

/** What the offer asks, before it is taken. */
export function missionBrief(m: Mission): string {
  switch (m.kind) {
    case 'courier':
      return crossSector(m)
        ? `Prend ${m.count} places en soute ; livraison dans le ${sectorOf(m.target)}, après un saut hyperspatial`
        : `Prend ${m.count} places en soute ; perdu si le vaisseau est détruit`;
    case 'mining':
      return 'Seul le minerai extrait après avoir accepté compte';
    case 'hunt':
      return 'Payé dès le dernier pirate abattu';
  }
}

/** Kinds for a fresh board: one of each, then random. */
export function boardKinds(rng: () => number, size: number): MissionKind[] {
  const kinds = [...KINDS];
  while (kinds.length < size) kinds.push(KINDS[Math.floor(rng() * KINDS.length)]);
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  return kinds.slice(0, size);
}

/** Contracts from untrusted data (a save), with sane bounds; unknown entries are dropped. */
export function cleanMissions(raw: unknown): Mission[] {
  if (!Array.isArray(raw)) return [];
  const out: Mission[] = [];
  for (const r of raw) {
    if (out.length >= MAX_ACTIVE || !r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const int = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : min);
    if (o.kind !== 'courier' && o.kind !== 'mining' && o.kind !== 'hunt') continue;
    if (!isStationId(o.station) || !isStationId(o.target)) continue;
    if (o.kind === 'mining' && !MINING_ORES.includes(o.item as ItemId)) continue;
    const count = int(o.count, 1, 30);
    out.push({
      id: 0,
      kind: o.kind,
      station: o.station,
      target: o.target,
      ...(o.kind === 'mining' ? { item: o.item as ItemId } : {}),
      count,
      progress: o.kind === 'courier' ? 0 : int(o.progress, 0, count),
      reward: int(o.reward, 0, 20000),
    });
  }
  return out;
}
