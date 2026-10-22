import { Game } from './client/Game';
import { probeServer, resolveServerUrl } from './client/net/config';
import { LocalTransport } from './client/net/LocalTransport';
import type { Transport } from './client/net/Transport';
import { WebSocketTransport } from './client/net/WebSocketTransport';
import { keyLabel, loadSettings, saveSettings, type Settings } from './client/settings';
import { Chat } from './client/ui/Chat';
import { Menu, type PlayMode } from './client/ui/Menu';
import { PROTOCOL_VERSION } from './shared/net/protocol';

const params = new URLSearchParams(location.search);
const quality = params.get('q') === 'low' ? 'low' : 'high';
const render = params.get('render') === 'direct' ? 'direct' : 'auto';
const canvas = document.getElementById('game') as HTMLCanvasElement;
const loading = document.getElementById('loading')!;
const capture = document.getElementById('capture')!;
const settings = loadSettings();

// Anything that breaks before or during start-up is shown on screen instead of
// leaving a black page, so a player can report it.
function showFatal(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(err);
  loading.classList.remove('hidden');
  loading.classList.add('fatal');
  loading.setAttribute('role', 'alert');
  loading.innerHTML =
    '<div><strong>Le jeu n\'a pas pu démarrer.</strong><p>Vérifiez que WebGL et l\'accélération matérielle sont activés, ou essayez la <a href="?q=low">qualité basse</a>.</p><code></code></div>';
  loading.querySelector('code')!.textContent = msg;
}
let booted = false;
window.addEventListener('error', (e) => {
  if (!booted) showFatal(e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  if (!booted) showFatal(e.reason);
});

let game: Game;
try {
  game = new Game(canvas, { quality, render }, settings);
} catch (err) {
  showFatal(err);
  throw err;
}
(window as unknown as { __game: Game }).__game = game;

// ?diag: graphics diagnostics on screen, to report rendering problems.
if (params.has('diag')) {
  const el = document.createElement('div');
  el.id = 'diag';
  document.body.appendChild(el);
  setInterval(() => (el.textContent = game.graphicsInfo()), 1000);
}

const serverUrl = resolveServerUrl();
let started = false;
let mode: PlayMode | null = null;
let connectWatch: ReturnType<typeof setInterval> | null = null;

const chat = new Chat(document.body, settings.chatVisible, {
  send: (text) => game.sendChat(text),
  onFocusChange: (open) => {
    if (open) game.input.releaseKeys();
  },
  onVisibilityChange: (visible) => {
    settings.chatVisible = visible;
    saveSettings(settings);
  },
});
(window as unknown as { __chat: Chat }).__chat = chat;

function chatKeys(s: Settings) {
  const layout = s.layout === 'auto' ? 'auto' : s.layout;
  chat.setKeyLabels(keyLabel(s.bindings.chat, layout), keyLabel(s.bindings.chatToggle, layout));
}
chatKeys(settings);

game.callbacks = {
  onChat: (line) => chat.add(line),
  onChatHistory: (lines) => chat.history(lines),
  onOpenChat: () => chat.open(),
  onToggleChat: () => chat.toggle(),
  onFatal: (_code, text) => {
    // Server full, wrong version, session taken over: back to the title screen.
    leave();
    menu.setServerStatus('bad', text);
  },
};

const menu = new Menu(document.getElementById('menu')!, settings, {
  onStart: (m, name) => begin(m, name),
  onResume: () => resume(),
  onLeave: () => leave(),
  onSettingsChanged: (s: Settings) => {
    game.applySettings(s);
    chatKeys(s);
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
    try {
      game.frame();
    } catch (err) {
      showFatal(err);
      return;
    }
    booted = true;
    loading.classList.add('hidden');
    menu.show('start');
    checkServer();
    requestAnimationFrame(loop);
    if (params.has('autostart')) begin(params.has('online') ? 'online' : 'solo', settings.name || 'Pilote');
  }, 30);
});

async function checkServer() {
  if (!serverUrl) {
    menu.setServerStatus('none', 'Aucun serveur en ligne configuré : le mode solo reste disponible.');
    return;
  }
  menu.setServerStatus('checking', 'Recherche du serveur en ligne…');
  const st = await probeServer(serverUrl);
  if (started) return;
  if (!st) menu.setServerStatus('bad', 'Serveur en ligne injoignable pour le moment. Le mode solo reste disponible.');
  else if (st.protocol !== PROTOCOL_VERSION) menu.setServerStatus('bad', 'Le serveur utilise une autre version du jeu.');
  else
    menu.setServerStatus(
      'ok',
      `Serveur en ligne · ${st.online} pilote${st.online > 1 ? 's' : ''} connecté${st.online > 1 ? 's' : ''} sur ${st.max}`,
    );
}

function lagOptions() {
  const n = (k: string) => Math.max(0, Math.min(2000, Number(params.get(k)) || 0));
  return { lagMs: n('lag'), jitterMs: n('jitter') };
}

function begin(m: PlayMode, name: string) {
  if (m === 'online') {
    if (!serverUrl) return;
    menu.setServerStatus('busy', 'Connexion au serveur…');
    const t = new WebSocketTransport(serverUrl, name, lagOptions());
    game.attach(t);
    // Wait for the welcome before taking off; give up after a few seconds.
    const deadline = performance.now() + 8000;
    if (connectWatch) clearInterval(connectWatch);
    connectWatch = setInterval(() => {
      if (game.transport !== t) {
        clearInterval(connectWatch!);
        return;
      }
      t.update(); // pump messages while the game loop is not running yet
      if (t.status.state === 'online') {
        clearInterval(connectWatch!);
        takeOff('online', t);
      } else if (t.status.state === 'failed' || performance.now() > deadline) {
        clearInterval(connectWatch!);
        game.detach();
        menu.setServerStatus('bad', t.status.error ?? 'Le serveur ne répond pas. Réessayez ou jouez en solo.');
      }
    }, 50);
    return;
  }
  const t = new LocalTransport(name || 'Pilote');
  game.attach(t);
  takeOff('solo', t);
}

function takeOff(m: PlayMode, _t: Transport) {
  mode = m;
  menu.hide();
  started = true;
  chat.clear();
  chat.setEnabled(m === 'online');
  game.start();
  game.setPaused(false);
  game.input.requestLock();
}

function leave() {
  if (connectWatch) clearInterval(connectWatch);
  game.detach();
  chat.setEnabled(false);
  chat.clear();
  started = false;
  mode = null;
  if (document.pointerLockElement) document.exitPointerLock();
  menu.show('start');
  checkServer();
}

function pause() {
  if (!started || menu.isOpen) return;
  chat.close();
  game.setPaused(true);
  if (document.pointerLockElement) document.exitPointerLock();
  menu.show('pause', { online: mode === 'online', diag: game.graphicsInfo() });
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
  const show = started && !menu.isOpen && !chat.isOpen && !game.input.locked && 'requestPointerLock' in canvas && !params.has('autostart');
  capture.classList.toggle('hidden', !show);
}

document.addEventListener('pointerlockchange', () => {
  // Leaving pointer lock (the browser's own Échap) opens the pause menu,
  // unless that Échap was closing the chat.
  if (document.pointerLockElement === canvas || !started || menu.isOpen) return;
  if (chat.isOpen || chat.justClosed) {
    chat.close();
    return;
  }
  pause();
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && started && !menu.isOpen && !chat.isOpen && !chat.justClosed) {
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
