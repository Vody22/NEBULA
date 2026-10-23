import { GameServer } from '../../server/GameServer';
import type { ClientMessage, ServerMessage } from '../../shared/net/protocol';
import type { PilotSave } from '../../shared/save';
import type { NetStatus, Transport } from './Transport';
import { TICK_RATE } from '../../shared/sim/world';
import { loadSolo, saveSolo } from '../account';

/** Solo progress is written at most this often (ms), and when the page goes away. */
const SAVE_DELAY = 1500;

export interface LocalTransportOptions {
  seed?: number;
  /** Keep the solo progress in this browser (credits, hold, station, market stocks). */
  persist?: boolean;
}

/** Runs the authoritative GameServer in-process (solo / offline mode). */
export class LocalTransport implements Transport {
  readonly label = 'Solo (hors ligne)';
  readonly online = false;
  readonly status: NetStatus = { state: 'local', rtt: 0 };
  readonly interpolationDelay = 1.5 / TICK_RATE;
  readonly server: GameServer;
  private handlers: ((msg: ServerMessage) => void)[] = [];
  private queue: ServerMessage[] = [];
  private sessionId: string;
  private persistOn: boolean;
  private unsaved: PilotSave | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(name: string, opts: LocalTransportOptions = {}) {
    this.persistOn = opts.persist ?? false;
    const stored = this.persistOn ? loadSolo() : null;
    this.server = new GameServer({
      seed: opts.seed,
      onSave: this.persistOn ? (_id, save, final) => this.queueSave(save, final) : undefined,
    });
    if (stored?.sector) this.server.importSector(stored.sector);
    // Messages are queued and delivered from update() to mimic async delivery.
    this.sessionId = this.server.connect({ send: (m) => this.queue.push(m) }, { accountId: this.persistOn ? 'solo' : null, name, save: stored?.save });
  }

  private queueSave(save: PilotSave, final: boolean) {
    this.unsaved = save;
    if (final) this.writeSave();
    else this.saveTimer ??= setTimeout(() => this.writeSave(), SAVE_DELAY);
  }

  private writeSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.unsaved) return;
    saveSolo(this.unsaved, this.server.exportSector());
    this.unsaved = null;
  }

  /** Writes the solo progress now (leaving the game, closing the page). */
  persist() {
    if (!this.persistOn) return;
    this.server.persistAll();
    this.writeSave();
  }

  send(msg: ClientMessage) {
    this.server.receive(this.sessionId, msg);
  }

  onMessage(handler: (msg: ServerMessage) => void) {
    this.handlers.push(handler);
  }

  close() {
    this.persist();
    this.handlers.length = 0;
  }

  update(dt: number) {
    this.server.update(dt);
    const q = this.queue;
    this.queue = [];
    for (const m of q) for (const h of this.handlers) h(m);
  }
}
