import type { Action } from '../settings';
import type { InputManager } from './Input';

/** Phones and tablets: no fine pointer at all (or ?touch to force the controls). */
export function isTouchDevice(params = new URLSearchParams(location.search)) {
  if (params.has('touch')) return params.get('touch') !== '0';
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
}

export interface TouchCallbacks {
  onPause(): void;
  onChat(): void;
}

const STICK_RADIUS = 58;
const THROTTLE_MIN = -0.4;

/**
 * On-screen controls for touch screens. The left thumb steers with a floating
 * joystick (it drives the same virtual cursor as the mouse), the right thumb
 * fires and boosts; a slider sets the throttle. Buttons act through the
 * rebindable actions, so the game logic is the same as with a keyboard.
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private base: HTMLDivElement;
  private knob: HTMLDivElement;
  private throttleEl: HTMLDivElement;
  private throttleFill: HTMLDivElement;
  private throttleId: number | null = null;
  private visible = false;

  constructor(
    private input: InputManager,
    private cb: TouchCallbacks,
  ) {
    const root = document.createElement('div');
    root.id = 'touch';
    root.className = 'hidden';
    root.innerHTML = `
      <div class="stick-zone" aria-hidden="true"><div class="stick-base"><div class="stick-knob"></div></div></div>
      <div class="throttle" role="slider" aria-label="Poussée" aria-valuemin="-40" aria-valuemax="100">
        <div class="fill"></div><div class="zero"></div><span>GAZ</span>
      </div>
      <button class="tb fire" data-hold="fire" aria-label="Tirer">FEU</button>
      <button class="tb boost" data-hold="boost" aria-label="Boost">BOOST</button>
      <button class="tb target" data-tap="target" aria-label="Cible suivante">CIBLE</button>
      <button class="tb stop" data-tap="stop" aria-label="Arrêt">STOP</button>
      <button class="tb mine" data-hold="mine" aria-label="Rayon de minage">MINER</button>
      <button class="tb dock" data-tap="dock" aria-label="S'amarrer à la station">S'AMARRER</button>
      <button class="tb jump" data-tap="jump" aria-label="Saut hyperspatial">SAUT</button>
      <button class="tb roll-l" data-hold="rollLeft" aria-label="Roulis gauche">⟲</button>
      <button class="tb roll-r" data-hold="rollRight" aria-label="Roulis droite">⟳</button>
      <div class="tbar netbar">
        <button class="tb small online" data-act="chat" aria-label="Chat">CHAT</button>
        <button class="tb small online" data-tap="pvp" aria-label="Activer ou couper le PvP">PVP</button>
        <button class="tb small online" data-hold="scoreboard" aria-label="Liste des pilotes">PILOTES</button>
      </div>
      <div class="tbar">
        <button class="tb small" data-tap="assist" aria-label="Assistance de vol">ASSIST.</button>
        <button class="tb small pause" data-act="pause" aria-label="Pause">II</button>
      </div>
      <div class="rotate" role="status"><div><b>Tournez votre appareil</b><p>NEBULA FRONTIER se joue en mode paysage.</p></div></div>`;
    document.body.appendChild(root);
    this.root = root;
    this.base = root.querySelector('.stick-base')!;
    this.knob = root.querySelector('.stick-knob')!;
    this.throttleEl = root.querySelector('.throttle')!;
    this.throttleFill = root.querySelector('.throttle .fill')!;

    const zone = root.querySelector<HTMLDivElement>('.stick-zone')!;
    zone.addEventListener('touchstart', (e) => this.stickStart(e), { passive: false });
    zone.addEventListener('touchmove', (e) => this.stickMove(e), { passive: false });
    zone.addEventListener('touchend', (e) => this.stickEnd(e));
    zone.addEventListener('touchcancel', (e) => this.stickEnd(e));

    this.throttleEl.addEventListener('touchstart', (e) => this.throttleTouch(e, true), { passive: false });
    this.throttleEl.addEventListener('touchmove', (e) => this.throttleTouch(e, false), { passive: false });
    const throttleEnd = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) if (t.identifier === this.throttleId) this.throttleId = null;
    };
    this.throttleEl.addEventListener('touchend', throttleEnd);
    this.throttleEl.addEventListener('touchcancel', throttleEnd);

    for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('button'))) {
      const hold = b.dataset.hold as Action | undefined;
      const tap = b.dataset.tap as Action | undefined;
      const act = b.dataset.act;
      const press = (e: Event) => {
        e.preventDefault();
        b.classList.add('down');
        if (hold) this.input.hold(hold, true);
        if (tap) this.input.tap(tap);
      };
      const release = (e: Event) => {
        e.preventDefault();
        const wasDown = b.classList.contains('down');
        b.classList.remove('down');
        if (hold) this.input.hold(hold, false);
        // Menus and the chat open on release: iOS only shows the keyboard from a touchend.
        if (wasDown && e.type !== 'touchcancel' && e.type !== 'mouseleave') {
          if (act === 'pause') this.cb.onPause();
          if (act === 'chat') this.cb.onChat();
        }
      };
      b.addEventListener('touchstart', press, { passive: false });
      b.addEventListener('touchend', release, { passive: false });
      b.addEventListener('touchcancel', release, { passive: false });
      // Mouse / pen on a hybrid device, and keyboard activation.
      b.addEventListener('mousedown', press);
      b.addEventListener('mouseup', release);
      b.addEventListener('mouseleave', (e) => b.classList.contains('down') && release(e));
      b.addEventListener('click', (e) => e.preventDefault());
    }
    // No page zoom, scrolling or long-press menus on the controls.
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setVisible(on: boolean) {
    if (on === this.visible) return;
    this.visible = on;
    this.root.classList.toggle('hidden', !on);
    if (!on) this.releaseAll();
  }

  /** The dock button shows only in a docking zone. */
  setDockable(on: boolean) {
    this.root.classList.toggle('dockable', on);
  }

  /** The jump button shows only in open space, away from the stations. */
  setJumpable(on: boolean) {
    this.root.classList.toggle('jumpable', on);
  }

  setOnline(online: boolean) {
    this.root.classList.toggle('online', online);
  }

  /** Lets go of everything (pause, menu, hidden tab). */
  releaseAll() {
    this.stickId = null;
    this.throttleId = null;
    this.base.classList.remove('active');
    this.input.centerCursor();
    for (const b of Array.from(this.root.querySelectorAll<HTMLButtonElement>('button.down'))) {
      b.classList.remove('down');
      const hold = b.dataset.hold as Action | undefined;
      if (hold) this.input.hold(hold, false);
    }
  }

  /** Mirrors the throttle (it can also change from the keyboard or a gamepad-less reset). */
  update() {
    const t = this.input.input.throttle;
    const zero = -THROTTLE_MIN / (1 - THROTTLE_MIN);
    const pos = (t - THROTTLE_MIN) / (1 - THROTTLE_MIN);
    this.throttleFill.style.bottom = `${Math.min(pos, zero) * 100}%`;
    this.throttleFill.style.height = `${Math.abs(pos - zero) * 100}%`;
    this.throttleFill.classList.toggle('reverse', t < 0);
    this.throttleEl.setAttribute('aria-valuenow', String(Math.round(t * 100)));
  }

  private stickStart(e: TouchEvent) {
    e.preventDefault();
    if (this.stickId !== null) return;
    const t = e.changedTouches[0];
    this.stickId = t.identifier;
    // The stick appears under the thumb, kept fully on screen.
    const r = STICK_RADIUS + 8;
    this.stickOrigin.x = Math.max(r, Math.min(window.innerWidth - r, t.clientX));
    this.stickOrigin.y = Math.max(r, Math.min(window.innerHeight - r, t.clientY));
    this.base.style.transform = `translate(${this.stickOrigin.x}px, ${this.stickOrigin.y}px)`;
    this.base.classList.add('active');
    this.moveStick(t.clientX, t.clientY);
  }

  private stickMove(e: TouchEvent) {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) if (t.identifier === this.stickId) this.moveStick(t.clientX, t.clientY);
  }

  private stickEnd(e: TouchEvent) {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== this.stickId) continue;
      this.stickId = null;
      this.base.classList.remove('active');
      this.knob.style.transform = '';
      this.input.centerCursor();
    }
  }

  private moveStick(x: number, y: number) {
    let dx = (x - this.stickOrigin.x) / STICK_RADIUS;
    let dy = (y - this.stickOrigin.y) / STICK_RADIUS;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    this.knob.style.transform = `translate(${dx * STICK_RADIUS}px, ${dy * STICK_RADIUS}px)`;
    this.input.cursor.x = dx;
    this.input.cursor.y = dy;
  }

  private throttleTouch(e: TouchEvent, start: boolean) {
    e.preventDefault();
    if (start && this.throttleId === null) this.throttleId = e.changedTouches[0].identifier;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== this.throttleId) continue;
      const r = this.throttleEl.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (r.bottom - t.clientY) / r.height));
      let v = THROTTLE_MIN + pos * (1 - THROTTLE_MIN);
      if (Math.abs(v) < 0.06) v = 0; // easy to find the stop position
      this.input.input.throttle = v;
    }
  }
}
