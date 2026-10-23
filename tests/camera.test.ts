import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { ChaseCamera } from '../src/client/camera/ChaseCamera';

/**
 * The ship must stay still on screen while the chase camera follows it at a
 * steady speed, even when frame times jitter (high refresh screens: 165 Hz
 * frames of 6 ms vary by a millisecond or two).
 */
describe('chase camera', () => {
  it('keeps a ship flying straight steady on screen despite frame-time jitter', () => {
    const cam = new ChaseCamera(16 / 9);
    const pos = new Vector3();
    const rot = new Quaternion();
    const vel = new Vector3(0, 0, -220);
    const cursor = { x: 0, y: 0 };
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const local: Vector3[] = [];
    for (let f = 0; f < 600; f++) {
      const dt = 1 / 165 + (rand() - 0.5) * 0.003;
      pos.addScaledVector(vel, dt);
      cam.update(dt, pos, rot, false, vel, cursor);
      cam.camera.updateMatrixWorld();
      // Where the ship sits in camera space (what the player sees).
      if (f > 300) local.push(pos.clone().applyMatrix4(cam.camera.matrixWorldInverse));
    }
    let worst = 0;
    for (const p of local) worst = Math.max(worst, p.distanceTo(local[0]));
    // A per-frame lerp follow moves it by ~0.3 m here, visible as a shake.
    expect(worst).toBeLessThan(0.01);
  });

  it('keeps the view steady in a constant turn despite frame-time jitter', () => {
    const cam = new ChaseCamera(16 / 9);
    const pos = new Vector3();
    const rot = new Quaternion();
    const vel = new Vector3();
    const turn = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const cursor = { x: 0, y: 0 };
    let seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const lag: number[] = [];
    for (let f = 0; f < 900; f++) {
      // Dropped frames too: 165 Hz with the odd 12 ms frame.
      const dt = rand() < 0.15 ? 2 / 165 : 1 / 165 + (rand() - 0.5) * 0.003;
      rot.premultiply(turn.setFromAxisAngle(up, 1.5 * dt));
      cam.update(dt, pos, rot, false, vel, cursor);
      cam.camera.updateMatrixWorld();
      // Angle between where the camera looks and where the ship points.
      if (f > 450) lag.push(cam.camera.quaternion.angleTo(rot));
    }
    expect(Math.max(...lag) - Math.min(...lag)).toBeLessThan(0.001);
  });
});
