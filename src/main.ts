import { Game } from './client/Game';
import { LocalTransport } from './client/net/LocalTransport';
import { loadSettings, saveSettings, type Settings } from './client/settings';
import { Menu } from './client/ui/Menu';

const params = new URLSearchParams(location.search);
const quality = params.get('q') === 'low' ? 'low' : 'high';
const canvas = document.getElementById('game') as HTMLCanvasElement;
const loading = document.getElementById('loading')!;
const capture = document.getElementById('capture')!;
const settings = loadSettings();

// Solo mode: the authoritative server runs in-page. Swapping LocalTransport
// for a WebSocket transport is all that multiplayer requires on the client.
const transport = new LocalTransport(params.get('name') ?? 'William');
const game = new Game(canvas, transport, { quality }, settings);
(window as unknown as { __game: Game }).__game = game;

let started = false;

const menu = new Menu(document.getElementById('menu')!, settings, {
  onStart: () => begin(),
  onResume: () => resume(),
  onSettingsChanged: (s: Settings) => {
    game.applySettings(s);
    saveSettings(s);
  },
});
(window as unknown as { __menu: Menu }).__menu = menu;

function loop() {
  game.frame();
  updateCaptureHint();
  requestAnimationFrame(loop);
}

// Let the loading text paint before the (one-off) sky bake.
requestAnimationFrame(() => {
  setTimeout(() => {
    game.frame();
    loading.classList.add('hidden');
    menu.show('start');
    requestAnimationFrame(loop);
    if (params.has('autostart')) begin();
  }, 30);
});

function begin() {
  menu.hide();
  if (!started) {
    started = true;
    game.start();
  }
  game.setPaused(false);
  game.input.requestLock();
}

function pause() {
  if (!started || menu.isOpen) return;
  game.setPaused(true);
  if (document.pointerLockElement) document.exitPointerLock();
  menu.show('pause');
}

function resume() {
  menu.hide();
  game.input.centerCursor();
  game.setPaused(false);
  canvas.focus?.();
  // May be refused (e.g. Échap is not a user gesture): the hint then asks for a click.
  game.input.requestLock();
}

function updateCaptureHint() {
  const show = started && !menu.isOpen && !game.input.locked && 'requestPointerLock' in canvas && !params.has('autostart');
  capture.classList.toggle('hidden', !show);
}

document.addEventListener('pointerlockchange', () => {
  // Leaving pointer lock (the browser's own Échap) opens the pause menu.
  if (document.pointerLockElement !== canvas && started && !menu.isOpen) pause();
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && started && !menu.isOpen) {
    e.preventDefault();
    pause();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});
canvas.addEventListener('click', () => {
  if (started && !menu.isOpen && !game.input.locked) game.input.requestLock();
});
