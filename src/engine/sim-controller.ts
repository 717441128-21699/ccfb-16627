/**
 * 仿真控制器：按 4Hz 节拍计算 24 路 SimChannelState 并下发 SimulatorWorklet
 *
 * 故障剧情（每路 70s）：
 *   idle 平稳呼呼声
 *   onset(0-12s)   振荡峰在理论模态频率上冒出，增长率 >0
 *   growth(12-34s) 峰幅值沿 λ 曲线爬升（λ 1.05→区间中心），频率缓慢漂移
 *   critical(34-52s) 到达不稳定区间中心，峰值最大，出现低频扑扑声
 *   recovery(52-70s) λ 回调到 1.05，峰先升后降曲线的下降沿，振荡消退
 * 自动模式每 45-90s 随机选一路起振；换火期间不安排新故障。
 */
import { CHANNEL_COUNT } from '../shared/constants';
import { getDataset } from '../shared/datasets';
import type { FaultPhase, SimChannelState } from '../shared/types';
import type { ChannelConfig } from './channel-config';
import type { EventManager } from './event-manager';

export interface FaultEpisode {
  ch: number;
  startedAt: number;
  durationSec: number;
  lambdaMin: number;
  phase: FaultPhase;
  /** 当前剧情 λ */
  lambda: number;
}

const EPISODE_SEC = 70;
const TICK_MS = 250;

/** 剧情时间轴（秒） */
const T_ONSET_END = 12;
const T_GROWTH_END = 34;
const T_CRITICAL_END = 52;

export class SimulationController {
  private configs: ChannelConfig[];
  private events: EventManager;
  private post: (msg: unknown) => void;
  private timer: number | null = null;
  private episodes = new Map<number, FaultEpisode>();
  private autoMode = true;
  private nextFaultAt = 0;
  private globalLambda = 1.05;
  private sweepActive = false;
  private sweepStart = 0;
  private onEpisodeChange: (ep: FaultEpisode | null) => void;
  /** 每路独立的漂移相位种子，保证各路漂移形态不同 */
  private driftSeeds: number[];

  constructor(
    configs: ChannelConfig[],
    events: EventManager,
    post: (msg: unknown) => void,
    onEpisodeChange: (ep: FaultEpisode | null) => void,
  ) {
    this.configs = configs;
    this.events = events;
    this.post = post;
    this.onEpisodeChange = onEpisodeChange;
    this.driftSeeds = configs.map((_, i) => (i * 37 + 11) % 100);
  }

  start(): void {
    if (this.timer !== null) return;
    this.nextFaultAt = performance.now() + 12000;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.episodes.clear();
  }

  setAuto(on: boolean): void {
    this.autoMode = on;
  }

  get isAuto(): boolean {
    return this.autoMode;
  }

  /** 手动在指定通道注入故障（默认自动选一路当前正常的） */
  triggerFault(ch?: number): FaultEpisode {
    const target =
      ch ?? this.pickIdleChannel() ?? Math.floor(Math.random() * CHANNEL_COUNT);
    const ep: FaultEpisode = {
      ch: target,
      startedAt: performance.now(),
      durationSec: EPISODE_SEC,
      lambdaMin: getDataset(this.configs[target].datasetId).unstableLambda[0],
      phase: 'onset',
      lambda: 1.05,
    };
    this.episodes.set(target, ep);
    this.onEpisodeChange(ep);
    return ep;
  }

  getEpisode(ch: number): FaultEpisode | undefined {
    return this.episodes.get(ch);
  }

  listEpisodes(): FaultEpisode[] {
    return [...this.episodes.values()];
  }

  /** λ 扫描（数据组验证页用）：16s 内 1.05→0.95 再返回 */
  startSweep(): void {
    this.sweepActive = true;
    this.sweepStart = performance.now();
  }

  stopSweep(): void {
    this.sweepActive = false;
  }

  get sweeping(): boolean {
    return this.sweepActive;
  }

  /** 当前扫描 λ（无扫描时返回全局设定） */
  currentLambda(ch: number): number {
    if (this.sweepActive) {
      const el = (performance.now() - this.sweepStart) / 1000;
      const cycle = 16;
      const x = (el % cycle) / cycle;
      // 0→0.5: 1.05→0.95；0.5→1: 0.95→1.05
      return x < 0.5 ? 1.05 - 0.1 * (x / 0.5) : 0.95 + 0.1 * ((x - 0.5) / 0.5);
    }
    const ep = this.episodes.get(ch);
    return ep ? ep.lambda : this.globalLambda;
  }

  setGlobalLambda(v: number): void {
    this.globalLambda = Math.max(0.9, Math.min(1.15, v));
  }

  private pickIdleChannel(): number | null {
    const idle = this.configs.map((c) => c.ch).filter((ch) => !this.episodes.has(ch));
    if (idle.length === 0) return null;
    return idle[Math.floor(Math.random() * idle.length)];
  }

  private tick(): void {
    const now = performance.now();
    const guard = this.events.guardState(now);

    // ---- 自动安排故障 ----
    if (this.autoMode && !guard.inReversal && now >= this.nextFaultAt && this.episodes.size < 3) {
      this.triggerFault();
      this.nextFaultAt = now + (45000 + Math.random() * 45000);
    }

    // ---- 更新剧情 ----
    for (const [ch, ep] of this.episodes) {
      const el = (now - ep.startedAt) / 1000;
      if (el >= EPISODE_SEC) {
        this.episodes.delete(ch);
        this.onEpisodeChange(null);
        continue;
      }
      ep.phase = this.phaseAt(el);
      ep.lambda = this.lambdaAt(el, ep.lambdaMin);
    }

    // ---- 生成 24 路状态 ----
    const states: SimChannelState[] = this.configs.map((cfg) => {
      const ch = cfg.ch;
      const ep = this.episodes.get(ch);
      const ds = getDataset(cfg.datasetId);
      const base: SimChannelState = {
        ch,
        noiseGain: 0.12,
        toneGain: 0,
        toneFreq: ds.typicalOscFreq,
        targetFreq: ds.typicalOscFreq,
        puffGain: 0,
        puffFreq: 9 + (ch % 5) * 2.2,
        puffDuty: 0.35,
        mute: 0,
        fanGain: this.events.isFanRunning ? 0.025 : 0,
      };

      if (ep) {
        const el = (now - ep.startedAt) / 1000;
        const peakDb = this.peakDbForLambda(ds.lambdaCurve, ep.lambda);
        // 剧情包络：onset 淡入，recovery 淡出
        const envelope = this.envelope(el);
        base.toneGain = this.dbToGain(peakDb) * envelope;
        // 频率漂移：模态频率 ±3% 缓漂（与 5% 模态容差留有余量）
        const drift = 1 + 0.03 * Math.sin(el * 0.35 + this.driftSeeds[ch]);
        base.targetFreq = ds.typicalOscFreq * drift;
        base.toneFreq = base.targetFreq;
        if (ep.phase === 'critical') {
          base.puffGain = 0.05 * (0.6 + 0.4 * Math.sin(el * 1.7));
          base.puffDuty = 0.55;
        } else if (ep.phase === 'growth') {
          base.puffGain = 0.012;
          base.puffDuty = 0.3;
        }
      }

      // 换火：非燃烧侧声音衰减，燃烧侧短暂扰动
      const firing = this.events.currentFiringSide;
      const mySide = ch < 12 ? 'left' : 'right';
      if (guard.inReversal) {
        base.mute = mySide === firing ? 0.15 : 0.82;
        base.fanGain = this.events.isFanRunning ? 0.05 : 0;
      }
      return base;
    });

    this.post({ type: 'state', states });
  }

  private phaseAt(el: number): FaultPhase {
    if (el < T_ONSET_END) return 'onset';
    if (el < T_GROWTH_END) return 'growth';
    if (el < T_CRITICAL_END) return 'critical';
    return 'recovery';
  }

  /** 剧情 λ：从 1.05 下探到不稳定区间中心附近再回升 */
  private lambdaAt(el: number, lambdaMin: number): number {
    const target = lambdaMin + 0.005; // 区间中心偏富燃
    if (el < T_GROWTH_END) {
      const u = Math.min(1, el / T_GROWTH_END);
      return 1.05 + (target - 1.05) * this.smooth(u);
    }
    if (el < T_CRITICAL_END) return target;
    const u = Math.min(1, (el - T_CRITICAL_END) / (EPISODE_SEC - T_CRITICAL_END));
    return target + (1.05 - target) * this.smooth(u);
  }

  private envelope(el: number): number {
    if (el < 2) return this.smooth(el / 2) * 0.7;
    if (el < T_ONSET_END) return 0.7 + 0.3 * ((el - 2) / (T_ONSET_END - 2));
    if (el < T_CRITICAL_END) return 1;
    return Math.max(0, 1 - (el - T_CRITICAL_END) / (EPISODE_SEC - T_CRITICAL_END));
  }

  private smooth(x: number): number {
    return x * x * (3 - 2 * x);
  }

  /** λ 曲线查表（线性插值），返回该 λ 下振荡峰 dBFS */
  private peakDbForLambda(
    curve: Array<{ lambda: number; peakDb: number }>,
    lambda: number,
  ): number {
    if (lambda >= curve[0].lambda) return curve[0].peakDb;
    if (lambda <= curve[curve.length - 1].lambda) return curve[curve.length - 1].peakDb;
    for (let i = 0; i < curve.length - 1; i++) {
      const a = curve[i];
      const b = curve[i + 1];
      if (lambda <= a.lambda && lambda >= b.lambda) {
        const u = (a.lambda - lambda) / (a.lambda - b.lambda);
        return a.peakDb + (b.peakDb - a.peakDb) * u;
      }
    }
    return curve[0].peakDb;
  }

  /**
   * dBFS → worklet 增益标定。
   * 谱底 -58dBFS 对应可闻但平稳的弱振荡；-32dBFS 为强振荡。
   */
  private dbToGain(db: number): number {
    const floor = -58;
    const norm = Math.max(0, Math.min(1, (db - floor) / 30));
    return 0.012 + norm * 0.16;
  }

  /** 供数据组验证页读取的理论 dB 值 */
  theoreticalPeakDb(ch: number): number {
    const cfg = this.configs[ch];
    const ds = getDataset(cfg.datasetId);
    return this.peakDbForLambda(ds.lambdaCurve, this.currentLambda(ch));
  }
}
