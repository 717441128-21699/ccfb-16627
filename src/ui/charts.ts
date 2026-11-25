/**
 * 轻量 Canvas 图表工具（无第三方依赖）：频谱图、时间序列、λ 曲线、谱峰标注
 * 所有绘制走 devicePixelRatio，主题色由 CSS 变量驱动
 */
export interface GridTheme {
  bg: string;
  fg: string;
  grid: string;
  accent: string;
  watch: string;
  warn: string;
  danger: string;
  muted: string;
}

export function readTheme(): GridTheme {
  const css = getComputedStyle(document.documentElement);
  return {
    bg: css.getPropertyValue('--panel').trim() || '#121826',
    fg: css.getPropertyValue('--fg').trim() || '#e6ebf5',
    grid: css.getPropertyValue('--grid').trim() || '#26304a',
    accent: css.getPropertyValue('--accent').trim() || '#46b6ff',
    watch: css.getPropertyValue('--watch').trim() || '#ffd166',
    warn: css.getPropertyValue('--warn').trim() || '#ffb84d',
    danger: css.getPropertyValue('--danger').trim() || '#ff5d6c',
    muted: css.getPropertyValue('--muted').trim() || '#8493ad',
  };
}

export function setupHiDpi(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function clear(ctx: CanvasRenderingContext2D, w: number, h: number, bg: string): void {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
}

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  padL: number,
  padB: number,
  padT: number,
  theme: GridTheme,
  yTicks: number,
  xTicks: number,
): void {
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = theme.muted;
  for (let i = 0; i <= yTicks; i++) {
    const y = padT + ((h - padT - padB) * i) / yTicks;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - 8, y);
    ctx.stroke();
  }
  for (let i = 0; i <= xTicks; i++) {
    const x = padL + ((w - padL - 8) * i) / xTicks;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, h - padB);
    ctx.stroke();
  }
}

export function logX(f: number, fMin: number, fMax: number): number {
  return (Math.log10(f) - Math.log10(fMin)) / (Math.log10(fMax) - Math.log10(fMin));
}

/** 对数频率轴标签 */
export function drawLogFreqAxis(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  padL: number,
  padB: number,
  fMin: number,
  fMax: number,
  theme: GridTheme,
): void {
  const labels = [10, 20, 50, 100, 200, 500, 1000, 2000];
  ctx.fillStyle = theme.muted;
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  for (const f of labels) {
    if (f < fMin || f > fMax) continue;
    const x = padL + logX(f, fMin, fMax) * (w - padL - 10);
    ctx.fillText(`${f >= 1000 ? f / 1000 + 'k' : f}`, x, h - padB + 14);
  }
  ctx.textAlign = 'left';
}

export function drawLine(
  ctx: CanvasRenderingContext2D,
  pts: Array<[number, number]>,
  color: string,
  width = 1.5,
): void {
  if (pts.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

export function drawFill(
  ctx: CanvasRenderingContext2D,
  pts: Array<[number, number]>,
  baseY: number,
  color: string,
): void {
  if (pts.length < 2) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], baseY);
  ctx.lineTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.lineTo(pts[pts.length - 1][0], baseY);
  ctx.closePath();
  ctx.fill();
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  align: CanvasTextAlign = 'left',
): void {
  ctx.fillStyle = color;
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
}

export function resizeCanvas(canvas: HTMLCanvasElement, redraw: () => void): () => void {
  const ro = new ResizeObserver(() => redraw());
  ro.observe(canvas);
  return () => ro.disconnect();
}
