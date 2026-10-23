import type { QualityLevel } from '../render/quality';

/** One rendered frame of the benchmark. */
export interface FrameSample {
  /** Time since the previous frame (display-paced), ms. */
  ms: number;
  /** JavaScript time spent building and submitting the frame, ms. */
  cpu: number;
  /** Draw calls and triangles of the whole frame (every pass). */
  calls: number;
  tris: number;
}

export interface SegmentStats {
  id: string;
  label: string;
  frames: number;
  avgFps: number;
  /** Frame rate over the slowest 1 % of frames (at least one frame). */
  low1Fps: number;
  medianMs: number;
  /** Mean duration of the slowest 1 % of frames. */
  slow1Ms: number;
  /** Frames over 50 ms: stutters a player notices. */
  hitches: number;
  cpuMs: number;
  /** GPU time per frame from timer queries, when the browser exposes them. */
  gpuMs: number | null;
  calls: number;
  tris: number;
}

export interface LevelResult {
  level: QualityLevel;
  label: string;
  renderPath: string;
  pixelRatio: number;
  width: number;
  height: number;
  /** Shader programs compiled during the measured scenes (each one is a stall). */
  compiles: number;
  segments: SegmentStats[];
  total: SegmentStats;
}

export interface BenchReport {
  gpu: string;
  userAgent: string;
  screen: string;
  refreshHz: number | null;
  levels: LevelResult[];
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/** Value at quantile q (0..1) of a sorted array. */
function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

export function summarize(id: string, label: string, samples: FrameSample[], gpu: number[]): SegmentStats {
  const ms = samples.map((s) => s.ms);
  const sorted = [...ms].sort((a, b) => a - b);
  const total = ms.reduce((s, x) => s + x, 0);
  const slow = mean(sorted.slice(sorted.length - Math.max(1, Math.floor(sorted.length * 0.01))));
  return {
    id,
    label,
    frames: samples.length,
    avgFps: total > 0 ? (1000 * samples.length) / total : 0,
    low1Fps: slow > 0 ? 1000 / slow : 0,
    medianMs: quantile(sorted, 0.5),
    slow1Ms: slow,
    hitches: ms.filter((x) => x > 50).length,
    cpuMs: mean(samples.map((s) => s.cpu)),
    gpuMs: gpu.length ? mean(gpu) : null,
    calls: Math.round(mean(samples.map((s) => s.calls))),
    tris: Math.round(mean(samples.map((s) => s.tris))),
  };
}

/**
 * The display refresh rate, from the fastest frames: when the GPU keeps up,
 * frames arrive exactly once per refresh. Null when no frame was fast enough
 * to tell (every frame slower than 30 Hz).
 */
export function estimateRefresh(intervalsMs: number[]): number | null {
  const sorted = intervalsMs.filter((x) => x > 0).sort((a, b) => a - b);
  if (sorted.length < 10) return null;
  const fast = quantile(sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.2))), 0.5);
  if (fast > 34) return null;
  return Math.round(1000 / fast);
}

const num = (x: number, digits = 1) => x.toFixed(digits).replace('.', ',');
const tris = (x: number) => (x >= 1e6 ? `${num(x / 1e6, 2)} M` : `${Math.round(x / 1000)} k`);

/** One line per scene, in French, for the player to copy and send. */
export function formatSegment(s: SegmentStats) {
  const gpu = s.gpuMs === null ? '' : `, GPU ${num(s.gpuMs)} ms`;
  return (
    `${s.label} : ${Math.round(s.avgFps)} IPS moy., 1 % bas ${Math.round(s.low1Fps)} IPS, ` +
    `image ${num(s.medianMs)} ms (CPU ${num(s.cpuMs)} ms${gpu}), ${s.calls} appels, ${tris(s.tris)} triangles, saccades ${s.hitches}`
  );
}

export function formatReport(r: BenchReport): string {
  const lines = [
    'NEBULA FRONTIER · test de performance',
    `Carte graphique : ${r.gpu}`,
    `Écran : ${r.screen}${r.refreshHz ? `, rafraîchissement estimé ${r.refreshHz} Hz` : ''}`,
    `Navigateur : ${r.userAgent}`,
  ];
  for (const l of r.levels) {
    lines.push('');
    lines.push(
      `Niveau ${l.label} (rendu ${l.renderPath}, ${Math.round(l.pixelRatio * 100)} %, ${l.width}×${l.height} px, ` +
        `shaders compilés pendant la mesure : ${l.compiles})`,
    );
    for (const s of l.segments) lines.push(`  ${formatSegment(s)}`);
    lines.push(`  ${formatSegment(l.total)}`);
  }
  return lines.join('\n');
}

export { num as formatNumber, tris as formatTriangles };
