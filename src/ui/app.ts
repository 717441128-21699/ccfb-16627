/**
 * 应用外壳：顶栏导航、路由分发、页面生命周期（卸载订阅）
 */
import { Monitor } from '../engine/monitor';
import { parseRoute, routeHash, type Route } from './router';
import { ToastHost } from './toast';
import { renderOverview } from './page-overview';
import { renderChannelPage } from './page-channel';
import { renderAlertsPage } from './page-alerts';
import { renderReversalPage } from './page-reversal';
import { renderDatasetsPage } from './page-datasets';

export type Unsubscriber = () => void;

export interface PageContext {
  root: HTMLElement;
  monitor: Monitor;
  navigate: (r: Route) => void;
  toast: ToastHost;
}

const NAV_ITEMS: Array<{ route: Route; label: string; match: string }> = [
  { route: { name: 'overview' }, label: '燃烧器总览', match: 'overview' },
  { route: { name: 'channel', ch: 0 }, label: '单路频谱', match: 'channel' },
  { route: { name: 'alerts' }, label: '预警记录', match: 'alerts' },
  { route: { name: 'reversal' }, label: '换火周期', match: 'reversal' },
  { route: { name: 'datasets' }, label: '燃烧数据', match: 'datasets' },
];

export class App {
  private monitor = new Monitor();
  private toast = new ToastHost();
  private root = document.getElementById('app')!;
  private currentUnsub: Unsubscriber | null = null;
  private started = false;

  async boot(): Promise<void> {
    this.renderShell();
    window.addEventListener('hashchange', () => this.dispatch());
    if (!location.hash) location.hash = routeHash({ name: 'overview' });
    this.dispatch();
  }

  private renderShell(): void {
    const shell = document.createElement('div');
    shell.style.flex = '1';
    shell.style.display = 'flex';
    shell.style.flexDirection = 'column';
    shell.innerHTML = `
      <header class="topbar">
        <div class="brand"><span class="logo"></span>熔窑热声振荡监测</div>
        <nav class="nav" id="nav"></nav>
        <div class="spacer"></div>
        <span class="mode-badge" id="mode-badge">未启动</span>
        <button class="btn primary" id="btn-start-sim">启动仿真</button>
        <button class="btn" id="btn-start-hw">硬件接入</button>
        <button class="btn" id="btn-fault" title="随机选一路注入故障">注入故障</button>
      </header>
      <div id="page-root" style="flex:1;display:flex;flex-direction:column"></div>`;
    this.root.appendChild(shell);

    const nav = shell.querySelector<HTMLDivElement>('#nav')!;
    nav.innerHTML = NAV_ITEMS.map(
      (n) => `<a href="${routeHash(n.route)}" data-match="${n.match}">${n.label}</a>`,
    ).join('');

    shell.querySelector<HTMLButtonElement>('#btn-start-sim')!.onclick = () => this.startSim();
    shell.querySelector<HTMLButtonElement>('#btn-start-hw')!.onclick = () => this.startHardware();
    shell.querySelector<HTMLButtonElement>('#btn-fault')!.onclick = () => {
      if (!this.started) {
        this.toast.showInfo('系统未启动', '请先启动仿真或接入硬件。');
        return;
      }
      const ep = this.monitor.triggerFault();
      if (ep) this.toast.showInfo('故障注入', `已在 CH${String(ep.ch).padStart(2, '0')} 注入 70s 热声振荡剧情`);
    };

    // 告警 toast
    this.monitor.onAlert((kind, rec) => {
      if (kind === 'raise' || kind === 'upgrade') this.toast.show(rec);
      if (kind === 'suppress') {
        this.toast.showInfo(
          '告警已门控',
          `CH${String(rec.ch).padStart(2, '0')} 的振荡信号处于${rec.suppressedBy === 'reversal' ? '换火' : '风机'}抑制窗，已记录不报警`,
        );
      }
    });
  }

  private async startSim(): Promise<void> {
    try {
      await this.monitor.startSim();
      this.started = true;
      const badge = document.querySelector<HTMLSpanElement>('#mode-badge')!;
      badge.textContent = '仿真模式 · 24 路';
      badge.className = 'mode-badge sim';
      this.toast.showInfo('仿真已启动', '24 路燃烧器声源与自动换火周期运行中，约 12s 后出现首个故障剧情');
    } catch (err) {
      this.toast.showInfo('启动失败', (err as Error).message);
    }
  }

  private async startHardware(): Promise<void> {
    try {
      const actual = await this.monitor.startHardware();
      this.started = true;
      const badge = document.querySelector<HTMLSpanElement>('#mode-badge')!;
      badge.textContent = `硬件模式 · ${actual} 通道`;
      badge.className = 'mode-badge hw';
      this.toast.showInfo('硬件已接入', `采集到 ${actual} 个音频通道，分析管线与仿真一致`);
    } catch (err) {
      this.started = true;
      const badge = document.querySelector<HTMLSpanElement>('#mode-badge')!;
      badge.textContent = '仿真模式 · 24 路（回退）';
      badge.className = 'mode-badge sim';
      this.toast.showInfo('硬件接入受限', (err as Error).message);
    }
  }

  private navigate = (r: Route): void => {
    location.hash = routeHash(r);
  };

  private dispatch(): void {
    const route = parseRoute(location.hash);
    const nav = document.querySelector<HTMLDivElement>('#nav')!;
    nav.querySelectorAll('a').forEach((a) => {
      a.classList.toggle('active', (a as HTMLElement).dataset.match === route.name);
    });

    this.currentUnsub?.();
    const pageRoot = document.getElementById('page-root')!;
    pageRoot.innerHTML = '';
    const ctx: PageContext = {
      root: pageRoot,
      monitor: this.monitor,
      navigate: this.navigate,
      toast: this.toast,
    };

    if (!this.started) {
      this.renderStartScreen(pageRoot);
      // 启动页之上仍允许路由切换，但无数据；启动后重放当前路由
      const observer = this.monitor.onSnapshot(() => {
        observer();
        this.dispatch();
      });
      return;
    }

    switch (route.name) {
      case 'channel':
        this.currentUnsub = renderChannelPage(ctx, route.ch);
        break;
      case 'alerts':
        this.currentUnsub = renderAlertsPage(ctx);
        break;
      case 'reversal':
        this.currentUnsub = renderReversalPage(ctx);
        break;
      case 'datasets':
        this.currentUnsub = renderDatasetsPage(ctx);
        break;
      default:
        this.currentUnsub = renderOverview(ctx);
    }
  }

  private renderStartScreen(host: HTMLElement): void {
    host.innerHTML = `
      <div class="page" style="display:flex;align-items:center;justify-content:center;flex:1">
        <div class="panel" style="max-width:680px;text-align:center;padding:36px">
          <h2 style="margin-top:0;font-size:20px">玻璃熔窑燃烧器热声振荡声学监测</h2>
          <p class="muted" style="line-height:1.9;text-align:left">
            系统在每支燃烧器旁部署耐高温拾音器，24 路音频经 Web Audio API 接入，
            每路频谱的持续跟踪由独立的 AudioWorklet 完成，自动识别热声振荡峰的出现、增长与频率漂移。<br/><br/>
            <b style="color:var(--fg)">报警准则：</b>振荡峰频率与按小炉通道长度、炉内温度计算的声学共振模态偏差 ≤5%，
            且 15s 窗内幅值增长率回归转正后才分级预警；通过耦合矩阵区分自身起振与隔壁串扰，
            换火与风机启停窗内自动门控。<br/><br/>
            <b style="color:var(--fg)">本演示：</b>点击右上角"启动仿真"即可获得完整 24 路仿真声源
            （含宽带燃烧声、振荡音、低频扑扑、邻炉串扰、换火与风机事件）；
            接入多通道声卡时可选择"硬件接入"走同一套分析管线。
          </p>
          <div style="display:flex;gap:12px;justify-content:center;margin-top:18px">
            <button class="btn primary" id="start-now">启动 24 路仿真</button>
            <button class="btn" id="start-hw-2">硬件接入</button>
          </div>
        </div>
      </div>`;
    host.querySelector<HTMLButtonElement>('#start-now')!.onclick = () => this.startSim();
    host.querySelector<HTMLButtonElement>('#start-hw-2')!.onclick = () => this.startHardware();
  }
}
