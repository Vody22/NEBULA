import type { EntityId, FactionId, Ship, ShipClassId, ShipInput, SimEvent } from '../sim/types';

/**
 * Wire protocol between client and authoritative server. Everything here is
 * plain JSON-serialisable data so it can travel over WebSocket unchanged
 * (a binary encoding can replace JSON later without touching game code).
 */
export const PROTOCOL_VERSION = 1;

export interface ShipSnapshot {
  id: EntityId;
  name: string;
  classId: ShipClassId;
  faction: FactionId;
  owner: string | null;
  p: [number, number, number];
  q: [number, number, number, number];
  v: [number, number, number];
  hull: number;
  shield: number;
  energy: number;
  throttle: number;
  boosting: boolean;
  firing: boolean;
  weaponsLocked: boolean;
}

export interface PlayerStats {
  kills: number;
  deaths: number;
  credits: number;
}

export interface WorldSnapshot {
  tick: number;
  time: number;
  ships: ShipSnapshot[];
}

export type ClientMessage =
  | { t: 'hello'; version: number; name: string }
  | { t: 'input'; seq: number; input: ShipInput };

export type ServerMessage =
  | { t: 'welcome'; playerId: string; zoneSeed: number; tickRate: number }
  | { t: 'snapshot'; snap: WorldSnapshot; ackSeq: number; you: EntityId | null; stats: PlayerStats; wave: number; respawnIn: number }
  | { t: 'events'; tick: number; events: SimEvent[] }
  | { t: 'notice'; text: string; tone: 'info' | 'warn' | 'good' };

const r2 = (n: number) => Math.round(n * 100) / 100;
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
    hull: r2(s.hull),
    shield: r2(s.shield),
    energy: r2(s.energy),
    throttle: s.boosting ? 1.6 : r2(s.input.throttle),
    boosting: s.boosting,
    firing: s.input.fire,
    weaponsLocked: s.weaponsLocked,
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
  };
}
