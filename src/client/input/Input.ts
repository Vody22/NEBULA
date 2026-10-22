import type { ShipInput } from '../../shared/sim/types';
import { neutralInput } from '../../shared/sim/types';
import type { Action } from '../settings';

/**
 * Turns keyboard + mouse into a ShipInput, through rebindable actions.
 * Mouse acts as a virtual joystick: the reticle offset from screen centre
 * sets the turn rate (like Star Citizen / Elite mouse flight).
 */
export class InputManager {
  readonly input: ShipInput = neutralInput();
  /** Virtual joystick position, -1..1 on each axis (y+ = down on screen). */
  readonly cursor = { x: 0, y: 0 };
  /** Multiplier on mouse movement (settings). */
  sensitivity = 1;
  invertY = false;
  /** When false (menus open) the ship receives neutral controls. */
  enabled = true;
  locked = false;
  bindings: Record<Action, string>;
  private keys = new Set<string>();
  private mouseDown = false;
  private pressed = new Set<string>();

  constructor(private element: HTMLElement, bindings: Record<Action, string>) {
    this.bindings = bindings;
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      // Keep game keys from scrolling the page or moving focus.
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.releaseAll());
    element.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.enabled) this.mouseDown = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (this.locked) {
        const k = 0.0022 * this.sensitivity;
        this.cursor.x += e.movementX * k;
        this.cursor.y += e.movementY * k;
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
        if (!this.enabled) return;
        this.input.throttle = Math.min(1, Math.max(-0.4, this.input.throttle - Math.sign(e.deltaY) * 0.1));
      },
      { passive: true },
    );
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === element;
    });
  }

  /** Requests mouse capture. Resolves false when the browser refuses (cool-down, headless...). */
  async requestLock(): Promise<boolean> {
    try {
      const p = this.element.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.then === 'function') await p;
      return true;
    } catch {
      return false;
    }
  }

  releaseAll() {
    this.keys.clear();
    this.pressed.clear();
    this.mouseDown = false;
  }

  /** Recentres the virtual joystick (after a pause, so the ship doesn't keep turning). */
  centerCursor() {
    this.cursor.x = 0;
    this.cursor.y = 0;
  }

  private down(a: Action) {
    return this.keys.has(this.bindings[a]) ? 1 : 0;
  }

  /** True once per press of the key bound to `a`. */
  consume(a: Action) {
    const code = this.bindings[a];
    const had = this.pressed.has(code);
    this.pressed.delete(code);
    return had;
  }

  endFrame() {
    this.pressed.clear();
  }

  get firing() {
    return this.input.fire;
  }

  update(dt: number): ShipInput {
    const inp = this.input;
    if (!this.enabled) {
      inp.fire = false;
      inp.boost = false;
      inp.pitch = inp.yaw = inp.roll = inp.strafeX = inp.strafeY = 0;
      return inp;
    }
    const d = (a: Action) => this.down(a);

    const throttleRate = 0.7;
    if (d('throttleUp')) inp.throttle = Math.min(1, inp.throttle + throttleRate * dt);
    if (d('throttleDown')) inp.throttle = Math.max(-0.4, inp.throttle - throttleRate * dt);
    if (this.consume('stop')) inp.throttle = 0;
    if (this.consume('assist')) inp.flightAssist = !inp.flightAssist;

    inp.strafeX = d('strafeRight') - d('strafeLeft');
    inp.strafeY = d('strafeUp') - d('strafeDown');
    inp.roll = d('rollRight') - d('rollLeft');
    inp.boost = d('boost') > 0 || this.keys.has('ShiftRight');
    inp.fire = this.mouseDown || d('fire') > 0;

    // Virtual joystick with a small dead zone and a response curve.
    const dz = 0.06;
    const shape = (v: number) => {
      const a = Math.abs(v);
      if (a < dz) return 0;
      const n = (a - dz) / (1 - dz);
      return Math.sign(v) * (0.35 * n + 0.65 * n * n);
    };
    const keyPitch = d('pitchUp') - d('pitchDown');
    const keyYaw = d('yawRight') - d('yawLeft');
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
