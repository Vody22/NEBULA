import type { ShipSnapshot } from '../shared/net/protocol';

/** Hostile from `me`'s point of view: another faction, or a player when both fly with PvP on. */
export function isHostile(me: ShipSnapshot, s: ShipSnapshot) {
  if (s.id === me.id) return false;
  if (s.faction !== me.faction) return true;
  return me.pvp && s.pvp && s.owner !== null;
}
