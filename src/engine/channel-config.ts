/**
 * 24 路通道静态配置：6 组燃料×窑型数据轮流分配，每组 4 支燃烧器；
 * 每路带独立炉温偏差，理论模态随之略有差异（真实窑炉温差的体现）
 */
import { resonanceModes } from '../shared/acoustics';
import { DATASETS } from '../shared/datasets';
import { soundSpeed } from '../shared/acoustics';
import type { ResonanceMode } from '../shared/types';

export interface ChannelConfig {
  ch: number;
  datasetId: string;
  /** 相对数据组基准炉温的偏差 ℃ */
  tempOffsetC: number;
  /** 当前炉温 ℃ */
  tempC: number;
  soundSpeed: number;
  modes: ResonanceMode[];
}

const TEMP_OFFSETS = [-28, -12, 8, 24];

export function buildChannelConfigs(): ChannelConfig[] {
  const configs: ChannelConfig[] = [];
  for (let ch = 0; ch < 24; ch++) {
    const ds = DATASETS[Math.floor(ch / 4) % DATASETS.length];
    const tempOffsetC = TEMP_OFFSETS[ch % 4];
    const tempC = ds.furnaceTempC + tempOffsetC;
    const c = soundSpeed(ds.gamma, ds.gasR, tempC);
    const hydraulicRadius =
      ds.id === 'ng-float'
        ? 0.55
        : ds.id === 'pg-horsehoe'
          ? 0.48
          : ds.id === 'oil-cross'
            ? 0.5
            : ds.id === 'cog-float'
              ? 0.52
              : ds.id === 'pc-horsehoe'
                ? 0.46
                : 0.4;
    const modes = resonanceModes(c, {
      length: ds.portLength,
      hydraulicRadius,
      model: ds.endModel,
      maxModes: 5,
    });
    configs.push({
      ch,
      datasetId: ds.id,
      tempOffsetC,
      tempC,
      soundSpeed: Math.round(c * 10) / 10,
      modes,
    });
  }
  return configs;
}

/** 数据组在自定义炉温下的模态（λ 扫描/参数页用） */
export function modesForDataset(datasetId: string, tempC: number): ResonanceMode[] {
  const ds = DATASETS.find((d) => d.id === datasetId) ?? DATASETS[0];
  const c = soundSpeed(ds.gamma, ds.gasR, tempC);
  const radiusMap: Record<string, number> = {
    'ng-float': 0.55,
    'pg-horsehoe': 0.48,
    'oil-cross': 0.5,
    'cog-float': 0.52,
    'pc-horsehoe': 0.46,
    'bio-boost': 0.4,
  };
  return resonanceModes(c, {
    length: ds.portLength,
    hydraulicRadius: radiusMap[ds.id] ?? 0.5,
    model: ds.endModel,
    maxModes: 5,
  });
}
