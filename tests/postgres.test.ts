import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from '../src/server/accounts/AccountService';
import { PostgresStore } from '../src/server/accounts/PostgresStore';
import { MAX_TOKENS_PER_ACCOUNT } from '../src/server/accounts/store';
import { SAVE_VERSION, type PilotSave } from '../src/shared/save';
import { noMods } from '../src/shared/sim/upgrades';

/**
 * The PostgreSQL store against a real database. Runs only when
 * TEST_DATABASE_URL points at a disposable database (its nf_* tables are
 * dropped first), e.g. postgres://nebula:nebula-test@127.0.0.1:5432/nebula_test.
 */
const url = process.env.TEST_DATABASE_URL;
const save = (credits: number): PilotSave => ({ v: SAVE_VERSION, credits, cargo: { water: 2 }, kills: 1, deaths: 0, station: 'ferro', hull: 200, ship: 'falcon', fleet: { falcon: { mods: noMods(), hull: 200 } }, missions: [] });

describe.skipIf(!url)('PostgresStore (real database)', () => {
  const stores: PostgresStore[] = [];
  const open = () => {
    const s = new PostgresStore(url!);
    stores.push(s);
    return s;
  };

  beforeAll(async () => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query('DROP TABLE IF EXISTS nf_tokens, nf_pilots, nf_sector, nf_meta CASCADE');
    await c.end();
  });
  afterAll(async () => {
    for (const s of stores) await s.close().catch(() => {});
  });

  it('creates its schema once, even with two servers starting together', async () => {
    const a = open();
    const b = open();
    await Promise.all([a.init(), b.init(), a.init()]);
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const meta = await c.query("SELECT value FROM nf_meta WHERE key = 'schema'");
    const tables = await c.query("SELECT tablename FROM pg_tables WHERE tablename LIKE 'nf_%' ORDER BY tablename");
    await c.end();
    expect(meta.rows).toEqual([{ value: '1' }]);
    expect(tables.rows.map((r) => r.tablename)).toEqual(['nf_meta', 'nf_pilots', 'nf_sector', 'nf_tokens']);
  });

  it('stores pilots with unique keys, claims them and refuses stale saves', async () => {
    const s = open();
    await s.init();
    const rec = await s.create('Kerys', 'kerys', 'hash-1');
    expect(rec).toMatchObject({ name: 'Kerys', key: 'kerys', passwordHash: 'hash-1', gen: 0, save: null });
    expect(rec!.id).toMatch(/^\d+$/);
    expect(await s.create('KERYS', 'kerys', 'hash-2')).toBeNull();
    expect((await s.byKey('kerys'))!.id).toBe(rec!.id);
    expect(await s.byKey('personne')).toBeNull();
    expect(await s.byId('abc')).toBeNull();
    expect(await s.byId('999999')).toBeNull();
    await s.setPasswordHash(rec!.id, 'hash-3');
    expect((await s.byId(rec!.id))!.passwordHash).toBe('hash-3');

    const first = await s.claim(rec!.id);
    expect(first).toEqual({ gen: 1, save: null });
    const other = await s.create('Vale', 'vale', 'h');
    const v = await s.claim(other!.id);
    expect(await s.saveProgress([{ id: rec!.id, gen: 1, save: save(100) }, { id: other!.id, gen: v!.gen, save: save(7) }])).toEqual([]);
    expect((await s.byId(rec!.id))!.save).toEqual(save(100));
    const second = await s.claim(rec!.id); // another session took it
    expect(second).toEqual({ gen: 2, save: save(100) });
    expect(await s.saveProgress([{ id: rec!.id, gen: 1, save: save(1) }, { id: other!.id, gen: v!.gen, save: save(8) }])).toEqual([rec!.id]);
    expect((await s.byId(rec!.id))!.save).toEqual(save(100));
    expect((await s.byId(other!.id))!.save).toEqual(save(8));
    expect(await s.saveProgress([])).toEqual([]);
    expect(await s.claim('424242')).toBeNull();
  });

  it('keeps hashed login tokens with an expiry, at most ten per pilot', async () => {
    const s = open();
    await s.init();
    const rec = (await s.create('Jeton', 'jeton', 'h'))!;
    const now = Date.now();
    await s.addToken('t-old', rec.id, now + 1000);
    expect(await s.tokenAccount('t-old', now)).toBe(rec.id);
    expect(await s.tokenAccount('t-old', now + 1001)).toBeNull();
    await s.extendToken('t-old', now + 86_400_000);
    expect(await s.tokenAccount('t-old', now + 5000)).toBe(rec.id);
    expect(await s.tokenAccount('inconnu', now)).toBeNull();
    await s.addToken('t-gone', rec.id, now + 86_400_000);
    await s.deleteToken('t-gone');
    expect(await s.tokenAccount('t-gone', now)).toBeNull();
    for (let i = 0; i < MAX_TOKENS_PER_ACCOUNT + 2; i++) {
      await s.addToken(`t-${i}`, rec.id, now + 86_400_000);
      await new Promise((r) => setTimeout(r, 2)); // distinct creation times
    }
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const left = await c.query('SELECT token_hash FROM nf_tokens WHERE pilot_id = $1', [rec.id]);
    await c.end();
    expect(left.rows).toHaveLength(MAX_TOKENS_PER_ACCOUNT);
    expect(await s.tokenAccount('t-old', now)).toBeNull(); // the oldest went first
    expect(await s.tokenAccount(`t-${MAX_TOKENS_PER_ACCOUNT + 1}`, now)).toBe(rec.id);
  });

  it('stores the sector state', async () => {
    const s = open();
    await s.init();
    expect(await s.sector('aurora')).toBeNull();
    await s.saveSector('aurora', { v: 1, savedAt: 5, stocks: { aurora: { water: 12.5 } } });
    await s.saveSector('aurora', { v: 1, savedAt: 6, stocks: { aurora: { water: 13 } } });
    expect(await s.sector('aurora')).toEqual({ v: 1, savedAt: 6, stocks: { aurora: { water: 13 } } });
  });

  it('a pilot signs up on one server and finds its progress on the next one (restart)', async () => {
    const one = new AccountService(open());
    await one.start();
    const a = await one.authenticate({ kind: 'register', name: 'Persistant', password: 'mot-de-passe-test' }, '1.2.3.4');
    if (!a.ok) throw new Error(a.text);
    one.queueSave(a.profile.accountId, save(2500), true);
    await one.close();

    const two = new AccountService(open());
    await two.start();
    const b = await two.authenticate({ kind: 'token', token: a.token }, '1.2.3.4');
    if (!b.ok) throw new Error(b.text);
    expect(b.profile).toMatchObject({ accountId: a.profile.accountId, name: 'Persistant', save: save(2500) });
    const c = await two.authenticate({ kind: 'login', name: 'persistant', password: 'mot-de-passe-test' }, '1.2.3.4');
    expect(c.ok).toBe(true);
    await two.close();
  });

  it('reports an unreachable database as unavailable, without crashing', async () => {
    const bad = new PostgresStore('postgres://nebula:mauvais@127.0.0.1:5432/nebula_test');
    await expect(bad.init()).rejects.toThrow();
    await bad.close();
  });
});
