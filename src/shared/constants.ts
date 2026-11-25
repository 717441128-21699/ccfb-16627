/**
 * 全局常量
 */

/** 燃烧器/拾音器路数 */
export const CHANNEL_COUNT = 24;

/** 每侧小炉数量（左 12 支 + 右 12 支） */
export const PORTS_PER_SIDE = CHANNEL_COUNT / 2;

/** 仿真与分析统一采样率 Hz（16kHz 兼顾低频分辨率与 24 路算力） */
export const TARGET_SAMPLE_RATE = 16000;

/** AnalyzerWorklet FFT 点数（16kHz 下 Δf≈3.9Hz，插值后精度约 1Hz） */
export const FFT_SIZE = 4096;

/** FFT 帧移样本数（约 8Hz 上报率） */
export const HOP_SIZE = 2048;

/** 上报频谱的 log bin 数量 */
export const MINI_BINS = 48;

/** 频谱显示/分析频率范围 Hz */
export const F_MIN = 8;
export const F_MAX = 4000;

/** 低频扑扑声检测频段 Hz */
export const PUFF_F_MIN = 5;
export const PUFF_F_MAX = 40;

/** 共振频率匹配允许偏差 5%（需求 1） */
export const MODE_MATCH_TOLERANCE = 0.05;

/** 增长率转正报警的最小置信次数 */
export const GROWTH_ALARM_FRAMES = 3;

/** 增长率观察窗（秒）与最小样本数 */
export const GROWTH_WINDOW_SEC = 15;

/** 峰跟踪：相邻帧频率关联最大相对偏差 */
export const PEAK_ASSOC_REL = 0.04;

/** 被认定为窄带振荡峰的最小 Q 值 */
export const PEAK_MIN_Q = 4;

/** 起振告警最小峰值 dBFS */
export const PEAK_FLOOR_DB = -62;

/** 三级告警增长率阈值 dB/s */
export const GROWTH_WATCH_DB_S = 0.6;
export const GROWTH_WARNING_DB_S = 1.8;
export const GROWTH_DANGER_DB_S = 4.0;

/** 源判定：簇内最强与次强幅值差小于该 dB 时仍按耦合矩阵裁决 */
export const CROSSTALK_MARGIN_DB = 3;

/** 换火事件持续时间（秒）与告警抑制窗口 */
export const REVERSAL_DURATION_SEC = 75;
export const REVERSAL_GUARD_SEC = 90;

/** 换火周期（秒，浮法窑典型 20 min） */
export const REVERSAL_PERIOD_SEC = 20 * 60;

/** 风机启停告警抑制窗口（秒） */
export const FAN_GUARD_SEC = 4;

/** 扑扑判定：低频占比阈值与连续帧要求 */
export const PUFF_RATIO_THRESHOLD = 0.32;
export const PUFF_HYSTERESIS_FRAMES = 2;

/** 告警自动解除观察时间（秒） */
export const ALERT_CLEAR_SEC = 6;

/** 告警 localStorage 键与最大保存条数 */
export const ALERT_STORE_KEY = 'bam.alerts.v1';
export const ALERT_MAX_STORE = 500;

/** 每路历史环形缓冲长度（约 8Hz × 300s） */
export const HISTORY_SEC = 300;
export const HISTORY_CAP = 8 * HISTORY_SEC;

/** 单路页详细频谱请求节流 ms */
export const DETAIL_REQUEST_MS = 120;

/** dBFS 与线性幅值换算辅助 */
export const EPS = 1e-10;
export function ampToDb(a: number): number {
  return 20 * Math.log10(Math.max(a, EPS));
}
