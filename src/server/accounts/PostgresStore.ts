import pg from 'pg';
import type { PilotSave } from '../../shared/save';
import { MAX_TOKENS_PER_ACCOUNT, type AccountRecord, type AccountStore } from './store';

/**
 * Accounts in PostgreSQL (Neon online, any Postgres locally). Tables are
 * prefixed nf_ so the game can share a database. The schema is created and
 * migrated on start, under an advisory lock so two servers starting together
 * (a deploy) do not race.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS nf_pilots (
     id BIGSERIAL PRIMARY KEY,
     name TEXT NOT NULL,
     name_key TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     gen BIGINT NOT NULL DEFAULT 0,
     save JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_login TIMESTAMPTZ
   );
   CREATE TABLE IF NOT EXISTS nf_tokens (
     token_hash TEXT PRIMARY KEY,
     pilot_id BIGINT NOT NULL REFERENCES nf_pilots(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at TIMESTAMPTZ NOT NULL
   );
   CREATE INDEX IF NOT EXISTS nf_tokens_pilot ON nf_tokens (pilot_id, created_at DESC);
   CREATE TABLE IF NOT EXISTS nf_sector (
     key TEXT PRIMARY KEY,
     data JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,
];

interface Row {
  id: string;
  gen: string;
  name: string;
  name_key: string;
  password_hash: string;
  save: unknown;
  created_at: Date;
}

const record = (r: Row): AccountRecord => ({
  id: String(r.id),
  gen: Number(r.gen),
  name: r.name,
  key: r.name_key,
  passwordHash: r.password_hash,
  save: r.save ?? null,
  createdAt: r.created_at.getTime(),
});

const COLUMNS = 'id, gen, name, name_key, password_hash, save, created_at';

export class PostgresStore implements AccountStore {
  readonly kind = 'postgres' as const;
  private pool: pg.Pool;

  constructor(connectionString: string, log: (m: string) => void = () => {}) {
    // No server-side startup parameters (statement_timeout…): Neon's pooled endpoint (PgBouncer) refuses
    // unknown ones. The query timeout is enforced by the client instead.
    this.pool = new pg.Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 30_000,
      // A suspended Neon compute takes a few seconds to wake up.
      connectionTimeoutMillis: 15_000,
      query_timeout: 15_000,
    });
    // An idle connection closed by the database (Neon suspends after 5 min) must not crash the server.
    this.pool.on('error', (err) => log(`database: idle connection lost (${err.message})`));
  }

  async init() {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('nebula-frontier-schema'))");
      await c.query('CREATE TABLE IF NOT EXISTS nf_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const r = await c.query<{ value: string }>("SELECT value FROM nf_meta WHERE key = 'schema'");
      const version = r.rows.length ? Number(r.rows[0].value) : 0;
      for (let v = version; v < MIGRATIONS.length; v++) await c.query(MIGRATIONS[v]);
      await c.query("INSERT INTO nf_meta (key, value) VALUES ('schema', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(Math.max(version, MIGRATIONS.length))]);
      await c.query('DELETE FROM nf_tokens WHERE expires_at < now()');
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async byKey(key: string) {
    const r = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM nf_pilots WHERE name_key = $1`, [key]);
    return r.rows.length ? record(r.rows[0]) : null;
  }

  async byId(id: string) {
    if (!/^\d{1,18}$/.test(id)) return null;
    const r = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM nf_pilots WHERE id = $1`, [id]);
    return r.rows.length ? record(r.rows[0]) : null;
  }

  async create(name: string, key: string, passwordHash: string) {
    const r = await this.pool.query<Row>(
      `INSERT INTO nf_pilots (name, name_key, password_hash) VALUES ($1, $2, $3) ON CONFLICT (name_key) DO NOTHING RETURNING ${COLUMNS}`,
      [name, key, passwordHash],
    );
    return r.rows.length ? record(r.rows[0]) : null;
  }

  async setPasswordHash(id: string, hash: string) {
    await this.pool.query('UPDATE nf_pilots SET password_hash = $2 WHERE id = $1', [id, hash]);
  }

  async claim(id: string) {
    const r = await this.pool.query<{ gen: string; save: unknown }>('UPDATE nf_pilots SET gen = gen + 1, last_login = now() WHERE id = $1 RETURNING gen, save', [id]);
    return r.rows.length ? { gen: Number(r.rows[0].gen), save: r.rows[0].save ?? null } : null;
  }

  async saveProgress(batch: { id: string; gen: number; save: PilotSave }[]) {
    if (!batch.length) return [];
    // One statement for the whole batch; a row only takes the save if its generation still matches.
    const r = await this.pool.query<{ id: string }>(
      `UPDATE nf_pilots AS p SET save = v.save::jsonb, updated_at = now()
         FROM unnest($1::bigint[], $2::bigint[], $3::text[]) AS v(id, gen, save)
        WHERE p.id = v.id AND p.gen = v.gen
        RETURNING p.id`,
      [batch.map((b) => b.id), batch.map((b) => b.gen), batch.map((b) => JSON.stringify(b.save))],
    );
    const done = new Set(r.rows.map((x) => String(x.id)));
    return batch.filter((b) => !done.has(b.id)).map((b) => b.id);
  }

  async addToken(hash: string, accountId: string, expiresAt: number) {
    await this.pool.query('INSERT INTO nf_tokens (token_hash, pilot_id, expires_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))', [hash, accountId, expiresAt]);
    await this.pool.query(
      `DELETE FROM nf_tokens WHERE pilot_id = $1 AND token_hash NOT IN (
         SELECT token_hash FROM nf_tokens WHERE pilot_id = $1 ORDER BY created_at DESC LIMIT $2)`,
      [accountId, MAX_TOKENS_PER_ACCOUNT],
    );
  }

  async tokenAccount(hash: string, now: number) {
    const r = await this.pool.query<{ pilot_id: string }>('SELECT pilot_id FROM nf_tokens WHERE token_hash = $1 AND expires_at > to_timestamp($2 / 1000.0)', [hash, now]);
    return r.rows.length ? String(r.rows[0].pilot_id) : null;
  }

  async extendToken(hash: string, expiresAt: number) {
    await this.pool.query('UPDATE nf_tokens SET expires_at = to_timestamp($2 / 1000.0) WHERE token_hash = $1', [hash, expiresAt]);
  }

  async deleteToken(hash: string) {
    await this.pool.query('DELETE FROM nf_tokens WHERE token_hash = $1', [hash]);
  }

  async sector(key: string) {
    const r = await this.pool.query<{ data: unknown }>('SELECT data FROM nf_sector WHERE key = $1', [key]);
    return r.rows.length ? r.rows[0].data : null;
  }

  async saveSector(key: string, data: unknown) {
    await this.pool.query(
      'INSERT INTO nf_sector (key, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
      [key, JSON.stringify(data)],
    );
  }

  async close() {
    await this.pool.end();
  }
}
