/**
 * 燃烧器总览页：KPI 条 + 两侧 24 支燃烧器卡片（迷你频谱 + 状态灯 + 关键指标）
 */
import { F_MAX, F_MIN, MINI_BINS, PORTS_PER_SIDE } from '../shared/constants';
import type { BurnerSnapshot } from '../shared/types';
import {
  clear,
  drawFill,
  drawGrid,
  drawLogFreqAxis,
  logX,
  readTheme,
  setupHiDpi,
  type GridTheme,
} from './charts';
import type { Monitor } from '../engine/monitor';
import type { Unsubscriber, PageContext } from './app';

function miniSpectrum(canvas: HTMLCanvasElement, snap: BurnerSnapshot, theme: GridTheme): void {
  const ctx = setupHiDpi(canvas);
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  clear(ctx, w, h, '#0d1426');
  drawGrid(ctx, w, h, 4, 14, 4, theme, 2, 3);

  const spec = snap.miniSpectrum;
  const dbMin = -90;
  const dbMax = -25;
  const padL = 4;
  const pts: Array<[number, number]> = [];
  for (let b = 0; b < MINI_BINS; b++) {
    const fLo = F_MIN * Math.pow(F_MAX / F_MIN, b / MINI_BINS);
    const x = padL + logX(fLo, F_MIN, F_MAX) * (w - padL - 2);
    const db = spec[b] ?? dbMin;
    const y = 4 + (1 - Math.max(0, Math.min(1, (db - dbMin) / (dbMax - dbMin)))) * (h - 18);
    pts.push([x, y]);
  }
  const color =
    snap.status === 'danger'
      ? theme.danger
      : snap.status === 'warning'
        ? theme.warn
        : snap.status === 'watch'
          ? theme.watch
          : theme.accent;
  ctx.globalAlpha = 0.25;
  drawFill(ctx, pts, h - 14, color);
  ctx.globalAlpha = 1;
  drawLine(ctx, pts, color, 1.2);

  // 峰值标记
  if (snap.peakFreq > 0) {
    const px = padL + logX(snap.peakFreq, F_MIN, F_MAX) * (w - padL - 2);
    ctx.strokeStyle = theme.danger;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, 3);
    ctx.lineTo(px, h - 14);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  drawLogFreqAxis(ctx, w, h, padL, 14, F_MIN, F_MAX, theme);
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  pts: Array<[number, number]>,
  color: string,
  width: number,
): void {
  if (pts.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

const STATUS_TEXT: Record<BurnerSnapshot['status'], string> = {
  normal: '正常',
  watch: '关注',
  warning: '预警',
  danger: '危险',
  event: '事件门控',
};

export function renderOverview(ctx: PageContext): Unsubscriber {
  const { root, monitor, navigate } = ctx;
  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <h2>燃烧器总览</h2>
        <span class="sub">24 路耐高温拾音器 · 16kHz · 4096 点 FFT · 每路独立 AudioWorklet 跟踪</span>
      </div>
      <div class="kpi-row" id="kpis"></div>
      <div class="panel">
        <h3>左侧熔窑（小炉 1–12） <span class="tag">点击卡片进入单路频谱</span></h3>
        <div class="burner-grid" id="grid-left"></div>
      </div>
      <div style="height:14px"></div>
      <div class="panel">
        <h3>右侧熔窑（小炉 1–12）</h3>
        <div class="burner-grid" id="grid-right"></div>
      </div>
    </div>`;

  const grids = [
    root.querySelector<HTMLDivElement>('#grid-left')!,
    root.querySelector<HTMLDivElement>('#grid-right')!,
  ];

  const cards: Array<{ card: HTMLDivElement; canvas: HTMLCanvasElement; snap: BurnerSnapshot | null }> = [];
  for (let ch = 0; ch < 24; ch++) {
    const side = ch < PORTS_PER_SIDE ? 0 : 1;
    const card = document.createElement('div');
    card.className = 'burner-card';
    card.innerHTML = `
      <div class="top">
        <span class="ch-id">CH${String(ch).padStart(2, '0')} · ${(ch % 12) + 1}#</span>
        <span class="status-dot normal"></span>
      </div>
      <canvas></canvas>
      <div class="metrics">
        <span class="m-freq">-- Hz</span>
        <span class="m-growth">-- dB/s</span>
      </div>
      <div class="badge-row"></div>`;
    card.onclick = () => navigate({ name: 'channel', ch });
    grids[side].appendChild(card);
    cards.push({ card, canvas: card.querySelector('canvas')!, snap: null });
  }

  const kpiHost = root.querySelector<HTMLDivElement>('#kpis')!;
  const kpiDefs = [
    { id: 'danger', label: '危险燃烧器' },
    { id: 'warning', label: '预警/关注' },
    { id: 'puff', label: '扑扑声通道' },
    { id: 'xtalk', label: '串扰通道' },
    { id: 'guard', label: '事件门控' },
    { id: 'rms', label: '平均声级 dBFS' },
  ];
  kpiHost.innerHTML = kpiDefs
    .map((k) => `<div class="kpi"><div class="label">${k.label}</div><div class="value" id="kpi-${k.id}">–</div></div>`)
    .join('');

  const theme = readTheme();

  const unsub = monitor.onSnapshot((snapshots) => {
    let danger = 0;
    let warn = 0;
    let puff = 0;
    let xtalk = 0;
    let guard = 0;
    let rmsSum = 0;

    snapshots.forEach((snap, idx) => {
      const item = cards[idx];
      item.snap = snap;
      const dot = item.card.querySelector<HTMLSpanElement>('.status-dot')!;
      dot.className = `status-dot ${snap.status}`;
      item.card.querySelector('.m-freq')!.textContent =
        snap.peakFreq > 0 ? `${snap.peakFreq.toFixed(0)}Hz` : '无峰';
      const growthEl = item.card.querySelector<HTMLElement>('.m-growth')!;
      growthEl.textContent = `${snap.growthRate >= 0 ? '+' : ''}${snap.growthRate.toFixed(1)}`;
      growthEl.style.color = snap.growthRate > 0.6 ? 'var(--danger)' : 'var(--muted)';
      const badgeRow = item.card.querySelector<HTMLDivElement>('.badge-row')!;
      const badges: string[] = [];
      if (snap.source?.origin === 'crosstalk') {
        badges.push(`<span class="mini-badge xtalk">串扰←CH${snap.source.sourceCh}</span>`);
        xtalk++;
      }
      if (snap.puffing) {
        badges.push(`<span class="mini-badge puff">扑扑</span>`);
        puff++;
      }
      if (snap.status === 'event') {
        badges.push(`<span class="mini-badge guard">门控</span>`);
        guard++;
      }
      if (snap.match?.matched) {
        badges.push(`<span class="mini-badge">模态${snap.match.mode.n}·${snap.match.errorPct.toFixed(1)}%</span>`);
      }
      badgeRow.innerHTML = badges.join('');

      if (snap.status === 'danger') danger++;
      if (snap.status === 'warning' || snap.status === 'watch') warn++;
      rmsSum += snap.rmsDb;
      miniSpectrum(item.canvas, snap, theme);
    });

    kpiHost.querySelector('#kpi-danger')!.textContent = String(danger);
    kpiHost.querySelector('#kpi-warning')!.textContent = String(warn);
    kpiHost.querySelector('#kpi-puff')!.textContent = String(puff);
    kpiHost.querySelector('#kpi-xtalk')!.textContent = String(xtalk);
    kpiHost.querySelector('#kpi-guard')!.textContent = String(guard);
    kpiHost.querySelector('#kpi-rms')!.textContent = (rmsSum / snapshots.length).toFixed(1);

    const dEl = kpiHost.querySelector<HTMLElement>('#kpi-danger')!;
    dEl.style.color = danger > 0 ? 'var(--danger)' : 'var(--fg)';
  });

  const onResize = () => {
    cards.forEach((c) => {
      if (c.snap) miniSpectrum(c.canvas, c.snap, readTheme());
    });
  };
  window.addEventListener('resize', onResize);

  return () => {
    window.removeEventListener('resize', onResize);
  };
}
