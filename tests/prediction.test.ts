import { describe, expect, it } from 'vitest';
import { Predictor } from '../src/client/net/Predictor';
import { GameServer } from '../src/server/GameServer';
import type { ServerMessage } from '../src/shared/net/protocol';
import { StaticGrid } from '../src/shared/sim/spatialGrid';
import { neutralInput, type ShipInput } from '../src/shared/sim/types';

/**
 * Client-side prediction against the real GameServer with a simulated
 * network delay: the predicted ship must agree with the server once the
 * server catches up, so corrections stay tiny while the player manoeuvres.
 */
function run(latencyTicks: number, ticks = 360) {
  const server = new GameServer({ npcs: false, snapshotEvery: 3 });
  const inFlightDown: { at: number; m: ServerMessage }[] = [];
  const inFlightUp: { at: number; seq: number; input: ShipInput }[] = [];
  let tick = 0;
  const id = server.connect({ send: (m) => inFlightDown.push({ at: tick + latencyTicks, m: JSON.parse(JSON.stringify(m)) }) }, 'Pilote');
  const predictor = new Predictor(new StaticGrid(server.world.zone.colliders));
  let seq = 0;
  const corrections: number[] = [];
  for (; tick < ticks; tick++) {
    // Client: deliver arrived messages, then sample input and predict.
    while (inFlightDown.length && inFlightDown[0].at <= tick) {
      const { m } = inFlightDown.shift()!;
      if (m.t !== 'snapshot' || m.you === null) continue;
      const mine = m.snap.ships.find((s) => s.id === m.you);
      if (mine) {
        const had = predictor.active;
        predictor.reconcile(mine, m.ackSeq);
        if (had) corrections.push(predictor.lastCorrection);
      }
    }
    const input: ShipInput = { ...neutralInput(), throttle: tick < 200 ? 1 : 0.3, yaw: Math.sin(tick / 25), pitch: 0.4 * Math.cos(tick / 40), roll: tick % 90 < 30 ? 1 : 0, boost: tick > 120 && tick < 160 };
    seq++;
    predictor.step(seq, input);
    inFlightUp.push({ at: tick + latencyTicks, seq, input });
    // Server: receive arrived inputs, run one tick.
    while (inFlightUp.length && inFlightUp[0].at <= tick) {
      const u = inFlightUp.shift()!;
      server.receive(id, { t: 'input', seq: u.seq, input: u.input });
    }
    server.tick();
  }
  return { corrections, predictor, server };
}

describe('client-side prediction', () => {
  it('without latency, prediction matches the server exactly', () => {
    const { corrections } = run(0);
    expect(corrections.length).toBeGreaterThan(50);
    expect(Math.max(...corrections)).toBeLessThan(0.05);
  });

  it('with 100 ms each way, the predicted ship agrees with the server (no rubber-banding)', () => {
    const { corrections, predictor, server } = run(6);
    expect(corrections.length).toBeGreaterThan(50);
    const sorted = [...corrections].sort((a, b) => a - b);
    // Snapshot rounding (1 cm, 1e-4 quaternion) is the only expected error.
    expect(sorted[Math.floor(sorted.length * 0.95)]).toBeLessThan(0.3);
    // The prediction runs ahead of the server by the in-flight inputs only.
    const shipOnServer = [...server.world.ships.values()][0];
    expect(predictor.ship!.position.distanceTo(shipOnServer.position)).toBeLessThan(shipOnServer.velocity.length() * 0.3 + 1);
  });
});
