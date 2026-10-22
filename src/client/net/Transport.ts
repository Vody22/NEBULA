import type { ClientMessage, ServerMessage } from '../../shared/net/protocol';

/**
 * The networking boundary. The game client only talks to a Transport, never
 * to the server directly. LocalTransport runs the authoritative server in the
 * same page; a WebSocketTransport will implement the same interface.
 */
export interface Transport {
  send(msg: ClientMessage): void;
  onMessage(handler: (msg: ServerMessage) => void): void;
  /** Called every frame; local transports advance the embedded server here. */
  update(dt: number): void;
  readonly label: string;
}
