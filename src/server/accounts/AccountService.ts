import { checkAccountName, checkPassword, loginKey } from '../../shared/accounts';
import type { AuthRequest } from '../../shared/net/protocol';
import type { PilotSave } from '../../shared/save';
import type { PilotProfile } from '../GameServer';
import { hashPassword, newToken, tokenHash, verifyPassword } from './passwords';
import type { AccountStore } from './store';

export type AuthFailure = 'credentials' | 'taken' | 'invalid' | 'limited' | 'expired' | 'unavailable';

export type AuthResult =
  | { ok: true; profile: PilotProfile & { accountId: string }; token: string; expiresAt: number; isNew: boolean }
  | { ok: false; reason: AuthFailure; text: string };

/** Brute-force and spam limits (in memory, per server). */
export interface AccountLimits {
  /** Login or sign-up attempts per address per minute. */
  perMinute: number;
  /** Failed logins per pilot name per 10 minutes (then that name waits). */
  failuresPerName: number;
  /** New accounts per address per hour. */
  signupsPerHour: number;
  /** New accounts on the whole server per hour: a backstop when addresses are shared or faked. */
  signupsPerHourTotal: number;
}

export const DEFAULT_LIMITS: AccountLimits = { perMinute: 20, failuresPerName: 8, signupsPerHour: 10, signupsPerHourTotal: 120 };

export interface AccountServiceOptions {
  /** Seconds between two database writes of pilot progress (a session ending is written at once). */
  saveInterval?: number;
  limits?: Partial<AccountLimits>;
  /** Login token lifetime in days. */
  tokenDays?: number;
  now?: () => number;
  log?: (m: string) => void;
  /** Another server took this account over: its session here must end without saving. */
  onTakenOver?: (accountId: string) => void;
}

const TEXT: Record<Exclude<AuthFailure, 'invalid'>, string> = {
  credentials: 'Pseudo ou mot de passe incorrect.',
  taken: "Ce pseudo est déjà pris. Choisissez-en un autre, ou connectez-vous si c'est le vôtre.",
  limited: 'Trop de tentatives : réessayez dans quelques minutes.',
  expired: 'Session expirée : reconnectez-vous avec votre mot de passe.',
  unavailable: 'Le serveur de comptes est momentanément indisponible. Réessayez dans un instant (le mode solo reste disponible).',
};

const fail = (reason: AuthFailure, text?: string): AuthResult => ({ ok: false, reason, text: text ?? TEXT[reason as Exclude<AuthFailure, 'invalid'>] });

/** At most `limit` hits per key within `windowMs` (sliding window, in memory). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Counts a hit; false when the key is over its limit (the hit is then not counted). */
  hit(key: string): boolean {
    if (!this.allowed(key)) return false;
    this.hits.get(key)!.push(this.now());
    return true;
  }

  /** Whether one more hit would pass, without counting it. */
  allowed(key: string): boolean {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.prune();
    return list.length < this.limit;
  }

  clear(key: string) {
    this.hits.delete(key);
  }

  private prune() {
    const t = this.now();
    for (const [k, list] of this.hits) if (!list.some((x) => t - x < this.windowMs)) this.hits.delete(k);
  }
}

/** A small queue so password hashing never takes more than `n` threads (the free server has a tenth of a CPU). */
class Semaphore {
  private waiting: (() => void)[] = [];
  private busy = 0;
  constructor(private n: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy >= this.n) await new Promise<void>((r) => this.waiting.push(r));
    this.busy++;
    try {
      return await fn();
    } finally {
      this.busy--;
      this.waiting.shift()?.();
    }
  }
}

/**
 * Pilot accounts on the game server: sign-up, login (password or token),
 * brute-force limits, and the progress write-back. The GameServer reports
 * progress through `queueSave`; it is written in batches every few seconds,
 * at once when a session ends, and on shutdown (`flush`).
 */
export class AccountService {
  /** 'starting' until the database answers; logins are refused while it is not 'ready'. */
  state: 'starting' | 'ready' | 'unavailable' = 'starting';
  private now: () => number;
  private log: (m: string) => void;
  private saveInterval: number;
  private tokenMs: number;
  /** Generation of each account this server holds (see AccountStore.claim). */
  private gens = new Map<string, number>();
  /** Progress not written yet. */
  private pending = new Map<string, PilotSave>();
  /** Progress being written right now: a pilot who comes straight back gets it, not the older row. */
  private inFlight = new Map<string, PilotSave>();
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  /** After failed writes, the periodic flush waits until then (back-off). */
  private retryAt = 0;
  private hashing = new Semaphore(2);
  private closed = false;
  private dummyHash: Promise<string> | null = null;
  /** Another server took this account over: its session here must end without saving. */
  onTakenOver: AccountServiceOptions['onTakenOver'];
  /** Any auth attempt, per address. */
  readonly perAddress: RateLimiter;
  /** Failed logins, per pilot name. */
  readonly perName: RateLimiter;
  /** New accounts, per address. */
  readonly signups: RateLimiter;
  /** New accounts, whole server. */
  readonly signupsTotal: RateLimiter;

  constructor(
    readonly store: AccountStore,
    opts: AccountServiceOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.saveInterval = (opts.saveInterval ?? 5) * 1000;
    this.tokenMs = (opts.tokenDays ?? 30) * 86_400_000;
    this.onTakenOver = opts.onTakenOver;
    const limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.perAddress = new RateLimiter(limits.perMinute, 60_000, this.now);
    this.perName = new RateLimiter(limits.failuresPerName, 10 * 60_000, this.now);
    this.signups = new RateLimiter(limits.signupsPerHour, 60 * 60_000, this.now);
    this.signupsTotal = new RateLimiter(limits.signupsPerHourTotal, 60 * 60_000, this.now);
  }

  /** Connects to the store, retrying in the background (a sleeping database, an outage). Resolves once ready (or closed). */
  start(onReady?: () => void | Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      let attempt = 0;
      const tryInit = async () => {
        if (this.closed) return resolve();
        try {
          await this.store.init();
          if (this.closed) return resolve();
          this.state = 'ready';
          this.log(`accounts: ${this.store.kind} store ready`);
          await onReady?.();
          resolve();
        } catch (e) {
          this.state = 'unavailable';
          const wait = Math.min(60_000, 2000 * 2 ** attempt++);
          this.log(`accounts: store unavailable (${(e as Error).message}), retry in ${Math.round(wait / 1000)} s`);
          setTimeout(tryInit, wait).unref?.();
        }
      };
      tryInit();
      this.timer = setInterval(() => {
        if (this.now() >= this.retryAt) void this.flush();
      }, this.saveInterval);
      this.timer.unref?.();
    });
  }

  async authenticate(req: AuthRequest, address: string): Promise<AuthResult> {
    if (this.state !== 'ready') return fail('unavailable');
    if (!this.perAddress.hit(address)) return fail('limited');
    try {
      if (req.kind === 'register') return await this.register(req.name, req.password, address);
      if (req.kind === 'login') return await this.login(req.name, req.password);
      return await this.tokenLogin(req.token);
    } catch (e) {
      this.log(`accounts: auth error (${(e as Error).message})`);
      return fail('unavailable');
    }
  }

  private async register(rawName: string, password: string, address: string): Promise<AuthResult> {
    const name = checkAccountName(rawName);
    if (!name.ok) return fail('invalid', name.text);
    const weak = checkPassword(password, name.name);
    if (weak) return fail('invalid', weak);
    if (!this.signups.allowed(address)) return fail('limited', 'Trop de comptes créés depuis cette connexion : réessayez plus tard.');
    if (!this.signupsTotal.allowed('*')) return fail('limited', 'Trop de nouveaux comptes en ce moment : réessayez dans un moment.');
    if (await this.store.byKey(name.key)) return fail('taken');
    const hash = await this.hashing.run(() => hashPassword(password));
    const rec = await this.store.create(name.name, name.key, hash);
    if (!rec) return fail('taken');
    this.signups.hit(address);
    this.signupsTotal.hit('*');
    this.log(`accounts: new pilot ${rec.id} "${rec.name}"`);
    return this.open(rec.id, rec.name, true);
  }

  private async login(rawName: string, password: string): Promise<AuthResult> {
    const key = loginKey(rawName);
    if (!this.perName.allowed(key)) return fail('limited');
    const rec = key.length >= 3 && typeof password === 'string' && password.length <= 256 ? await this.store.byKey(key) : null;
    // Same work whether the pilot exists or not: response times do not reveal which names are taken.
    this.dummyHash ??= hashPassword('nebula-frontier-dummy');
    const check = await this.hashing.run(async () => verifyPassword(String(password ?? ''), rec?.passwordHash ?? (await this.dummyHash!)));
    if (!rec || !check.ok) {
      this.perName.hit(key);
      return fail('credentials');
    }
    this.perName.clear(key);
    if (check.rehash) {
      const hash = await this.hashing.run(() => hashPassword(password));
      await this.store.setPasswordHash(rec.id, hash);
    }
    return this.open(rec.id, rec.name, false);
  }

  private async tokenLogin(token: string): Promise<AuthResult> {
    const hash = tokenHash(token);
    const id = await this.store.tokenAccount(hash, this.now());
    const rec = id ? await this.store.byId(id) : null;
    if (!rec) return fail('expired');
    return this.open(rec.id, rec.name, false, { token, hash });
  }

  /** Takes the account for a session here and issues a login token (or extends the one used). */
  private async open(id: string, name: string, isNew: boolean, existing?: { token: string; hash: string }): Promise<AuthResult> {
    const claimed = await this.store.claim(id);
    if (!claimed) return fail('credentials');
    this.gens.set(id, claimed.gen);
    // Progress not yet in the database (waiting or being written) is newer than the row.
    const save = this.pending.get(id) ?? this.inFlight.get(id) ?? claimed.save ?? null;
    const expiresAt = this.now() + this.tokenMs;
    let token: string;
    if (existing) {
      // The client keeps its token; its lifetime slides with use.
      token = existing.token;
      await this.store.extendToken(existing.hash, expiresAt);
    } else {
      token = newToken();
      await this.store.addToken(tokenHash(token), id, expiresAt);
    }
    return { ok: true, profile: { accountId: id, name, save }, token, expiresAt, isNew };
  }

  /** "Changer de compte": the browser's login token stops working (a shared computer keeps no usable session). */
  async revoke(token: string, address: string): Promise<boolean> {
    if (this.state !== 'ready' || !/^[A-Za-z0-9_-]{32,64}$/.test(token) || !this.perAddress.hit(address)) return false;
    try {
      await this.store.deleteToken(tokenHash(token));
      return true;
    } catch (e) {
      this.log(`accounts: sign-out failed (${(e as Error).message})`);
      return false;
    }
  }

  /** Progress reported by the GameServer. `final`: the session ended, write it now. */
  queueSave(accountId: string, save: PilotSave, final: boolean) {
    if (!this.gens.has(accountId)) return;
    this.pending.set(accountId, save);
    if (final && !this.soon) {
      this.soon = setTimeout(() => {
        this.soon = null;
        void this.flush();
      }, 50);
    }
  }

  /** Writes everything pending (one batch). Concurrent calls share the same write. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing.then(() => (this.pending.size ? this.flush() : undefined));
    if (!this.pending.size || this.state !== 'ready') return Promise.resolve();
    const batch = [...this.pending].map(([id, save]) => ({ id, gen: this.gens.get(id) ?? -1, save }));
    this.pending.clear();
    for (const b of batch) this.inFlight.set(b.id, b.save);
    this.flushing = this.store
      .saveProgress(batch)
      .then((refused) => {
        if (this.failures) this.log(`accounts: saves written again after ${this.failures} failure(s)`);
        this.failures = 0;
        this.retryAt = 0;
        for (const id of refused) {
          const entry = batch.find((b) => b.id === id)!;
          if (this.gens.has(id) && this.gens.get(id) !== entry.gen) {
            // Claimed again here meanwhile (the pilot came back): write it with the new generation.
            if (!this.pending.has(id)) this.pending.set(id, entry.save);
            continue;
          }
          this.log(`accounts: pilot ${id} was taken over by another server, its session here ends`);
          this.gens.delete(id);
          this.onTakenOver?.(id);
        }
      })
      .catch((e) => {
        // Keep the progress for the next attempt, unless newer progress arrived meanwhile.
        for (const b of batch) if (!this.pending.has(b.id)) this.pending.set(b.id, b.save);
        this.failures++;
        this.retryAt = this.now() + Math.min(60_000, this.saveInterval * 2 ** Math.min(this.failures, 6));
        if (this.failures % 10 === 1) this.log(`accounts: saving failed (${(e as Error).message}), retrying`);
      })
      .finally(() => {
        for (const b of batch) this.inFlight.delete(b.id);
        this.flushing = null;
      });
    return this.flushing;
  }

  async loadSector(key: string): Promise<unknown> {
    return this.state === 'ready' ? this.store.sector(key) : null;
  }

  async saveSector(key: string, data: unknown) {
    if (this.state !== 'ready') return;
    try {
      await this.store.saveSector(key, data);
    } catch (e) {
      this.log(`accounts: sector save failed (${(e as Error).message})`);
    }
  }

  /** Last writes, then the database connection closes. Never waits more than `timeoutMs`. */
  async close(timeoutMs = 8000) {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    const deadline = this.now() + timeoutMs;
    while (this.pending.size && this.state === 'ready' && this.now() < deadline) {
      await Promise.race([this.flush(), new Promise((r) => setTimeout(r, Math.max(0, deadline - this.now())))]);
      if (this.failures) break;
    }
    if (this.pending.size) this.log(`accounts: ${this.pending.size} pilot save(s) could not be written before shutdown`);
    await this.store.close().catch(() => {});
  }

  get pendingCount() {
    return this.pending.size;
  }
}
