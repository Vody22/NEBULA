import { formatNumber, formatReport, formatTriangles, type BenchReport, type SegmentStats } from '../bench/report';

/**
 * The performance test's screen: a small progress line while it runs, then
 * the results table with a button to copy them as text.
 */
export class BenchPanel {
  private root: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'bench';
    this.root.setAttribute('role', 'status');
    parent.appendChild(this.root);
  }

  progress(text: string) {
    this.root.className = 'running';
    this.root.innerHTML = '<strong>TEST DE PERFORMANCE</strong><span></span><small>Ne touchez à rien, environ 2 minutes.</small>';
    this.root.querySelector('span')!.textContent = text;
  }

  results(report: BenchReport, actions: { replay(): void; play(): void }) {
    const text = formatReport(report);
    this.root.className = 'done';
    this.root.setAttribute('role', 'dialog');
    this.root.innerHTML = `
      <div class="box">
        <h2>Résultats du test de performance</h2>
        <p class="device"></p>
        <div class="scroll"><table>
          <thead><tr><th>Niveau</th><th>Scène</th><th>IPS moy.</th><th>1 % bas</th><th>CPU ms</th><th>GPU ms</th><th>Appels</th><th>Triangles</th><th>Saccades</th></tr></thead>
          <tbody></tbody>
        </table></div>
        <p class="hint">Envoyez ces résultats en les copiant : ils ne quittent pas votre appareil autrement.</p>
        <div class="menu-buttons row">
          <button class="primary" data-act="copy">Copier les résultats</button>
          <button data-act="replay">Relancer</button>
          <button data-act="play">Jouer</button>
        </div>
        <textarea readonly aria-label="Résultats en texte"></textarea>
      </div>`;
    // GPU names and the user agent are not trusted HTML.
    this.root.querySelector('.device')!.textContent =
      `${report.gpu} · ${report.screen}${report.refreshHz ? ` · écran ≈ ${report.refreshHz} Hz` : ''}`;
    const body = this.root.querySelector('tbody')!;
    const row = (level: string, s: SegmentStats, strong: boolean) => {
      const tr = document.createElement('tr');
      if (strong) tr.className = 'total';
      const cells = [
        level,
        s.label,
        String(Math.round(s.avgFps)),
        String(Math.round(s.low1Fps)),
        formatNumber(s.cpuMs),
        s.gpuMs === null ? '—' : formatNumber(s.gpuMs),
        String(s.calls),
        formatTriangles(s.tris),
        String(s.hitches),
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    };
    for (const l of report.levels) {
      l.segments.forEach((s, i) => row(i === 0 ? l.label : '', s, false));
      row('', l.total, true);
    }
    const area = this.root.querySelector('textarea')!;
    area.value = text;
    this.root.addEventListener('click', async (e) => {
      const act = (e.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'replay') actions.replay();
      else if (act === 'play') actions.play();
      else if (act === 'copy') {
        const btn = this.root.querySelector<HTMLButtonElement>('[data-act="copy"]')!;
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = 'Copié !';
        } catch {
          // No clipboard access (http, old browser): select the text instead.
          area.classList.add('shown');
          area.focus();
          area.select();
          btn.textContent = 'Sélectionné : copiez avec Ctrl+C';
        }
      }
    });
    this.root.querySelector<HTMLButtonElement>('[data-act="copy"]')!.focus();
  }
}
