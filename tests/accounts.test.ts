import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccountService } from '../src/server/accounts/AccountService';
import { hashPassword, newToken, tokenHash, verifyPassword } from '../src/server/accounts/passwords';
import { MemoryStore } from '../src/server/accounts/store';
import { checkAccountName, checkPassword, loginKey, nameKey } from '../src/shared/accounts';
import type { AuthRequest } from '../src/shared/net/protocol';
import { SAVE_VERSION, type PilotSave } from '../src/shared/save';
import { STARTING_CREDITS } from '../src/server/GameServer';

const PASSWORD = 'mot-de-passe-test';
const save = (credits: number, extra: Partial<PilotSave> = {}): PilotSave => ({ v: SAVE_VERSION, credits, cargo: {}, kills: 0, deaths: 0, station: 'aurora', hull: 260, ...extra });
const register = (name: string, password = PASSWORD): AuthRequest => ({ kind: 'register', name, password });
const login = (name: string, password = PASSWORD): AuthRequest => ({ kind: 'login', name, password });

/** An account service on a fresh memory store, with a clock the test moves. */
async function service(opts: ConstructorParameters<typeof AccountService>[1] = {}, store = new MemoryStore()) {
  const clock = { t: Date.UTC(2026, 9, 23) };
  const svc = new AccountService(store, { now: () => clock.t, saveInterval: 3600, ...opts });
  await svc.start();
  return { svc, store, clock };
}

async function ok(p: ReturnType<AccountService['authenticate']>) {
  const r = await p;
  if (!r.ok) throw new Error(`auth failed: ${r.reason} ${r.text}`);
  return r;
}

async function refused(p: ReturnType<AccountService['authenticate']>) {
  const r = await p;
  if (r.ok) throw new Error('auth should have failed');
  return r;
}

describe('passwords', () => {
  it('hashes with a random salt and checks in constant time', async () => {
    const a = await hashPassword('Étoile filante 42');
    const b = await hashPassword('Étoile filante 42');
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('Étoile filante 42', a)).toEqual({ ok: true, rehash: false });
    // The same text typed with a decomposed accent is the same password.
    expect((await verifyPassword('Étoile filante 42', a)).ok).toBe(true);
    expect((await verifyPassword('étoile filante 42', a)).ok).toBe(false);
    expect((await verifyPassword('', a)).ok).toBe(false);
  });

  it('never matches a malformed or tampered hash, and refuses absurd costs without trying them', async () => {
    const good = await hashPassword(PASSWORD);
    const parts = good.split('$');
    const variants = [
      '',
      'scrypt',
      'bcrypt$16384$8$1$' + parts.slice(4).join('$'),
      [parts[0], 2 ** 30, ...parts.slice(2)].join('$'), // gigabytes of memory
      [parts[0], 10000, ...parts.slice(2)].join('$'), // not a power of two
      [parts[0], parts[1], 0, ...parts.slice(3)].join('$'),
      [parts[0], parts[1], 64, ...parts.slice(3)].join('$'),
      [...parts.slice(0, 4), 'AA', parts[5]].join('$'), // salt too short
      [...parts.slice(0, 5), 'AAAA'].join('$'), // hash too short
      [...parts.slice(0, 5), parts[5].slice(0, -2) + (parts[5].endsWith('A') ? 'BB' : 'AA')].join('$'),
    ];
    const t0 = Date.now();
    for (const v of variants) expect(await verifyPassword(PASSWORD, v)).toEqual({ ok: false, rehash: false });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('asks for a rehash when a hash was made with other parameters', async () => {
    const salt = randomBytes(16);
    const key = scryptSync(PASSWORD, salt, 32, { N: 1024, r: 8, p: 1 });
    const old = ['scrypt', 1024, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
    expect(await verifyPassword(PASSWORD, old)).toEqual({ ok: true, rehash: true });
    expect(await verifyPassword('autre-mot-de-passe', old)).toEqual({ ok: false, rehash: false });
  });

  it('makes long random login tokens, stored only as their hash', () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(t);
    expect(tokenHash(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash(t)).toBe(tokenHash(t));
    expect(tokenHash(t)).not.toContain(t);
  });
});

describe('account names and passwords', () => {
  it('accepts Latin names with accents, spaces and . _ \' -, folded to one key', () => {
    expect(checkAccountName('Kerys')).toEqual({ ok: true, name: 'Kerys', key: 'kerys' });
    expect(checkAccountName("  Élodie   d'Arc ")).toEqual({ ok: true, name: "Élodie d'Arc", key: "élodie d'arc" });
    expect(checkAccountName('Nova_7.x-2')).toMatchObject({ ok: true });
    // Full-width letters, case and spacing all lead to the same account.
    expect(nameKey('ＫＥＲＹＳ')).toBe('kerys');
    expect(loginKey('  KERYS ')).toBe('kerys');
    expect(loginKey("E\u0301lodie  d'Arc")).toBe("élodie d'arc"); // decomposed accent, double space
  });

  it('refuses short, long, foreign-script, symbol and reserved names with a reason', () => {
    const text = (n: string) => {
      const r = checkAccountName(n);
      return r.ok ? '' : r.text;
    };
    expect(text('Ka')).toMatch(/3 à 16/);
    expect(text('Un pseudo bien trop long')).toMatch(/3 à 16/); // never cut silently
    expect(text('Кerys')).toMatch(/lettres/); // Cyrillic К looks like a Latin K
    expect(text('Kerys 🚀')).toMatch(/lettres/);
    expect(text('-Kerys')).toMatch(/lettres/);
    expect(text('<b>Kerys</b>')).toMatch(/lettres/);
    for (const n of ['Pilote', 'SYSTÈME', 'Admin', 'Nebula', 'Vous', 'Garde-3', 'Raider 2', 'marauder-1A']) expect(text(n)).toMatch(/réservé/);
    expect(text('Gardenia')).toBe('');
  });

  it('wants passwords of 8 to 128 characters that are not the name', () => {
    expect(checkPassword('court')).toMatch(/au moins 8/);
    expect(checkPassword('x'.repeat(129))).toMatch(/au plus 128/);
    expect(checkPassword('Kerys Vale', 'kerys  vale')).toMatch(/pseudo/);
    expect(checkPassword(12345678)).toMatch(/au moins/);
    expect(checkPassword('huit car')).toBeNull();
  });
});

describe('AccountService', () => {
  it('signs up, logs in by password or token, and keeps names unique whatever the case', async () => {
    const { svc } = await service();
    const a = await ok(svc.authenticate(register('Kerys'), '1.1.1.1'));
    expect(a).toMatchObject({ isNew: true, profile: { name: 'Kerys', save: null } });
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await refused(svc.authenticate(register('KERYS'), '1.1.1.1'))).reason).toBe('taken');
    const b = await ok(svc.authenticate(login(' kerys '), '1.1.1.1'));
    expect(b).toMatchObject({ isNew: false, profile: { accountId: a.profile.accountId, name: 'Kerys' } });
    expect(b.token).not.toBe(a.token);
    const c = await ok(svc.authenticate({ kind: 'token', token: a.token }, '1.1.1.1'));
    expect(c.profile.accountId).toBe(a.profile.accountId);
    expect(c.token).toBe(a.token);
    const bad = await refused(svc.authenticate(login('Kerys', 'pas-le-bon'), '1.1.1.1'));
    const nobody = await refused(svc.authenticate(login('Personne'), '1.1.1.1'));
    expect(bad).toEqual(nobody); // the answer does not reveal which names exist
    expect(bad.reason).toBe('credentials');
    expect((await refused(svc.authenticate({ kind: 'token', token: newToken() }, '1.1.1.1'))).reason).toBe('expired');
  });

  it('signing out revokes the browser token; the password still works', async () => {
    const { svc } = await service();
    const a = await ok(svc.authenticate(register('Partagé'), 'x'));
    const other = await ok(svc.authenticate(login('Partagé'), 'x')); // another browser
    expect(await svc.revoke(a.token, 'x')).toBe(true);
    expect((await refused(svc.authenticate({ kind: 'token', token: a.token }, 'x'))).reason).toBe('expired');
    await ok(svc.authenticate({ kind: 'token', token: other.token }, 'x')); // only that browser is signed out
    expect(await svc.revoke('pas un jeton', 'x')).toBe(false);
    await ok(svc.authenticate(login('Partagé'), 'x'));
  });

  it('login tokens last 30 days, sliding with each use', async () => {
    const { svc, clock } = await service();
    const a = await ok(svc.authenticate(register('Voyageur'), 'x'));
    expect(a.expiresAt).toBe(clock.t + 30 * 86_400_000);
    clock.t += 20 * 86_400_000;
    const b = await ok(svc.authenticate({ kind: 'token', token: a.token }, 'x'));
    expect(b.expiresAt).toBe(clock.t + 30 * 86_400_000);
    clock.t += 29 * 86_400_000; // 49 days after sign-up, 29 after the last use
    await ok(svc.authenticate({ kind: 'token', token: a.token }, 'x'));
    clock.t += 31 * 86_400_000;
    expect((await refused(svc.authenticate({ kind: 'token', token: a.token }, 'x'))).reason).toBe('expired');
    // The password still works, with a new token.
    await ok(svc.authenticate(login('Voyageur'), 'x'));
  });

  it('slows down password guessing per name and per address, and limits sign-ups', async () => {
    const { svc, clock } = await service({ limits: { perMinute: 1000, failuresPerName: 3, signupsPerHour: 2, signupsPerHourTotal: 3 } });
    const { token } = await ok(svc.authenticate(register('Cible'), 'a'));
    for (let i = 0; i < 3; i++) expect((await refused(svc.authenticate(login('Cible', `essai-${i}-xx`), `10.0.0.${i}`))).reason).toBe('credentials');
    // Locked for that name, even with the right password and from elsewhere...
    expect((await refused(svc.authenticate(login('CIBLE'), 'b'))).reason).toBe('limited');
    // ...but a browser that kept its token still gets in, and the lock lifts after 10 minutes.
    await ok(svc.authenticate({ kind: 'token', token }, 'a'));
    clock.t += 10 * 60_000 + 1;
    await ok(svc.authenticate(login('Cible'), 'b'));

    await ok(svc.authenticate(register('Second'), 'a'));
    expect((await refused(svc.authenticate(register('Troisième'), 'a'))).text).toMatch(/depuis cette connexion/);
    await ok(svc.authenticate(register('Autre'), 'c'));
    expect((await refused(svc.authenticate(register('Encore'), 'd'))).text).toMatch(/en ce moment/); // 3 per hour in all
    clock.t += 60 * 60_000 + 1;
    await ok(svc.authenticate(register('Encore'), 'd'));

    const { svc: tight } = await service({ limits: { perMinute: 2 } });
    await refused(tight.authenticate(login('Qui'), 'e'));
    await refused(tight.authenticate(login('Quoi'), 'e'));
    expect((await refused(tight.authenticate(login('Ou'), 'e'))).reason).toBe('limited');
    expect((await refused(tight.authenticate(login('Ou'), 'f'))).reason).toBe('credentials');
  });

  it('refuses logins while the store is unreachable instead of failing later', async () => {
    const store = new MemoryStore();
    const svc = new AccountService(store);
    expect((await refused(svc.authenticate(register('Tôt'), 'a'))).reason).toBe('unavailable'); // not started
    await svc.start();
    store.failing = true;
    const r = await refused(svc.authenticate(register('Panne'), 'a'));
    expect(r.reason).toBe('unavailable');
    expect(r.text).toMatch(/solo/);
    store.failing = false;
    await ok(svc.authenticate(register('Panne'), 'a'));
    await svc.close();
  });

  it('writes progress in one batch, keeps it through an outage, and ignores unknown accounts', async () => {
    const { svc, store } = await service();
    const a = await ok(svc.authenticate(register('Mineur'), 'a'));
    const b = await ok(svc.authenticate(register('Pilote Deux'), 'a'));
    const ida = a.profile.accountId;
    const idb = b.profile.accountId;
    svc.queueSave(ida, save(100), false);
    svc.queueSave(ida, save(150), false); // only the latest is written
    svc.queueSave(idb, save(900), false);
    svc.queueSave('999', save(1e6), false); // not claimed here
    expect(svc.pendingCount).toBe(2);
    const writes = store.writes;
    await svc.flush();
    expect(store.writes).toBe(writes + 1);
    expect((await store.byId(ida))!.save).toMatchObject({ credits: 150 });
    expect((await store.byId(idb))!.save).toMatchObject({ credits: 900 });
    expect(await store.byId('999')).toBeNull();

    store.failing = true;
    svc.queueSave(ida, save(200), false);
    await svc.flush();
    expect(svc.pendingCount).toBe(1); // kept for the next attempt
    svc.queueSave(ida, save(250), false);
    store.failing = false;
    await svc.flush();
    expect(svc.pendingCount).toBe(0);
    expect((await store.byId(ida))!.save).toMatchObject({ credits: 250 });
  });

  it('a pilot who leaves is written at once (final save), without waiting for the batch', async () => {
    const { svc, store } = await service({ now: Date.now });
    const a = await ok(svc.authenticate(register('Pressé'), 'a'));
    svc.queueSave(a.profile.accountId, save(321), true);
    await new Promise((r) => setTimeout(r, 120));
    expect((await store.byId(a.profile.accountId))!.save).toMatchObject({ credits: 321 });
  });

  it('a pilot coming straight back gets the progress not yet written, and it is written later', async () => {
    const { svc, store } = await service();
    const a = await ok(svc.authenticate(register('Rapide'), 'a'));
    const id = a.profile.accountId;
    svc.queueSave(id, save(777), true);
    // Back before the write: the newer progress wins over the database row.
    const b = await ok(svc.authenticate({ kind: 'token', token: a.token }, 'a'));
    expect(b.profile.save).toMatchObject({ credits: 777 });
    await svc.flush();
    expect((await store.byId(id))!.save).toMatchObject({ credits: 777 });
  });

  it('a write overtaken by our own new login is written again with the new generation', async () => {
    let release = () => {};
    class SlowStore extends MemoryStore {
      gate: Promise<void> | null = null;
      override async saveProgress(batch: Parameters<MemoryStore['saveProgress']>[0]) {
        if (this.gate) await this.gate;
        return super.saveProgress(batch);
      }
    }
    const store = new SlowStore();
    const { svc } = await service({}, store);
    const a = await ok(svc.authenticate(register('Retour'), 'a'));
    const id = a.profile.accountId;
    svc.queueSave(id, save(500), false);
    store.gate = new Promise((r) => (release = r));
    const writing = svc.flush(); // held back by the gate, with generation 1
    const b = await ok(svc.authenticate(login('Retour'), 'a')); // claims generation 2 meanwhile
    expect(b.profile.save).toMatchObject({ credits: 500 }); // the save being written
    store.gate = null;
    release();
    await writing; // refused (old generation) but ours: queued again
    expect(svc.pendingCount).toBe(1);
    await svc.flush();
    expect((await store.byId(id))!.save).toMatchObject({ credits: 500 });
  });

  it('when another server takes a pilot over, this one stops writing it and ends its session', async () => {
    const store = new MemoryStore();
    const taken: string[] = [];
    const { svc: here } = await service({ onTakenOver: (id) => taken.push(id) }, store);
    const { svc: there } = await service({}, store);
    const a = await ok(here.authenticate(register('Nomade'), 'a'));
    const id = a.profile.accountId;
    here.queueSave(id, save(100), false);
    await here.flush();
    const b = await ok(there.authenticate(login('Nomade'), 'b'));
    expect(b.profile.save).toMatchObject({ credits: 100 });
    there.queueSave(id, save(5000), false);
    await there.flush();
    here.queueSave(id, save(1), false); // a stale session must not overwrite the newer progress
    await here.flush();
    expect(taken).toEqual([id]);
    expect((await store.byId(id))!.save).toMatchObject({ credits: 5000 });
    here.queueSave(id, save(2), false);
    expect(here.pendingCount).toBe(0); // no longer ours
  });

  it('rehashes an old password hash on login', async () => {
    const { svc, store } = await service();
    const a = await ok(svc.authenticate(register('Ancien'), 'a'));
    const salt = randomBytes(16);
    const key = scryptSync(PASSWORD, salt, 32, { N: 1024, r: 8, p: 1 });
    await store.setPasswordHash(a.profile.accountId, ['scrypt', 1024, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$'));
    await ok(svc.authenticate(login('Ancien'), 'a'));
    expect((await store.byId(a.profile.accountId))!.passwordHash).toMatch(/^scrypt\$16384\$/);
    await ok(svc.authenticate(login('Ancien'), 'a'));
  });

  it('close() writes what is pending before closing the store', async () => {
    const { svc, store } = await service({ now: Date.now });
    const a = await ok(svc.authenticate(register('Dernier'), 'a'));
    svc.queueSave(a.profile.accountId, save(42), false);
    await svc.close();
    expect((await store.byId(a.profile.accountId))!.save).toMatchObject({ credits: 42 });
    expect(STARTING_CREDITS).toBeGreaterThan(42);
  });
});
