import * as THREE from 'three';
import { damp } from '../../shared/math';

export type CameraMode = 'chase' | 'close' | 'cinematic';

const MODES: Record<CameraMode, { offset: THREE.Vector3; look: number; posRate: number; rotRate: number }> = {
  chase: { offset: new THREE.Vector3(0, 6.5, 30), look: 60, posRate: 14, rotRate: 6.5 },
  close: { offset: new THREE.Vector3(0, 3.6, 17), look: 50, posRate: 18, rotRate: 9 },
  cinematic: { offset: new THREE.Vector3(14, 5, 42), look: 30, posRate: 6, rotRate: 3 },
};

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
  private initialized = false;
  private shake = 0;
  private boostBlend = 0;
  private baseFov = 68;
  private tmp = new THREE.Vector3();
  private look = new THREE.Vector3();
  private lookAhead = new THREE.Vector2();
  private scale = 1;

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

  snap() {
    this.initialized = false;
  }

  /** `cursor` is the virtual-joystick offset; it slightly offsets the view in the turn direction. */
  update(dt: number, shipPos: THREE.Vector3, shipRot: THREE.Quaternion, boosting: boolean, speed: number, cursor: { x: number; y: number }, shipScale = 1) {
    const m = MODES[this.mode];
    this.scale += (shipScale - this.scale) * damp(3, dt);
    if (!this.initialized) {
      this.rot.copy(shipRot);
      this.pos.copy(shipPos);
      this.initialized = true;
    }
    this.rot.slerp(shipRot, damp(m.rotRate, dt));
    this.pos.lerp(shipPos, damp(m.posRate * 4, dt));

    this.boostBlend += ((boosting ? 1 : 0) - this.boostBlend) * damp(3, dt);
    this.lookAhead.x += (cursor.x - this.lookAhead.x) * damp(4, dt);
    this.lookAhead.y += (cursor.y - this.lookAhead.y) * damp(4, dt);

    // Pull back with boost, and slightly with speed.
    const pull = 1 + this.boostBlend * 0.35 + Math.min(speed / 600, 0.25);
    this.tmp.copy(m.offset).multiplyScalar(pull * this.scale);
    this.tmp.x += this.lookAhead.x * -3 * this.scale;
    this.tmp.y += this.lookAhead.y * 2 * this.scale;
    this.tmp.applyQuaternion(this.rot);
    this.camera.position.copy(this.pos).add(this.tmp);

    this.look.set(this.lookAhead.x * 8, 2 * this.scale - this.lookAhead.y * 5, -m.look).applyQuaternion(this.rot).add(this.pos);
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
