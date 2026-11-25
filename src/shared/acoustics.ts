/**
 * 声学物理：声速、小炉通道驻波共振频率、模态匹配
 *
 * 小炉（port）通道可近似为一端开口（熔窑大碹空间，近似压力释放端）
 * 一端封闭（烧嘴端，刚性壁）的声学管路：
 *   - 四分之一波长模型（开口-封闭）：f_n = (2n-1)·c / (4L_eff)，仅奇次
 *   - 半波长模型（两端近似开口或封闭-封闭）：f_n = n·c / (2L_eff)
 * L_eff 计入开口端修正 ΔL ≈ 0.6·R（R 为通道等效水力半径）。
 */
import type { CombustionDataset, ModeMatch, ResonanceMode } from './types';
import { MODE_MATCH_TOLERANCE } from './constants';

/** 烟气声速 c = sqrt(γ R_specific T)，T 为绝对温度 */
export function soundSpeed(gamma: number, gasR: number, tempC: number): number {
  const T = tempC + 273.15;
  return Math.sqrt(gamma * gasR * T);
}

/** 开口端修正长度 */
export function endCorrection(hydraulicRadius: number): number {
  return 0.6 * hydraulicRadius;
}

export interface ChannelGeometry {
  /** 通道长度 m */
  length: number;
  /** 等效水力半径 m（截面积/湿周，矩形通道 = ab/(2(a+b))） */
  hydraulicRadius: number;
  model: 'half-wave' | 'quarter-wave';
  /** 计算模态数上限 */
  maxModes?: number;
}

/**
 * 计算通道的全部声学共振模态
 * @param c 烟气声速 m/s
 */
export function resonanceModes(c: number, geo: ChannelGeometry): ResonanceMode[] {
  const L = geo.length + endCorrection(geo.hydraulicRadius);
  const maxN = geo.maxModes ?? 5;
  const modes: ResonanceMode[] = [];
  for (let n = 1; n <= maxN; n++) {
    const freq =
      geo.model === 'quarter-wave'
        ? ((2 * n - 1) * c) / (4 * L)
        : (n * c) / (2 * L);
    modes.push({ n, freq, model: geo.model });
  }
  return modes;
}

/**
 * 实测峰值与理论模态匹配，找偏差最小者并判定是否落在 5% 容差内
 */
export function matchPeakToModes(
  peakFreq: number,
  modes: ResonanceMode[],
  tolerance = MODE_MATCH_TOLERANCE,
): ModeMatch | null {
  if (peakFreq <= 0 || modes.length === 0) return null;
  let best: ModeMatch | null = null;
  for (const mode of modes) {
    const errorPct = Math.abs(peakFreq - mode.freq) / mode.freq * 100;
    if (!best || errorPct < best.errorPct) {
      best = { mode, errorPct, matched: errorPct <= tolerance * 100 };
    }
  }
  return best;
}

/** 温度漂移导致的共振频率变化（用于解释频率漂移） */
export function frequencyForTemp(mode: ResonanceMode, baseC: number, c: number): number {
  return mode.freq * (c / baseC);
}
