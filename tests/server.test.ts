import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { GameServer } from '../src/server/GameServer';
import type { ServerMessage } from '../src/shared/net/protocol';
import { sanitizeInput } from '../src/shared/net/protocol';
import { AIPilot } from '../src/shared/sim/ai';
import { mulberry32 } from '../src/shared/rng';
import { World, TICK_DT } from '../src/shared/sim/world';
import { buildZone } from '../src/shared/sim/zone';

describe('server & protocol', () => {
  it('zone generation is deterministic', () => {
    const a = buildZone(42), b = buildZone(42);
    expect(a.asteroids.length).toBe(b.asteroids.length);
    expect(a.asteroids[10].position.equals(b.asteroids[10].position)).toBe(true);
    expect(a.colliders.length).toBe(b.colliders.length);
  });

  it('a client joins, receives welcome + snapshots, and its input drives its ship', () => {
    const server = new GameServer({ npcs: false });
    const inbox: ServerMessage[] = [];
    const id = server.connect({ send: (m) => inbox.push(JSON.parse(JSON.stringify(m))) }, 'William');
    expect(inbox[0].t).toBe('welcome');
    server.receive(id, { t: 'input', seq: 1, input: { throttle: 1, strafeX: 0, strafeY: 0, pitch: 0, yaw: 0, roll: 0, boost: false, fire: false, flightAssist: true } });
    for (let i = 0; i < 60; i++) server.update(1 / 60);
    const snaps = inbox.filter((m) => m.t === 'snapshot');
    expect(snaps.length).toBeGreaterThanOrEqual(58);
    const last = snaps[snaps.length - 1];
    if (last.t !== 'snapshot') throw new Error();
    const me = last.snap.ships.find((s) => s.id === last.you)!;
    expect(me.name).toBe('William');
    expect(me.v[2]).toBeLessThan(-50);
    expect(last.ackSeq).toBe(1);
  });

  it('rejects stale and malformed input', () => {
    expect(sanitizeInput({ throttle: 99, yaw: NaN, fire: 'yes' })).toMatchObject({ throttle: 1, yaw: 0, fire: false });
    expect(sanitizeInput(null)).toBeNull();
    const server = new GameServer({ npcs: false });
    const id = server.connect({ send: () => {} });
    const ship = [...server.world.ships.values()][0];
    server.receive(id, { t: 'input', seq: 5, input: { ...ship.input, throttle: 1 } });
    server.receive(id, { t: 'input', seq: 4, input: { ...ship.input, throttle: 0 } });
    server.tick(); // inputs are applied one per tick
    expect(ship.input.throttle).toBe(1);
  });

  it('spawns pirate waves which engage and damage an idle player', () => {
    const server = new GameServer();
    const notices: string[] = [];
    let damaged = false;
    let you: number | null = null;
    server.connect({
      send: (m) => {
        if (m.t === 'notice') notices.push(m.text);
        if (m.t === 'snapshot') you = m.you;
        if (m.t === 'events' && m.events.some((e) => e.type === 'hit' && e.target === you)) damaged = true;
      },
    });
    for (let i = 0; i < 60 * 60 && !damaged; i++) server.tick();
    expect(server.wave).toBeGreaterThanOrEqual(1);
    expect(notices.some((n) => n.startsWith('VAGUE 1'))).toBe(true);
    expect(damaged).toBe(true);
  });

  it('AI pilot hunts down a stationary target', () => {
    const zone = buildZone(3);
    zone.colliders.length = 0;
    const w = new World(zone);
    const target = w.spawnShip({ classId: 'falcon', faction: 'union', name: 'target', position: new Vector3(800, 200, -1500) });
    const npc = w.spawnShip({ classId: 'raider', faction: 'raiders', name: 'npc', position: new Vector3(0, 0, 0) });
    const pilot = new AIPilot(npc.id, mulberry32(7), 0.8);
    let damaged = false;
    for (let i = 0; i < 60 * 30 && !damaged; i++) {
      w.setInput(npc.id, pilot.update(w, TICK_DT));
      w.step();
      damaged = w.drainEvents().some((e) => e.type === 'hit' && e.target === target.id);
    }
    expect(damaged).toBe(true);
  });

  it('AI pilot steers around an asteroid in its path', () => {
    const zone = buildZone(3);
    zone.colliders.length = 0;
    zone.colliders.push({ kind: 'asteroid', center: new Vector3(0, 0, -900), radius: 220 });
    const w = new World(zone);
    w.spawnShip({ classId: 'falcon', faction: 'union', name: 'target', position: new Vector3(0, 0, -2200) });
    const npc = w.spawnShip({ classId: 'raider', faction: 'raiders', name: 'npc', position: new Vector3(0, 0, 0) });
    const pilot = new AIPilot(npc.id, mulberry32(9), 0.8);
    let collisions = 0;
    for (let i = 0; i < 60 * 20; i++) {
      w.setInput(npc.id, pilot.update(w, TICK_DT));
      w.step();
      collisions += w.drainEvents().filter((e) => e.type === 'collision').length;
    }
    expect(collisions).toBe(0);
    expect(npc.position.z).toBeLessThan(-1200); // it got past the rock
  });
});
