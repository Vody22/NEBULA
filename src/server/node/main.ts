import { AccountService } from '../accounts/AccountService';
import { PostgresStore } from '../accounts/PostgresStore';
import { MemoryStore } from '../accounts/store';
import { startServer } from './server';

// Configuration comes from the environment (see .env.example / docs/DEPLOIEMENT.md).
const env = process.env;
const int = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d);
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

// Pilot accounts live in PostgreSQL (Neon) when DATABASE_URL is set; otherwise in memory, lost on restart.
const databaseUrl = env.DATABASE_URL?.trim();
if (!databaseUrl) log('WARNING: DATABASE_URL is not set. Pilot accounts are kept in memory and lost when the server restarts.');
const accounts = new AccountService(databaseUrl ? new PostgresStore(databaseUrl, log) : new MemoryStore(), { log });

const server = await startServer({
  port: int(env.PORT, 8080),
  host: env.HOST ?? '0.0.0.0',
  allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(','),
  maxPlayers: int(env.MAX_PLAYERS, 30),
  seed: int(env.SECTOR_SEED, 1337),
  snapshotEvery: Math.max(1, Math.min(6, int(env.SNAPSHOT_EVERY, 3))),
  staticDir: env.STATIC_DIR ?? 'dist',
  reconnectGrace: int(env.RECONNECT_GRACE, 20),
  accounts,
  log,
});

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: saving pilots, then closing`);
    // Render waits up to 30 s after SIGTERM; the saves get at most 10 s.
    setTimeout(() => process.exit(0), 12_000).unref();
    server.close().then(
      () => process.exit(0),
      (e) => {
        log(`shutdown error: ${(e as Error).message}`);
        process.exit(1);
      },
    );
  });
}
