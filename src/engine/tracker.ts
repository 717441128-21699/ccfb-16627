/**
 * 单路燃烧器跟踪器：
 *  - 谱峰跨帧关联（频率相近归为同一支振荡）
 *  - 15s 窗内幅值（dB）增长率与频率漂移率最小二乘回归
 *  - 与小炉通道理论共振模态匹配（5% 容差）
 *  - 扑扑声迟滞判定
 *  - 历史环形缓冲（供页面曲线与告警证据链）
 */
import {
  GROWTH_WINDOW_SEC,
  HISTORY_CAP,
  PEAK_ASSOC_REL,
  PEAK_FLOOR_DB,
  PEAK_MIN_Q,
  PUFF_HYSTERESIS_FRAMES,
  PUFF_RATIO_THRESHOLD,
  ampToDb,
} from '../shared/constants';
import { matchPeakToModes } from '../shared/acoustics';
import type { ResonanceMode } from '../shared/types';
import { linearFit } from './regression';
import type {
  BurnerSnapshot,
  ChannelFrame,
  ModeMatch,
  Side,
  SourceVerdict,
  FaultPhase,
} from '../shared/types';
import { DATASETS, getDataset } from '../shared/datasets';

interface HistPoint {
  t: number;
  rmsDb: number;
  peakFreq: number;
  peakDb: number;
  lowRatio: number;
}

interface PeakSample {
  t: number;
  freq: number;
  ampDb: number;
}

export class ChannelTracker {
  readonly ch: number;
  readonly side: Side;
  readonly port: number;
  private history: HistPoint[] = [];
  private peakSamples: PeakSample[] = [];
  private lastPeakFreq = 0;
  private puffOnCount = 0;
  private puffOffCount = 0;
  private puffing = false;
  private match: ModeMatch | null = null;
  private growthRate = 0;
  private driftRate = 0;
  private fitR2 = 0;
  private source: SourceVerdict | null = null;
  private status: BurnerSnapshot['status'] = 'normal';
  private faultPhase: FaultPhase = 'idle';
  private datasetId: string;
  private modes: ResonanceMode[];
  private latest: ChannelFrame | null = null;

  constructor(ch: number, defaultDatasetId: string, modes: ResonanceMode[]) {
    this.ch = ch;
    this.side = ch < 12 ? 'left' : 'right';
    this.port = (ch % 12) + 1;
    this.datasetId = defaultDatasetId;
    this.modes = modes;
  }

  /** 更换燃烧数据组（联动更新理论模态） */
  setDataset(id: string, modes: ResonanceMode[]): void {
    this.datasetId = id;
    this.modes = modes;
  }

  setModes(modes: ResonanceMode[]): void {
    this.modes = modes;
  }

  setFaultPhase(phase: FaultPhase): void {
    this.faultPhase = phase;
  }

  setSource(v: SourceVerdict | null): void {
    this.source = v;
  }

  setStatus(s: BurnerSnapshot['status']): void {
    this.status = s;
  }

  ingest(frame: ChannelFrame): void {
    this.latest = frame;
    const now = frame.t;

    // ---- 谱峰关联 ----
    const hasTone =
      frame.peakFreq > 0 &&
      frame.peakQ >= PEAK_MIN_Q &&
      frame.peakAmp > 0 &&
      ampToDb(frame.peakAmp) > PEAK_FLOOR_DB;
    let freq = 0;
    if (hasTone) {
      if (
        this.lastPeakFreq > 0 &&
        Math.abs(frame.peakFreq - this.lastPeakFreq) / this.lastPeakFreq <= PEAK_ASSOC_REL
      ) {
        freq = frame.peakFreq;
      } else if (this.lastPeakFreq === 0) {
        freq = frame.peakFreq;
      } else {
        // 频率跳变超 4%：视为旧振荡消失、新振荡建立
        this.peakSamples = [];
        freq = frame.peakFreq;
      }
      this.lastPeakFreq = frame.peakFreq;
      this.match = matchPeakToModes(frame.peakFreq, this.modes);
      this.peakSamples.push({ t: now, freq, ampDb: ampToDb(frame.peakAmp) });
    } else {
      this.lastPeakFreq = 0;
      this.match = null;
    }
    this.trimWindow(this.peakSamples, now);

    // ---- 增长率 / 漂移率回归（15s 窗）----
    if (this.peakSamples.length >= 3) {
      const xs = this.peakSamples.map((p) => p.t - this.peakSamples[0].t);
      const ampFit = linearFit(xs, this.peakSamples.map((p) => p.ampDb));
      const driftFit = linearFit(xs, this.peakSamples.map((p) => p.freq));
      this.growthRate = ampFit.slope;
      this.driftRate = driftFit.slope;
      this.fitR2 = ampFit.r2;
    } else {
      this.growthRate = 0;
      this.driftRate = 0;
      this.fitR2 = 0;
    }

    // ---- 扑扑声迟滞 ----
    if (frame.lowRatio >= PUFF_RATIO_THRESHOLD) {
      this.puffOnCount++;
      this.puffOffCount = 0;
      if (this.puffOnCount >= PUFF_HYSTERESIS_FRAMES) this.puffing = true;
    } else {
      this.puffOffCount++;
      this.puffOnCount = 0;
      if (this.puffOffCount >= PUFF_HYSTERESIS_FRAMES + 2) this.puffing = false;
    }

    // ---- 历史 ----
    this.history.push({
      t: now,
      rmsDb: ampToDb(frame.rms),
      peakFreq: freq,
      peakDb: hasTone ? ampToDb(frame.peakAmp) : -200,
      lowRatio: frame.lowRatio,
    });
    if (this.history.length > HISTORY_CAP) this.history.shift();
  }

  private trimWindow(arr: PeakSample[], now: number): void {
    const cutoff = now - GROWTH_WINDOW_SEC;
    while (arr.length > 2 && arr[0].t < cutoff) arr.shift();
  }

  get snapshot(): BurnerSnapshot {
    const f = this.latest;
    return {
      ch: this.ch,
      side: this.side,
      port: this.port,
      status: this.status,
      t: f?.t ?? 0,
      rms: f?.rms ?? 0,
      rmsDb: f ? ampToDb(f.rms) : -200,
      rmsLow: f?.rmsLow ?? 0,
      lowRatio: f?.lowRatio ?? 0,
      peakFreq: f?.peakFreq ?? 0,
      peakAmp: f?.peakAmp ?? 0,
      peakQ: f?.peakQ ?? 0,
      peakBW: f?.peakBW ?? 0,
      growthRate: this.growthRate,
      driftRate: this.driftRate,
      fitR2: this.fitR2,
      match: this.match,
      source: this.source,
      puffing: this.puffing,
      datasetId: this.datasetId,
      faultPhase: this.faultPhase,
      miniSpectrum: f ? (f.miniSpectrum as number[]) : new Array(48).fill(-100),
    };
  }

  getHistory(): HistPoint[] {
    return this.history;
  }

  getPeakSamples(): PeakSample[] {
    return this.peakSamples;
  }

  get fitConfidence(): number {
    return this.fitR2;
  }

  get hasTrackedPeak(): boolean {
    return this.peakSamples.length >= 3;
  }
}

export function defaultDatasetId(): string {
  return DATASETS[0].id;
}

export function datasetFor(id: string) {
  return getDataset(id);
}
