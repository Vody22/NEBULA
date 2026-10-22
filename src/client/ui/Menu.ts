import {
  ACTION_LABELS,
  DEFAULT_BINDINGS,
  guessLayout,
  keyLabel,
  rebind,
  type Action,
  type KeyboardLayout,
  type Settings,
} from '../settings';

export type PlayMode = 'online' | 'solo';
export type ServerState = 'checking' | 'ok' | 'bad' | 'none' | 'busy';

export interface MenuCallbacks {
  onStart(mode: PlayMode, name: string): void;
  onResume(): void;
  onLeave(): void;
  onSettingsChanged(s: Settings): void;
}

type Mode = 'start' | 'pause';
type View = 'main' | 'controls' | 'options';

const GROUPS: { title: string; actions: Action[] }[] = [
  { title: 'Vol', actions: ['throttleUp', 'throttleDown', 'stop', 'boost', 'assist'] },
  { title: 'Manœuvres', actions: ['strafeLeft', 'strafeRight', 'strafeUp', 'strafeDown', 'rollLeft', 'rollRight', 'pitchUp', 'pitchDown', 'yawLeft', 'yawRight'] },
  { title: 'Combat et interface', actions: ['fire', 'target', 'camera', 'mute'] },
  { title: 'En ligne', actions: ['chat', 'chatToggle', 'pvp', 'scoreboard'] },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Start screen and pause menu: resume, controls (rebindable, AZERTY/QWERTY
 * labels) and options. Fully usable with the keyboard (Tab / Entrée / Échap).
 */
export class Menu {
  readonly root: HTMLElement;
  mode: Mode = 'start';
  view: View = 'main';
  private capturing: Action | null = null;
  private layoutMap: Map<string, string> | null = null;
  private touchOnly: boolean;
  private lastFocus: string | null = null;
  private online = false;
  private server: { state: ServerState; text: string } = { state: 'checking', text: 'Recherche du serveur en ligne…' };

  constructor(
    root: HTMLElement,
    private settings: Settings,
    private cb: MenuCallbacks,
  ) {
    this.root = root;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'menuTitle');
    this.touchOnly =
      typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;

    type LayoutNav = Navigator & { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } };
    (navigator as LayoutNav).keyboard
      ?.getLayoutMap?.()
      .then((m) => {
        this.layoutMap = m;
        if (this.isOpen) this.render();
      })
      .catch(() => {});

    window.addEventListener('keydown', (e) => this.onKey(e), true);
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('input', (e) => this.onInput(e));
    this.root.addEventListener('change', (e) => this.onInput(e));
  }

  get isOpen() {
    return !this.root.classList.contains('hidden');
  }

  show(mode: Mode, opts: { online?: boolean } = {}) {
    this.mode = mode;
    this.online = opts.online ?? false;
    this.view = 'main';
    this.capturing = null;
    this.root.classList.remove('hidden');
    this.render();
  }

  hide() {
    this.capturing = null;
    this.root.classList.add('hidden');
  }

  /** Online server reachability, shown under the pilot name without re-rendering the menu. */
  setServerStatus(state: ServerState, text: string) {
    this.server = { state, text };
    const el = this.root.querySelector<HTMLElement>('#serverStatus');
    if (el) {
      el.textContent = text;
      el.className = `server ${state}`;
    }
    const online = this.root.querySelector<HTMLButtonElement>('[data-act="online"]');
    const solo = this.root.querySelector<HTMLButtonElement>('[data-act="solo"]');
    const busy = state === 'busy';
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.menu-buttons button')) b.disabled = busy;
    if (online) {
      online.disabled = busy || state === 'none';
      online.classList.toggle('primary', state !== 'bad' && state !== 'none');
    }
    solo?.classList.toggle('primary', state === 'bad' || state === 'none');
  }

  private pilotName() {
    return (this.root.querySelector<HTMLInputElement>('#pilotName')?.value ?? this.settings.name).trim();
  }

  private effectiveLayout(): KeyboardLayout {
    if (this.settings.layout !== 'auto') return this.settings.layout;
    return this.layoutMap ? 'auto' : guessLayout(navigator.languages ?? [navigator.language]);
  }

  label(code: string) {
    return keyLabel(code, this.effectiveLayout(), this.layoutMap);
  }

  private kbd(code: string) {
    return `<kbd>${esc(this.label(code))}</kbd>`;
  }

  private render() {
    const s = this.settings;
    const b = s.bindings;
    let html = '';
    if (this.view === 'main') {
      const start = this.mode === 'start';
      html = `
        <h1 id="menuTitle">${start ? 'NEBULA <span>FRONTIER</span>' : 'PAUSE'}</h1>
        <p class="sub">${start ? 'Secteur Aurora · v0.2 multijoueur' : this.online ? 'En ligne : le secteur continue, votre vaisseau coupe les gaz' : 'La simulation est en pause'}</p>
        ${
          this.touchOnly
            ? `<p class="device-warning" role="alert"><strong>Clavier et souris requis.</strong> Ce prototype ne propose pas encore de commandes tactiles : sur cet appareil, il est seulement possible de regarder la scène.</p>`
            : ''
        }
        ${
          start
            ? `<div class="pilot">
                <label for="pilotName">Pseudo de pilote</label>
                <input id="pilotName" type="text" maxlength="16" autocomplete="nickname" spellcheck="false" value="${esc(s.name)}" placeholder="2 à 16 caractères">
                <p id="serverStatus" class="server ${this.server.state}" role="status">${esc(this.server.text)}</p>
              </div>`
            : ''
        }
        <div class="menu-buttons">
          ${
            start
              ? `<button class="primary" data-act="online">Jouer en ligne</button>
                 <button data-act="solo">Solo hors ligne</button>`
              : `<button class="primary" data-act="resume">Reprendre</button>`
          }
          <button data-act="controls">Commandes</button>
          <button data-act="options">Options et son</button>
          ${start ? '' : `<button data-act="leave">Quitter vers le menu</button>`}
        </div>
        ${
          start
            ? `<div class="quickhelp" aria-label="Commandes essentielles">
                <div><span class="k">Souris</span> piloter (le réticule blanc indique la direction du virage)</div>
                <div><span class="k">Clic gauche</span> ou ${this.kbd(b.fire)} tirer</div>
                <div>${this.kbd(b.throttleUp)} ${this.kbd(b.throttleDown)} poussée · ${this.kbd(b.boost)} boost · ${this.kbd(b.stop)} arrêt</div>
                <div>${this.kbd(b.target)} cible suivante · <kbd>Échap</kbd> pause et aide</div>
                <div>${this.kbd(b.chat)} chat · ${this.kbd(b.pvp)} PvP · ${this.kbd(b.scoreboard)} pilotes (en ligne)</div>
              </div>
              <p class="note">Défendez la station Aurora-7 contre les vagues de pirates, seul ou avec d'autres pilotes.</p>`
            : `<p class="note">Entrée ou clic sur « Reprendre » pour revenir en vol. La souris sera capturée de nouveau.</p>`
        }`;
    } else if (this.view === 'controls') {
      const layout = s.layout;
      const rows = GROUPS.map(
        (g) => `
        <h3>${g.title}</h3>
        <div class="binds">
          ${g.actions
            .map((a) => {
              const cap = this.capturing === a;
              return `<div class="bind-row"><span id="lbl-${a}">${ACTION_LABELS[a]}</span>
                <button class="key${cap ? ' capturing' : ''}" data-bind="${a}" aria-describedby="lbl-${a}"
                  aria-label="${esc(ACTION_LABELS[a])} : touche ${esc(this.label(b[a]))}. Activer pour changer.">
                  ${cap ? 'Appuyez sur une touche…' : esc(this.label(b[a]))}</button></div>`;
            })
            .join('')}
        </div>`,
      ).join('');
      html = `
        <h2 id="menuTitle">Commandes</h2>
        <div class="layout-row">
          <label for="layoutSel">Clavier</label>
          <select id="layoutSel" data-setting="layout">
            <option value="auto"${layout === 'auto' ? ' selected' : ''}>Détection automatique</option>
            <option value="azerty"${layout === 'azerty' ? ' selected' : ''}>AZERTY (français)</option>
            <option value="qwerty"${layout === 'qwerty' ? ' selected' : ''}>QWERTY</option>
          </select>
        </div>
        <p class="hint">Les touches sont liées à leur position sur le clavier : ZQSD sur AZERTY correspond à WASD sur QWERTY.
          Activez une touche pour la changer, puis appuyez sur la nouvelle (Échap pour annuler).</p>
        <div class="binds fixed">
          <div class="bind-row"><span>Piloter</span><span class="fixedkey">Souris</span></div>
          <div class="bind-row"><span>Tirer</span><span class="fixedkey">Clic gauche</span></div>
          <div class="bind-row"><span>Poussée</span><span class="fixedkey">Molette</span></div>
          <div class="bind-row"><span>Pause et aide</span><span class="fixedkey">Échap</span></div>
        </div>
        <div class="scroll">${rows}</div>
        <div class="menu-buttons row">
          <button data-act="reset-binds">Touches par défaut</button>
          <button class="primary" data-act="back">Retour</button>
        </div>`;
    } else {
      html = `
        <h2 id="menuTitle">Options et son</h2>
        <div class="opts">
          <label class="opt"><span>Volume</span>
            <input type="range" min="0" max="100" step="5" value="${Math.round(s.volume * 100)}" data-setting="volume" aria-valuetext="${Math.round(s.volume * 100)} %">
            <output>${Math.round(s.volume * 100)} %</output></label>
          <label class="opt check"><input type="checkbox" data-setting="muted"${s.muted ? ' checked' : ''}><span>Couper le son (${esc(this.label(b.mute))} en jeu)</span></label>
          <label class="opt"><span>Sensibilité de la souris</span>
            <input type="range" min="25" max="300" step="5" value="${Math.round(s.sensitivity * 100)}" data-setting="sensitivity" aria-valuetext="${Math.round(s.sensitivity * 100)} %">
            <output>${Math.round(s.sensitivity * 100)} %</output></label>
          <label class="opt check"><input type="checkbox" data-setting="invertY"${s.invertY ? ' checked' : ''}><span>Inverser l'axe vertical de la souris</span></label>
        </div>
        <p class="hint">Les réglages sont enregistrés dans ce navigateur.</p>
        <div class="menu-buttons row"><button class="primary" data-act="back">Retour</button></div>`;
    }
    this.root.innerHTML = `<div class="box view-${this.view}">${html}</div>`;
    if (this.view === 'main' && this.mode === 'start') this.setServerStatus(this.server.state, this.server.text);
    this.focusDefault();
  }

  private focusDefault() {
    let want = this.lastFocus ? this.root.querySelector<HTMLElement>(this.lastFocus) : null;
    this.lastFocus = null;
    if (!want && this.view === 'main' && this.mode === 'start' && !this.settings.name) want = this.root.querySelector<HTMLElement>('#pilotName');
    (want ?? this.root.querySelector<HTMLElement>('button.primary:not(:disabled), button:not(:disabled)'))?.focus();
  }

  private onClick(e: Event) {
    const t = (e.target as HTMLElement).closest('button');
    if (!t) return;
    const act = t.dataset.act;
    const bind = t.dataset.bind as Action | undefined;
    if (bind) {
      this.capturing = this.capturing === bind ? null : bind;
      this.lastFocus = `[data-bind="${bind}"]`;
      this.render();
      return;
    }
    switch (act) {
      case 'online':
      case 'solo': {
        const name = this.pilotName();
        if (act === 'online' && name.length < 2) {
          this.setServerStatus(this.server.state === 'busy' ? 'ok' : this.server.state, 'Choisissez un pseudo de 2 à 16 caractères pour jouer en ligne.');
          this.root.querySelector<HTMLInputElement>('#pilotName')?.focus();
          break;
        }
        if (name !== this.settings.name) {
          this.settings.name = name;
          this.changed();
        }
        this.cb.onStart(act, name);
        break;
      }
      case 'leave':
        this.cb.onLeave();
        break;
      case 'resume':
        this.cb.onResume();
        break;
      case 'controls':
      case 'options':
        this.view = act;
        this.render();
        break;
      case 'back':
        this.lastFocus = `[data-act="${this.view}"]`;
        this.view = 'main';
        this.render();
        break;
      case 'reset-binds':
        this.settings.bindings = { ...DEFAULT_BINDINGS };
        this.changed();
        this.lastFocus = '[data-act="reset-binds"]';
        this.render();
        break;
    }
  }

  private onInput(e: Event) {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const key = el.dataset.setting;
    if (!key) return;
    const s = this.settings;
    if (key === 'volume' || key === 'sensitivity') {
      const v = Number((el as HTMLInputElement).value) / 100;
      if (key === 'volume') s.volume = v;
      else s.sensitivity = v;
      const out = el.parentElement?.querySelector('output');
      if (out) out.textContent = `${Math.round(v * 100)} %`;
      el.setAttribute('aria-valuetext', `${Math.round(v * 100)} %`);
    } else if (key === 'muted' || key === 'invertY') {
      s[key] = (el as HTMLInputElement).checked;
    } else if (key === 'layout' && e.type === 'change') {
      s.layout = el.value as KeyboardLayout;
      this.changed();
      this.lastFocus = '#layoutSel';
      this.render();
      return;
    }
    this.changed();
  }

  private changed() {
    this.cb.onSettingsChanged(this.settings);
  }

  private onKey(e: KeyboardEvent) {
    if (!this.isOpen) return;
    if (e.code === 'Enter' && (e.target as HTMLElement).id === 'pilotName') {
      e.preventDefault();
      this.root.querySelector<HTMLButtonElement>('.menu-buttons button.primary:not(:disabled)')?.click();
      return;
    }
    if (this.capturing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const action = this.capturing;
      this.capturing = null;
      if (e.code !== 'Escape' && e.code) {
        rebind(this.settings.bindings, action, e.code);
        this.changed();
      }
      this.lastFocus = `[data-bind="${action}"]`;
      this.render();
      return;
    }
    if (e.code === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.view !== 'main') {
        this.lastFocus = `[data-act="${this.view}"]`;
        this.view = 'main';
        this.render();
      } else if (this.mode === 'pause') {
        this.cb.onResume();
      }
    }
  }
}
