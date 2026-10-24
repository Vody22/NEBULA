import * as THREE from 'three';
import { damp } from '../../shared/math';

export type CameraMode = 'chase' | 'close' | 'cinematic';

const MODES: Record<CameraMode, { offset: THREE.Vector3; look: number; posRate: number; rotRate: number }> = {
  chase: { offset: new THREE.Vector3(0, 6.5, 30), look: 60, posRate: 14, rotRate: 6.5 },
  close: { offset: new THREE.Vector3(0, 3.6, 17), look: 50, posRate: 18, rotRate: 9 },
  cinematic: { offset: new THREE.Vector3(14, 5, 42), look: 30, posRate: 6, rotRate: 3 },
};

/** Angular frequency of the impact jolt's spring (rad/s). */
const JOLT_RATE = 14;

/**
 * Third-person chase camera. Its orientation lags the ship with a damped
 * slerp so turns, rolls and drift read clearly; FOV widens and the camera
 * shakes under boost and impacts.
 */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  private rot = new THREE.Quaternion();
  private pos = new THREE.Vector3();
  /** Ship velocity smoothed at the follow rate: the camera trails by lagVel / rate. */
  private lagVel = new THREE.Vector3();
  private prevShipRot = new THREE.Quaternion();
  private subRot = new THREE.Quaternion();
  private initialized = false;
  private shake = 0;
  private boostBlend = 0;
  private baseFov = 68;
  private tmp = new THREE.Vector3();
  private look = new THREE.Vector3();
  private lookAhead = new THREE.Vector2();
  private scale = 1;
  /** Impact jolt (v0.8): an offset on a damped spring, and its rate of change. */
  private jolt = new THREE.Vector3();
  private joltVel = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.5, 250000);
  }

  cycleMode() {
    const order: CameraMode[] = ['chase', 'close', 'cinematic'];
    this.mode = order[(order.indexOf(this.mode) + 1) % order.length];
  }

  addShake(amount: number) {
    this.shake = Math.min(1.5, this.shake + amount);
  }

  /**
   * The ship struck something: carried on by its own inertia, the camera
   * lurches about `amount` metres toward what was hit (`normal` points away
   * from it), then springs back with a small overshoot.
   */
  kick(normal: THREE.Vector3, amount: number) {
    this.joltVel.addScaledVector(normal, -amount * JOLT_RATE * 2);
  }

  private stepJolt(dt: number) {
    const n = Math.min(40, Math.ceil(dt / 0.004));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      // x'' = −ω²x − 2ζωx', ζ = 0.55: a quick lurch, one soft rebound.
      this.joltVel.addScaledVector(this.jolt, -JOLT_RATE * JOLT_RATE * h).addScaledVector(this.joltVel, -2 * 0.55 * JOLT_RATE * h);
      this.jolt.addScaledVector(this.joltVel, h);
    }
    if (this.jolt.lengthSq() < 1e-8 && this.joltVel.lengthSq() < 1e-8) {
      this.jolt.set(0, 0, 0);
      this.joltVel.set(0, 0, 0);
    }
  }

  /** Size of the followed ship relative to a fighter (the camera stands further back from bigger ones). */
  get shipScale() {
    return this.scale;
  }

  snap() {
    this.initialized = false;
    this.jolt.set(0, 0, 0);
    this.joltVel.set(0, 0, 0);
  }

  /** `cursor` is the virtual-joystick offset; it slightly offsets the view in the turn direction. */
  update(dt: number, shipPos: THREE.Vector3, shipRot: THREE.Quaternion, boosting: boolean, shipVel: THREE.Vector3, cursor: { x: number; y: number }, shipScale = 1) {
    const speed = shipVel.length();
    const m = MODES[this.mode];
    this.scale += (shipScale - this.scale) * damp(3, dt);
    if (!this.initialized) {
      this.rot.copy(shipRot);
      this.prevShipRot.copy(shipRot);
      this.lagVel.set(0, 0, 0);
      this.initialized = true;
    }
    // The ship turned smoothly during the frame, not in one jump at its start:
    // follow it in ~1 ms sub-steps so the lag does not depend on frame times.
    const n = Math.min(32, Math.max(1, Math.ceil(dt / 0.001)));
    const k = damp(m.rotRate, dt / n);
    for (let i = 1; i <= n; i++) this.rot.slerp(this.subRot.slerpQuaternions(this.prevShipRot, shipRot, i / n), k);
    this.prevShipRot.copy(shipRot);
    // Same trailing as lerping towards the ship every frame, but computed from
    // the smoothed velocity: a per-frame lerp makes the gap depend on the frame
    // time, so on a 144-165 Hz screen the slightest frame-time jitter shook the
    // ship on screen.
    const rate = m.posRate * 4;
    this.lagVel.lerp(shipVel, damp(rate, dt));
    this.pos.copy(shipPos).addScaledVector(this.lagVel, -1 / rate);

    this.boostBlend += ((boosting ? 1 : 0) - this.boostBlend) * damp(3, dt);
    this.lookAhead.x += (cursor.x - this.lookAhead.x) * damp(4, dt);
    this.lookAhead.y += (cursor.y - this.lookAhead.y) * damp(4, dt);

    // Pull back with boost, and slightly with speed.
    const pull = 1 + this.boostBlend * 0.35 + Math.min(speed / 600, 0.25);
    this.tmp.copy(m.offset).multiplyScalar(pull * this.scale);
    this.tmp.x += this.lookAhead.x * -3 * this.scale;
    this.tmp.y += this.lookAhead.y * 2 * this.scale;
    this.tmp.applyQuaternion(this.rot);
    this.stepJolt(dt);
    this.camera.position.copy(this.pos).add(this.tmp).add(this.jolt);

    this.look.set(this.lookAhead.x * 8, 2 * this.scale - this.lookAhead.y * 5, -m.look).applyQuaternion(this.rot).add(this.pos).add(this.jolt);
    this.camera.up.set(0, 1, 0).applyQuaternion(this.rot);
    this.camera.lookAt(this.look);

    // Shake: high-frequency jitter decaying over time, plus boost rumble.
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const s = this.shake * this.shake * 0.8 + this.boostBlend * 0.08;
    if (s > 0.001) {
      const t = performance.now() * 0.001;
      this.camera.rotateX(Math.sin(t * 53) * 0.01 * s);
      this.camera.rotateY(Math.sin(t * 47 + 1) * 0.01 * s);
      this.camera.rotateZ(Math.sin(t * 31 + 2) * 0.008 * s);
    }

    const fov = this.baseFov + this.boostBlend * 14 + Math.min(speed / 500, 1) * 4;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
