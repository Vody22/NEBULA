import { isItemId, type Cargo, type ItemId } from '../economy/items';
import type { StationId } from '../economy/market';
import type { EntityId, FactionId, Ship, ShipClassId, ShipInput, SimEvent } from '../sim/types';

/**
 * Wire protocol between client and authoritative server. Everything here is
 * plain JSON-serialisable data so it can travel over WebSocket unchanged
 * (a binary encoding can replace JSON later without touching game code).
 */
export const PROTOCOL_VERSION = 4;

export interface ShipSnapshot {
  id: EntityId;
  name: string;
  classId: ShipClassId;
  faction: FactionId;
  owner: string | null;
  p: [number, number, number];
  q: [number, number, number, number];
  v: [number, number, number];
  /** Angular velocity (local frame), needed by client-side prediction. */
  w: [number, number, number];
  hull: number;
  shield: number;
  energy: number;
  throttle: number;
  boosting: boolean;
  firing: boolean;
  weaponsLocked: boolean;
  pvp: boolean;
  /** Index of the asteroid this ship is mining (zone.asteroids), absent when not mining. */
  m?: number;
}

export interface PlayerStats {
  kills: number;
  deaths: number;
  credits: number;
}

/** The player's own economy: sent on every change. */
export interface PilotState {
  credits: number;
  cargo: Cargo;
  capacity: number;
  /** Station the player is docked at, or null in space. */
  docked: StationId | null;
  /** The docked ship's hull, for the repair counter (null in space). */
  hull: number | null;
  hullMax: number;
}

/** A station's market as the docked player sees it. */
export interface MarketView {
  station: StationId;
  /** buy: the station's asking price; sell: what it pays. */
  items: { id: ItemId; buy: number; sell: number; stock: number }[];
}

export interface WorldSnapshot {
  tick: number;
  time: number;
  ships: ShipSnapshot[];
}

export interface PlayerInfo {
  id: string;
  name: string;
  ship: EntityId | null;
  pvp: boolean;
  kills: number;
  deaths: number;
  /** Round-trip time reported by the client (ms), 0 when unknown. */
  ping: number;
  online: boolean;
}

export interface ChatLine {
  id: number;
  /** Sender name, or null for system messages (joins, leaves). */
  from: string | null;
  text: string;
  /** Server wall-clock time (ms since epoch). */
  time: number;
}

export type ErrorCode = 'full' | 'version' | 'kicked' | 'protocol' | 'auth';

/** How a pilot proves who it is when joining online. */
export type AuthRequest =
  | { kind: 'login'; name: string; password: string }
  | { kind: 'register'; name: string; password: string }
  /** The login token received after a previous login (kept by the browser). */
  | { kind: 'token'; token: string };

export type ClientMessage =
  /** First message on a connection. Without a valid `auth` the server answers with an `auth` error. */
  | { t: 'hello'; version: number; auth?: AuthRequest }
  | { t: 'input'; seq: number; input: ShipInput }
  | { t: 'chat'; text: string }
  | { t: 'pvp'; on: boolean }
  | { t: 'ping'; c: number; rtt?: number }
  | { t: 'dock' }
  | { t: 'undock' }
  /** qty > 0 buys, qty < 0 sells, at the station the player is docked at. */
  | { t: 'trade'; item: ItemId; qty: number }
  | { t: 'repair' };

export type ServerMessage =
  | { t: 'welcome'; playerId: string; token: string; name: string; zoneSeed: number; tickRate: number; snapshotRate: number; resumed: boolean }
  | { t: 'snapshot'; snap: WorldSnapshot; ackSeq: number; you: EntityId | null; stats: PlayerStats; wave: number; respawnIn: number }
  | { t: 'events'; tick: number; events: SimEvent[] }
  | { t: 'notice'; text: string; tone: 'info' | 'warn' | 'good' }
  | { t: 'chat'; line: ChatLine }
  | { t: 'chatHistory'; lines: ChatLine[] }
  | { t: 'players'; list: PlayerInfo[]; max: number }
  | { t: 'pong'; c: number }
  | { t: 'pilot'; pilot: PilotState }
  | { t: 'market'; market: MarketView }
  /** After a successful login: the token to keep for the next connections, and whether the account was just created. */
  | { t: 'account'; name: string; token: string; expiresAt: number; isNew: boolean }
  /** `reason` details an `auth` error ('credentials', 'taken', 'invalid', 'limited', 'expired', 'unavailable'). */
  | { t: 'error'; code: ErrorCode; text: string; reason?: string };

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function snapshotShip(s: Ship): ShipSnapshot {
  return {
    id: s.id,
    name: s.name,
    classId: s.classId,
    faction: s.faction,
    owner: s.ownerId,
    p: [r2(s.position.x), r2(s.position.y), r2(s.position.z)],
    q: [r4(s.rotation.x), r4(s.rotation.y), r4(s.rotation.z), r4(s.rotation.w)],
    v: [r2(s.velocity.x), r2(s.velocity.y), r2(s.velocity.z)],
    w: [r3(s.angularVelocity.x), r3(s.angularVelocity.y), r3(s.angularVelocity.z)],
    hull: r2(s.hull),
    shield: r2(s.shield),
    energy: r2(s.energy),
    throttle: s.boosting ? 1.6 : r2(s.input.throttle),
    boosting: s.boosting,
    firing: s.input.fire,
    weaponsLocked: s.weaponsLocked,
    pvp: s.pvp,
    ...(s.mining !== null ? { m: s.mining } : {}),
  };
}

/** Validates and clamps untrusted client input (the server never trusts clients). */
export function sanitizeInput(raw: unknown): ShipInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    return Math.min(max, Math.max(min, n));
  };
  return {
    throttle: num(o.throttle, -0.4, 1),
    strafeX: num(o.strafeX, -1, 1),
    strafeY: num(o.strafeY, -1, 1),
    pitch: num(o.pitch, -1, 1),
    yaw: num(o.yaw, -1, 1),
    roll: num(o.roll, -1, 1),
    boost: o.boost === true,
    fire: o.fire === true,
    flightAssist: o.flightAssist !== false,
    mine: o.mine === true,
  };
}

/** Player names: printable characters only, collapsed spaces, 2..16 chars. */
export function sanitizeName(raw: unknown): string {
  const s = cleanName(raw).slice(0, 16).trim();
  return s.length >= 2 ? s : '';
}

/** A name without control, invisible or bidi characters and markup brackets, spaces collapsed; not cut to length. */
export function cleanName(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const CHAT_MAX_LENGTH = 200;

/** Chat text: no control or bidi characters, collapsed whitespace, length-capped. Empty means "drop". */
export function sanitizeChat(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX_LENGTH);
}

/**
 * Parses one untrusted client frame (a message or an array of messages).
 * Anything that is not a well-formed ClientMessage is dropped; the count of
 * dropped items lets the server disconnect misbehaving clients.
 */
export function parseClientFrame(text: string): { messages: ClientMessage[]; rejected: number } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { messages: [], rejected: 1 };
  }
  const items = Array.isArray(data) ? data.slice(0, 64) : [data];
  const messages: ClientMessage[] = [];
  let rejected = Array.isArray(data) ? Math.max(0, data.length - 64) : 0;
  for (const raw of items) {
    const m = validateClientMessage(raw);
    if (m) messages.push(m);
    else rejected++;
  }
  return { messages, rejected };
}

/** The credentials part of a hello, or undefined when absent or malformed (passwords are checked by the server). */
export function validateAuth(raw: unknown): AuthRequest | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const a = raw as Record<string, unknown>;
  if (a.kind === 'token') return typeof a.token === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(a.token) ? { kind: 'token', token: a.token } : undefined;
  if (a.kind !== 'login' && a.kind !== 'register') return undefined;
  if (typeof a.name !== 'string' || typeof a.password !== 'string' || a.name.length > 64 || a.password.length > 256) return undefined;
  return { kind: a.kind, name: a.name, password: a.password };
}

export function validateClientMessage(raw: unknown): ClientMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  switch (o.t) {
    case 'hello':
      if (typeof o.version !== 'number') return null;
      return { t: 'hello', version: o.version, auth: validateAuth(o.auth) };
    case 'input': {
      const input = sanitizeInput(o.input);
      if (!input || typeof o.seq !== 'number' || !Number.isInteger(o.seq) || o.seq < 0) return null;
      return { t: 'input', seq: o.seq, input };
    }
    case 'chat':
      return typeof o.text === 'string' ? { t: 'chat', text: o.text.slice(0, 1000) } : null;
    case 'pvp':
      return typeof o.on === 'boolean' ? { t: 'pvp', on: o.on } : null;
    case 'ping':
      if (typeof o.c !== 'number' || !Number.isFinite(o.c)) return null;
      return { t: 'ping', c: o.c, rtt: typeof o.rtt === 'number' && Number.isFinite(o.rtt) ? Math.max(0, Math.min(10000, o.rtt)) : undefined };
    case 'dock':
    case 'undock':
    case 'repair':
      return { t: o.t };
    case 'trade':
      if (!isItemId(o.item) || typeof o.qty !== 'number' || !Number.isInteger(o.qty) || o.qty === 0 || Math.abs(o.qty) > 1000) return null;
      return { t: 'trade', item: o.item, qty: o.qty };
    default:
      return null;
  }
}
