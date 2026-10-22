import { Game } from './client/Game';
import { LocalTransport } from './client/net/LocalTransport';

const params = new URLSearchParams(location.search);
const quality = params.get('q') === 'low' ? 'low' : 'high';
const canvas = document.getElementById('game') as HTMLCanvasElement;
const menu = document.getElementById('menu')!;
const loading = document.getElementById('loading')!;
const launch = document.getElementById('launch') as HTMLButtonElement;

// Solo mode: the authoritative server runs in-page. Swapping LocalTransport
// for a WebSocket transport is all that multiplayer requires on the client.
const transport = new LocalTransport(params.get('name') ?? 'William');
const game = new Game(canvas, transport, { quality });
(window as unknown as { __game: Game }).__game = game;

let started = false;
let hadLock = false;

function loop() {
  game.frame();
  requestAnimationFrame(loop);
}

// Let the loading text paint before the (one-off) sky bake.
requestAnimationFrame(() => {
  setTimeout(() => {
    game.frame();
    loading.classList.add('hidden');
    menu.classList.remove('hidden');
    requestAnimationFrame(loop);
    if (params.has('autostart')) begin();
  }, 30);
});

function begin() {
  menu.classList.add('hidden');
  if (!started) {
    started = true;
    game.start();
  }
  game.input.requestLock();
}

launch.addEventListener('click', begin);

// Controls use physical key positions (KeyboardEvent.code), so on AZERTY the
// "W/A" keys are Z/Q. Show the labels of the player's actual layout.
type LayoutNav = Navigator & { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } };
(navigator as LayoutNav).keyboard?.getLayoutMap?.()
  .then((map) => {
    document.querySelectorAll<HTMLElement>('kbd[data-code]').forEach((k) => {
      const label = map.get(k.dataset.code!);
      if (label) k.textContent = label.toUpperCase();
    });
  })
  .catch(() => {});
launch.textContent = 'DÉCOLLER';

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) {
    hadLock = true;
  } else if (hadLock && started) {
    launch.textContent = 'REPRENDRE';
    menu.classList.remove('hidden');
  }
});
