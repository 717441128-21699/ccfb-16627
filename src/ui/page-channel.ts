/**
 * 单路频谱页
 *  - 完整 4096 点频谱（对数频轴）+ 理论共振模态竖线 + 实测峰值标注
 *  - 15s 增长率/漂移率数字与趋势小图
 *  - 历史曲线（峰频、峰幅值 dB、低频占比）
 *  - 仿真模式下可手动注入故障、监听该路声音
 */
import { DETAIL_REQUEST_MS, F_MAX, F_MIN } from '../shared/constants';
import { getDataset } from '../shared/datasets';
import type { BurnerSnapshot } from '../shared/types';
import {
  clear,
  drawGrid,
  drawLine,
  drawLogFreqAxis,
  drawText,
  logX,
  readTheme,
  resizeCanvas,
  setupHiDpi,
} from './charts';
import type { PageContext, Unsubscriber } from './app';

const DB_LO = -95;
const DB_HI = -20;

export function renderChannelPage(ctx: PageContext, ch: number): Unsubscriber {
  const { root, monitor } = ctx;
  const cfg = monitor.configs[ch];
  const ds = getDataset(cfg.datasetId);
  let monitorOn = false;
  let lastDetailReq = 0;
  let detail: number[] | null = null;
  let latest: BurnerSnapshot | null = null;

  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <h2>CH${String(ch).padStart(2, '0')} · ${ch < 12 ? '左' : '右'}侧 ${(ch % 12) + 1}# 小炉</h2>
        <span class="sub">${ds.label} · 炉温 ${cfg.tempC.toFixed(0)}℃ · 声速 ${cfg.soundSpeed}m/s · 通道长 ${ds.portLength}m（${ds.endModel === 'quarter-wave' ? '开-闭 1/4 波长' : '双端 1/2 波长'}）</span>
      </div>

      <div class="toolbar" style="margin-bottom:12px">
        <select id="ch-select">
          ${monitor.configs
            .map(
              (c) =>
                `<option value="${c.ch}" ${c.ch === ch ? 'selected' : ''}>CH${String(c.ch).padStart(2, '0')} · ${getDataset(c.datasetId).label}</option>`,
            )
            .join('')}
        </select>
        <button class="btn" id="btn-monitor">🔊 监听该路</button>
        <button class="btn primary" id="btn-fault">⚡ 注入故障仿真</button>
        <button class="btn" id="btn-detail">请求完整频谱</button>
        <span class="muted" id="phase-text"></span>
      </div>

      <div class="grid" style="grid-template-columns: 2fr 1fr">
        <div class="panel spectrum-wrap">
          <h3>实时频谱与理论共振模态 <span class="tag">虚线=理论模态（5% 容差带），红点=实测峰</span></h3>
          <canvas id="spec-canvas"></canvas>
          <div class="legend" style="margin-top:8px">
            <span><i style="background:var(--accent)"></i>实测频谱</span>
            <span><i style="background:var(--warn)"></i>理论模态频率</span>
            <span><i style="background:var(--danger)"></i>实测振荡峰</span>
          </div>
        </div>

        <div class="panel">
          <h3>振荡特征量</h3>
          <div class="metric-grid">
            <div class="metric-box"><div class="k">峰值频率</div><div class="v" id="m-freq">–</div></div>
            <div class="metric-box"><div class="k">峰值幅值</div><div class="v" id="m-amp">–</div></div>
            <div class="metric-box"><div class="k">增长率 dB/s</div><div class="v" id="m-growth">–</div></div>
            <div class="metric-box"><div class="k">漂移率 Hz/s</div><div class="v" id="m-drift">–</div></div>
            <div class="metric-box"><div class="k">品质因数 Q</div><div class="v" id="m-q">–</div></div>
            <div class="metric-box"><div class="k">-3dB 带宽</div><div class="v" id="m-bw">–</div></div>
            <div class="metric-box"><div class="k">模态偏差</div><div class="v" id="m-err">–</div></div>
            <div class="metric-box"><div class="k">回归 R²</div><div class="v" id="m-r2">–</div></div>
            <div class="metric-box"><div class="k">低频占比</div><div class="v" id="m-low">–</div></div>
            <div class="metric-box"><div class="k">声源判定</div><div class="v" id="m-src">–</div></div>
          </div>
        </div>
      </div>

      <div style="height:14px"></div>

      <div class="grid" style="grid-template-columns: 1fr 1fr">
        <div class="panel">
          <h3>峰频率与幅值历史（300s）</h3>
          <canvas class="history-canvas" id="hist-peak"></canvas>
        </div>
        <div class="panel">
          <h3>低频能量占比（扑扑声 5–40Hz）与总声级</h3>
          <canvas class="history-canvas" id="hist-low"></canvas>
        </div>
      </div>

      <div style="height:14px"></div>

      <div class="panel">
        <h3>理论共振模态（按当前炉温与通道几何实时计算）</h3>
        <div class="scroll-x">
          <table>
            <thead><tr><th>模态</th><th>模型</th><th>理论频率 Hz</th><th>实测峰 Hz</th><th>偏差</th><th>是否匹配(≤5%)</th></tr></thead>
            <tbody id="mode-rows"></tbody>
          </table>
        </div>
      </div>
    </div>`;

  root.querySelector<HTMLSelectElement>('#ch-select')!.onchange = (e) => {
    const next = parseInt((e.target as HTMLSelectElement).value, 10);
    ctx.navigate({ name: 'channel', ch: next });
  };

  root.querySelector<HTMLButtonElement>('#btn-monitor')!.onclick = () => {
    monitorOn = !monitorOn;
    monitor.audio.setMonitor(ch, monitorOn ? 0.9 : 0);
    root.querySelector('#btn-monitor')!.textContent = monitorOn ? '🔇 关闭监听' : '🔊 监听该路';
  };

  root.querySelector<HTMLButtonElement>('#btn-fault')!.onclick = () => {
    monitor.triggerFault(ch);
  };

  root.querySelector<HTMLButtonElement>('#btn-detail')!.onclick = () => {
    monitor.audio.requestDetail(ch);
  };

  const specCanvas = root.querySelector<HTMLCanvasElement>('#spec-canvas')!;
  const histPeak = root.querySelector<HTMLCanvasElement>('#hist-peak')!;
  const histLow = root.querySelector<HTMLCanvasElement>('#hist-low')!;

  function drawSpectrum(): void {
    const theme = readTheme();
    const c = setupHiDpi(specCanvas);
    const rect = specCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    clear(c, w, h, theme.bg);
    const padL = 46;
    const padB = 26;
    const padT = 12;
    drawGrid(c, w, h, padL, padB, padT, theme, 5, 4);

    // dB 轴
    c.fillStyle = theme.muted;
    c.font = '10px ui-monospace, monospace';
    c.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const db = DB_LO + ((DB_HI - DB_LO) * (5 - i)) / 5;
      const y = padT + ((h - padT - padB) * i) / 5;
      c.fillText(`${db.toFixed(0)}`, padL - 6, y + 3);
    }
    c.textAlign = 'left';
    drawLogFreqAxis(c, w, h, padL, padB, F_MIN, F_MAX, theme);

    const yOf = (db: number) =>
      padT + (1 - (db - DB_LO) / (DB_HI - DB_LO)) * (h - padT - padB);
    const xOf = (f: number) => padL + logX(f, F_MIN, F_MAX) * (w - padL - 10);

    // 理论模态 + 5% 容差带
    for (const m of cfg.modes) {
      if (m.freq > F_MAX || m.freq < F_MIN) continue;
      const x = xOf(m.freq);
      c.fillStyle = 'rgba(255,184,77,0.10)';
      const x1 = xOf(m.freq * 0.95);
      const x2 = xOf(m.freq * 1.05);
      c.fillRect(x1, padT, x2 - x1, h - padT - padB);
      c.strokeStyle = theme.warn;
      c.setLineDash([5, 4]);
      c.beginPath();
      c.moveTo(x, padT);
      c.lineTo(x, h - padB);
      c.stroke();
      c.setLineDash([]);
      drawText(c, `f${m.n}`, x + 3, padT + 11, theme.warn);
    }

    // 实测频谱
    if (detail && detail.length > 0) {
      const sr = monitor.audio.sampleRate;
      const df = sr / (detail.length * 2);
      const pts: Array<[number, number]> = [];
      for (let k = 2; k < detail.length; k++) {
        const f = k * df;
        if (f < F_MIN || f > F_MAX) continue;
        pts.push([xOf(f), yOf(Math.max(DB_LO, Math.min(DB_HI, detail[k])))]);
      }
      drawLine(c, pts, theme.accent, 1.4);
    } else {
      // 降级：mini 频谱
      const s = latest?.miniSpectrum;
      if (s) {
        const pts: Array<[number, number]> = [];
        for (let b = 0; b < s.length; b++) {
          const f = F_MIN * Math.pow(F_MAX / F_MIN, b / s.length);
          pts.push([xOf(f), yOf(Math.max(DB_LO, Math.min(DB_HI, s[b])))]);
        }
        drawLine(c, pts, theme.accent, 1.4);
      }
    }

    // 实测峰值
    if (latest && latest.peakFreq > 0) {
      const x = xOf(latest.peakFreq);
      const y = yOf(20 * Math.log10(Math.max(latest.peakAmp, 1e-10)));
      c.fillStyle = theme.danger;
      c.beginPath();
      c.arc(x, y, 4.5, 0, Math.PI * 2);
      c.fill();
      drawText(c, `${latest.peakFreq.toFixed(1)}Hz`, x + 7, y - 6, theme.danger);
    }
  }

  function drawHistory(): void {
    const theme = readTheme();
    const tracker = monitor.getTracker(ch);
    const hist = tracker.getHistory();

    // 峰频/峰幅
    const c1 = setupHiDpi(histPeak);
    const r1 = histPeak.getBoundingClientRect();
    clear(c1, r1.width, r1.height, theme.bg);
    drawGrid(c1, r1.width, r1.height, 44, 18, 10, theme, 4, 4);
    if (hist.length > 1) {
      const t0 = hist[0].t;
      const t1 = hist[hist.length - 1].t;
      const xOf = (t: number) => 44 + ((t - t0) / Math.max(0.1, t1 - t0)) * (r1.width - 54);
      const freqPts = hist
        .filter((p) => p.peakFreq > 0)
        .map((p) => [xOf(p.t), 10 + (1 - Math.min(1, p.peakFreq / 600)) * (r1.height - 34)] as [number, number]);
      drawLine(c1, freqPts, theme.danger, 1.5);
      const ampPts = hist.map(
        (p) => [xOf(p.t), 10 + (1 - (p.peakDb + 90) / 70) * (r1.height - 34)] as [number, number],
      );
      drawLine(c1, ampPts, theme.accent, 1.3);
      drawText(c1, '红=峰频(Hz, 0-600量程)', 50, 22, theme.danger);
      drawText(c1, '蓝=峰幅(dBFS)', 200, 22, theme.accent);
    }

    // 低频占比/总声级
    const c2 = setupHiDpi(histLow);
    const r2 = histLow.getBoundingClientRect();
    clear(c2, r2.width, r2.height, theme.bg);
    drawGrid(c2, r2.width, r2.height, 44, 18, 10, theme, 4, 4);
    if (hist.length > 1) {
      const t0 = hist[0].t;
      const t1 = hist[hist.length - 1].t;
      const xOf = (t: number) => 44 + ((t - t0) / Math.max(0.1, t1 - t0)) * (r2.width - 54);
      const lowPts = hist.map(
        (p) => [xOf(p.t), 10 + (1 - Math.min(1, p.lowRatio / 0.6)) * (r2.height - 34)] as [number, number],
      );
      drawLine(c2, lowPts, theme.warn, 1.5);
      const rmsPts = hist.map(
        (p) => [xOf(p.t), 10 + (1 - (p.rmsDb + 70) / 45) * (r2.height - 34)] as [number, number],
      );
      drawLine(c2, rmsPts, theme.accent, 1.2);
      drawText(c2, '黄=低频占比', 50, 22, theme.warn);
      drawText(c2, '蓝=总声级 dBFS', 150, 22, theme.accent);
    }
  }

  function fillModes(snap: BurnerSnapshot | null): void {
    const tbody = root.querySelector<HTMLTableSectionElement>('#mode-rows')!;
    tbody.innerHTML = cfg.modes
      .map((m) => {
        const err =
          snap && snap.match?.mode.n === m.n
            ? snap.match.errorPct
            : snap && snap.peakFreq > 0
              ? Math.abs(snap.peakFreq - m.freq) / m.freq * 100
              : null;
        const matched = err !== null && err <= 5;
        return `<tr>
          <td>n=${m.n}</td>
          <td>${m.model === 'quarter-wave' ? '1/4 波长' : '1/2 波长'}</td>
          <td>${m.freq.toFixed(1)}</td>
          <td>${snap && snap.peakFreq > 0 ? snap.peakFreq.toFixed(1) : '—'}</td>
          <td style="color:${matched ? 'var(--ok)' : err !== null ? 'var(--muted)' : ''}">${err !== null ? err.toFixed(2) + '%' : '—'}</td>
          <td>${matched ? '<span style="color:var(--ok)">✓ 匹配</span>' : '<span class="muted">—</span>'}</td>
        </tr>`;
      })
      .join('');
  }

  const unsub = monitor.onSnapshot((snapshots) => {
    latest = snapshots[ch];
    const s = latest;
    root.querySelector<HTMLElement>('#phase-text')!.textContent =
      monitor.currentMode === 'sim'
        ? `仿真阶段：${({ idle: '正常', onset: '起振', growth: '增长', critical: '临脱火', recovery: '恢复' } as Record<string, string>)[s.faultPhase]}`
        : '';
    root.querySelector('#m-freq')!.textContent = s.peakFreq ? `${s.peakFreq.toFixed(1)} Hz` : '—';
    root.querySelector('#m-amp')!.textContent = s.peakAmp
      ? `${(20 * Math.log10(Math.max(s.peakAmp, 1e-10))).toFixed(1)} dBFS`
      : '—';
    const g = root.querySelector('#m-growth')!;
    g.textContent = `${s.growthRate >= 0 ? '+' : ''}${s.growthRate.toFixed(2)} dB/s`;
    g.className = `v ${s.growthRate > 0 ? 'pos' : 'neg'}`;
    root.querySelector('#m-drift')!.textContent = `${s.driftRate >= 0 ? '+' : ''}${s.driftRate.toFixed(2)} Hz/s`;
    root.querySelector('#m-q')!.textContent = s.peakQ ? s.peakQ.toFixed(1) : '—';
    root.querySelector('#m-bw')!.textContent = s.peakBW ? `${s.peakBW.toFixed(1)} Hz` : '—';
    root.querySelector('#m-err')!.textContent = s.match ? `${s.match.errorPct.toFixed(2)} %` : '—';
    root.querySelector('#m-r2')!.textContent = s.fitR2 ? s.fitR2.toFixed(2) : '—';
    root.querySelector('#m-low')!.textContent = `${(s.lowRatio * 100).toFixed(1)} %`;
    const src = root.querySelector<HTMLElement>('#m-src')!;
    src.textContent = s.source ? (s.source.origin === 'self' ? `自身 (置信${(s.source.confidence * 100).toFixed(0)}%)` : `串扰←CH${s.source.sourceCh}`) : '—';
    src.style.color = s.source?.origin === 'crosstalk' ? 'var(--accent-2)' : 'var(--ok)';

    // 节流请求完整频谱
    const now = performance.now();
    if (now - lastDetailReq > DETAIL_REQUEST_MS) {
      lastDetailReq = now;
      monitor.audio.requestDetail(ch);
    }
    if (s.miniSpectrum) fillModes(s);
    drawSpectrum();
    drawHistory();
  });

  // 完整频谱通过 frame 事件回流（monitor 未转发 detail，这里直接挂引擎回调）
  const offFrame = monitor.audio.onFrame((f) => {
    if (f.ch === ch && f.detailSpectrum) {
      detail = f.detailSpectrum as number[];
    }
  });

  const offResize1 = resizeCanvas(specCanvas, drawSpectrum);
  const offResize2 = resizeCanvas(histPeak, drawHistory);
  const offResize3 = resizeCanvas(histLow, drawHistory);

  return () => {
    unsub();
    offFrame();
    offResize1();
    offResize2();
    offResize3();
    if (monitorOn) monitor.audio.setMonitor(ch, 0);
  };
}
