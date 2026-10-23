/**
 * Everything that can travel in a cargo hold. Shared by the server (markets,
 * mining, trades) and the client (labels, prices, hold display).
 */
export type ItemId = 'carbon' | 'regolith' | 'silicates' | 'ironNickel' | 'platinum' | 'rations' | 'water' | 'parts' | 'medicine';

export interface ItemDef {
  id: ItemId;
  label: string;
  kind: 'ore' | 'goods';
  /** Reference price in credits per unit (a station at equilibrium prices around it). */
  base: number;
}

export const ITEMS: Record<ItemId, ItemDef> = {
  carbon: { id: 'carbon', label: 'Carbone', kind: 'ore', base: 9 },
  regolith: { id: 'regolith', label: 'Régolithe', kind: 'ore', base: 6 },
  silicates: { id: 'silicates', label: 'Silicates', kind: 'ore', base: 14 },
  ironNickel: { id: 'ironNickel', label: 'Fer-nickel', kind: 'ore', base: 24 },
  platinum: { id: 'platinum', label: 'Platine', kind: 'ore', base: 140 },
  rations: { id: 'rations', label: 'Rations', kind: 'goods', base: 18 },
  water: { id: 'water', label: 'Eau', kind: 'goods', base: 12 },
  parts: { id: 'parts', label: 'Pièces détachées', kind: 'goods', base: 45 },
  medicine: { id: 'medicine', label: 'Médicaments', kind: 'goods', base: 80 },
};

export const ITEM_IDS = Object.keys(ITEMS) as ItemId[];

export function isItemId(v: unknown): v is ItemId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ITEMS, v);
}

/** Units per item in a hold; missing items are 0. */
export type Cargo = Partial<Record<ItemId, number>>;

export function cargoTotal(cargo: Cargo): number {
  let n = 0;
  for (const id of ITEM_IDS) n += cargo[id] ?? 0;
  return n;
}

/** Adds up to `qty` units within `capacity`; returns how many fitted. */
export function addCargo(cargo: Cargo, item: ItemId, qty: number, capacity: number): number {
  const fit = Math.max(0, Math.min(qty, capacity - cargoTotal(cargo)));
  if (fit > 0) cargo[item] = (cargo[item] ?? 0) + fit;
  return fit;
}

/** Removes up to `qty` units; returns how many were there. */
export function removeCargo(cargo: Cargo, item: ItemId, qty: number): number {
  const have = cargo[item] ?? 0;
  const taken = Math.max(0, Math.min(qty, have));
  if (have - taken > 0) cargo[item] = have - taken;
  else delete cargo[item];
  return taken;
}
