import type { ClientMessage, ServerMessage } from '../../shared/net/protocol';

export type NetState = 'local' | 'connecting' | 'online' | 'reconnecting' | 'failed';

export interface NetStatus {
  state: NetState;
  /** Smoothed round-trip time in ms (0 when unknown or local). */
  rtt: number;
  /** Why the connection failed or was refused (shown to the player). */
  error?: string;
}

/**
 * The networking boundary. The game client only talks to a Transport, never
 * to the server directly. LocalTransport runs the authoritative server in the
 * same page (solo); WebSocketTransport talks to the Node server (online).
 */
export interface Transport {
  send(msg: ClientMessage): void;
  onMessage(handler: (msg: ServerMessage) => void): void;
  /** Called every frame; local transports advance the embedded server here. */
  update(dt: number): void;
  /** True when the authoritative server is remote (the sector keeps running while paused). */
  readonly online: boolean;
  readonly status: NetStatus;
  /** Seconds of interpolation delay suited to this transport's snapshot rate and jitter. */
  readonly interpolationDelay: number;
  readonly label: string;
  close(): void;
}
