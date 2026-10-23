import { describe, expect, it } from 'vitest';
import { estimateRefresh, formatReport, summarize, type FrameSample } from '../src/client/bench/report';

const frames = (ms: number[]): FrameSample[] => ms.map((x) => ({ ms: x, cpu: 2, calls: 100, tris: 500_000 }));

describe('performance test report', () => {
  it('averages the frame rate over the time actually spent, not per frame', () => {
    // 9 frames at 10 ms and 1 at 110 ms: 10 frames in 200 ms = 50 FPS (not 82).
    const s = summarize('combat', 'Combat', frames([...Array(9).fill(10), 110]), []);
    expect(s.avgFps).toBeCloseTo(50, 5);
    expect(s.medianMs).toBe(10);
    expect(s.hitches).toBe(1);
  });

  it('reports the slowest 1 % of frames', () => {
    const ms = [...Array(198).fill(16.7), 40, 40];
    const s = summarize('x', 'X', frames(ms), []);
    expect(s.slow1Ms).toBe(40);
    expect(s.low1Fps).toBeCloseTo(25, 5);
  });

  it('leaves the GPU time empty when the browser has no timer queries', () => {
    expect(summarize('x', 'X', frames([16, 17]), []).gpuMs).toBeNull();
    expect(summarize('x', 'X', frames([16, 17]), [3, 5]).gpuMs).toBe(4);
  });

  it('copes with a segment without frames', () => {
    const s = summarize('x', 'X', [], []);
    expect(s.frames).toBe(0);
    expect(s.avgFps).toBe(0);
  });

  it('estimates the display refresh from the fastest frames', () => {
    const at165 = Array.from({ length: 200 }, (_, i) => (i % 5 === 0 ? 12.1 : 6.06));
    expect(estimateRefresh(at165)).toBe(165);
    expect(estimateRefresh(Array(100).fill(16.67))).toBe(60);
    // Every frame slower than 30 Hz: the screen's rate cannot be known.
    expect(estimateRefresh(Array(100).fill(50))).toBeNull();
    expect(estimateRefresh([16])).toBeNull();
  });

  it('formats a French text report with every level and scene', () => {
    const seg = summarize('station', 'Station', frames(Array(60).fill(16.67)), [4.2]);
    const total = summarize('total', 'Ensemble', frames(Array(60).fill(16.67)), [4.2]);
    const text = formatReport({
      gpu: 'Test GPU',
      userAgent: 'UA',
      screen: '1920×1080',
      refreshHz: 60,
      levels: [{ level: 'high', label: 'Élevé', renderPath: 'msaa', pixelRatio: 1.5, width: 2880, height: 1620, compiles: 0, segments: [seg], total }],
    });
    expect(text).toContain('Carte graphique : Test GPU');
    expect(text).toContain('rafraîchissement estimé 60 Hz');
    expect(text).toContain('Niveau Élevé (rendu msaa, 150 %, 2880×1620 px, shaders compilés pendant la mesure : 0)');
    expect(text).toContain('Station : 60 IPS moy.');
    expect(text).toContain('GPU 4,2 ms');
    expect(text).toContain('500 k triangles');
  });
});
