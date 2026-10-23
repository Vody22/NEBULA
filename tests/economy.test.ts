import { describe, expect, it } from 'vitest';
import { addCargo, cargoTotal, ITEMS, removeCargo, type Cargo } from '../src/shared/economy/items';
import { createMarket, priceFactor, quote, stepMarket, STOCK_CAP, trade } from '../src/shared/economy/market';

describe('cargo hold', () => {
  it('fills up to its capacity and empties', () => {
    const c: Cargo = {};
    expect(addCargo(c, 'ironNickel', 30, 40)).toBe(30);
    expect(addCargo(c, 'carbon', 30, 40)).toBe(10);
    expect(cargoTotal(c)).toBe(40);
    expect(removeCargo(c, 'carbon', 25)).toBe(10);
    expect(c.carbon).toBeUndefined();
    expect(cargoTotal(c)).toBe(30);
  });
});

describe('market prices', () => {
  it('are dear when stock is low and cheap when it is high, within bounds', () => {
    expect(priceFactor(100, 100)).toBe(1);
    expect(priceFactor(0, 100)).toBe(1.6);
    expect(priceFactor(10_000, 100)).toBe(0.5);
    expect(priceFactor(50, 100)).toBeGreaterThan(priceFactor(150, 100));
  });

  it('always ask more than they offer at the same station', () => {
    for (const station of ['aurora', 'ferro'] as const) {
      const m = createMarket(station);
      for (const [id, line] of Object.entries(m)) {
        const q = quote(id as keyof typeof m, line);
        expect(q.buy).toBeGreaterThan(q.sell);
      }
    }
  });

  it('make carrying supplies to the depot and ore to Aurora-7 pay', () => {
    const aurora = createMarket('aurora');
    const ferro = createMarket('ferro');
    for (const id of ['rations', 'water', 'parts', 'medicine'] as const) {
      expect(quote(id, ferro[id]).sell).toBeGreaterThan(quote(id, aurora[id]).buy);
    }
    for (const id of ['carbon', 'regolith', 'silicates', 'ironNickel'] as const) {
      expect(quote(id, aurora[id]).sell).toBeGreaterThan(quote(id, ferro[id]).buy);
    }
    // A full hold of iron-nickel sold at Aurora-7 is worth more than a few pirates.
    expect(quote('ironNickel', aurora.ironNickel).sell * 40).toBeGreaterThan(800);
    expect(ITEMS.platinum.base).toBeGreaterThan(ITEMS.ironNickel.base * 4);
  });
});

describe('trading', () => {
  it('buys unit by unit, moving the price, within money and hold space', () => {
    const m = createMarket('aurora');
    const wallet = { credits: 500 };
    const cargo: Cargo = {};
    const first = quote('water', m.water).buy;
    const r = trade(m, 'water', 100, wallet, cargo, 40);
    expect(r).toMatchObject({ ok: true, qty: 40 });
    expect(cargo.water).toBe(40);
    expect(wallet.credits).toBe(500 + (r.ok ? r.credits : 0));
    expect(quote('water', m.water).buy).toBeGreaterThanOrEqual(first);
    expect(trade(m, 'water', 1, wallet, cargo, 40)).toEqual({ ok: false, reason: 'hold' });
  });

  it('stops when the money runs out', () => {
    const m = createMarket('aurora');
    const wallet = { credits: 150 };
    const cargo: Cargo = {};
    const r = trade(m, 'medicine', 10, wallet, cargo, 40);
    expect(r.ok && r.qty).toBe(Math.floor(150 / quote('medicine', createMarket('aurora').medicine).buy));
    expect(wallet.credits).toBeGreaterThanOrEqual(0);
    expect(trade(m, 'medicine', 10, { credits: 0 }, cargo, 40)).toEqual({ ok: false, reason: 'funds' });
  });

  it('sells what is in the hold, and a big sale lowers the price', () => {
    const m = createMarket('aurora');
    const wallet = { credits: 0 };
    const cargo: Cargo = { ironNickel: 40 };
    const before = quote('ironNickel', m.ironNickel).sell;
    const r = trade(m, 'ironNickel', -50, wallet, cargo, 40);
    expect(r).toMatchObject({ ok: true, qty: -40 });
    expect(cargo.ironNickel).toBeUndefined();
    expect(wallet.credits).toBeGreaterThan(before * 30);
    expect(quote('ironNickel', m.ironNickel).sell).toBeLessThan(before);
    expect(trade(m, 'ironNickel', -1, wallet, cargo, 40)).toEqual({ ok: false, reason: 'cargo' });
  });

  it('refuses to buy more once the station is saturated', () => {
    const m = createMarket('ferro');
    m.carbon.stock = m.carbon.ref * STOCK_CAP;
    expect(trade(m, 'carbon', -5, { credits: 0 }, { carbon: 5 }, 40)).toEqual({ ok: false, reason: 'saturated' });
  });

  it('rejects nonsense quantities', () => {
    const m = createMarket('aurora');
    for (const q of [0, 1.5, NaN, 5000]) expect(trade(m, 'water', q, { credits: 1e6 }, {}, 40)).toEqual({ ok: false, reason: 'quantity' });
  });

  it('recovers toward its equilibrium after a big sale', () => {
    const m = createMarket('aurora');
    m.ironNickel.stock += 200;
    const after = m.ironNickel.stock;
    for (let i = 0; i < 600; i++) stepMarket(m, 1);
    expect(m.ironNickel.stock).toBeLessThan(after);
    expect(m.ironNickel.stock - m.ironNickel.eq).toBeLessThan((after - m.ironNickel.eq) * 0.4);
  });
});
