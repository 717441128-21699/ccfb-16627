/**
 * 最小二乘线性回归工具
 */
export interface LinearFit {
  /** 斜率 */
  slope: number;
  /** 截距 */
  intercept: number;
  /** 样本数 */
  n: number;
  /** 拟合优度 R² */
  r2: number;
}

export function linearFit(xs: number[], ys: number[]): LinearFit {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? ys[0] : 0, n, r2: 0 };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
    syy += ys[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) {
    return { slope: 0, intercept: sy / n, n, r2: 0 };
  }
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const ssTot = syy - (sy * sy) / n;
  const ssRes =
    ssTot - slope * (sxy - (sx * sy) / n);
  const r2 = ssTot > 1e-12 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : 0;
  return { slope, intercept, n, r2 };
}
