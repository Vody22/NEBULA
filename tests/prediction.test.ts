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
        predictor.reconcile(mine, m.ackSeq, m.snap.time);
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

  it('on a 144 Hz screen the rendered ship moves and turns smoothly between 60 Hz ticks', () => {
    // Open space, no colliders: only the rendering is under test here.
    const predictor = new Predictor(new StaticGrid([]));
    predictor.reconcile(
      { id: 1, name: 'Pilote', classId: 'falcon', faction: 'union', owner: 'me', p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, -150], w: [0, 0, 0], hull: 100, shield: 100, energy: 100, throttle: 1, boosting: false, firing: false, weaponsLocked: false, pvp: false },
      0,
      0,
    );
    // Mimic Game: a fixed 60 Hz input accumulator driven by 144 Hz frames.
    const TICK = 1 / 60;
    const frame = 1 / 144;
    let acc = 0;
    let seq = 0;
    const moves: number[] = [];
    const turns: number[] = [];
    predictor.update(frame, 0);
    let lastPos = predictor.renderPosition.clone();
    let lastRot = predictor.renderRotation.clone();
    for (let f = 0; f < 432; f++) {
      acc += frame;
      while (acc >= TICK) {
        acc -= TICK;
        predictor.step(++seq, { ...neutralInput(), throttle: 1, yaw: 0.5 });
      }
      predictor.update(frame, acc / TICK);
      moves.push(predictor.renderPosition.distanceTo(lastPos));
      turns.push(predictor.renderRotation.angleTo(lastRot));
      lastPos = predictor.renderPosition.clone();
      lastRot = predictor.renderRotation.clone();
    }
    // Speed and turn rate still change, so compare each frame with its
    // neighbours: judder is a frame that barely moves next to one that jumps.
    const roughness = (steps: number[]) => {
      let worst = 0;
      for (let i = 144 + 3; i < steps.length - 3; i++) {
        const local = (steps[i - 3] + steps[i - 2] + steps[i - 1] + steps[i + 1] + steps[i + 2] + steps[i + 3]) / 6;
        worst = Math.max(worst, Math.abs(steps[i] / local - 1));
      }
      return worst;
    };
    // Without interpolation one frame in ~2.4 does not move at all (roughness ≈ 1+).
    expect(Math.min(...moves.slice(144))).toBeGreaterThan(0);
    expect(roughness(moves)).toBeLessThan(0.05);
    expect(roughness(turns)).toBeLessThan(0.05);
  });

  it('interpolates the velocity too, so speed-driven effects do not step at 60 Hz', () => {
    const predictor = new Predictor(new StaticGrid([]));
    predictor.reconcile(
      { id: 1, name: 'Pilote', classId: 'falcon', faction: 'union', owner: 'me', p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], hull: 100, shield: 100, energy: 100, throttle: 0, boosting: false, firing: false, weaponsLocked: false, pvp: false },
      0,
      0,
    );
    const TICK = 1 / 60;
    const frame = 1 / 165;
    let acc = 0;
    let seq = 0;
    const speeds: number[] = [];
    for (let f = 0; f < 165; f++) {
      acc += frame;
      while (acc >= TICK) {
        acc -= TICK;
        predictor.step(++seq, { ...neutralInput(), throttle: 1 });
      }
      predictor.update(frame, acc / TICK);
      speeds.push(predictor.renderVelocity.length());
    }
    // Accelerating: the rendered speed rises a little on every frame, never in 60 Hz steps.
    const deltas = speeds.slice(20, 120).map((v, i, a) => (i ? v - a[i - 1] : 0)).slice(1);
    expect(Math.min(...deltas)).toBeGreaterThan(0);
    expect(Math.max(...deltas) / Math.min(...deltas)).toBeLessThan(1.5);
  });
});
