/**
 * 24 路拾音器声学耦合矩阵（主线程侧，与 simulator-worklet 中的布置一致）
 * 用于源判定：同一振荡峰被多个拾音器收到时，按能量排名 + 耦合先验裁决声源
 */
import { CHANNEL_COUNT, PORTS_PER_SIDE } from '../shared/constants';

export function sideOf(ch: number): 0 | 1 {
  return ch < PORTS_PER_SIDE ? 0 : 1;
}

export function portOf(ch: number): number {
  return ch % PORTS_PER_SIDE;
}

let matrix: Float32Array | null = null;

export function couplingMatrix(): Float32Array {
  if (matrix) return matrix;
  const m = new Float32Array(CHANNEL_COUNT * CHANNEL_COUNT);
  for (let i = 0; i < CHANNEL_COUNT; i++) {
    for (let j = 0; j < CHANNEL_COUNT; j++) {
      if (i === j) {
        m[i * CHANNEL_COUNT + j] = 1;
        continue;
      }
      if (sideOf(i) === sideOf(j)) {
        const d = Math.abs(portOf(i) - portOf(j));
        m[i * CHANNEL_COUNT + j] = d === 1 ? 0.18 : d === 2 ? 0.06 : 0.02;
      } else {
        m[i * CHANNEL_COUNT + j] = 0.01;
      }
    }
  }
  matrix = m;
  return m;
}

export function couplingBetween(a: number, b: number): number {
  return couplingMatrix()[a * CHANNEL_COUNT + b];
}
