/**
 * Where the multiplayer server lives, in order of priority:
 * 1. `?server=wss://…` in the page URL (testing another server),
 * 2. VITE_SERVER_URL at build time (Vercel environment variable),
 * 3. the page's own origin + /ws when the Node server also serves the client,
 * 4. ws://<host>:8080/ws during local development (Vite on :5173).
 */
export function resolveServerUrl(loc: Location = location, env: Record<string, string | undefined> = import.meta.env ?? {}): string | null {
  const param = new URLSearchParams(loc.search).get('server');
  if (param && /^wss?:\/\//.test(param)) return withPath(param);
  const built = env.VITE_SERVER_URL;
  if (built && /^wss?:\/\//.test(built)) return withPath(built);
  if (env.DEV || loc.port === '5173' || loc.port === '4173') return `ws://${loc.hostname}:8080/ws`;
  if (loc.protocol === 'https:' || loc.protocol === 'http:') return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
  return null;
}

function withPath(u: string) {
  const url = new URL(u);
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
  return url.toString();
}

/** HTTP status endpoint next to a WebSocket URL (wss://host/ws → https://host/status). */
export function statusUrl(wsUrl: string) {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '/status';
  u.search = '';
  return u.toString();
}

export interface ServerStatus {
  online: number;
  players: number;
  max: number;
  protocol: number;
}

/** Quick reachability probe for the start menu (never throws). */
export async function probeServer(wsUrl: string, timeoutMs = 4000): Promise<ServerStatus | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(statusUrl(wsUrl), { signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as ServerStatus;
    return typeof j.online === 'number' ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
