import { GameServer } from '../../server/GameServer';
import type { ClientMessage, ServerMessage } from '../../shared/net/protocol';
import type { NetStatus, Transport } from './Transport';
import { TICK_RATE } from '../../shared/sim/world';

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

  constructor(name: string, seed?: number) {
    this.server = new GameServer({ seed });
    // Messages are queued and delivered from update() to mimic async delivery.
    this.sessionId = this.server.connect({ send: (m) => this.queue.push(m) }, name);
  }

  send(msg: ClientMessage) {
    this.server.receive(this.sessionId, msg);
  }

  onMessage(handler: (msg: ServerMessage) => void) {
    this.handlers.push(handler);
  }

  close() {
    this.handlers.length = 0;
  }

  update(dt: number) {
    this.server.update(dt);
    const q = this.queue;
    this.queue = [];
    for (const m of q) for (const h of this.handlers) h(m);
  }
}
