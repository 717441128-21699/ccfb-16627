/**
 * 燃料 × 窑型燃烧数据组（6 组）
 *
 * 空燃比 λ 从 1.05 降到 0.95 的过程中，热声振荡峰幅值"先升后降"：
 * 进入燃烧手册给出的热声不稳定区间后幅值迅速抬升，区间中心附近最剧烈，
 * 越过富燃边界后因反应速率与放热耦合减弱而回落。
 */
import type { CombustionDataset, FuelKind, FurnaceKind, LambdaPoint } from './types';
import { soundSpeed } from './acoustics';

interface RawSpec {
  id: string;
  label: string;
  fuel: FuelKind;
  furnace: FurnaceKind;
  gamma: number;
  gasR: number;
  portLength: number;
  hydraulicRadius: number;
  endModel: 'half-wave' | 'quarter-wave';
  furnaceTempC: number;
  /** 不稳定空燃比区间 [富燃边界, 贫燃边界] */
  unstableLambda: [number, number];
  /** 区间中心振荡峰相对基底的抬升量 dB */
  peakHeightDb: number;
  /** 典型起振模态序号（1=基频） */
  typicalMode: number;
  note: string;
}

const SPECS: RawSpec[] = [
  {
    id: 'ng-float',
    label: '天然气 · 浮法窑',
    fuel: '天然气',
    furnace: '浮法窑',
    gamma: 1.34,
    gasR: 287,
    portLength: 4.2,
    hydraulicRadius: 0.55,
    endModel: 'quarter-wave',
    furnaceTempC: 1520,
    unstableLambda: [0.98, 1.02],
    peakHeightDb: 26,
    typicalMode: 2,
    note: '甲烷燃烧烟气含湿量高，γ 偏低；小炉长 4.2m，二阶（3λ/4）模态最易被放热脉动激发',
  },
  {
    id: 'pg-horsehoe',
    label: '发生炉煤气 · 马蹄焰窑',
    fuel: '发生炉煤气',
    furnace: '马蹄焰窑',
    gamma: 1.36,
    gasR: 292,
    portLength: 3.4,
    hydraulicRadius: 0.48,
    endModel: 'quarter-wave',
    furnaceTempC: 1450,
    unstableLambda: [0.96, 1.01],
    peakHeightDb: 24,
    typicalMode: 1,
    note: '煤气热值波动大、含 N₂/CO，不稳定区间偏富燃；基频模态约 60Hz 起振',
  },
  {
    id: 'oil-cross',
    label: '重油 · 横火焰窑',
    fuel: '重油',
    furnace: '横火焰窑',
    gamma: 1.33,
    gasR: 285,
    portLength: 3.8,
    hydraulicRadius: 0.5,
    endModel: 'half-wave',
    furnaceTempC: 1560,
    unstableLambda: [0.975, 1.015],
    peakHeightDb: 28,
    typicalMode: 1,
    note: '雾化重油放热集中，双开端半波模型；区间窄但峰最尖，Q 值高，回火风险最大',
  },
  {
    id: 'cog-float',
    label: '焦炉煤气 · 浮法窑',
    fuel: '焦炉煤气',
    furnace: '浮法窑',
    gamma: 1.35,
    gasR: 290,
    portLength: 4.0,
    hydraulicRadius: 0.52,
    endModel: 'quarter-wave',
    furnaceTempC: 1500,
    unstableLambda: [0.97, 1.02],
    peakHeightDb: 25,
    typicalMode: 2,
    note: '富氢燃料火焰传播速度快，λ 偏离化学计量比时流速-火焰面耦合敏感',
  },
  {
    id: 'pc-horsehoe',
    label: '石油焦粉 · 马蹄焰窑',
    fuel: '石油焦粉',
    furnace: '马蹄焰窑',
    gamma: 1.32,
    gasR: 284,
    portLength: 3.6,
    hydraulicRadius: 0.46,
    endModel: 'quarter-wave',
    furnaceTempC: 1420,
    unstableLambda: [0.955, 1.0],
    peakHeightDb: 22,
    typicalMode: 1,
    note: '颗粒燃烧时延大，振荡带偏宽、Q 值略低；不稳定区间整体偏向富燃侧',
  },
  {
    id: 'bio-boost',
    label: '沼气 · 电助熔配合窑',
    fuel: '沼气',
    furnace: '电助熔配合窑',
    gamma: 1.35,
    gasR: 291,
    portLength: 2.8,
    hydraulicRadius: 0.4,
    endModel: 'half-wave',
    furnaceTempC: 1380,
    unstableLambda: [0.985, 1.03],
    peakHeightDb: 23,
    typicalMode: 1,
    note: 'CO₂ 稀释使燃烧速度低、区间偏贫燃；短通道基频高，约 140Hz 量级',
  },
];

/** 基底噪声级 dBFS（宽带呼呼声对应的谱底） */
const BASE_FLOOR_DB = -58;

/**
 * 生成 λ 1.05→0.95 曲线（步长 0.01，共 11 点）
 * 不稳定区间内 sin^0.8 钟形凸起，区间外保持基底、边界处留肩部过渡
 */
export function buildLambdaCurve(spec: RawSpec): LambdaPoint[] {
  const [lo, hi] = spec.unstableLambda;
  const points: LambdaPoint[] = [];
  for (let i = 0; i <= 10; i++) {
    const lambda = round2(1.05 - i * 0.01);
    const unstable = lambda >= lo - 1e-9 && lambda <= hi + 1e-9;
    let peakDb = BASE_FLOOR_DB;
    if (unstable) {
      const x = (lambda - lo) / (hi - lo); // 0..1
      const bell = Math.pow(Math.sin(Math.PI * x), 0.8);
      // 边界处保留 6dB 肩部，中心达到满幅
      peakDb = BASE_FLOOR_DB + 6 + spec.peakHeightDb * bell;
    } else {
      // 区间外侧邻近点留 2dB 肩部，体现边界过渡
      const dist = lambda > hi ? lambda - hi : lo - lambda;
      if (dist <= 0.015) peakDb = BASE_FLOOR_DB + 2;
    }
    points.push({ lambda, peakDb: round1(peakDb), unstable });
  }
  return points;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function buildDataset(spec: RawSpec): CombustionDataset {
  const c = soundSpeed(spec.gamma, spec.gasR, spec.furnaceTempC);
  const L = spec.portLength + 0.6 * spec.hydraulicRadius;
  const fundamental =
    spec.endModel === 'quarter-wave' ? c / (4 * L) : c / (2 * L);
  const modeFactor =
    spec.endModel === 'quarter-wave' ? 2 * spec.typicalMode - 1 : spec.typicalMode;
  const typicalOscFreq =
    spec.endModel === 'quarter-wave'
      ? ((2 * spec.typicalMode - 1) * c) / (4 * L)
      : (spec.typicalMode * c) / (2 * L);
  return {
    id: spec.id,
    label: spec.label,
    fuel: spec.fuel,
    furnace: spec.furnace,
    gamma: spec.gamma,
    gasR: spec.gasR,
    portLength: spec.portLength,
    endModel: spec.endModel,
    furnaceTempC: spec.furnaceTempC,
    soundSpeed: Math.round(c * 10) / 10,
    fundamental: Math.round(fundamental * 10) / 10,
    unstableLambda: spec.unstableLambda,
    lambdaCurve: buildLambdaCurve(spec),
    typicalOscFreq: Math.round(typicalOscFreq * 10) / 10,
    note: `${spec.note}；声速 ${Math.round(c)}m/s，模态因子 ${modeFactor}`,
  };
}

export const DATASETS: CombustionDataset[] = SPECS.map(buildDataset);

export function getDataset(id: string): CombustionDataset {
  return DATASETS.find((d) => d.id === id) ?? DATASETS[0];
}
