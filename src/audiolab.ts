import { GameAudio, type AudioFrame, type OwnShipAudio, type UiSound } from './client/audio/Audio';
import type { Vec3 } from './client/audio/AudioEngine';
import { RECIPES, type SoundId } from './client/audio/recipes';

/**
 * Audio lab (audio-lab.html, dev server only): plays scripted scenes through
 * the game's real audio code, without the 3D renderer, so each system can be
 * heard alone and recorded (scripts/audio-check.mjs exports them as WAV).
 * The scenes drive GameAudio exactly as Game.ts does: a frame of state 60
 * times a second, plus gameplay events at given times.
 */

interface Scene {
  id: string;
  label: string;
  duration: number;
  frame(t: number): Partial<AudioFrame> & { ship?: Partial<OwnShipAudio> | null };
  events: [number, (a: GameAudio) => void][];
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const every = (from: number, to: number, step: number, fn: (a: GameAudio, i: number) => void): [number, (a: GameAudio) => void][] => {
  const out: [number, (a: GameAudio) => void][] = [];
  for (let t = from, i = 0; t < to; t += step, i++) {
    const k = i;
    out.push([t, (a) => fn(a, k)]);
  }
  return out;
};
const circle = (t: number, r: number, speed: number, phase: number, y = 0) => v(Math.cos(t * speed + phase) * r, y, -Math.abs(Math.sin(t * speed + phase)) * r - 80);

const SCENES: Scene[] = [
  {
    id: '01-espace-profond',
    label: 'Espace profond, au ralenti (musique exploration, silence)',
    duration: 12,
    frame: () => ({ ship: { throttle: 0.05 } }),
    events: [],
  },
  {
    id: '02-acceleration-boost',
    label: 'Accélération, boost, propulseurs latéraux, décélération',
    duration: 14,
    frame: (t) => ({
      ship: {
        throttle: t < 1 ? 0 : t < 4 ? (t - 1) / 3 : t < 11 ? 1 : 0.1,
        speed: t < 4 ? Math.max(0, (t - 1) / 3) : t < 9 ? 1 + Math.min(0.5, (t - 5) * 0.2) : 0.6,
        boosting: t > 5 && t < 8.5,
        thrusters: t > 11.5 && t < 13.5 ? 0.8 : 0,
      },
      speed: 120,
    }),
    events: [],
  },
  {
    id: '03-cameras',
    label: 'Même poussée vue de la caméra poursuite, proche (cockpit), cinématique',
    duration: 10,
    frame: (t) => ({ ship: { throttle: 0.7, speed: 0.7 }, view: t < 3.3 ? 'chase' : t < 6.6 ? 'close' : 'cinematic' }),
    events: [],
  },
  {
    id: '04-combat',
    label: 'Combat contre deux pirates : tirs, boucliers qui tombent, coque touchée, cibles détruites',
    duration: 17,
    frame: (t) => ({
      ship: { throttle: 0.6, speed: 0.6, shield: Math.max(0, 100 - Math.max(0, t - 2) * 16), hull: t < 8 ? 100 : Math.max(40, 100 - (t - 8) * 7) },
      hostilesFar: t < 15 ? 2 : 1,
      hostilesNear: t < 15 ? 2 : 1,
      nearestHostile: 300,
      others: [
        { id: 1, at: circle(t, 220, 0.6, 0), raider: true, throttle: 0.8, boosting: false },
        { id: 2, at: circle(t, 320, -0.45, 2), raider: true, throttle: 0.9, boosting: t > 6 && t < 8 },
      ],
    }),
    events: [
      ...every(1, 7, 0.2, (a) => a.shot(v(0, 0, -2), 'falcon', true)),
      ...every(9, 14, 0.2, (a) => a.shot(v(0, 0, -2), 'falcon', true)),
      ...every(1.2, 7, 0.4, (a, i) => a.hitMarker(i < 8)),
      ...every(1.5, 15, 0.45, (a, i) => a.shot(circle(1.5 + i * 0.45, 220, 0.6, 0), 'raider', false)),
      ...every(2.5, 7.5, 0.6, (a) => a.hit(v(0, 0, 0), true, true, 8)),
      ...every(8.2, 14, 0.7, (a) => a.hit(v(0, 0, 0), false, true, 9)),
      [8, (a) => a.explosion(v(160, 10, -300), 'raider', false, true)],
      [14.5, (a) => a.explosion(v(-200, -20, -380), 'raider', false, true)],
    ],
  },
  {
    id: '05-boss-marauder',
    label: 'Marauder (boss) : tirs lourds, impacts sur sa coque, grosse explosion',
    duration: 13,
    frame: (t) => ({
      ship: { throttle: 0.5, speed: 0.5, shield: 0, hull: 40 },
      hostilesFar: t < 10 ? 1 : 0,
      hostilesNear: t < 10 ? 1 : 0,
      nearestHostile: 350,
      boss: t < 10,
      others: t < 10 ? [{ id: 3, at: v(60, 40, -350), raider: true, throttle: 0.6, boosting: false }] : [],
    }),
    events: [
      ...every(0.5, 9.5, 0.6, (a) => a.shot(v(60, 40, -350), 'marauder', false)),
      ...every(1, 9.5, 0.25, (a) => a.shot(v(0, 0, -2), 'falcon', true)),
      ...every(1.1, 9.5, 0.5, (a, i) => a.hit(v(60, 40, -340), i < 8, false, 10)),
      [9.8, (a) => a.explosion(v(60, 40, -350), 'marauder', false, true)],
    ],
  },
  {
    id: '06-victoire-retour-au-calme',
    label: 'Fin du combat : résolution musicale, puis retour au calme',
    duration: 16,
    frame: () => ({ ship: { throttle: 0.3, speed: 0.3, shield: 30, hull: 40 } }),
    events: [],
  },
  {
    id: '07-asteroides-minage',
    label: 'Champ d’astéroïdes à vive allure (alerte de proximité), puis minage',
    duration: 12,
    frame: (t) => ({
      ship: { throttle: t < 7 ? 0.8 : 0, speed: t < 7 ? 0.9 : 0.05, mining: t > 7.5 ? 1 : 0, shield: 60, hull: 40 },
      asteroidDist: t < 7 ? Math.max(40, 400 - t * 60) : 30,
      speed: t < 7 ? 160 : 5,
    }),
    events: [],
  },
  {
    id: '08-approche-station',
    label: 'Approche de la station : trafic radio, machinerie, un vaisseau qui passe',
    duration: 12,
    frame: (t) => ({
      ship: { throttle: 0.3, speed: 0.3, shield: 100, hull: 40 },
      stationDist: Math.max(60, 1600 - t * 140),
      others: [{ id: 4, at: v(-300 + t * 50, 20, -120), raider: false, throttle: 0.7, boosting: false }],
    }),
    events: [],
  },
  {
    id: '09-hangar',
    label: 'Amarrage puis hangar : réverbération, annonces, achats, réparation, amélioration, contrat',
    duration: 16,
    frame: (t) => (t < 1 ? { ship: { throttle: 0.1, speed: 0.1, hull: 40 }, stationDist: 30 } : { docked: true, ship: null, stationDist: 0 }),
    events: [
      [1, (a) => a.alert('docked')],
      [4, (a) => (a.ui('click'), a.ui('purchase'))],
      [6, (a) => (a.ui('click'), a.ui('repair'))],
      [8, (a) => (a.ui('tab'), a.ui('upgrade'))],
      [10, (a) => (a.ui('click'), a.ui('mission'))],
      [12.5, (a) => a.alert('contractDone')],
    ],
  },
  {
    id: '10-interface',
    label: 'Sons d’interface un par un',
    duration: 9,
    frame: () => ({ docked: true, ship: null, stationDist: 0 }),
    events: (['click', 'tab', 'confirm', 'deny', 'notify', 'lock', 'comms', 'mission', 'repair', 'upgrade', 'purchase'] as UiSound[]).map((k, i) => [0.5 + i * 0.75, (a) => a.ui(k)]),
  },
  {
    id: '11-collision-destruction',
    label: 'Décollage, collision, puis destruction de notre vaisseau',
    duration: 11,
    frame: (t) => (t < 6 ? { ship: { throttle: 0.6, speed: 0.6, shield: 0, hull: t < 3 ? 40 : 15 } } : { ship: null }),
    events: [
      [3, (a) => a.collision(v(0, 0, -5), 22, true)],
      [6, (a) => a.explosion(v(0, 0, 0), 'falcon', true, false)],
    ],
  },
];

const BASE_SHIP: OwnShipAudio = { throttle: 0, speed: 0, boosting: false, thrusters: 0, energy: 1, shield: 100, shieldMax: 100, hull: 100, hullMax: 100, weaponsLocked: false, mining: 0 };

const audio = new GameAudio();
const statsEl = document.getElementById('stats')!;
let current: { scene: Scene; t0: number; fired: number } | null = null;
/** Between scenes, the state of the last one holds (no jump to another place). */
let idle: ReturnType<Scene['frame']> = { ship: { throttle: 0.05 } };
let last = performance.now();

function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const c = current;
  const t = c ? (now - c.t0) / 1000 : 0;
  const o = c ? c.scene.frame(Math.min(t, c.scene.duration)) : idle;
  if (c) idle = o;
  const ship = o.ship === null ? null : { ...BASE_SHIP, ...(o.ship ?? {}) };
  const frame: AudioFrame = {
    dt,
    listener: { pos: v(0, 0, 0), fwd: v(0, 0, -1), up: v(0, 1, 0) },
    docked: o.docked ?? false,
    me: ship,
    view: o.view ?? 'chase',
    stationDist: o.stationDist ?? 6000,
    asteroidDist: o.asteroidDist ?? 3000,
    speed: o.speed ?? (ship ? ship.speed * 100 : 0),
    hostilesFar: o.hostilesFar ?? 0,
    hostilesNear: o.hostilesNear ?? 0,
    nearestHostile: o.nearestHostile ?? Infinity,
    boss: o.boss ?? false,
    others: o.others ?? [],
  };
  audio.frame(frame);
  if (c) {
    const ev = c.scene.events.slice().sort((x, y) => x[0] - y[0]);
    while (c.fired < ev.length && ev[c.fired][0] <= t) ev[c.fired++][1](audio);
    if (t >= c.scene.duration) current = null;
  }
  statsEl.textContent = JSON.stringify(audio.report(), null, 1);
}
setInterval(tick, 16);

function play(scene: Scene) {
  audio.unlock();
  current = { scene, t0: performance.now(), fired: 0 };
}

const list = document.getElementById('scenes')!;
for (const s of SCENES) {
  const b = document.createElement('button');
  b.textContent = s.label;
  b.onclick = () => play(s);
  list.append(b, document.createElement('br'));
}

let recorder: { node: AudioWorkletNode; chunks: Float32Array[][] } | null = null;

/** Starts capturing the final output (after the limiter). */
async function startCapture() {
  audio.unlock();
  const e = audio.engine;
  await e.ready;
  const ctx = e.ctx!;
  await ctx.resume();
  if (!recorder) {
    const code = `class Rec extends AudioWorkletProcessor { process(inputs) { const i = inputs[0]; if (i && i.length) this.port.postMessage([i[0].slice(), (i[1] || i[0]).slice()]); return true; } } registerProcessor('rec', Rec);`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
    const node = new AudioWorkletNode(ctx, 'rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    const sink = ctx.createGain();
    sink.gain.value = 0;
    e.output!.connect(node).connect(sink).connect(ctx.destination);
    recorder = { node, chunks: [] };
    node.port.onmessage = (m) => recorder!.chunks.push(m.data);
  }
  recorder.chunks.length = 0;
}

/** Stops and returns what was captured: levels per channel, and the 16-bit stereo PCM if asked. */
function stopCapture(withPcm = false) {
  const chunks = recorder ? recorder.chunks.splice(0) : [];
  const n = chunks.reduce((k, c) => k + c[0].length, 0);
  const pcm = withPcm ? new Int16Array(n * 2) : null;
  let k = 0;
  let peak = 0;
  let sl = 0;
  let sr = 0;
  for (const [l, r] of chunks)
    for (let i = 0; i < l.length; i++) {
      peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
      sl += l[i] * l[i];
      sr += r[i] * r[i];
      if (pcm) {
        pcm[k++] = Math.max(-1, Math.min(1, l[i])) * 32767;
        pcm[k++] = Math.max(-1, Math.min(1, r[i])) * 32767;
      }
    }
  const db = (x: number) => +(10 * Math.log10(x / Math.max(1, n) + 1e-12)).toFixed(1);
  let b64 = '';
  if (pcm) {
    const bytes = new Uint8Array(pcm.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    b64 = btoa(bin);
  }
  return { rate: audio.engine.ctx!.sampleRate, seconds: n / audio.engine.ctx!.sampleRate, peak, leftDb: db(sl), rightDb: db(sr), pcm: b64 };
}

/** Records the scenes one after another; returns 16-bit stereo PCM per scene (for the WAV export) and the music timeline. */
async function record(ids?: string[]) {
  const out = [];
  for (const s of SCENES.filter((x) => !ids || ids.includes(x.id))) {
    await startCapture();
    play(s);
    const timeline: string[] = [];
    for (let t = 0; t < s.duration + 0.3; t += 0.5) {
      await new Promise((r) => setTimeout(r, 500));
      const r = audio.report();
      timeline.push(`${t.toFixed(1)}:${r.director}/${r.music}`);
    }
    out.push({ id: s.id, label: s.label, timeline, ...stopCapture(true) });
  }
  return out;
}

(window as unknown as { __lab: unknown }).__lab = {
  audio,
  bankPeaks: () => {
    const out: Record<string, number> = {};
    for (const id of Object.keys(RECIPES) as SoundId[]) {
      const b = audio.engine.buffer(id, 0);
      if (!b) continue;
      let p = 0;
      for (let c = 0; c < b.numberOfChannels; c++) for (const x of b.getChannelData(c)) p = Math.max(p, Math.abs(x));
      out[id] = +p.toFixed(3);
    }
    return out;
  },
  record, startCapture, stopCapture, setIdle: (o: typeof idle) => (idle = o), scenes: SCENES.map((s) => ({ id: s.id, label: s.label, duration: s.duration })) };
