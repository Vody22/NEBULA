import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { GameServer, STARTING_CREDITS } from '../src/server/GameServer';
import type { ServerMessage } from '../src/shared/net/protocol';
import { SHIP_CLASSES } from '../src/shared/sim/shipClasses';
import type { Ship } from '../src/shared/sim/types';
import { TICK_DT, World } from '../src/shared/sim/world';
import { buildZone } from '../src/shared/sim/zone';

function soloServer(npcs = false) {
  const server = new GameServer({ npcs });
  const inbox: ServerMessage[] = [];
  const session = server.connect({ send: (m) => inbox.push(m) }, 'Pilote');
  const me = () => [...server.world.ships.values()].find((s) => s.ownerId === session) as Ship | undefined;
  const lastSnap = () => [...inbox].reverse().find((m) => m.t === 'snapshot') as Extract<ServerMessage, { t: 'snapshot' }>;
  return { server, inbox, session, me, lastSnap };
}

describe('gameplay rules', () => {
  it('firing drains energy, and energy recovers when the trigger is released', () => {
    const w = new World(Object.assign(buildZone(1), { colliders: [] }));
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'a', position: new Vector3() });
    s.input.fire = true;
    for (let i = 0; i < 60; i++) w.step();
    const afterFiring = s.energy;
    expect(afterFiring).toBeLessThan(SHIP_CLASSES.falcon.energy - 10);
    s.input.fire = false;
    for (let i = 0; i < 120; i++) w.step();
    expect(s.energy).toBeGreaterThan(Math.min(SHIP_CLASSES.falcon.energy - 0.5, afterFiring + 20));
  });

  it('a kill credits the player with the kill and the bounty', () => {
    const { server, session, me, lastSnap } = soloServer();
    const ship = me()!;
    const fwd = new Vector3(0, 0, -1).applyQuaternion(ship.rotation);
    const pirate = server.world.spawnShip({ classId: 'raider', faction: 'raiders', name: 'Cible', position: ship.position.clone().addScaledVector(fwd, 300) });
    pirate.shield = 0;
    pirate.hull = 5;
    let seq = 1;
    for (let i = 0; i < 120 && server.world.ships.has(pirate.id); i++) {
      server.receive(session, { t: 'input', seq: seq++, input: { ...ship.input, fire: true, throttle: 0 } });
      server.tick();
    }
    expect(server.world.ships.has(pirate.id)).toBe(false);
    const snap = lastSnap();
    expect(snap.stats.kills).toBe(1);
    expect(snap.stats.credits).toBe(STARTING_CREDITS + SHIP_CLASSES.raider.bounty);
  });

  it('the player respawns at the station 5 s after being destroyed', () => {
    const { server, me, lastSnap } = soloServer();
    const first = me()!;
    server.world.applyDamage(first, 99999, null);
    server.tick();
    expect(me()).toBeUndefined();
    expect(lastSnap().you).toBeNull();
    expect(lastSnap().respawnIn).toBeGreaterThan(4);
    for (let i = 0; i < 60 * 5 + 5; i++) server.tick();
    const second = me()!;
    expect(second).toBeDefined();
    expect(second.id).not.toBe(first.id);
    expect(second.hull).toBe(SHIP_CLASSES.falcon.hull);
    expect(lastSnap().stats.deaths).toBe(1);
    expect(second.position.distanceTo(server.world.zone.playerSpawn)).toBeLessThan(200);
  });

  it('clearing a wave starts the next, harder one', () => {
    const { server } = soloServer(true);
    let guard = 0;
    while (server.wave < 1 && guard++ < 60 * 20) server.tick();
    expect(server.wave).toBe(1);
    const count = () => [...server.world.ships.values()].filter((s) => s.faction === 'raiders').length;
    const wave1 = count();
    for (const s of [...server.world.ships.values()]) if (s.faction === 'raiders') server.world.applyDamage(s, 99999, null);
    guard = 0;
    while (server.wave < 2 && guard++ < 60 * 20) server.tick();
    expect(server.wave).toBe(2);
    expect(count()).toBeGreaterThan(wave1);
  });

  it('ramming the station bounces the ship and damages it', () => {
    const w = new World(buildZone(1));
    const st = w.zone.station;
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'a', position: new Vector3(0, 0, st.coreRadius + 200), velocity: new Vector3(0, 0, -200) });
    s.input.throttle = 1;
    let collided = false;
    for (let i = 0; i < 90; i++) {
      w.step(TICK_DT);
      if (w.drainEvents().some((e) => e.type === 'collision')) collided = true;
    }
    expect(collided).toBe(true);
    expect(s.position.length()).toBeGreaterThanOrEqual(st.coreRadius + SHIP_CLASSES.falcon.radius - 0.01);
    expect(s.shield + s.hull).toBeLessThan(SHIP_CLASSES.falcon.shield + SHIP_CLASSES.falcon.hull);
  });
});

describe('weapon capacitor', () => {
  it('holding fire empties the capacitor, locks the guns, then they come back at 30 %', () => {
    const w = new World(Object.assign(buildZone(1), { colliders: [] }));
    const s = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'a', position: new Vector3() });
    s.input.fire = true;
    let shots = 0;
    let t = 0;
    while (!s.weaponsLocked && t < 20) {
      w.step();
      t += TICK_DT;
      shots += w.drainEvents().filter((e) => e.type === 'shot').length;
    }
    expect(s.weaponsLocked).toBe(true);
    expect(t).toBeGreaterThan(3); // several seconds of sustained fire
    expect(t).toBeLessThan(8);
    expect(shots).toBeGreaterThan(40);
    // Still holding the trigger: no shots while locked, energy recovers.
    let lockedShots = 0;
    for (let i = 0; i < 60; i++) {
      w.step();
      lockedShots += w.drainEvents().filter((e) => e.type === 'shot').length;
    }
    expect(lockedShots).toBe(0);
    for (let i = 0; i < 60 * 4 && s.weaponsLocked; i++) w.step();
    expect(s.weaponsLocked).toBe(false);
  });
});
