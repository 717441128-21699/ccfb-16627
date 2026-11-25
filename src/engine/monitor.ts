/**
 * Monitor —— 系统中央门面
 *
 * 周期（约 4Hz，跟随分析帧到达节流）：
 *  frames → 24 路 tracker 摄入 → 源判定 → 状态合成 → 告警引擎评估 → 订阅者广播
 */
import { CHANNEL_COUNT } from '../shared/constants';
import type {
  AlertRecord,
  BurnerSnapshot,
  ChannelFrame,
  FaultPhase,
} from '../shared/types';
import { AudioEngine, type AudioMode } from './audio-graph';
import { ChannelTracker } from './tracker';
import { attributeSources } from './source-attribution';
import { AlertEngine } from './alert-engine';
import { EventManager } from './event-manager';
import { SimulationController, type FaultEpisode } from './sim-controller';
import { buildChannelConfigs, type ChannelConfig } from './channel-config';

export type SnapshotListener = (snapshots: BurnerSnapshot[]) => void;
export type AlertListener = (event: 'raise' | 'upgrade' | 'resolve' | 'suppress', rec: AlertRecord) => void;

export class Monitor {
  readonly audio = new AudioEngine();
  readonly events: EventManager;
  readonly alerts: AlertEngine;
  readonly configs: ChannelConfig[];
  private trackers: ChannelTracker[];
  private sim: SimulationController | null = null;
  private snapshotListeners = new Set<SnapshotListener>();
  private alertListeners = new Set<AlertListener>();
  private lastTickAt = 0;
  private mode: AudioMode = 'sim';
  private faultPhases = new Map<number, FaultPhase>();

  constructor() {
    this.configs = buildChannelConfigs();
    this.trackers = this.configs.map(
      (cfg) => new ChannelTracker(cfg.ch, cfg.datasetId, cfg.modes),
    );
    this.events = new EventManager(() => performance.now());
    this.alerts = new AlertEngine({
      onRaise: (r) => this.emitAlert('raise', r),
      onUpgrade: (r) => this.emitAlert('upgrade', r),
      onResolve: (r) => this.emitAlert('resolve', r),
      onSuppress: (r) => this.emitAlert('suppress', r),
    });

    this.audio.onFrame((f) => this.handleFrame(f));
  }

  private emitAlert(kind: 'raise' | 'upgrade' | 'resolve' | 'suppress', rec: AlertRecord): void {
    for (const l of this.alertListeners) l(kind, rec);
  }

  onSnapshot(l: SnapshotListener): () => void {
    this.snapshotListeners.add(l);
    return () => this.snapshotListeners.delete(l);
  }

  onAlert(l: AlertListener): () => void {
    this.alertListeners.add(l);
    return () => this.alertListeners.delete(l);
  }

  async startSim(): Promise<void> {
    await this.audio.startSim();
    this.mode = 'sim';
    this.events.reset();
    this.events.setAutoReversal(true);
    this.sim = new SimulationController(
      this.configs,
      this.events,
      (msg) => this.audio.postSim(msg),
      (ep) => {
        if (ep) this.faultPhases.set(ep.ch, ep.phase);
      },
    );
    this.sim.start();
  }

  async startHardware(): Promise<number> {
    const info = await this.audio.startHardware();
    this.mode = 'hardware';
    return info.actual;
  }

  get currentMode(): AudioMode {
    return this.mode;
  }

  get simulator(): SimulationController | null {
    return this.sim;
  }

  getTracker(ch: number): ChannelTracker {
    return this.trackers[ch];
  }

  triggerFault(ch?: number): FaultEpisode | undefined {
    return this.sim?.triggerFault(ch);
  }

  private handleFrame(frame: ChannelFrame): void {
    if (frame.ch < 0 || frame.ch >= CHANNEL_COUNT) return;
    this.trackers[frame.ch].ingest(frame);

    // 节流到 ~4Hz 做系统级综合（帧到达率约 8Hz/路）
    const now = performance.now();
    if (now - this.lastTickAt < 250) return;
    this.lastTickAt = now;
    this.tick(now);
  }

  private tick(now: number): void {
    this.events.tick(now);
    const guard = this.events.guardState(now);

    // 同步仿真剧情阶段到 tracker
    if (this.sim) {
      for (const t of this.trackers) {
        const ep = this.sim.getEpisode(t.ch);
        const phase: FaultPhase = ep?.phase ?? 'idle';
        t.setFaultPhase(phase);
        this.faultPhases.set(t.ch, phase);
      }
    }

    let snapshots = this.trackers.map((t) => t.snapshot);

    // 源判定
    const verdicts = attributeSources(snapshots);
    for (const t of this.trackers) t.setSource(verdicts.get(t.ch) ?? null);
    snapshots = this.trackers.map((t) => t.snapshot);

    // 状态合成
    const activeLevels = this.alerts.activeLevels();
    for (const s of snapshots) {
      const t = this.trackers[s.ch];
      let status: BurnerSnapshot['status'] = 'normal';
      const level = activeLevels.get(s.ch);
      if (level) status = level;
      else if (guard.guardReason && (s.peakFreq > 0 || s.rmsDb > -40)) status = 'event';
      else if (s.puffing) status = 'watch';
      else if (s.source?.origin === 'crosstalk' && s.match?.matched) status = 'watch';
      else if (s.faultPhase !== 'idle' && this.mode === 'sim') status = status === 'normal' ? 'watch' : status;
      t.setStatus(status);
    }
    snapshots = this.trackers.map((t) => t.snapshot);

    // 告警评估
    this.alerts.evaluate(snapshots, guard, now);

    // 证据链回填
    for (const [ch] of this.alerts.activeLevels()) {
      const samples = this.trackers[ch].getPeakSamples();
      if (samples.length > 0) {
        this.alerts.attachEvidence(
          ch,
          samples.slice(-24).map((p) => ({
            t: Math.round(p.t * 10) / 10,
            freq: Math.round(p.freq * 10) / 10,
            ampDb: Math.round(p.ampDb * 10) / 10,
          })),
        );
      }
    }

    for (const l of this.snapshotListeners) l(snapshots);
  }
}
