import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../../shared/net/protocol';
import type { NetStatus, Transport } from './Transport';

export interface WebSocketTransportOptions {
  /** Simulated one-way latency in ms (testing: ?lag=120). */
  lagMs?: number;
  /** Random extra delay 0..jitter ms on each message (testing: ?jitter=40). */
  jitterMs?: number;
  /** Where the reconnection token is kept (per tab, so two tabs are two pilots). */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

const TOKEN_KEY = 'nebula-frontier.session';
/** Errors after which reconnecting is pointless. */
const FATAL = new Set(['full', 'version', 'kicked']);

function sessionStore() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Online transport: talks to the Node GameServer over a WebSocket.
 * Outgoing messages are batched into one frame per rendered frame; the
 * connection is retried with back-off and the session resumed with its token.
 */
export class WebSocketTransport implements Transport {
  readonly online = true;
  readonly status: NetStatus = { state: 'connecting', rtt: 0 };
  /** 20 Hz snapshots + some jitter margin. */
  interpolationDelay = 0.11;
  private ws: WebSocket | null = null;
  private handlers: ((msg: ServerMessage) => void)[] = [];
  private inbox: ServerMessage[] = [];
  private outbox: ClientMessage[] = [];
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;
  private everConnected = false;
  private storage: WebSocketTransportOptions['storage'];

  constructor(
    readonly url: string,
    private name: string,
    private opts: WebSocketTransportOptions = {},
  ) {
    this.storage = opts.storage === undefined ? sessionStore() : opts.storage;
    this.open();
  }

  get label() {
    switch (this.status.state) {
      case 'online':
        return 'En ligne';
      case 'connecting':
        return 'Connexion…';
      case 'reconnecting':
        return 'Reconnexion…';
      default:
        return 'Hors ligne';
    }
  }

  private delay(fn: () => void) {
    const lag = (this.opts.lagMs ?? 0) + Math.random() * (this.opts.jitterMs ?? 0);
    if (lag > 0) setTimeout(fn, lag);
    else fn();
  }

  private open() {
    this.status.state = this.everConnected ? 'reconnecting' : 'connecting';
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.fail(`Adresse du serveur invalide (${(e as Error).message})`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const token = this.storage?.getItem(TOKEN_KEY) ?? undefined;
      this.delay(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'hello', version: PROTOCOL_VERSION, name: this.name, token })));
    };
    ws.onmessage = (ev) => {
      this.delay(() => {
        let data: unknown;
        try {
          data = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        for (const m of (Array.isArray(data) ? data : [data]) as ServerMessage[]) this.receive(m);
      });
    };
    ws.onclose = () => {
      this.stopPing();
      if (this.ws === ws) this.ws = null;
      if (this.closedByUs || this.status.state === 'failed') return;
      // Back-off 1, 2, 4, 8, 8… s; give up after ~1 min if the server never answered at all.
      this.attempts++;
      if (!this.everConnected && this.attempts >= 3) {
        this.fail('Serveur injoignable.');
        return;
      }
      this.status.state = 'reconnecting';
      this.retryTimer = setTimeout(() => this.open(), Math.min(8000, 1000 * 2 ** (this.attempts - 1)));
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private receive(m: ServerMessage) {
    if (m.t === 'welcome') {
      this.status.state = 'online';
      this.status.error = undefined;
      this.everConnected = true;
      this.attempts = 0;
      this.storage?.setItem(TOKEN_KEY, m.token);
      this.startPing();
    } else if (m.t === 'pong') {
      const rtt = performance.now() - m.c;
      this.status.rtt = this.status.rtt ? this.status.rtt * 0.7 + rtt * 0.3 : rtt;
      return;
    } else if (m.t === 'error') {
      if (FATAL.has(m.code)) {
        if (m.code === 'kicked') this.storage?.removeItem(TOKEN_KEY);
        this.fail(m.text);
      }
    }
    this.inbox.push(m);
    // A hidden tab renders no frames: keep only what still matters instead of piling up snapshots.
    if (this.inbox.length > 300) {
      const last = this.inbox.filter((x) => x.t === 'snapshot').pop();
      this.inbox = this.inbox.filter((x) => x.t !== 'snapshot' && x.t !== 'events' && x.t !== 'players');
      if (last) this.inbox.push(last);
    }
  }

  private fail(error: string) {
    this.status.state = 'failed';
    this.status.error = error;
    this.stopPing();
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  private startPing() {
    this.stopPing();
    const ping = () => this.send({ t: 'ping', c: performance.now(), rtt: Math.round(this.status.rtt) || undefined });
    ping();
    this.pingTimer = setInterval(ping, 2000);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  send(msg: ClientMessage) {
    if (this.status.state !== 'online') return; // inputs while disconnected are meaningless
    this.outbox.push(msg);
  }

  onMessage(handler: (msg: ServerMessage) => void) {
    this.handlers.push(handler);
  }

  update() {
    const ws = this.ws;
    if (this.outbox.length && ws && ws.readyState === WebSocket.OPEN) {
      const frame = JSON.stringify(this.outbox.length === 1 ? this.outbox[0] : this.outbox);
      this.delay(() => ws.readyState === WebSocket.OPEN && ws.send(frame));
    }
    this.outbox.length = 0;
    const q = this.inbox;
    this.inbox = [];
    for (const m of q) for (const h of this.handlers) h(m);
  }

  /** Retry now (after a failure, from the menu). */
  retry() {
    if (this.status.state !== 'failed') return;
    this.attempts = 0;
    this.open();
  }

  close() {
    this.closedByUs = true;
    this.stopPing();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.handlers.length = 0;
  }
}
