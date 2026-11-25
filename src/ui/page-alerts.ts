/**
 * 预警记录页：历史告警表 + 筛选 + 证据链查看 + 手动清除
 */
import type { AlertRecord } from '../shared/types';
import type { PageContext, Unsubscriber } from './app';

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const LEVEL_NAME: Record<AlertRecord['level'], string> = {
  watch: '关注',
  warning: '预警',
  danger: '危险',
};

export function renderAlertsPage(ctx: PageContext): Unsubscriber {
  const { root, monitor } = ctx;
  let filter = 'all';

  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <h2>预警记录</h2>
        <span class="sub">仅在振荡峰匹配理论模态（≤5%）且增长率转正后产生；换火/风机窗内记录为"已抑制"</span>
      </div>
      <div class="toolbar" style="margin-bottom:12px">
        <select id="filter-level">
          <option value="all">全部等级</option>
          <option value="danger">危险</option>
          <option value="warning">预警</option>
          <option value="watch">关注</option>
          <option value="suppressed">仅看门控抑制</option>
          <option value="active">仅看未解除</option>
        </select>
        <select id="filter-ch">
          <option value="all">全部燃烧器</option>
          ${Array.from({ length: 24 }, (_, ch) => `<option value="${ch}">CH${String(ch).padStart(2, '0')}</option>`).join('')}
        </select>
        <button class="btn danger" id="btn-clear">清除全部记录</button>
        <span class="muted" id="count-text"></span>
      </div>
      <div class="panel">
        <div class="scroll-x">
          <table>
            <thead>
              <tr>
                <th>等级</th><th>燃烧器</th><th>开始</th><th>解除</th><th>峰频 Hz</th>
                <th>增长率 dB/s</th><th>模态/偏差</th><th>声源</th><th>扑扑</th><th>门控</th><th>说明</th><th></th>
              </tr>
            </thead>
            <tbody id="alert-tbody"></tbody>
          </table>
        </div>
      </div>
      <div id="evidence-host"></div>
    </div>`;

  const tbody = root.querySelector<HTMLTableSectionElement>('#alert-tbody')!;
  const countText = root.querySelector<HTMLElement>('#count-text')!;

  function rowHtml(r: AlertRecord): string {
    const side = r.ch < 12 ? '左' : '右';
    const port = (r.ch % 12) + 1;
    const state = r.resolvedAt
      ? r.suppressedBy
        ? `<span class="state-chip">已抑制·${r.suppressedBy === 'reversal' ? '换火' : '风机'}</span>`
        : '<span class="state-chip">已解除</span>'
      : '<span class="state-chip active">未解除</span>';
    return `
      <tr data-id="${r.id}">
        <td><span class="level-chip ${r.level}">${LEVEL_NAME[r.level]}</span></td>
        <td>CH${String(r.ch).padStart(2, '0')} ${side}${port}#</td>
        <td>${fmtTime(r.startedAt)}</td>
        <td>${r.resolvedAt ? fmtTime(r.resolvedAt) : '—'}</td>
        <td>${r.peakFreq.toFixed(1)}</td>
        <td style="color:${r.growthRate > 0 ? 'var(--danger)' : ''}">${r.growthRate.toFixed(2)}</td>
        <td>${r.modeN !== null ? `n=${r.modeN} · ${r.errorPct.toFixed(2)}%` : '—'}</td>
        <td>${r.origin === 'self' ? '自身' : `串扰←CH${String(r.sourceCh).padStart(2, '0')}`}</td>
        <td>${r.puffing ? '<span style="color:var(--warn)">是</span>' : '否'}</td>
        <td>${state}</td>
        <td style="font-family:inherit;white-space:normal;max-width:260px">${r.message}</td>
        <td>${r.evidence.length > 1 ? `<button class="btn small" data-ev="${r.id}">证据链</button>` : ''}</td>
      </tr>`;
  }

  function render(): void {
    const levelFilter = root.querySelector<HTMLSelectElement>('#filter-level')!.value;
    const chFilter = root.querySelector<HTMLSelectElement>('#filter-ch')!.value;
    let list = monitor.alerts.records.slice().reverse();
    if (levelFilter === 'suppressed') list = list.filter((r) => !!r.suppressedBy);
    else if (levelFilter === 'active') list = list.filter((r) => !r.resolvedAt);
    else if (levelFilter !== 'all') list = list.filter((r) => r.level === levelFilter && !r.suppressedBy);
    if (chFilter !== 'all') list = list.filter((r) => r.ch === parseInt(chFilter, 10));
    countText.textContent = `共 ${list.length} 条 / 累计 ${monitor.alerts.records.length} 条`;
    tbody.innerHTML = list.map(rowHtml).join('') || '<tr><td colspan="12" class="muted" style="text-align:center;padding:24px">暂无记录</td></tr>';
  }

  root.querySelector<HTMLSelectElement>('#filter-level')!.onchange = render;
  root.querySelector<HTMLSelectElement>('#filter-ch')!.onchange = render;
  root.querySelector<HTMLButtonElement>('#btn-clear')!.onclick = () => {
    if (confirm('确认清除全部预警记录？该操作不可恢复。')) {
      monitor.alerts.clearRecords();
      render();
    }
  };

  tbody.onclick = (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-ev]');
    if (!btn) return;
    const rec = monitor.alerts.records.find((r) => r.id === btn.dataset.ev);
    if (rec) showEvidence(rec);
  };

  function showEvidence(r: AlertRecord): void {
    const host = root.querySelector<HTMLDivElement>('#evidence-host')!;
    const lines = r.evidence
      .map(
        (p) => `<tr><td>${p.t.toFixed(2)}s</td><td>${p.freq.toFixed(1)} Hz</td><td>${p.ampDb.toFixed(1)} dBFS</td></tr>`,
      )
      .join('');
    host.innerHTML = `
      <div class="modal-backdrop" id="ev-backdrop">
        <div class="modal">
          <h3>证据链 · CH${String(r.ch).padStart(2, '0')} · ${LEVEL_NAME[r.level]}</h3>
          <p class="muted" style="margin-top:0">触发前 15s 窗内的峰跟踪采样（频率稳定在模态附近、幅值持续正增长）</p>
          <table><thead><tr><th>相对时刻</th><th>峰频</th><th>峰幅</th></tr></thead><tbody>${lines}</tbody></table>
          <div style="margin-top:14px;text-align:right">
            <button class="btn primary" id="ev-close">关闭</button>
          </div>
        </div>
      </div>`;
    host.querySelector<HTMLButtonElement>('#ev-close')!.onclick = () => (host.innerHTML = '');
    host.querySelector<HTMLElement>('#ev-backdrop')!.onclick = (e: MouseEvent) => {
      if (e.target === host.querySelector('#ev-backdrop')) host.innerHTML = '';
    };
  }

  // 新告警/解除时刷新
  const unsubAlert = monitor.onAlert(() => render());
  render();

  const unsub: Unsubscriber = () => unsubAlert();
  return unsub;
}
