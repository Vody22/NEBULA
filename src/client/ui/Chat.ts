import type { ChatLine } from '../../shared/net/protocol';
import { CHAT_MAX_LENGTH } from '../../shared/net/protocol';

const MAX_LINES = 40;
/** Lines fade out of the idle chat after this long (they stay in the open chat). */
const IDLE_FADE_MS = 15000;

export interface ChatCallbacks {
  send(text: string): void;
  /** Chat input opened / closed (the game releases held keys, keeps the mouse). */
  onFocusChange(open: boolean): void;
  onVisibilityChange(visible: boolean): void;
}

/**
 * In-game sector chat. Entrée opens the input (the mouse keeps flying the
 * ship), Entrée sends, Échap cancels; H hides or shows the panel.
 */
export class Chat {
  readonly root: HTMLDivElement;
  private log: HTMLDivElement;
  private form: HTMLFormElement;
  private field: HTMLInputElement;
  private hint: HTMLDivElement;
  private unread = 0;
  private seen = new Set<number>();
  visible: boolean;
  enabled = false;
  private closedAt = 0;
  private keys = { chat: 'Entrée', toggle: 'H' };

  constructor(parent: HTMLElement, visible: boolean, private cb: ChatCallbacks) {
    this.visible = visible;
    this.root = document.createElement('div');
    this.root.id = 'chat';
    this.root.className = 'hidden';
    this.root.innerHTML = `
      <div class="log" role="log" aria-live="polite" aria-label="Chat du secteur"></div>
      <form autocomplete="off">
        <label class="sr" for="chatField">Message pour les pilotes du secteur</label>
        <input id="chatField" type="text" maxlength="${CHAT_MAX_LENGTH}" spellcheck="false" enterkeyhint="send" placeholder="Message au secteur…">
      </form>
      <div class="hint"></div>`;
    parent.appendChild(this.root);
    this.log = this.root.querySelector('.log')!;
    this.form = this.root.querySelector('form')!;
    this.field = this.root.querySelector('input')!;
    this.hint = this.root.querySelector('.hint')!;
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.field.value.trim();
      if (text) this.cb.send(text);
      this.close();
    });
    this.field.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing never reaches the game or the pause menu
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    this.field.addEventListener('blur', () => {
      if (this.isOpen) this.close();
    });
    setInterval(() => this.fade(), 1000);
    this.renderHint();
  }

  get isOpen() {
    return this.root.classList.contains('open');
  }

  /** Closed within the last moments (Échap that closed the chat must not also pause). */
  get justClosed() {
    return performance.now() - this.closedAt < 400;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.close();
    this.root.classList.toggle('hidden', !on);
    this.applyVisibility();
  }

  /** `focusNow`: opened from a tap, where iOS only shows the keyboard if focus happens in the same gesture. */
  open(focusNow = false) {
    if (!this.enabled) return;
    if (!this.visible) this.toggle();
    this.root.classList.add('open');
    this.unread = 0;
    this.renderHint();
    this.cb.onFocusChange(true);
    // Defer focus so the Entrée that opened the chat is not typed into it.
    if (focusNow) this.field.focus();
    else setTimeout(() => this.field.focus(), 0);
  }

  close() {
    if (!this.isOpen) return;
    this.root.classList.remove('open');
    this.field.value = '';
    this.closedAt = performance.now();
    if (document.activeElement === this.field) this.field.blur();
    this.cb.onFocusChange(false);
  }

  toggle() {
    if (!this.enabled) return;
    this.visible = !this.visible;
    if (!this.visible) this.close();
    this.unread = 0;
    this.applyVisibility();
    this.cb.onVisibilityChange(this.visible);
  }

  private applyVisibility() {
    this.root.classList.toggle('collapsed', !this.visible);
    this.renderHint();
  }

  private renderHint() {
    const k = (s: string) => `<kbd>${s.replace(/[&<>]/g, '')}</kbd>`;
    this.hint.innerHTML = this.visible
      ? `${k(this.keys.chat)} écrire · ${k(this.keys.toggle)} masquer le chat`
      : `Chat masqué${this.unread ? ` · ${this.unread} nouveau${this.unread > 1 ? 'x' : ''}` : ''} · ${k(this.keys.toggle)} afficher`;
  }

  /** Key names for the hint line (they follow the player's bindings and layout). */
  setKeyLabels(chat: string, toggle: string) {
    this.keys = { chat, toggle };
    this.renderHint();
  }

  clear() {
    this.log.textContent = '';
    this.seen.clear();
  }

  history(lines: ChatLine[]) {
    for (const l of lines) this.add(l, true);
  }

  add(line: ChatLine, old = false) {
    if (this.seen.has(line.id)) return;
    this.seen.add(line.id);
    const row = document.createElement('div');
    row.className = line.from === null ? 'line system' : 'line';
    row.dataset.t = String(old ? 0 : performance.now());
    if (line.from === null) {
      row.textContent = `• ${line.text}`;
    } else {
      const who = document.createElement('b');
      who.textContent = `${line.from} : `;
      row.append(who, document.createTextNode(line.text));
    }
    if (old) row.classList.add('stale');
    this.log.appendChild(row);
    while (this.log.children.length > MAX_LINES) this.log.firstChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
    if (!this.visible && !old) {
      this.unread++;
      this.renderHint();
    }
  }

  private fade() {
    const now = performance.now();
    for (const row of this.log.children as HTMLCollectionOf<HTMLElement>) {
      const t = Number(row.dataset.t);
      if (!row.classList.contains('stale') && now - t > IDLE_FADE_MS) row.classList.add('stale');
    }
  }
}
