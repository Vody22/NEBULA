import { ITEMS, ITEM_IDS, addCargo, cargoTotal, removeCargo, type Cargo, type ItemId } from './items';

/** Aurora-7 and the Ferro-9 depot (Aurora sector), Kepler-4 and the Vesta-2 depot (Kepler sector, v0.7). */
export type StationId = 'aurora' | 'ferro' | 'kepler' | 'vesta';

export const STATION_IDS: readonly StationId[] = ['aurora', 'ferro', 'kepler', 'vesta'];

export function isStationId(v: unknown): v is StationId {
  return typeof v === 'string' && (STATION_IDS as readonly string[]).includes(v);
}

/**
 * One commodity at one station. The price follows the stock: scarce goods
 * are dear, plentiful ones cheap. The stock drifts back toward `eq` (the
 * station's own production and consumption), so a big sale moves the price
 * for a while, then the market recovers.
 */
export interface MarketLine {
  /** Units the station holds now. */
  stock: number;
  /** Stock at which the price equals the item's base price. */
  ref: number;
  /** Stock the station drifts back to. Below `ref`: it pays well; above: it sells cheap. */
  eq: number;
  /** Share of the gap to `eq` closed per minute. */
  rate: number;
}

export type MarketState = Record<ItemId, MarketLine>;

/** Prices move between these multiples of the base price. */
export const PRICE_MIN = 0.5;
export const PRICE_MAX = 1.6;
/** The station sells this much above its price and buys this much below. */
export const SPREAD = 0.08;
/** A station stops buying an item past this many times its reference stock. */
export const STOCK_CAP = 4;
/** Credits per hull point repaired at a station. */
export const REPAIR_COST = 2;

/** Price of repairing `points` of hull, in whole credits. */
export function repairCost(points: number): number {
  return Math.ceil(points * REPAIR_COST - 1e-9);
}

/** Price multiplier for a stock level. */
export function priceFactor(stock: number, ref: number): number {
  const ratio = ref > 0 ? stock / ref : 1;
  return Math.min(PRICE_MAX, Math.max(PRICE_MIN, 1 + 0.6 * (1 - ratio)));
}

/** What the station asks (player buys) and offers (player sells) for one unit, in whole credits. */
export function quote(item: ItemId, line: MarketLine): { buy: number; sell: number } {
  const p = ITEMS[item].base * priceFactor(line.stock, line.ref);
  return { buy: Math.max(1, Math.round(p * (1 + SPREAD))), sell: Math.max(1, Math.round(p * (1 - SPREAD))) };
}

const line = (ref: number, eq: number, rate = 0.12): MarketLine => ({ stock: eq, ref, eq, rate });

/**
 * Starting markets. Aurora-7 makes goods and needs ore; the Ferro-9 depot digs
 * ore and needs supplies. In the Kepler sector, the Kepler-4 hub builds parts
 * and medicine and pays for metals (platinum above all); the Vesta-2 ice
 * depot has water and carbon to spare and lacks everything else. The best
 * margins cross sectors: Vesta's water to the Ferro-9 depot, Kepler's
 * medicine to the depots, Aurora's ore and platinum to Kepler-4.
 */
export function createMarket(station: StationId): MarketState {
  if (station === 'kepler') {
    return {
      carbon: line(300, 160),
      regolith: line(300, 260),
      silicates: line(300, 70),
      ironNickel: line(300, 60),
      platinum: line(40, 5),
      rations: line(400, 220),
      water: line(400, 170),
      parts: line(200, 330),
      medicine: line(120, 230),
    };
  }
  if (station === 'vesta') {
    return {
      carbon: line(400, 700),
      regolith: line(400, 520),
      silicates: line(400, 380),
      ironNickel: line(400, 300),
      platinum: line(40, 18),
      rations: line(300, 50),
      water: line(300, 640),
      parts: line(150, 30),
      medicine: line(100, 20),
    };
  }
  if (station === 'aurora') {
    return {
      carbon: line(300, 100),
      regolith: line(300, 120),
      silicates: line(300, 90),
      ironNickel: line(300, 90),
      platinum: line(40, 10),
      rations: line(400, 560),
      water: line(400, 600),
      parts: line(200, 280),
      medicine: line(120, 170),
    };
  }
  return {
    carbon: line(400, 620),
    regolith: line(400, 680),
    silicates: line(400, 600),
    ironNickel: line(400, 640),
    platinum: line(40, 14),
    rations: line(300, 70),
    water: line(300, 60),
    parts: line(150, 35),
    medicine: line(100, 25),
  };
}

/** Production and consumption: every stock drifts toward its equilibrium. */
export function stepMarket(m: MarketState, dt: number) {
  for (const id of ITEM_IDS) {
    const l = m[id];
    l.stock += (l.eq - l.stock) * (1 - Math.exp((-l.rate * dt) / 60));
  }
}

export type TradeResult =
  | { ok: true; qty: number; credits: number }
  | { ok: false; reason: 'funds' | 'hold' | 'stock' | 'cargo' | 'saturated' | 'quantity' };

/**
 * Buys (qty > 0) or sells (qty < 0) whole units, one at a time at the price
 * of the moment, so a big order moves the price as it goes. Partial orders
 * go through as far as money, hold space, station stock or demand allow;
 * nothing at all fails with the reason. Mutates the wallet, hold and market.
 */
export function trade(m: MarketState, item: ItemId, qty: number, wallet: { credits: number }, cargo: Cargo, capacity: number): TradeResult {
  if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > 1000) return { ok: false, reason: 'quantity' };
  const l = m[item];
  let done = 0;
  let credits = 0;
  if (qty > 0) {
    let reason: 'funds' | 'hold' | 'stock' = 'stock';
    for (; done < qty; done++) {
      const { buy } = quote(item, l);
      if (l.stock < 1) break;
      if (cargoTotal(cargo) >= capacity) {
        reason = 'hold';
        break;
      }
      if (wallet.credits < buy) {
        reason = 'funds';
        break;
      }
      wallet.credits -= buy;
      credits -= buy;
      l.stock -= 1;
      addCargo(cargo, item, 1, capacity);
    }
    return done ? { ok: true, qty: done, credits } : { ok: false, reason };
  }
  let reason: 'cargo' | 'saturated' = 'cargo';
  for (; done < -qty; done++) {
    if ((cargo[item] ?? 0) < 1) break;
    if (l.stock >= l.ref * STOCK_CAP) {
      reason = 'saturated';
      break;
    }
    const { sell } = quote(item, l);
    removeCargo(cargo, item, 1);
    wallet.credits += sell;
    credits += sell;
    l.stock += 1;
  }
  return done ? { ok: true, qty: -done, credits } : { ok: false, reason };
}

export const TRADE_REFUSALS: Record<Exclude<TradeResult, { ok: true }>['reason'], string> = {
  funds: 'Crédits insuffisants',
  hold: 'Soute pleine',
  stock: 'Rupture de stock',
  cargo: "Vous n'en avez pas en soute",
  saturated: 'La station ne rachète plus ce produit pour le moment',
  quantity: 'Quantité invalide',
};
