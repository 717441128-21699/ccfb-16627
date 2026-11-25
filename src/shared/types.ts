/**
 * 共享类型定义（主线程与 AudioWorklet 之间通过 postMessage 传递的均为结构化克隆数据）
 */

/** 窑体侧别 */
export type Side = 'left' | 'right';

/** 燃烧器综合状态 */
export type BurnerStatus = 'normal' | 'watch' | 'warning' | 'danger' | 'event';

/** 告警等级 */
export type AlertLevel = 'watch' | 'warning' | 'danger';

/** 告警判定状态（未结束/已解除） */
export type AlertState = 'active' | 'resolved';

/** 仿真故障阶段（正常 → 起振 → 增长 → 临脱火 → 恢复） */
export type FaultPhase = 'idle' | 'onset' | 'growth' | 'critical' | 'recovery';

/** 燃烧数据组适用的窑型 */
export type FurnaceKind = '浮法窑' | '马蹄焰窑' | '横火焰窑' | '电助熔配合窑';

/** 燃料种类 */
export type FuelKind = '天然气' | '发生炉煤气' | '重油' | '焦炉煤气' | '石油焦粉' | '沼气';

/** AnalyzerWorklet 每帧上报的单路结果 */
export interface ChannelFrame {
  /** 燃烧器编号 0..23 */
  ch: number;
  /** 时间戳（AudioContext.currentTime，秒） */
  t: number;
  /** 全频带 RMS，线性幅值 */
  rms: number;
  /** 低频段（5–40Hz）RMS，用于扑扑声检测 */
  rmsLow: number;
  /** 低频能量占比 0..1 */
  lowRatio: number;
  /** 最强谱峰频率 Hz（无峰时为 0） */
  peakFreq: number;
  /** 最强谱峰线性幅值 */
  peakAmp: number;
  /** 峰值处 -3dB 带宽 Hz */
  peakBW: number;
  /** 峰品质因数 f/BW */
  peakQ: number;
  /** 对数频谱（48 个 log-spaced bin），单位 dBFS */
  miniSpectrum: Float32Array | number[];
  /** 单路页请求时的完整 4096 点频谱（dBFS，长度 N/2） */
  detailSpectrum?: Float32Array | number[];
}

export type AnalyzerMessage =
  | { type: 'frame'; frame: ChannelFrame }
  | { type: 'detail'; ch: number; t: number; spectrum: Float32Array | number[] };

/** 换火事件（换火周期页数据源） */
export interface ReversalEvent {
  id: number;
  /** 触发时刻，墙钟 ms */
  startedAt: number;
  /** 换火持续时间，秒 */
  durationSec: number;
  /** 换向前的燃烧侧 */
  firingBefore: Side;
  /** 换向之后的燃烧侧 */
  firingAfter: Side;
  kind: 'auto' | 'manual';
}

/** 风机启停事件（正常声音变化门控依据之一） */
export interface FanEvent {
  id: number;
  at: number;
  running: boolean;
  reason: 'schedule' | 'manual';
}

/** 单个共振模态（按小炉通道长度+炉温计算） */
export interface ResonanceMode {
  /** 模态序号 1,2,3... */
  n: number;
  /** 理论共振频率 Hz */
  freq: number;
  /** 半波/四分之一波长模型 */
  model: 'half-wave' | 'quarter-wave';
}

/** 谱峰与理论模态的匹配结果 */
export interface ModeMatch {
  mode: ResonanceMode;
  /** 相对偏差（绝对值，百分数，如 3.2 表示 3.2%） */
  errorPct: number;
  matched: boolean;
}

/** 谱峰跟踪记录（Tracker 内部使用） */
export interface PeakTrack {
  freq: number;
  amp: number;
  q: number;
  bw: number;
  t: number;
  match: ModeMatch | null;
}

/** 同源/串扰判定结果 */
export interface SourceVerdict {
  /** 本路判定：自身起振 or 隔壁传来 */
  origin: 'self' | 'crosstalk';
  /** 判定为声源的燃烧器编号；自身时等于本路 */
  sourceCh: number;
  /** 本路在同源簇中的能量排名（0 = 最强） */
  rank: number;
  /** 簇内通道编号 */
  cluster: number[];
  /** 簇中心频率 Hz */
  clusterFreq: number;
  /** 串扰耦合系数（来自耦合矩阵，0..1） */
  coupling: number;
  confidence: number;
}

/** 每路燃烧器的实时分析快照（供 UI 使用） */
export interface BurnerSnapshot {
  ch: number;
  side: Side;
  port: number;
  status: BurnerStatus;
  t: number;
  rms: number;
  rmsDb: number;
  rmsLow: number;
  lowRatio: number;
  peakFreq: number;
  peakAmp: number;
  peakQ: number;
  peakBW: number;
  /** 幅值增长率 dB/s（15s 最小二乘） */
  growthRate: number;
  /** 频率漂移率 Hz/s（15s 线性回归） */
  driftRate: number;
  /** 增长率回归拟合优度 R²（<0.5 不报警） */
  fitR2: number;
  match: ModeMatch | null;
  source: SourceVerdict | null;
  /** 扑扑声活跃 */
  puffing: boolean;
  /** 当前使用的燃烧数据组 id */
  datasetId: string;
  /** 仿真故障阶段（真实硬件模式下恒为 idle） */
  faultPhase: FaultPhase;
  miniSpectrum: number[];
}

/** 预警记录（预警记录页数据源，持久化到 localStorage） */
export interface AlertRecord {
  id: string;
  level: AlertLevel;
  ch: number;
  startedAt: number;
  /** 解除时刻，未解除为 null */
  resolvedAt: number | null;
  /** 触发时刻的峰值频率 */
  peakFreq: number;
  /** 触发时刻增长率 dB/s */
  growthRate: number;
  /** 与理论模态的偏差 % */
  errorPct: number;
  /** 匹配上的模态序号 */
  modeN: number | null;
  origin: 'self' | 'crosstalk';
  sourceCh: number;
  puffing: boolean;
  /** 事件门控原因，被抑制时记录 */
  suppressedBy?: 'reversal' | 'fan' | null;
  message: string;
  /** 证据链：触发前若干秒的 (t, freq, ampDb) 采样 */
  evidence: Array<{ t: number; freq: number; ampDb: number }>;
}

/** 燃烧数据组（燃料 × 窑型） */
export interface CombustionDataset {
  id: string;
  label: string;
  fuel: FuelKind;
  furnace: FurnaceKind;
  /** 燃气绝热/烟气定压比热比 */
  gamma: number;
  /** 烟气比气体常数 J/(kg·K) */
  gasR: number;
  /** 小炉通道长度 m */
  portLength: number;
  /** 通道声学模型 */
  endModel: 'half-wave' | 'quarter-wave';
  /** 炉内温度 ℃ */
  furnaceTempC: number;
  /** 计算声速 m/s */
  soundSpeed: number;
  /** 基频 Hz */
  fundamental: number;
  /** 空燃比不稳定区间 [下限, 上限] */
  unstableLambda: [number, number];
  /** λ 曲线采样点 */
  lambdaCurve: LambdaPoint[];
  /** 典型热声振荡频率（用于仿真与核对） */
  typicalOscFreq: number;
  note: string;
}

export interface LambdaPoint {
  lambda: number;
  /** 振荡峰相对幅值 dB */
  peakDb: number;
  unstable: boolean;
}

/** 仿真工作路每路状态（主线程 → SimulatorWorklet） */
export interface SimChannelState {
  ch: number;
  /** 宽带燃烧噪声增益 0..1 */
  noiseGain: number;
  /** 振荡音增益 0..1 */
  toneGain: number;
  /** 振荡频率 Hz */
  toneFreq: number;
  /** 频率漂移目标 Hz（worklet 内部平滑趋近） */
  targetFreq: number;
  /** 扑扑声增益 0..1 */
  puffGain: number;
  /** 扑扑基频 Hz */
  puffFreq: number;
  /** 扑扑调制随机开关占空 */
  puffDuty: number;
  /** 换火静音系数 0..1（换火时该侧下降） */
  mute: number;
  /** 风机带通扰动增益 */
  fanGain: number;
}

export type SimulatorControl =
  | { type: 'state'; states: SimChannelState[] }
  | { type: 'fan'; running: boolean }
  | { type: 'monitor'; ch: number; gain: number }
  | { type: 'trigger' };
