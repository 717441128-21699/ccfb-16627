/**
 * 同源/串扰判定
 *
 * 每个分析 tick：
 *  1. 把存在跟踪峰且匹配上理论模态的通道，按"模态序号 + 频率相近(≤4%)"聚成同源簇
 *  2. 簇内按峰值幅值排名：最强者判为自身起振(self)，其余判为隔壁串扰(crosstalk)
 *  3. 幅值差 ≥3dB 时高置信；差距小则结合耦合矩阵先验给出置信度
 */
import { CROSSTALK_MARGIN_DB, PEAK_ASSOC_REL, ampToDb } from '../shared/constants';
import { couplingBetween, portOf, sideOf } from './coupling';
import type { BurnerSnapshot, SourceVerdict } from '../shared/types';

interface Cluster {
  channels: number[];
  freqSum: number;
  modeN: number;
}

export function attributeSources(snapshots: BurnerSnapshot[]): Map<number, SourceVerdict> {
  const results = new Map<number, SourceVerdict>();
  const active = snapshots.filter(
    (s) => s.match?.matched && s.peakFreq > 0 && s.peakAmp > 0,
  );
  if (active.length === 0) return results;

  // ---- 聚类 ----
  const clusters: Cluster[] = [];
  for (const s of active) {
    const modeN = s.match!.mode.n;
    let hit: Cluster | null = null;
    for (const c of clusters) {
      if (c.modeN !== modeN) continue;
      const center = c.freqSum / c.channels.length;
      if (Math.abs(s.peakFreq - center) / center <= PEAK_ASSOC_REL) {
        hit = c;
        break;
      }
    }
    if (hit) {
      hit.channels.push(s.ch);
      hit.freqSum += s.peakFreq;
    } else {
      clusters.push({ channels: [s.ch], freqSum: s.peakFreq, modeN });
    }
  }

  // ---- 簇内裁决 ----
  const byCh = new Map(snapshots.map((s) => [s.ch, s]));
  for (const c of clusters) {
    const members = c.channels
      .map((ch) => byCh.get(ch))
      .filter((s): s is BurnerSnapshot => !!s)
      .sort((a, b) => ampToDb(b.peakAmp) - ampToDb(a.peakAmp));
    const leader = members[0];
    const secondDb = members[1] ? ampToDb(members[1].peakAmp) : -Infinity;
    const leaderDb = ampToDb(leader.peakAmp);
    const margin = leaderDb - secondDb;
    const clusterFreq = c.freqSum / c.channels.length;

    members.forEach((s, rank) => {
      if (rank === 0) {
        // 声源通道：领先越大置信越高；并列时若物理上远离其他强通道也保持 self
        const confidence =
          margin === Infinity ? 0.95 : Math.max(0.55, Math.min(0.95, 0.55 + margin / 10));
        results.set(s.ch, {
          origin: 'self',
          sourceCh: s.ch,
          rank: 0,
          cluster: c.channels.slice(),
          clusterFreq,
          coupling: 1,
          confidence,
        });
      } else {
        const k = couplingBetween(leader.ch, s.ch);
        // 与声源相邻/同测 → 串扰先验强；对侧弱耦合却收到强信号 → 置信降低
        const sameSide = sideOf(leader.ch) === sideOf(s.ch);
        const proximity = sameSide ? 1 - Math.min(1, Math.abs(portOf(leader.ch) - portOf(s.ch)) / 6) : 0.2;
        const marginConf = margin === Infinity ? 0.9 : Math.max(0.4, Math.min(0.9, 0.4 + margin / 8));
        const confidence = Math.round(Math.min(0.92, marginConf * 0.6 + (0.4 * k + 0.3 * proximity)) * 100) / 100;
        results.set(s.ch, {
          origin: 'crosstalk',
          sourceCh: leader.ch,
          rank,
          cluster: c.channels.slice(),
          clusterFreq,
          coupling: k,
          confidence,
        });
      }
    });
  }
  return results;
}
