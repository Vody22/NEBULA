import { checkAccountName, checkPassword, PASSWORD_MAX } from '../../shared/accounts';
import type { AuthRequest } from '../../shared/net/protocol';
import { isTouchDevice } from '../input/Touch';
import { isQualityLevel, QUALITY, QUALITY_LEVELS } from '../render/quality';
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
type AuthTab = 'login' | 'register';

export interface StartRequest {
  /** Pilot name (solo; online it comes from the account). */
  name: string;
  /** Online with a password (no stored login): sign in or create the account. Absent: use the stored token. */
  auth?: AuthRequest;
}

export interface MenuCallbacks {
  onStart(mode: PlayMode, start: StartRequest): void;
  /** "Changer de compte": forget the stored login. */
  onSignOut?(): void;
  onResume(): void;
  onLeave(): void;
  onSettingsChanged(s: Settings): void;
  /** Start the performance test (reloads the page with ?bench). */
  onBenchmark?(): void;
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
  /** Signed in on this browser (a stored login token): no password to type. */
  private account: { name: string } | null = null;
  private authTab: AuthTab = 'login';
  private authMsg: { text: string; tone: '' | 'bad' | 'ok' } = { text: '', tone: '' };
  /** What is typed in the login form survives re-renders (tab switch, server status). */
  private draft = { name: '', pass: '', pass2: '' };

  constructor(
    root: HTMLElement,
    private settings: Settings,
    private cb: MenuCallbacks,
  ) {
    this.root = root;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'menuTitle');
    this.touchOnly = isTouchDevice();

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

  /** Graphics diagnostics line (pause menu), so a player can report rendering problems. */
  private diag = '';

  get isOpen() {
    return !this.root.classList.contains('hidden');
  }

  show(mode: Mode, opts: { online?: boolean; diag?: string } = {}) {
    this.mode = mode;
    this.online = opts.online ?? false;
    this.diag = opts.diag ?? '';
    this.view = 'main';
    this.capturing = null;
    this.root.classList.remove('hidden');
    this.render();
  }

  hide() {
    this.capturing = null;
    this.root.classList.add('hidden');
    this.draft.pass = this.draft.pass2 = '';
  }

  /** The stored login (null: show the sign-in form). */
  setAccount(account: { name: string } | null) {
    this.account = account;
    if (!account) this.authTab = 'login';
    // Signed in: the typed password is not needed any more (reconnections use the token).
    else this.draft = { name: account.name, pass: '', pass2: '' };
    if (this.isOpen && this.view === 'main' && this.mode === 'start') this.render();
  }

  /** A line under the login form: why it was refused, or that it worked. */
  setAuthMessage(text: string, tone: '' | 'bad' | 'ok' = 'bad') {
    this.authMsg = { text, tone };
    const el = this.root.querySelector<HTMLElement>('#authStatus');
    if (el) {
      el.textContent = text;
      el.className = `auth ${tone}`;
    }
  }

  /** Opens the form on a tab (e.g. "Se connecter" after a "name taken" refusal). */
  showAuthTab(tab: AuthTab) {
    this.authTab = tab;
    if (this.isOpen && this.view === 'main' && this.mode === 'start') this.render();
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

  private accountBlock() {
    const msg = `<p id="authStatus" class="auth ${this.authMsg.tone}" role="alert">${esc(this.authMsg.text)}</p>`;
    const server = `<p id="serverStatus" class="server ${this.server.state}" role="status">${esc(this.server.text)}</p>`;
    if (this.account) {
      return `<div class="pilot signed">
          <span class="label">Pilote</span>
          <div class="who"><b>${esc(this.account.name)}</b><button type="button" class="link" data-act="signout">Changer de compte</button></div>
          ${msg}${server}
        </div>`;
    }
    const reg = this.authTab === 'register';
    const tab = (t: AuthTab, label: string) =>
      `<button type="button" role="tab" id="tab-${t}" data-tab="${t}" aria-selected="${this.authTab === t}" aria-controls="authForm"${this.authTab === t ? '' : ' tabindex="-1"'}>${label}</button>`;
    return `<div class="tabs" role="tablist" aria-label="Compte pilote">${tab('login', 'Se connecter')}${tab('register', 'Créer un compte')}</div>
      <form class="pilot" id="authForm" role="tabpanel" aria-labelledby="tab-${this.authTab}" autocomplete="on" novalidate>
        <label for="pilotName">Pseudo de pilote</label>
        <input id="pilotName" name="username" type="text" maxlength="16" autocomplete="username" spellcheck="false" placeholder="3 à 16 caractères">
        <label for="pilotPass">Mot de passe</label>
        <input id="pilotPass" name="password" type="password" maxlength="${PASSWORD_MAX}" autocomplete="${reg ? 'new-password' : 'current-password'}"${reg ? ' placeholder="8 caractères minimum"' : ''}>
        ${
          reg
            ? `<label for="pilotPass2">Confirmez le mot de passe</label>
               <input id="pilotPass2" name="password2" type="password" maxlength="${PASSWORD_MAX}" autocomplete="new-password">
               <p class="hint">Aucune adresse e-mail n'est demandée : notez votre mot de passe, il ne pourra pas être récupéré.</p>`
            : ''
        }
        ${msg}${server}
      </form>`;
  }

  /** Online: checks the form and hands the credentials over, or says what is wrong. */
  private startOnline() {
    if (this.account) {
      this.cb.onStart('online', { name: this.account.name });
      return;
    }
    const nameEl = this.root.querySelector<HTMLInputElement>('#pilotName');
    const passEl = this.root.querySelector<HTMLInputElement>('#pilotPass');
    const name = (nameEl?.value ?? '').trim();
    const password = passEl?.value ?? '';
    const bad = (text: string, el?: HTMLElement | null) => {
      this.setAuthMessage(text, 'bad');
      el?.focus();
    };
    if (this.authTab === 'register') {
      const n = checkAccountName(name);
      if (!n.ok) return bad(n.text, nameEl);
      const weak = checkPassword(password, n.name);
      if (weak) return bad(weak, passEl);
      const pass2 = this.root.querySelector<HTMLInputElement>('#pilotPass2');
      if ((pass2?.value ?? '') !== password) return bad('Les deux mots de passe ne correspondent pas.', pass2);
    } else {
      if (name.length < 3) return bad('Entrez votre pseudo de pilote.', nameEl);
      if (!password) return bad('Entrez votre mot de passe.', passEl);
    }
    this.setAuthMessage('', '');
    if (name !== this.settings.name) {
      this.settings.name = name;
      this.changed();
    }
    this.cb.onStart('online', { name, auth: { kind: this.authTab, name, password } });
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
        <p class="sub">${start ? 'MMO spatial · Secteur Aurora · v0.4' : this.online ? 'En ligne : le secteur continue, votre vaisseau coupe les gaz' : 'La simulation est en pause'}</p>
        ${
          this.touchOnly
            ? `<p class="touch-note"><strong>Commandes tactiles.</strong> Pouce gauche : glissez pour piloter. Pouce droit : FEU, BOOST et MINER. Curseur GAZ pour la poussée. Jouez en mode paysage.</p>`
            : ''
        }
        ${start ? this.accountBlock() : ''}
        <div class="menu-buttons">
          ${
            start
              ? `<button class="primary" data-act="online">${this.account ? 'Jouer en ligne' : this.authTab === 'register' ? 'Créer le compte et jouer' : 'Se connecter et jouer'}</button>
                 <button data-act="solo">Solo hors ligne</button>`
              : `<button class="primary" data-act="resume">Reprendre</button>`
          }
          <div class="pair">
            <button data-act="controls">Commandes</button>
            <button data-act="options">Options et son</button>
          </div>
          ${start ? '' : `<button data-act="leave">Quitter vers le menu</button>`}
        </div>
        ${
          start
            ? `<div class="quickhelp" aria-label="Commandes essentielles">
                <div><span class="k">Souris</span> piloter (le réticule blanc indique la direction du virage)</div>
                <div><span class="k">Clic gauche</span> ou ${this.kbd(b.fire)} tirer</div>
                <div>${this.kbd(b.throttleUp)} ${this.kbd(b.throttleDown)} poussée · ${this.kbd(b.boost)} boost · ${this.kbd(b.stop)} arrêt</div>
                <div>${this.kbd(b.mine)} ou <span class="k">Clic droit</span> miner · ${this.kbd(b.dock)} s'amarrer à une station</div>
                <div>${this.kbd(b.target)} cible suivante · <kbd>Échap</kbd> pause et aide</div>
                <div>${this.kbd(b.chat)} chat · ${this.kbd(b.pvp)} PvP · ${this.kbd(b.scoreboard)} pilotes (en ligne)</div>
              </div>
              <p class="note">Minez, commercez entre les stations et repoussez les raids pirates, seul ou avec les autres pilotes du secteur.</p>`
            : `<p class="note">Entrée ou clic sur « Reprendre » pour revenir en vol. La souris sera capturée de nouveau.</p>
               <p class="diag"></p>`
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
          <label class="opt"><span>Qualité graphique</span>
            <select id="qualitySel" data-setting="quality">
              ${(['auto', ...QUALITY_LEVELS] as const)
                .map((q) => `<option value="${q}"${s.quality === q ? ' selected' : ''}>${q === 'auto' ? 'Automatique' : QUALITY[q].label}</option>`)
                .join('')}
            </select></label>
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
        ${
          this.mode === 'start'
            ? `<p class="hint">Test de performance : mesure la fluidité de cet appareil aux quatre niveaux de qualité (environ 2 minutes, hors ligne).</p>`
            : ''
        }
        <div class="menu-buttons row">
          ${this.mode === 'start' ? '<button data-act="bench">Test de performance</button>' : ''}
          <button class="primary" data-act="back">Retour</button>
        </div>`;
    }
    this.root.innerHTML = `<div class="box view-${this.view}">${html}</div>`;
    // Typed values are put back as properties, never written into the markup.
    const put = (sel: string, v: string) => {
      const el = this.root.querySelector<HTMLInputElement>(sel);
      if (el) el.value = v;
    };
    put('#pilotName', this.draft.name || this.settings.name);
    put('#pilotPass', this.draft.pass);
    put('#pilotPass2', this.draft.pass2);
    const diag = this.root.querySelector('.diag');
    if (diag) diag.textContent = this.diag; // GPU names are not trusted HTML
    if (this.view === 'main' && this.mode === 'start') this.setServerStatus(this.server.state, this.server.text);
    this.focusDefault();
  }

  private focusDefault() {
    let want = this.lastFocus ? this.root.querySelector<HTMLElement>(this.lastFocus) : null;
    this.lastFocus = null;
    if (!want && this.view === 'main' && this.mode === 'start' && !this.account) {
      const name = this.root.querySelector<HTMLInputElement>('#pilotName');
      want = name && !name.value ? name : this.root.querySelector<HTMLElement>('#pilotPass');
    }
    (want ?? this.root.querySelector<HTMLElement>('button.primary:not(:disabled), button:not(:disabled)'))?.focus();
  }

  private onClick(e: Event) {
    const t = (e.target as HTMLElement).closest('button');
    if (!t) return;
    if (t.dataset.tab) {
      this.authTab = t.dataset.tab as AuthTab;
      this.setAuthMessage('', '');
      this.lastFocus = `[data-tab="${this.authTab}"]`;
      this.render();
      return;
    }
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
        this.startOnline();
        break;
      case 'solo': {
        const name = this.account?.name ?? this.pilotName();
        if (!this.account && name && name !== this.settings.name) {
          this.settings.name = name;
          this.changed();
        }
        this.cb.onStart('solo', { name: name || 'Pilote' });
        break;
      }
      case 'signout':
        this.draft = { name: this.account?.name ?? '', pass: '', pass2: '' };
        this.cb.onSignOut?.();
        this.setAccount(null);
        this.setAuthMessage('Vous êtes déconnecté sur ce navigateur.', 'ok');
        break;
      case 'leave':
        this.cb.onLeave();
        break;
      case 'bench':
        this.cb.onBenchmark?.();
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
    if (el.id === 'pilotName') this.draft.name = el.value;
    else if (el.id === 'pilotPass') this.draft.pass = el.value;
    else if (el.id === 'pilotPass2') this.draft.pass2 = el.value;
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
    } else if (key === 'quality' && e.type === 'change') {
      s.quality = isQualityLevel(el.value) ? el.value : 'auto';
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
    if (e.code === 'Enter' && ['pilotName', 'pilotPass', 'pilotPass2'].includes((e.target as HTMLElement).id)) {
      // Entrée in the login form always means "sign in", even when solo is highlighted (server not found yet).
      e.preventDefault();
      if (!this.root.querySelector<HTMLButtonElement>('[data-act="online"]')?.disabled) this.startOnline();
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
