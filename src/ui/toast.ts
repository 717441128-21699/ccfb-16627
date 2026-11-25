/**
 * 告警 toast 通知（右下角，danger 级持续展示直到手动关闭）
 */
import type { AlertRecord } from '../shared/types';

export class ToastHost {
  private wrap: HTMLDivElement;

  constructor() {
    this.wrap = document.createElement('div');
    this.wrap.className = 'toast-wrap';
    document.body.appendChild(this.wrap);
  }

  show(rec: AlertRecord): void {
    const el = document.createElement('div');
    el.className = `toast ${rec.level}`;
    const side = rec.ch < 12 ? '左' : '右';
    const port = (rec.ch % 12) + 1;
    const levelText = rec.level === 'danger' ? '危险' : rec.level === 'warning' ? '预警' : '关注';
    el.innerHTML = `
      <div class="t-title">${levelText} · ${side}侧 ${port}# 小炉 (CH${rec.ch})</div>
      <div class="t-body">${rec.message}<br/>
        峰值 ${rec.peakFreq.toFixed(1)}Hz · 模态偏差 ${rec.errorPct.toFixed(2)}% ·
        ${rec.origin === 'self' ? '自身起振' : `串扰自 CH${rec.sourceCh}`}
      </div>`;
    const close = document.createElement('button');
    close.className = 'btn small';
    close.style.marginTop = '8px';
    close.textContent = '知道了';
    close.onclick = () => el.remove();
    el.appendChild(close);
    this.wrap.appendChild(el);
    if (rec.level !== 'danger') {
      window.setTimeout(() => el.remove(), 9000);
    }
  }

  showInfo(title: string, body: string): void {
    const el = document.createElement('div');
    el.className = 'toast watch';
    el.innerHTML = `<div class="t-title">${title}</div><div class="t-body">${body}</div>`;
    this.wrap.appendChild(el);
    window.setTimeout(() => el.remove(), 6000);
  }
}
