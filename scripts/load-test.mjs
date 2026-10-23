// Load test: N bot pilots over real WebSockets against the real server
// (in this process), flying and shooting for a while with NPC waves on.
// Reports server tick cost and per-client bandwidth.
//   node scripts/load-test.mjs [bots=30] [seconds=40]
import { build } from 'esbuild';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const BOTS = Number(process.argv[2] ?? 30);
const SECONDS = Number(process.argv[3] ?? 40);
fs.mkdirSync('.mp-check', { recursive: true });
await build({ entryPoints: ['src/server/node/server.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: '.mp-check/server.mjs', logLevel: 'warning' });
const { startServer } = await import(pathToFileURL('.mp-check/server.mjs').href);
const server = await startServer({
  port: 0,
  host: '127.0.0.1',
  maxPlayers: Math.max(30, BOTS),
  log: () => {},
  compression: process.env.NO_DEFLATE ? false : undefined,
  // Every bot signs up from 127.0.0.1.
  accountLimits: { perMinute: 10_000, signupsPerHour: 10_000, signupsPerHourTotal: 10_000 },
});
await server.ready;
const game = server.game;
const { protocol } = await (await fetch(`http://127.0.0.1:${server.port}/status`)).json();

// Measure the cost of each simulation tick.
const tickTimes = [];
const tick = game.tick.bind(game);
game.tick = () => {
  const t0 = performance.now();
  tick();
  tickTimes.push(performance.now() - t0);
};

const url = `ws://127.0.0.1:${server.port}/ws`;
const bots = [];
for (let i = 0; i < BOTS; i++) {
  const ws = new WebSocket(url);
  const bot = { ws, raw: 0, frames: 0, seq: 0, phase: Math.random() * 10, wire0: 0, welcomed: false, refused: '' };
  bot.wire = () => ws._socket?.bytesRead ?? 0;
  const name = `Bot ${i + 1}`;
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', version: protocol, auth: { kind: 'register', name, password: `bot-password-${i}` } })));
  ws.on('message', (d) => {
    bot.raw += d.length;
    bot.frames++;
    if (!bot.welcomed && !bot.refused) {
      const text = d.toString();
      if (text.includes('"t":"welcome"')) bot.welcomed = true;
      const err = /"t":"error","code":"(\w+)"/.exec(text);
      if (err) bot.refused = err[1];
    }
  });
  bots.push(bot);
  await new Promise((r) => setTimeout(r, 20));
}
const inputTimer = setInterval(() => {
  const t = performance.now() / 1000;
  for (const b of bots) {
    if (b.ws.readyState !== WebSocket.OPEN) continue;
    const input = {
      throttle: 0.8,
      strafeX: 0,
      strafeY: 0,
      pitch: 0.3 * Math.sin(t * 0.7 + b.phase),
      yaw: 0.5 * Math.sin(t * 0.4 + b.phase),
      roll: 0,
      boost: Math.sin(t * 0.2 + b.phase) > 0.9,
      fire: Math.sin(t * 1.3 + b.phase) > 0,
      flightAssist: true,
    };
    // Real clients send one frame per rendered frame with the ticks it covers; here 2 inputs per ~33 ms.
    b.ws.send(JSON.stringify([{ t: 'input', seq: ++b.seq, input }, { t: 'input', seq: ++b.seq, input }]));
  }
}, 1000 / 30);

const warmup = 5;
await new Promise((r) => setTimeout(r, warmup * 1000));
const joined = bots.filter((b) => b.welcomed).length;
if (joined < BOTS) {
  console.log(`only ${joined}/${BOTS} bots joined (${[...new Set(bots.map((b) => b.refused).filter(Boolean))].join(', ') || 'no error'}): the numbers below would be meaningless`);
  for (const b of bots) b.ws.terminate();
  await server.close();
  process.exit(1);
}
tickTimes.length = 0;
for (const b of bots) {
  b.raw = b.frames = 0;
  b.wire0 = b.wire();
}
const mem0 = process.memoryUsage().heapUsed;
await new Promise((r) => setTimeout(r, SECONDS * 1000));

clearInterval(inputTimer);
const sorted = [...tickTimes].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const avgKBs = bots.reduce((s, b) => s + b.wire() - b.wire0, 0) / bots.length / SECONDS / 1024;
const rawKBs = bots.reduce((s, b) => s + b.raw, 0) / bots.length / SECONDS / 1024;
const ships = game.world.ships.size;
const npcs = [...game.world.ships.values()].filter((s) => !s.ownerId).length;
const result = {
  bots: BOTS,
  seconds: SECONDS,
  ticksPerSecond: +(tickTimes.length / SECONDS).toFixed(1),
  tickMs: { avg: +(tickTimes.reduce((a, b) => a + b, 0) / tickTimes.length).toFixed(3), p50: +pct(0.5).toFixed(3), p99: +pct(0.99).toFixed(3), max: +sorted[sorted.length - 1].toFixed(3) },
  budgetUsedPct: +((tickTimes.reduce((a, b) => a + b, 0) / tickTimes.length / (1000 / 60)) * 100).toFixed(1),
  shipsAtEnd: ships,
  npcsAtEnd: npcs,
  wave: game.wave,
  downPerClientKBs: +avgKBs.toFixed(1),
  uncompressedPerClientKBs: +rawKBs.toFixed(1),
  downTotalMbit: +((avgKBs * bots.length * 8) / 1024).toFixed(1),
  framesPerClientPerSec: +(bots.reduce((s, b) => s + b.frames, 0) / bots.length / SECONDS).toFixed(1),
  heapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
  heapGrowthMB: +((process.memoryUsage().heapUsed - mem0) / 1048576).toFixed(1),
  online: game.onlineCount,
  joined,
};
console.log(JSON.stringify(result, null, 2));
for (const b of bots) b.ws.terminate();
await server.close();
process.exit(0);
