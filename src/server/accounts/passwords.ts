import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt (memory-hard, built into Node). The cost is set
 * for the free server (a tenth of a CPU): about 50 ms of one core per hash. It
 * runs on the libuv thread pool, so the game loop keeps ticking meanwhile.
 * The parameters are stored in each hash, so they can be raised later: a
 * login with older parameters reports `rehash` and the caller stores a new hash.
 */
export const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;
const PREFIX = 'scrypt';

function derive(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  const opts: ScryptOptions = { N, r, p, maxmem: 256 * N * r + 1024 * 1024 };
  return new Promise((resolve, reject) => scrypt(password.normalize('NFC'), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

/** "scrypt$N$r$p$salt$hash" (salt and hash in base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return [PREFIX, SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Checks a password against a stored hash in constant time. A malformed hash never matches. */
export async function verifyPassword(password: string, stored: string): Promise<{ ok: boolean; rehash: boolean }> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return { ok: false, rehash: false };
  const [N, r, p] = parts.slice(1, 4).map(Number);
  // Refuse absurd parameters from a tampered row instead of allocating gigabytes.
  if (![N, r, p].every(Number.isInteger) || N < 1024 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16 || 128 * N * r > 64 * 1024 * 1024) return { ok: false, rehash: false };
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (salt.length < 8 || expected.length < 16 || expected.length > 64) return { ok: false, rehash: false };
  const key = await derive(password, salt, N, r, p, expected.length);
  const ok = timingSafeEqual(key, expected);
  return { ok, rehash: ok && (N !== SCRYPT.N || r !== SCRYPT.r || p !== SCRYPT.p || expected.length !== SCRYPT.keylen) };
}

/** A login token: 32 random bytes, sent once to the client. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored hashed: a leaked database does not give live sessions away. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
