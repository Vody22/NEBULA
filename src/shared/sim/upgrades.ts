import type { StationId } from '../economy/market';
import { SHIP_CLASSES, type ShipClass } from './shipClasses';
import type { Ship, ShipClassId } from './types';

/**
 * Ship upgrades (v0.5). Each ship a pilot owns has a level from 0 to
 * UPGRADE_MAX per slot. The effective characteristics are the class values
 * scaled by those levels; the server and client-side prediction both read
 * them through `statsOf`, so an upgraded ship flies the same on both sides.
 */
export const UPGRADE_SLOTS = ['guns', 'shields', 'armor', 'engines', 'hold', 'mining'] as const;
export type UpgradeSlot = (typeof UPGRADE_SLOTS)[number];
export type ShipMods = Record<UpgradeSlot, number>;
export const UPGRADE_MAX = 3;

export interface UpgradeDef {
  slot: UpgradeSlot;
  label: string;
  /** What one level gives, for the station screen. */
  effect: string;
}

export const UPGRADES: Record<UpgradeSlot, UpgradeDef> = {
  guns: { slot: 'guns', label: 'Canons', effect: '+12 % de dégâts' },
  shields: { slot: 'shields', label: 'Boucliers', effect: '+15 % de bouclier et de recharge' },
  armor: { slot: 'armor', label: 'Blindage', effect: '+15 % de coque' },
  engines: { slot: 'engines', label: 'Moteurs', effect: '+5 % de vitesse et de poussée' },
  hold: { slot: 'hold', label: 'Soute', effect: '+25 % de capacité' },
  mining: { slot: 'mining', label: 'Rayon de minage', effect: '+25 % de rendement' },
};

export const noMods = (): ShipMods => ({ guns: 0, shields: 0, armor: 0, engines: 0, hold: 0, mining: 0 });

/** Credits for the next level of a slot (levels 1, 2, 3), before the ship's price factor. */
const LEVEL_COST = [500, 1400, 3200];

/** Ships pilots can own. The Falcon is every new pilot's first ship. */
export interface ShipOffer {
  classId: ShipClassId;
  price: number;
  /** Upgrades on this ship cost this much more. */
  upgradeFactor: number;
  role: string;
}

export const SHIPYARD: ShipOffer[] = [
  { classId: 'falcon', price: 0, upgradeFactor: 1, role: 'Chasseur polyvalent' },
  { classId: 'warden', price: 2000, upgradeFactor: 1.2, role: 'Transporteur : soute de 60 unités, plus lent et moins armé' },
];

/** Ships are sold at the hub's shipyard; upgrades are fitted at every station. */
export const SHIPYARD_STATION: StationId = 'aurora';

export function isUpgradeSlot(v: unknown): v is UpgradeSlot {
  return typeof v === 'string' && (UPGRADE_SLOTS as readonly string[]).includes(v);
}

export function offerOf(classId: ShipClassId): ShipOffer | undefined {
  return SHIPYARD.find((o) => o.classId === classId);
}

/** Price of the next level of `slot`, or null at the maximum. */
export function upgradeCost(classId: ShipClassId, mods: ShipMods, slot: UpgradeSlot): number | null {
  const level = mods[slot];
  if (level >= UPGRADE_MAX) return null;
  return Math.round((LEVEL_COST[level] * (offerOf(classId)?.upgradeFactor ?? 1)) / 10) * 10;
}

/** Validated levels from untrusted data (a save, a snapshot). */
export function cleanMods(raw: unknown): ShipMods {
  const m = noMods();
  if (!raw || typeof raw !== 'object') return m;
  for (const slot of UPGRADE_SLOTS) {
    const v = (raw as Record<string, unknown>)[slot];
    if (typeof v === 'number' && Number.isFinite(v)) m[slot] = Math.max(0, Math.min(UPGRADE_MAX, Math.floor(v)));
  }
  return m;
}

/** Six digits, one per slot ("030102"); '' for a ship without upgrades (NPCs). */
export function packMods(m: ShipMods): string {
  const s = UPGRADE_SLOTS.map((k) => m[k]).join('');
  return /^0+$/.test(s) ? '' : s;
}

export function unpackMods(s: string | undefined): ShipMods {
  const m = noMods();
  if (!s) return m;
  UPGRADE_SLOTS.forEach((k, i) => {
    const d = Number(s[i]);
    if (Number.isInteger(d)) m[k] = Math.max(0, Math.min(UPGRADE_MAX, d));
  });
  return m;
}

/** Effective characteristics, with the mining yield multiplier. */
export type ShipStats = ShipClass & { miningRate: number };

const cache = new Map<string, ShipStats>();

export function effectiveStats(classId: ShipClassId, mods: ShipMods): ShipStats {
  const key = `${classId}:${packMods(mods)}`;
  let s = cache.get(key);
  if (s) return s;
  const c = SHIP_CLASSES[classId];
  const k = (slot: UpgradeSlot, per: number) => 1 + per * mods[slot];
  const eng = k('engines', 0.05);
  s = {
    ...c,
    hull: c.hull * k('armor', 0.15),
    shield: c.shield * k('shields', 0.15),
    shieldRegen: c.shieldRegen * k('shields', 0.15),
    maxSpeed: c.maxSpeed * eng,
    boostSpeed: c.boostSpeed * eng,
    mainAccel: c.mainAccel * eng,
    boostAccel: c.boostAccel * eng,
    strafeAccel: c.strafeAccel * eng,
    weapon: { ...c.weapon, damage: c.weapon.damage * k('guns', 0.12) },
    cargo: Math.floor(c.cargo * k('hold', 0.25)),
    miningRate: k('mining', 0.25),
  };
  cache.set(key, s);
  return s;
}

/** What this ship can do, upgrades included. */
export function statsOf(ship: Pick<Ship, 'classId' | 'mods'>): ShipStats {
  return effectiveStats(ship.classId, ship.mods);
}

/** Effective characteristics from a snapshot (`u` as sent by snapshotShip). */
export function statsOfPacked(classId: ShipClassId, u: string | undefined): ShipStats {
  return cache.get(`${classId}:${u ?? ''}`) ?? effectiveStats(classId, unpackMods(u));
}
