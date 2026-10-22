import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientFrame, PROTOCOL_VERSION, type ServerMessage } from '../../shared/net/protocol';
import { TICK_DT } from '../../shared/sim/world';
import { GameServer, type ClientLink } from '../GameServer';

export interface NodeServerOptions {
  port: number;
  host?: string;
  /** Allowed browser origins for the WebSocket ("*" or empty = any). */
  allowedOrigins?: string[];
  maxPlayers?: number;
  seed?: number;
  /** Snapshot every N ticks (3 → 20 Hz). */
  snapshotEvery?: number;
  /** Optional folder with the built client (dist/) served over HTTP. */
  staticDir?: string;
  reconnectGrace?: number;
  npcs?: boolean;
  /** permessage-deflate on large frames (default on). */
  compression?: boolean;
  log?: (msg: string) => void;
}

export interface RunningServer {
  readonly game: GameServer;
  readonly http: Server;
  readonly port: number;
  close(): Promise<void>;
}

/** Client messages allowed per second (inputs are 60/s), with a burst allowance. */
const MSG_RATE = 150;
const MSG_BURST = 300;
/** Malformed / over-limit items tolerated before the client is dropped. */
const MAX_VIOLATIONS = 200;
const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 15_000;
/** A client this far behind on its socket stops receiving snapshots; further behind, it is dropped. */
const SLOW_BYTES = 512 * 1024;
const DEAD_BYTES = 4 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** One WebSocket client: buffers outgoing messages and flushes them as a single frame. */
class WsLink implements ClientLink {
  private out: string[] = [];
  constructor(readonly ws: WebSocket) {}

  send(msg: ServerMessage) {
    this.out.push(JSON.stringify(msg));
  }

  sendRaw(json: string) {
    // Snapshots are expendable: a congested client skips them instead of queueing more.
    if (this.ws.bufferedAmount > SLOW_BYTES) return;
    this.out.push(json);
  }

  close() {
    this.flush();
    this.ws.close(4000, 'closed');
  }

  flush() {
    if (!this.out.length) return;
    if (this.ws.readyState !== this.ws.OPEN) {
      this.out.length = 0;
      return;
    }
    if (this.ws.bufferedAmount > DEAD_BYTES) {
      this.out.length = 0;
      this.ws.terminate();
      return;
    }
    this.ws.send(this.out.length === 1 ? this.out[0] : `[${this.out.join(',')}]`);
    this.out.length = 0;
  }
}

/**
 * The real multiplayer server: one authoritative GameServer (one sector)
 * behind a WebSocket endpoint at /ws, plus /health, /status and optionally
 * the built client.
 */
export function startServer(opts: NodeServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((m: string) => console.log(`[${new Date().toISOString()}] ${m}`));
  const game = new GameServer({
    seed: opts.seed,
    snapshotEvery: opts.snapshotEvery ?? 3,
    maxPlayers: opts.maxPlayers ?? 30,
    reconnectGrace: opts.reconnectGrace,
    npcs: opts.npcs,
  });
  const origins = (opts.allowedOrigins ?? []).map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  const anyOrigin = origins.length === 0 || origins.includes('*');
  // "https://nebula-*.vercel.app" style patterns cover Vercel preview deployments.
  const originPatterns = origins.map((o) => new RegExp(`^${o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]*')}$`, 'i'));
  const originAllowed = (o: string | undefined) => anyOrigin || (o !== undefined && originPatterns.some((r) => r.test(o)));
  const links = new Set<WsLink>();
  const started = Date.now();
  const staticRoot = opts.staticDir && existsSync(opts.staticDir) ? resolve(opts.staticDir) : null;

  const http = createServer((req, res) => handleHttp(req, res));

  function handleHttp(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const origin = req.headers.origin;
    if (origin && originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', anyOrigin ? '*' : origin);
      res.setHeader('Vary', 'Origin');
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok');
      return;
    }
    if (url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(
        JSON.stringify({
          game: 'NEBULA FRONTIER',
          protocol: PROTOCOL_VERSION,
          sector: game.world.zone.name,
          online: game.onlineCount,
          players: game.sessionCount,
          max: game.maxPlayers,
          wave: game.wave,
          uptime: Math.round((Date.now() - started) / 1000),
        }),
      );
      return;
    }
    if (staticRoot && (req.method === 'GET' || req.method === 'HEAD')) {
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
      let file = resolve(join(staticRoot, rel || 'index.html'));
      if (file !== staticRoot && !file.startsWith(staticRoot + sep)) {
        res.writeHead(403).end();
        return;
      }
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(staticRoot, 'index.html');
      if (existsSync(file)) {
        const ext = extname(file);
        res.writeHead(200, {
          'Content-Type': MIME[ext] ?? 'application/octet-stream',
          'Cache-Control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        });
        if (req.method === 'HEAD') res.end();
        else createReadStream(file).pipe(res);
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('NEBULA FRONTIER server: WebSocket endpoint at /ws');
  }

  // JSON snapshots compress ~4x: deflate frames above 1 KB (snapshots), keep small ones raw.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
    perMessageDeflate: opts.compression === false
      ? false
      : { threshold: 1024, serverMaxWindowBits: 13, zlibDeflateOptions: { level: 3, memLevel: 7 }, concurrencyLimit: 8 },
  });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws' || !originAllowed(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
  });

  function onConnection(ws: WebSocket, req: IncomingMessage) {
    const link = new WsLink(ws);
    links.add(link);
    const addr = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? '?';
    let sessionId: string | null = null;
    let tokens = MSG_BURST;
    let lastRefill = Date.now();
    let violations = 0;
    let alive = true;

    const helloTimer = setTimeout(() => {
      if (!sessionId) ws.close(4001, 'hello timeout');
    }, HELLO_TIMEOUT_MS);
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    ws.on('pong', () => (alive = true));

    const fail = (text: string) => {
      link.send({ t: 'error', code: 'protocol', text });
      link.close();
    };

    ws.on('message', (data, isBinary) => {
      alive = true;
      if (isBinary) {
        if (++violations > MAX_VIOLATIONS) fail('Messages invalides.');
        return;
      }
      const now = Date.now();
      tokens = Math.min(MSG_BURST, tokens + ((now - lastRefill) / 1000) * MSG_RATE);
      lastRefill = now;
      const { messages, rejected } = parseClientFrame(data.toString());
      violations += rejected;
      for (const msg of messages) {
        if (tokens < 1) {
          violations++;
          continue;
        }
        tokens--;
        if (!sessionId) {
          if (msg.t !== 'hello') {
            violations++;
            continue;
          }
          if (msg.version !== PROTOCOL_VERSION) {
            link.send({ t: 'error', code: 'version', text: 'Version du jeu différente du serveur : rechargez la page.' });
            link.close();
            return;
          }
          const id = game.connect(link, msg.name, msg.token);
          link.flush();
          if (!id) return;
          sessionId = id;
          clearTimeout(helloTimer);
          log(`join ${id} from ${addr} (${game.onlineCount}/${game.maxPlayers} online)`);
          continue;
        }
        game.receive(sessionId, msg);
      }
      if (violations > MAX_VIOLATIONS) fail('Trop de messages invalides.');
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(heartbeat);
      links.delete(link);
      if (sessionId) {
        game.detach(sessionId, link);
        log(`leave ${sessionId} (${game.onlineCount} online)`);
      }
    });
    ws.on('error', () => ws.terminate());
  }

  // Fixed-step loop driven by the wall clock. Network frames go out with each
  // snapshot (every `snapshotEvery` ticks), bundling that window's events.
  const snapshotEvery = opts.snapshotEvery ?? 3;
  let last = performance.now();
  let acc = 0;
  const loop = setInterval(() => {
    const now = performance.now();
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    while (acc >= TICK_DT) {
      acc -= TICK_DT;
      game.tick();
      if (game.world.tick % snapshotEvery === 0) for (const l of links) l.flush();
    }
  }, 4);

  return new Promise((resolveStart, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      const addr = http.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      log(`NEBULA FRONTIER server on :${port} (ws path /ws, max ${game.maxPlayers} players, origins ${anyOrigin ? '*' : origins.join(' ')}${staticRoot ? `, static ${staticRoot}` : ''})`);
      resolveStart({
        game,
        http,
        port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(loop);
            for (const l of links) {
              l.send({ t: 'notice', text: 'Redémarrage du serveur…', tone: 'warn' });
              l.close();
            }
            wss.close();
            http.closeAllConnections?.();
            http.close(() => done());
          }),
      });
    });
  });
}
