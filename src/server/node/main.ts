import { startServer } from './server';

// Configuration comes from the environment (see .env.example / docs/DEPLOIEMENT.md).
const env = process.env;
const int = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d);

const server = await startServer({
  port: int(env.PORT, 8080),
  host: env.HOST ?? '0.0.0.0',
  allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(','),
  maxPlayers: int(env.MAX_PLAYERS, 30),
  seed: int(env.SECTOR_SEED, 1337),
  snapshotEvery: Math.max(1, Math.min(6, int(env.SNAPSHOT_EVERY, 3))),
  staticDir: env.STATIC_DIR ?? 'dist',
  reconnectGrace: int(env.RECONNECT_GRACE, 20),
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`${sig}: closing`);
    server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
