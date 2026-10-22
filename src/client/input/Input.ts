import type { ShipInput } from '../../shared/sim/types';
import { neutralInput } from '../../shared/sim/types';

/**
 * Turns keyboard + mouse into a ShipInput.
 * Mouse acts as a virtual joystick: the reticle offset from screen centre
 * sets the turn rate (like Star Citizen / Elite mouse flight).
 */
export class InputManager {
  readonly input: ShipInput = neutralInput();
  /** Virtual joystick position, -1..1 on each axis (y+ = down on screen). */
  readonly cursor = { x: 0, y: 0 };
  sensitivity = 0.0022;
  invertY = false;
  private keys = new Set<string>();
  private mouseDown = false;
  private pressed = new Set<string>();
  locked = false;

  constructor(private element: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown = false;
    });
    element.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouseDown = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (this.locked) {
        this.cursor.x += e.movementX * this.sensitivity;
        this.cursor.y += e.movementY * this.sensitivity;
      } else {
        // Without pointer lock, the real mouse position is the joystick.
        this.cursor.x = ((e.clientX / window.innerWidth) * 2 - 1) * 1.6;
        this.cursor.y = ((e.clientY / window.innerHeight) * 2 - 1) * 1.6;
      }
      const len = Math.hypot(this.cursor.x, this.cursor.y);
      if (len > 1) {
        this.cursor.x /= len;
        this.cursor.y /= len;
      }
    });
    window.addEventListener(
      'wheel',
      (e) => {
        this.input.throttle = Math.min(1, Math.max(-0.4, this.input.throttle - Math.sign(e.deltaY) * 0.1));
      },
      { passive: true },
    );
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === element;
    });
  }

  requestLock() {
    try {
      const p = this.element.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {
      /* pointer lock unavailable (e.g. headless): absolute mouse mode */
    }
  }

  isDown(code: string) {
    return this.keys.has(code);
  }

  /** True once per key press. */
  consume(code: string) {
    const had = this.pressed.has(code);
    this.pressed.delete(code);
    return had;
  }

  endFrame() {
    this.pressed.clear();
  }

  update(dt: number): ShipInput {
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    const inp = this.input;

    const throttleRate = 0.7;
    if (k('KeyW')) inp.throttle = Math.min(1, inp.throttle + throttleRate * dt);
    if (k('KeyS')) inp.throttle = Math.max(-0.4, inp.throttle - throttleRate * dt);
    if (this.consume('KeyX')) inp.throttle = 0;
    if (this.consume('KeyZ')) inp.flightAssist = !inp.flightAssist;

    inp.strafeX = k('KeyD') - k('KeyA');
    inp.strafeY = k('Space') - k('KeyC');
    inp.roll = k('KeyE') - k('KeyQ');
    inp.boost = k('ShiftLeft') + k('ShiftRight') > 0;
    inp.fire = this.mouseDown || k('KeyF') > 0;

    // Virtual joystick with a small dead zone and a response curve.
    const dz = 0.06;
    const shape = (v: number) => {
      const a = Math.abs(v);
      if (a < dz) return 0;
      const n = (a - dz) / (1 - dz);
      return Math.sign(v) * (0.35 * n + 0.65 * n * n);
    };
    const keyPitch = k('ArrowUp') - k('ArrowDown');
    const keyYaw = k('ArrowRight') - k('ArrowLeft');
    if (keyPitch || keyYaw) {
      // Keyboard steering recentres the virtual joystick.
      this.cursor.x *= 0.9;
      this.cursor.y *= 0.9;
    }
    const ySign = this.invertY ? 1 : -1;
    inp.pitch = Math.max(-1, Math.min(1, shape(this.cursor.y) * ySign + keyPitch));
    inp.yaw = Math.max(-1, Math.min(1, shape(this.cursor.x) + keyYaw));
    return inp;
  }
}
