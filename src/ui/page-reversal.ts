/**
 * 换火周期页：
 *  - 当前燃烧侧、换火倒计时、抑制窗状态
 *  - 最近 2 小时换火时间轴（交替侧别 + 换火段）
 *  - 换火/风机手动控制与事件列表
 */
import { REVERSAL_PERIOD_SEC } from '../shared/constants';
import type { ReversalEvent } from '../shared/types';
import type { PageContext, Unsubscriber } from './app';

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}分${String(s).padStart(2, '0')}秒`;
}

export function renderReversalPage(ctx: PageContext): Unsubscriber {
  const { root, monitor } = ctx;
  const events = monitor.events;

  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <h2>换火周期与工况事件</h2>
        <span class="sub">换火 75s + 前后抑制窗 90s，窗内声学告警自动门控；周期 ${REVERSAL_PERIOD_SEC / 60} 分钟</span>
      </div>

      <div class="kpi-row">
        <div class="kpi"><div class="label">当前燃烧侧</div><div class="value" id="k-side">–</div></div>
        <div class="kpi"><div class="label">距下次自动换火</div><div class="value" id="k-countdown">–</div></div>
        <div class="kpi"><div class="label">换火状态</div><div class="value" id="k-revstate">–</div></div>
        <div class="kpi"><div class="label">风机</div><div class="value" id="k-fan">–</div></div>
        <div class="kpi"><div class="label">累计换火次数</div><div class="value" id="k-revcount">0</div></div>
      </div>

      <div class="toolbar" style="margin-bottom:14px">
        <button class="btn primary" id="btn-rev">手动换火</button>
        <button class="btn" id="btn-fan-on">启动风机</button>
        <button class="btn" id="btn-fan-off">停止风机</button>
        <label class="muted"><input type="checkbox" id="chk-auto" checked /> 自动换火</label>
      </div>

      <div class="panel">
        <h3>近两小时换火时间轴</h3>
        <div class="timeline" id="timeline"></div>
        <div class="legend" style="margin-top:8px">
          <span><i style="background:rgba(70,182,255,0.65)"></i>左侧燃烧</span>
          <span><i style="background:rgba(124,92,255,0.65)"></i>右侧燃烧</span>
          <span><i style="background:rgba(255,184,77,0.35)"></i>换火进行中（门控）</span>
        </div>
      </div>

      <div style="height:14px"></div>

      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="panel">
          <h3>换火事件</h3>
          <div class="scroll-x" style="max-height:340px;overflow:auto">
            <table>
              <thead><tr><th>#</th><th>时刻</th><th>方向</th><th>类型</th><th>时长</th></tr></thead>
              <tbody id="rev-tbody"></tbody>
            </table>
          </div>
        </div>
        <div class="panel">
          <h3>风机启停事件</h3>
          <div class="scroll-x" style="max-height:340px;overflow:auto">
            <table>
              <thead><tr><th>#</th><th>时刻</th><th>动作</th><th>原因</th></tr></thead>
              <tbody id="fan-tbody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;

  root.querySelector<HTMLButtonElement>('#btn-rev')!.onclick = () => events.triggerReversal('manual');
  root.querySelector<HTMLButtonElement>('#btn-fan-on')!.onclick = () => events.setFanRunning(true);
  root.querySelector<HTMLButtonElement>('#btn-fan-off')!.onclick = () => events.setFanRunning(false);
  root.querySelector<HTMLInputElement>('#chk-auto')!.onchange = (e) => {
    events.setAutoReversal((e.target as HTMLInputElement).checked);
  };

  function renderTimeline(): void {
    const tl = root.querySelector<HTMLDivElement>('#timeline')!;
    const now = performance.now();
    const windowMs = 2 * 3600 * 1000;
    const startWall = Date.now() - windowMs;
    const revs = events.reversalList.filter((r) => r.startedAt + r.durationSec * 1000 > startWall);

    // 以换火事件为分隔构造段
    interface Seg {
      from: number;
      to: number;
      kind: 'left' | 'right' | 'rev';
    }
    const segs: Seg[] = [];
    let cursor = startWall;
    let side: 'left' | 'right' = 'left';
    // 回溯当前 side
    for (const r of events.reversalList) {
      if (r.startedAt < startWall) side = r.firingAfter;
    }
    for (const r of revs) {
      if (r.startedAt > cursor) segs.push({ from: cursor, to: r.startedAt, kind: side });
      const end = r.startedAt + r.durationSec * 1000;
      segs.push({ from: r.startedAt, to: end, kind: 'rev' });
      side = r.firingAfter;
      cursor = end;
    }
    if (cursor < Date.now()) segs.push({ from: cursor, to: Date.now(), kind: side });

    tl.innerHTML = sevsToHtml(segs, startWall, Date.now());
  }

  function sevsToHtml(segs: Array<{ from: number; to: number; kind: string }>, start: number, end: number): string {
    const span = Math.max(1, end - start);
    return segs
      .map((s) => {
        const leftPct = ((s.from - start) / span) * 100;
        const widthPct = Math.max(0.4, ((s.to - s.from) / span) * 100);
        const label = s.kind === 'rev' ? '换火' : s.kind === 'left' ? '左燃' : '右燃';
        return `<div class="seg ${s.kind}" style="left:${leftPct.toFixed(3)}%;width:${widthPct.toFixed(3)}%">${widthPct > 4 ? label : ''}</div>`;
      })
      .join('');
  }

  function renderTables(): void {
    const revBody = root.querySelector<HTMLTableSectionElement>('#rev-tbody')!;
    revBody.innerHTML =
      events.reversalList
        .slice()
        .reverse()
        .slice(0, 60)
        .map(
          (r: ReversalEvent) => `<tr>
          <td>${r.id}</td><td>${fmtClock(r.startedAt)}</td>
          <td>${r.firingBefore === 'left' ? '左→右' : '右→左'}</td>
          <td>${r.kind === 'auto' ? '自动' : '手动'}</td>
          <td>${r.durationSec}s</td></tr>`,
        )
        .join('') || '<tr><td colspan="5" class="muted" style="text-align:center">暂无事件</td></tr>';

    const fanBody = root.querySelector<HTMLTableSectionElement>('#fan-tbody')!;
    fanBody.innerHTML =
      events.fanList
        .slice()
        .reverse()
        .slice(0, 60)
        .map(
          (f) => `<tr><td>${f.id}</td><td>${fmtClock(f.at)}</td>
          <td style="color:${f.running ? 'var(--ok)' : 'var(--warn)'}">${f.running ? '启动' : '停止'}</td>
          <td>${f.reason === 'manual' ? '手动' : '计划'}</td></tr>`,
        )
        .join('') || '<tr><td colspan="4" class="muted" style="text-align:center">暂无事件</td></tr>';
  }

  const timer = window.setInterval(() => {
    const now = performance.now();
    const guard = events.guardState(now);
    root.querySelector('#k-side')!.textContent = events.currentFiringSide === 'left' ? '左侧' : '右侧';
    const cd = events.nextReversalInSec;
    root.querySelector('#k-countdown')!.textContent = cd < 0 ? '自动已关' : fmtDuration(cd);
    const stateEl = root.querySelector<HTMLElement>('#k-revstate')!;
    stateEl.textContent = guard.inReversal
      ? `换火中 ${guard.reversalRemaining.toFixed(0)}s`
      : guard.reversalGuarded
        ? '抑制窗内'
        : '正常监测';
    stateEl.style.color = guard.guardReason ? 'var(--warn)' : 'var(--ok)';
    const fanEl = root.querySelector<HTMLElement>('#k-fan')!;
    fanEl.textContent = events.isFanRunning ? '运行' : '停止';
    fanEl.style.color = events.isFanRunning ? 'var(--ok)' : 'var(--warn)';
    root.querySelector('#k-revcount')!.textContent = String(events.reversalList.length);
    renderTimeline();
    renderTables();
  }, 500);

  const unsub: Unsubscriber = () => clearInterval(timer);
  return unsub;
}
