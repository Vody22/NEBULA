import { ITEMS, ITEM_IDS, cargoTotal, type ItemId } from '../../shared/economy/items';
import { repairCost } from '../../shared/economy/market';
import type { MarketView, PilotState } from '../../shared/net/protocol';
import './station.css';

export interface StationCallbacks {
  trade(item: ItemId, qty: number): void;
  repair(): void;
  undock(): void;
  /** Touch screens: the pause menu (the flight buttons are hidden at the station). */
  menu(): void;
}

/** A price seen at another station, for comparing (the client only knows the market it is docked at). */
export interface KnownPrice {
  station: string;
  buy: number;
  sell: number;
  /** performance.now() when it was seen. */
  at: number;
}

type Qty = 1 | 10 | 'max';

const fmt = (n: number) => Math.round(n).toLocaleString('fr-FR');

/**
 * The station screen while docked: credits, hold, hull repair, the market
 * and take-off. Rows are built once per station and only their numbers are
 * updated, so buttons keep focus and hover between market updates.
 */
export class StationPanel {
  readonly root: HTMLDivElement;
  private nameEl: HTMLElement;
  private creditsEl: HTMLElement;
  private holdEl: HTMLElement;
  private holdBar: HTMLElement;
  private hullEl: HTMLElement;
  private repairBtn: HTMLButtonElement;
  private undockKey: HTMLElement;
  private body: HTMLTableSectionElement;
  private rows = new Map<ItemId, { tr: HTMLTableRowElement; cells: HTMLElement[]; buy: HTMLButtonElement; sell: HTMLButtonElement }>();
  private qty: Qty = 1;
  private pilot: PilotState | null = null;
  private market: MarketView | null = null;
  private known: Map<ItemId, KnownPrice> = new Map();

  constructor(parent: HTMLElement, private cb: StationCallbacks) {
    const root = document.createElement('div');
    root.id = 'station';
    root.className = 'hidden';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Station');
    root.innerHTML = `
      <header>
        <div><div class="label">Amarré à</div><h2></h2></div>
        <div class="acts">
          <button class="menu" data-act="menu" aria-label="Menu">II</button>
          <button class="undock" data-act="undock">Décoller <kbd></kbd></button>
        </div>
      </header>
      <div class="summary">
        <div class="cell"><div class="label">Crédits</div><div class="v credits"></div></div>
        <div class="cell"><div class="label">Soute</div><div class="v hold"></div><div class="bar o"><i></i></div></div>
        <div class="cell"><div class="label">Coque</div><div class="v hull"></div><button class="repair" data-act="repair"></button></div>
      </div>
      <div class="mhead">
        <h3>Marché</h3>
        <div class="qty" role="group" aria-label="Quantité par ordre">
          <button data-qty="1" aria-pressed="true">×1</button><button data-qty="10" aria-pressed="false">×10</button><button data-qty="max" aria-pressed="false">Max</button>
        </div>
      </div>
      <div class="scroll"><table>
        <thead><tr><th>Marchandise</th><th>Stock</th><th>Achat</th><th>Vente</th><th class="cmp">Vu ailleurs</th><th>Soute</th><th></th></tr></thead>
        <tbody></tbody>
      </table></div>
      <p class="hint">Les prix montent quand le stock de la station baisse et baissent quand il monte : vendre une grosse cargaison fait chuter le prix, qui remonte peu à peu.</p>`;
    parent.appendChild(root);
    this.root = root;
    this.nameEl = root.querySelector('h2')!;
    this.creditsEl = root.querySelector('.credits')!;
    this.holdEl = root.querySelector('.hold')!;
    this.holdBar = root.querySelector('.bar.o > i')!;
    this.hullEl = root.querySelector('.hull')!;
    this.repairBtn = root.querySelector('.repair')!;
    this.undockKey = root.querySelector('.undock kbd')!;
    this.body = root.querySelector('tbody')!;
    this.buildRows();

    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      // A mouse click must not leave focus on the button: Espace and Entrée fly the ship and open the chat.
      if (e.detail > 0) b.blur();
      if (b.dataset.qty) this.setQty(b.dataset.qty === 'max' ? 'max' : (Number(b.dataset.qty) as 1 | 10));
      else if (b.dataset.act === 'undock') this.cb.undock();
      else if (b.dataset.act === 'repair') this.cb.repair();
      else if (b.dataset.act === 'menu') this.cb.menu();
      else if (b.dataset.trade) {
        const item = b.closest('tr')?.dataset.item as ItemId | undefined;
        if (item) this.order(item, b.dataset.trade === 'buy');
      }
    });
  }

  get isOpen() {
    return !this.root.classList.contains('hidden');
  }

  show(stationName: string) {
    this.nameEl.textContent = stationName.toUpperCase();
    this.root.classList.remove('hidden');
    this.root.querySelector<HTMLElement>('.scroll')!.scrollTop = 0;
  }

  hide() {
    this.root.classList.add('hidden');
    this.market = null;
  }

  setUndockKey(label: string) {
    this.undockKey.textContent = label;
  }

  setPilot(p: PilotState) {
    this.pilot = p;
    this.refresh();
  }

  setMarket(m: MarketView) {
    this.market = m;
    this.refresh();
  }

  /** Last prices seen at the other stations (shown only when there are some). */
  setKnownPrices(known: Map<ItemId, KnownPrice>) {
    this.known = known;
    this.refresh();
  }

  private setQty(q: Qty) {
    this.qty = q;
    for (const b of Array.from(this.root.querySelectorAll<HTMLButtonElement>('.qty button'))) {
      b.setAttribute('aria-pressed', String(b.dataset.qty === String(q)));
    }
  }

  /** How many units one click asks for. The server fills what money, space and stock allow, and says why when nothing goes through. */
  orderSize(item: ItemId, buy: boolean): number {
    const p = this.pilot;
    const line = this.market?.items.find((i) => i.id === item);
    if (this.qty !== 'max') return this.qty;
    if (!p || !line) return 1;
    if (!buy) return Math.max(1, p.cargo[item] ?? 0);
    const free = p.capacity - cargoTotal(p.cargo);
    return Math.max(1, Math.min(free, line.stock, Math.floor(p.credits / line.buy), 1000));
  }

  private order(item: ItemId, buy: boolean) {
    const n = this.orderSize(item, buy);
    this.cb.trade(item, buy ? n : -n);
  }

  private buildRows() {
    for (const id of ITEM_IDS) {
      const def = ITEMS[id];
      const tr = document.createElement('tr');
      tr.dataset.item = id;
      tr.className = def.kind;
      tr.innerHTML =
        `<td class="name"><i class="dot"></i>${def.label}<small>${def.kind === 'ore' ? 'minerai' : 'marchandise'}</small></td>` +
        '<td></td><td class="price"></td><td class="price"></td><td class="cmp"></td><td class="have"></td>' +
        `<td class="trade"><button data-trade="buy" aria-label="Acheter ${def.label}">Acheter</button><button data-trade="sell" aria-label="Vendre ${def.label}">Vendre</button></td>`;
      this.body.appendChild(tr);
      const cells = Array.from(tr.children).slice(1, 6) as HTMLElement[];
      this.rows.set(id, { tr, cells, buy: tr.querySelector('[data-trade=buy]')!, sell: tr.querySelector('[data-trade=sell]')! });
    }
  }

  private refresh() {
    const p = this.pilot;
    if (p) {
      const used = cargoTotal(p.cargo);
      this.creditsEl.textContent = `${fmt(p.credits)} cr`;
      this.holdEl.textContent = `${used} / ${p.capacity}`;
      this.holdBar.style.transform = `scaleX(${p.capacity ? used / p.capacity : 0})`;
      const hull = p.hull ?? p.hullMax;
      const missing = p.hullMax - hull;
      this.hullEl.textContent = `${Math.floor((hull / p.hullMax) * 100)} %`;
      this.hullEl.classList.toggle('crit', hull < p.hullMax * 0.3);
      this.repairBtn.textContent = missing >= 0.5 ? `Réparer · ${fmt(repairCost(missing))} cr` : 'Coque intacte';
      this.repairBtn.disabled = missing < 0.5;
    }
    this.root.classList.toggle('compare', this.known.size > 0);
    const now = performance.now();
    for (const id of ITEM_IDS) {
      const row = this.rows.get(id)!;
      const line = this.market?.items.find((i) => i.id === id);
      const have = p?.cargo[id] ?? 0;
      const [stock, buy, sell, seen, hold] = row.cells;
      stock.textContent = line ? fmt(line.stock) : '…';
      buy.textContent = line ? `${line.buy} cr` : '…';
      sell.textContent = line ? `${line.sell} cr` : '…';
      // Cheap or dear compared with the reference price.
      const base = ITEMS[id].base;
      buy.className = `price${line && line.buy < base * 0.9 ? ' cheap' : line && line.buy > base * 1.2 ? ' dear' : ''}`;
      sell.className = `price${line && line.sell > base * 1.1 ? ' good' : ''}`;
      const k = this.known.get(id);
      seen.textContent = k ? `${k.station} : ${k.sell} cr` : '—';
      seen.title = k ? `Prix de rachat vu à ${k.station} il y a ${Math.max(1, Math.round((now - k.at) / 60000))} min` : '';
      hold.textContent = have ? String(have) : '';
      row.tr.classList.toggle('held', have > 0);
      // Dimmed when it cannot work right now; still clickable, the station says why.
      const free = p ? p.capacity - cargoTotal(p.cargo) : 0;
      row.buy.classList.toggle('na', !line || !p || free <= 0 || line.stock < 1 || p.credits < line.buy);
      row.sell.classList.toggle('na', have <= 0);
    }
  }
}
