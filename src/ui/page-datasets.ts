/**
 * 燃烧数据组页（需求 2 验证）
 *  - 6 组燃料×窑型参数表与不稳定区间
 *  - λ 1.05→0.95 振荡峰幅值"先升后降"曲线，标注燃烧手册边界
 *  - 实时 λ 扫描：驱动仿真并叠加实测峰幅值，与手册曲线对照
 */
import { DATASETS, getDataset } from '../shared/datasets';
import { modesForDataset } from '../engine/channel-config';
import {
  clear,
  drawGrid,
  drawLine,
  drawText,
  readTheme,
  resizeCanvas,
  setupHiDpi,
} from './charts';
import type { CombustionDataset } from '../shared/types';
import type { PageContext, Unsubscriber } from './app';

export function renderDatasetsPage(ctx: PageContext): Unsubscriber {
  const { root, monitor } = ctx;
  let selectedId = DATASETS[0].id;
  let sweepTimer: number | null = null;
  let measured: Array<{ lambda: number; db: number }> = [];

  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <h2>燃料 × 窑型燃烧数据与热声不稳定区间</h2>
        <span class="sub">空燃比 λ 由 1.05 降至 0.95：振荡峰先升后降，与燃烧手册不稳定区间边界一致</span>
      </div>

      <div class="panel" style="margin-bottom:14px">
        <div class="scroll-x">
          <table>
            <thead><tr>
              <th>数据组</th><th>燃料</th><th>窑型</th><th>炉温 ℃</th><th>声速 m/s</th>
              <th>通道长 m</th><th>模型</th><th>基频 Hz</th><th>典型振荡 Hz</th><th>不稳定 λ 区间</th>
            </tr></thead>
            <tbody id="ds-tbody"></tbody>
          </table>
        </div>
      </div>

      <div class="grid" style="grid-template-columns: 1fr 1fr">
        <div class="panel">
          <h3 id="curve-title">λ — 振荡峰幅值曲线（手册数据）</h3>
          <canvas class="lambda-canvas" id="lambda-canvas"></canvas>
          <div class="legend" style="margin-top:8px">
            <span><i style="background:var(--accent)"></i>手册曲线（峰幅值 dBFS）</span>
            <span><i style="background:var(--danger)"></i>实时扫描实测</span>
            <span><i style="background:rgba(255,184,77,0.5)"></i>不稳定区间</span>
          </div>
        </div>
        <div class="panel">
          <h3>实时 λ 扫描验证</h3>
          <div class="toolbar" style="margin-bottom:10px">
            <select id="ds-select">
              ${DATASETS.map((d) => `<option value="${d.id}">${d.label}</option>`).join('')}
            </select>
            <button class="btn primary" id="btn-sweep">开始 1.05→0.95 扫描</button>
            <button class="btn" id="btn-clear-measure">清空实测点</button>
          </div>
          <p class="muted" id="ds-note"></p>
          <div id="mode-table-host"></div>
          <div class="metric-grid" style="margin-top:12px">
            <div class="metric-box"><div class="k">当前扫描 λ</div><div class="v" id="m-lambda">1.05</div></div>
            <div class="metric-box"><div class="k">手册峰幅 dBFS</div><div class="v" id="m-handbook">–</div></div>
            <div class="metric-box"><div class="k">实测峰幅 dBFS</div><div class="v" id="m-measured">–</div></div>
            <div class="metric-box"><div class="k">偏差</div><div class="v" id="m-delta">–</div></div>
          </div>
        </div>
      </div>
    </div>`;

  const tbody = root.querySelector<HTMLTableSectionElement>('#ds-tbody')!;
  tbody.innerHTML = DATASETS.map((d) => {
    const ch = monitor.configs.find((c) => c.datasetId === d.id)?.ch ?? 0;
    return `<tr data-id="${d.id}" style="cursor:pointer">
      <td style="font-family:inherit">${d.label}</td><td>${d.fuel}</td><td>${d.furnace}</td>
      <td>${d.furnaceTempC}</td><td>${d.soundSpeed}</td><td>${d.portLength}</td>
      <td>${d.endModel === 'quarter-wave' ? '1/4 波' : '1/2 波'}</td>
      <td>${d.fundamental}</td><td>${d.typicalOscFreq}</td>
      <td><span style="color:var(--warn)">[${d.unstableLambda[0]}, ${d.unstableLambda[1]}]</span></td>
    </tr>`;
  }).join('');
  tbody.onclick = (e) => {
    const tr = (e.target as HTMLElement).closest('tr');
    if (tr?.dataset.id) {
      selectedId = tr.dataset.id;
      root.querySelector<HTMLSelectElement>('#ds-select')!.value = selectedId;
      redrawCurve(getDataset(selectedId));
      renderNoteAndModes(getDataset(selectedId));
    }
  };

  const canvas = root.querySelector<HTMLCanvasElement>('#lambda-canvas')!;

  function redrawCurve(ds: CombustionDataset): void {
    const theme = readTheme();
    const c = setupHiDpi(canvas);
    const r = canvas.getBoundingClientRect();
    const w = r.width;
    const h = r.height;
    clear(c, w, h, theme.bg);
    const padL = 52;
    const padB = 34;
    const padT = 16;
    drawGrid(c, w, h, padL, padB, padT, theme, 5, 5);

    const xLo = 0.94;
    const xHi = 1.06;
    const yLo = -62;
    const yHi = -28;
    const xOf = (lam: number) => padL + ((lam - xLo) / (xHi - xLo)) * (w - padL - 12);
    const yOf = (db: number) => padT + (1 - (db - yLo) / (yHi - yLo)) * (h - padT - padB);

    // 不稳定区间阴影
    const [lo, hi] = ds.unstableLambda;
    c.fillStyle = 'rgba(255,184,77,0.12)';
    c.fillRect(xOf(lo), padT, xOf(hi) - xOf(lo), h - padT - padB);
    c.strokeStyle = theme.warn;
    c.setLineDash([4, 4]);
    for (const bx of [lo, hi]) {
      c.beginPath();
      c.moveTo(xOf(bx), padT);
      c.lineTo(xOf(bx), h - padB);
      c.stroke();
    }
    c.setLineDash([]);
    drawText(c, `不稳定区 [${lo}, ${hi}]`, xOf(lo) + 6, padT + 12, theme.warn);

    // 轴标签
    c.fillStyle = theme.muted;
    c.font = '10px ui-monospace, monospace';
    c.textAlign = 'center';
    for (let lam = 0.95; lam <= 1.051; lam += 0.02) {
      c.fillText(lam.toFixed(2), xOf(lam), h - padB + 14);
    }
    c.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const db = yLo + ((yHi - yLo) * (5 - i)) / 5;
      const y = padT + ((h - padT - padB) * i) / 5;
      c.fillText(db.toFixed(0), padL - 6, y + 3);
    }
    c.textAlign = 'left';
    drawText(c, 'λ →', w - 34, h - 8, theme.muted);
    drawText(c, 'dBFS', 8, padT + 4, theme.muted);

    // 手册曲线
    const pts = ds.lambdaCurve.map((p) => [xOf(p.lambda), yOf(p.peakDb)] as [number, number]);
    drawLine(c, pts, theme.accent, 2);
    for (const p of pts) {
      c.fillStyle = theme.accent;
      c.beginPath();
      c.arc(p[0], p[1], 2.5, 0, Math.PI * 2);
      c.fill();
    }

    // 实测点
    for (const m of measured) {
      c.fillStyle = theme.danger;
      c.beginPath();
      c.arc(xOf(m.lambda), yOf(m.db), 3.2, 0, Math.PI * 2);
      c.fill();
    }

    root.querySelector('#curve-title')!.textContent = `${ds.label} · λ — 振荡峰幅值曲线`;
  }

  function renderNoteAndModes(ds: CombustionDataset): void {
    root.querySelector('#ds-note')!.textContent = ds.note;
    const modes = modesForDataset(ds.id, ds.furnaceTempC);
    root.querySelector('#mode-table-host')!.innerHTML = `
      <table>
        <thead><tr><th>模态</th><th>理论频率 Hz</th></tr></thead>
        <tbody>${modes
          .slice(0, 4)
          .map((m) => `<tr><td>n=${m.n} (${m.model === 'quarter-wave' ? '1/4' : '1/2'})</td><td>${m.freq.toFixed(1)}</td></tr>`)
          .join('')}</tbody>
      </table>`;
  }

  function handbookDb(ds: CombustionDataset, lam: number): number {
    const curve = ds.lambdaCurve;
    if (lam >= curve[0].lambda) return curve[0].peakDb;
    if (lam <= curve[curve.length - 1].lambda) return curve[curve.length - 1].peakDb;
    for (let i = 0; i < curve.length - 1; i++) {
      if (lam <= curve[i].lambda && lam >= curve[i + 1].lambda) {
        const u = (curve[i].lambda - lam) / (curve[i].lambda - curve[i + 1].lambda);
        return curve[i].peakDb + (curve[i + 1].peakDb - curve[i].peakDb) * u;
      }
    }
    return curve[0].peakDb;
  }

  function startSweep(): void {
    if (monitor.currentMode !== 'sim') {
      ctx.toast.showInfo('仅仿真模式', 'λ 实时扫描需要仿真声源，硬件模式下展示手册曲线。');
      return;
    }
    const sim = monitor.simulator!;
    measured = [];
    sim.startSweep();
    const ds = getDataset(selectedId);
    const targetCh = monitor.configs.find((c) => c.datasetId === selectedId)?.ch ?? 0;

    if (sweepTimer !== null) clearInterval(sweepTimer);
    sweepTimer = window.setInterval(() => {
      const lam = sim.currentLambda(targetCh);
      const snap = monitor.getTracker(targetCh).snapshot;
      const measuredDb = snap.peakAmp > 0 ? 20 * Math.log10(Math.max(snap.peakAmp, 1e-10)) : -58;
      measured.push({ lambda: Math.round(lam * 1000) / 1000, db: measuredDb });
      if (measured.length > 400) measured.shift();
      const hb = handbookDb(ds, lam);
      root.querySelector('#m-lambda')!.textContent = lam.toFixed(3);
      root.querySelector('#m-handbook')!.textContent = hb.toFixed(1);
      root.querySelector('#m-measured')!.textContent = measuredDb.toFixed(1);
      const delta = measuredDb - hb;
      const deltaEl = root.querySelector<HTMLElement>('#m-delta')!;
      deltaEl.textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} dB`;
      deltaEl.style.color = Math.abs(delta) > 6 ? 'var(--warn)' : 'var(--ok)';
      redrawCurve(ds);
      if (!sim.sweeping) {
        sim.stopSweep();
        if (sweepTimer !== null) {
          clearInterval(sweepTimer);
          sweepTimer = null;
        }
      }
    }, 120);
  }

  root.querySelector<HTMLSelectElement>('#ds-select')!.onchange = (e) => {
    selectedId = (e.target as HTMLSelectElement).value;
    measured = [];
    redrawCurve(getDataset(selectedId));
    renderNoteAndModes(getDataset(selectedId));
  };
  root.querySelector<HTMLButtonElement>('#btn-sweep')!.onclick = startSweep;
  root.querySelector<HTMLButtonElement>('#btn-clear-measure')!.onclick = () => {
    measured = [];
    redrawCurve(getDataset(selectedId));
  };

  redrawCurve(getDataset(selectedId));
  renderNoteAndModes(getDataset(selectedId));
  const offResize = resizeCanvas(canvas, () => redrawCurve(getDataset(selectedId)));

  const unsub: Unsubscriber = () => {
    offResize();
    if (sweepTimer !== null) clearInterval(sweepTimer);
    monitor.simulator?.stopSweep();
  };
  return unsub;
}
