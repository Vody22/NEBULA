import type { PilotSave } from '../../shared/save';

/** One pilot account as stored. `save` is raw: whoever reads it validates it. */
export interface AccountRecord {
  id: string;
  /** Raised each time a session takes the account (see AccountStore.claim). */
  gen: number;
  /** Display name, as registered. */
  name: string;
  /** Lookup key (see nameKey): unique. */
  key: string;
  passwordHash: string;
  save: unknown;
  createdAt: number;
}

/**
 * Where accounts, login tokens and the sector state live. MemoryStore for
 * tests and local runs; PostgresStore online (DATABASE_URL).
 */
export interface AccountStore {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  byKey(key: string): Promise<AccountRecord | null>;
  byId(id: string): Promise<AccountRecord | null>;
  /** Creates an account; null when the name key is taken. */
  create(name: string, key: string, passwordHash: string): Promise<AccountRecord | null>;
  setPasswordHash(id: string, hash: string): Promise<void>;
  /**
   * A game server takes charge of an account for a session: its generation goes
   * up, and saves carrying an older generation (another server, a stale
   * session) are refused from then on. Returns the new generation and the save.
   */
  claim(id: string): Promise<{ gen: number; save: unknown } | null>;
  /** Writes the latest progress of several pilots at once; returns the ids refused (claimed elsewhere since). */
  saveProgress(batch: { id: string; gen: number; save: PilotSave }[]): Promise<string[]>;
  addToken(hash: string, accountId: string, expiresAt: number): Promise<void>;
  /** The account behind a token that has not expired, or null. */
  tokenAccount(hash: string, now: number): Promise<string | null>;
  extendToken(hash: string, expiresAt: number): Promise<void>;
  /** Signs a browser out: its token stops working. */
  deleteToken(hash: string): Promise<void>;
  sector(key: string): Promise<unknown>;
  saveSector(key: string, data: unknown): Promise<void>;
  close(): Promise<void>;
}

/** Login tokens kept per account (one per browser where the pilot stays signed in). */
export const MAX_TOKENS_PER_ACCOUNT = 10;

const clone = <T>(v: T): T => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

/** Everything in memory: lost when the process stops. Tests, local runs, or a server without DATABASE_URL. */
export class MemoryStore implements AccountStore {
  readonly kind = 'memory' as const;
  private accounts = new Map<string, AccountRecord>();
  private keys = new Map<string, string>();
  private tokens = new Map<string, { accountId: string; expiresAt: number; createdAt: number }>();
  private sectors = new Map<string, unknown>();
  private nextId = 1;
  /** Set to make every call fail (tests of a database outage). */
  failing = false;
  /** Calls made, for tests. */
  writes = 0;

  private check() {
    if (this.failing) return Promise.reject(new Error('store unavailable'));
    return Promise.resolve();
  }

  async init() {
    await this.check();
  }

  async byKey(key: string) {
    await this.check();
    const id = this.keys.get(key);
    return id ? clone(this.accounts.get(id)!) : null;
  }

  async byId(id: string) {
    await this.check();
    const a = this.accounts.get(id);
    return a ? clone(a) : null;
  }

  async create(name: string, key: string, passwordHash: string) {
    await this.check();
    if (this.keys.has(key)) return null;
    const rec: AccountRecord = { id: String(this.nextId++), gen: 0, name, key, passwordHash, save: null, createdAt: Date.now() };
    this.accounts.set(rec.id, rec);
    this.keys.set(key, rec.id);
    return clone(rec);
  }

  async setPasswordHash(id: string, hash: string) {
    await this.check();
    const a = this.accounts.get(id);
    if (a) a.passwordHash = hash;
  }

  async claim(id: string) {
    await this.check();
    const a = this.accounts.get(id);
    if (!a) return null;
    a.gen++;
    return { gen: a.gen, save: clone(a.save) };
  }

  async saveProgress(batch: { id: string; gen: number; save: PilotSave }[]) {
    await this.check();
    this.writes++;
    const refused: string[] = [];
    for (const { id, gen, save } of batch) {
      const a = this.accounts.get(id);
      if (a && a.gen === gen) a.save = clone(save);
      else refused.push(id);
    }
    return refused;
  }

  async addToken(hash: string, accountId: string, expiresAt: number) {
    await this.check();
    this.tokens.set(hash, { accountId, expiresAt, createdAt: Date.now() });
    const mine = [...this.tokens].filter(([, t]) => t.accountId === accountId).sort((a, b) => b[1].createdAt - a[1].createdAt);
    for (const [h] of mine.slice(MAX_TOKENS_PER_ACCOUNT)) this.tokens.delete(h);
  }

  async tokenAccount(hash: string, now: number) {
    await this.check();
    const t = this.tokens.get(hash);
    return t && t.expiresAt > now ? t.accountId : null;
  }

  async extendToken(hash: string, expiresAt: number) {
    await this.check();
    const t = this.tokens.get(hash);
    if (t) t.expiresAt = expiresAt;
  }

  async deleteToken(hash: string) {
    await this.check();
    this.tokens.delete(hash);
  }

  async sector(key: string) {
    await this.check();
    return clone(this.sectors.get(key) ?? null);
  }

  async saveSector(key: string, data: unknown) {
    await this.check();
    this.sectors.set(key, clone(data));
  }

  async close() {}
}
