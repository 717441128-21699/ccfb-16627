/**
 * 无头自检（tsx 运行，不依赖浏览器）：
 *  1. 声学共振频率与 5% 模态匹配
 *  2. 6 组燃料×窑型数据完整性 + λ 1.05→0.95 先升后降 + 不稳定区间边界一致性
 *  3. 最小二乘回归（增长率/漂移率）
 *  4. 串扰源判定
 *  5. 告警引擎准则：模态偏差>5% 不报警、增长率非正不报警、门控抑制、串扰不报警
 */
import { resonanceModes, matchPeakToModes, soundSpeed } from '../src/shared/acoustics';
import { DATASETS } from '../src/shared/datasets';
import { linearFit } from '../src/engine/regression';
import { attributeSources } from '../src/engine/source-attribution';
import { AlertEngine } from '../src/engine/alert-engine';
import type { GuardState } from '../src/engine/event-manager';
import type { BurnerSnapshot } from '../src/shared/types';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

function approx(a: number, b: number, rel = 0.05): boolean {
  return Math.abs(a - b) / b <= rel;
}

console.log('\n[1] 声学物理：声速与共振模态');
{
  const c = soundSpeed(1.34, 287, 1520);
  check('1520℃ 烟气声速在 800–950 m/s 合理区间', c > 800 && c < 950, `got ${c.toFixed(1)}`);
  const modes = resonanceModes(c, { length: 4.2, hydraulicRadius: 0.55, model: 'quarter-wave' });
  check('1/4 波长模型只产生奇次模态序列', approx(modes[1].freq, modes[0].freq * 3, 0.01));
  check('基频为 c/(4L_eff)', approx(modes[0].freq, c / (4 * (4.2 + 0.6 * 0.55)), 0.005));
  const m = matchPeakToModes(modes[1].freq * 1.03, modes)!;
  check('偏差 3% 的峰匹配成功', m.matched && m.errorPct < 5);
  const m2 = matchPeakToModes(modes[1].freq * 1.08, modes)!;
  check('偏差 8% 的峰匹配失败', !m2.matched && m2.errorPct > 5);
  const hw = resonanceModes(c, { length: 3.8, hydraulicRadius: 0.5, model: 'half-wave' });
  check('1/2 波长模型模态为整数倍', approx(hw[1].freq, hw[0].freq * 2, 0.01));
}

console.log('\n[2] 燃烧数据组：6 组燃料×窑型与 λ 先升后降');
{
  check('数据组数量为 6', DATASETS.length === 6);
  const fuels = new Set(DATASETS.map((d) => d.fuel));
  const furnaces = new Set(DATASETS.map((d) => d.furnace));
  check('覆盖 6 种燃料', fuels.size === 6, `got ${fuels.size}`);
  check('覆盖 4 种窑型', furnaces.size === 4, `got ${furnaces.size}`);

  for (const ds of DATASETS) {
    const curve = ds.lambdaCurve;
    check(`${ds.label} 曲线含 11 个 λ 采样(1.05→0.95)`, curve.length === 11 && approx(curve[0].lambda, 1.05, 0.001) && approx(curve[10].lambda, 0.95, 0.001));
    const [lo, hi] = ds.unstableLambda;
    // 不稳定区间内必有显著抬升
    const inside = curve.filter((p) => p.unstable);
    const outside = curve.filter((p) => !p.unstable);
    check(`${ds.label} 不稳定区间标记与 [lo,hi] 一致`, inside.every((p) => p.lambda >= lo - 1e-9 && p.lambda <= hi + 1e-9));
    const maxInside = Math.max(...inside.map((p) => p.peakDb));
    const maxOutside = Math.max(...outside.map((p) => p.peakDb));
    check(`${ds.label} 区间内峰值高于区间外（先升后降的“升”）`, maxInside > maxOutside + 8, `${maxInside.toFixed(1)} vs ${maxOutside.toFixed(1)}`);
    // 先升后降：沿 λ 递减方向，幅值先增后减，单峰
    let inc = 0;
    let dec = 0;
    let phase: 'up' | 'down' | 'flat' = 'flat';
    let monotonic = true;
    for (let i = 1; i < curve.length; i++) {
      const diff = curve[i].peakDb - curve[i - 1].peakDb;
      if (diff > 1) {
        inc++;
        if (phase === 'down') monotonic = false;
        phase = 'up';
      } else if (diff < -1) {
        dec++;
        if (phase === 'up') phase = 'down';
      }
    }
    check(`${ds.label} 曲线单峰先升后降`, monotonic === true && inc >= 2 && dec >= 2, `inc=${inc} dec=${dec}`);
    // 峰中心位于不稳定区间内部
    const peakPoint = curve.reduce((a, b) => (b.peakDb > a.peakDb ? b : a));
    check(`${ds.label} 峰值点落在不稳定区间内`, peakPoint.lambda >= lo - 1e-9 && peakPoint.lambda <= hi + 1e-9, `λ=${peakPoint.lambda}`);
    // 典型振荡频率与该组模态对得上（≤5%）
    const modes = resonanceModes(ds.soundSpeed, {
      length: ds.portLength,
      hydraulicRadius: 0.5,
      model: ds.endModel,
    });
    const match = matchPeakToModes(ds.typicalOscFreq, modes)!;
    check(`${ds.label} 典型振荡频率 ${ds.typicalOscFreq}Hz 与理论模态偏差≤5%`, match.matched, `err=${match.errorPct.toFixed(2)}%`);
  }
}

console.log('\n[3] 最小二乘回归');
{
  const xs = [0, 1, 2, 3, 4];
  const ys = xs.map((x) => 2 * x + 1);
  const fit = linearFit(xs, ys);
  check('精确直线斜率=2、R²=1', approx(fit.slope, 2, 1e-9) && approx(fit.r2, 1, 1e-9));
  const noisy = linearFit(xs, xs.map((x) => 2 * x + 1 + (x % 2 ? 0.3 : -0.3)));
  check('含噪直线 R² 仍 >0.95', noisy.r2 > 0.95);
  const flat = linearFit(xs, [5, 5, 5, 5, 5]);
  check('恒定序列斜率为 0', flat.slope === 0);
}

console.log('\n[4] 同源/串扰源判定');
{
  const base = (ch: number, overrides: Partial<BurnerSnapshot>): BurnerSnapshot => ({
    ch,
    side: ch < 12 ? 'left' : 'right',
    port: (ch % 12) + 1,
    status: 'normal',
    t: 0,
    rms: 0.01,
    rmsDb: -40,
    rmsLow: 0.001,
    lowRatio: 0.1,
    peakFreq: 0,
    peakAmp: 0,
    peakQ: 10,
    peakBW: 10,
    growthRate: 0,
    driftRate: 0,
    fitR2: 0.9,
    match: null,
    source: null,
    puffing: false,
    datasetId: 'ng-float',
    faultPhase: 'idle',
    miniSpectrum: [],
    ...overrides,
  });
  const mode = resonanceModes(880, { length: 4.2, hydraulicRadius: 0.55, model: 'quarter-wave' })[1];
  const mkMatch = (freq: number) => matchPeakToModes(freq, resonanceModes(880, { length: 4.2, hydraulicRadius: 0.55, model: 'quarter-wave' }))!;
  const snaps = [
    base(3, { peakFreq: mode.freq, peakAmp: 0.05, match: mkMatch(mode.freq) }),
    base(4, { peakFreq: mode.freq * 1.01, peakAmp: 0.012, match: mkMatch(mode.freq * 1.01) }), // 相邻，弱
    base(5, { peakFreq: mode.freq * 1.02, peakAmp: 0.006, match: mkMatch(mode.freq * 1.02) }),
  ];
  const verdicts = attributeSources(snaps);
  check('最强通道判为自身起振', verdicts.get(3)?.origin === 'self');
  check('相邻弱通道判为串扰并指向 CH3', verdicts.get(4)?.origin === 'crosstalk' && verdicts.get(4)?.sourceCh === 3);
  check('串扰簇包含全部 3 路', (verdicts.get(5)?.cluster.includes(3) ?? false) && (verdicts.get(5)?.cluster.length === 3));
}

console.log('\n[5] 告警引擎准则');
{
  const events: string[] = [];
  const engine = new AlertEngine({
    onRaise: (r) => events.push(`raise:${r.ch}`),
    onUpgrade: () => events.push('upgrade'),
    onResolve: () => events.push('resolve'),
    onSuppress: (r) => events.push(`suppress:${r.ch}`),
  });

  const snap = (over: Partial<BurnerSnapshot>): BurnerSnapshot => ({
    ch: 0,
    side: 'left',
    port: 1,
    status: 'normal',
    t: 0,
    rms: 0.01,
    rmsDb: -40,
    rmsLow: 0.001,
    lowRatio: 0.1,
    peakFreq: 120,
    peakAmp: 0.04,
    peakQ: 12,
    peakBW: 8,
    growthRate: 2.5,
    driftRate: 0.2,
    fitR2: 0.92,
    match: { mode: { n: 1, freq: 120, model: 'quarter-wave' }, errorPct: 2.1, matched: true },
    source: { origin: 'self', sourceCh: 0, rank: 0, cluster: [0], clusterFreq: 120, coupling: 1, confidence: 0.9 },
    puffing: false,
    datasetId: 'ng-float',
    faultPhase: 'growth',
    miniSpectrum: [],
    ...over,
  });

  const noGuard = { inReversal: false, reversalRemaining: 0, reversalGuarded: false, fanGuarded: false, guardReason: null } as const;
  const reversalGuard = { ...noGuard, reversalGuarded: true, guardReason: 'reversal' as const };
  /** 连续 evaluate n 次（模拟 4Hz tick 下的连续确认帧） */
  const evalN = (engine: AlertEngine, s: BurnerSnapshot, guard: GuardState, n: number) => {
    for (let i = 0; i < n; i++) engine.evaluate([s], guard, Date.now() + i * 250);
  };

  // 5a. 满足全部条件并连续 3 帧确认 → 报警；仅 2 帧不报警
  evalN(engine, snap({}), noGuard, 2);
  check('仅连续 2 帧满足条件时尚不报警（需 3 帧确认）', !events.some((e) => e === 'raise:0'));
  evalN(engine, snap({}), noGuard, 1);
  check('模态匹配 + 增长率连续转正 → 产生告警', events.some((e) => e === 'raise:0'));

  // 5b. 偏差 >5% → 不报警（连续多帧也不触发）
  const engine2 = new AlertEngine({
    onRaise: (r) => events.push(`raise:${r.ch}`),
    onUpgrade: () => {},
    onResolve: () => {},
    onSuppress: (r) => events.push(`suppress:${r.ch}`),
  });
  evalN(
    engine2,
    snap({ ch: 1, match: { mode: { n: 1, freq: 120, model: 'quarter-wave' }, errorPct: 8.4, matched: false } }),
    noGuard,
    5,
  );
  check('模态偏差 8.4%（>5%）不报警', !events.includes('raise:1'));

  // 5c. 增长率非正 → 不报警
  evalN(engine2, snap({ ch: 2, growthRate: -1.2 }), noGuard, 5);
  check('增长率为负不报警', !events.includes('raise:2'));

  // 5d. R² 太低 → 不报警
  evalN(engine2, snap({ ch: 3, fitR2: 0.3 }), noGuard, 5);
  check('回归 R²=0.3 不报警', !events.includes('raise:3'));

  // 5e. 串扰源 → 本路不报警
  evalN(
    engine2,
    snap({ ch: 4, source: { origin: 'crosstalk', sourceCh: 0, rank: 1, cluster: [0, 4], clusterFreq: 120, coupling: 0.18, confidence: 0.8 } }),
    noGuard,
    5,
  );
  check('串扰通道自身不报警', !events.includes('raise:4'));

  // 5f. 换火门控 → 抑制记录而非告警，且同一次起振只记一条
  evalN(engine2, snap({ ch: 5 }), reversalGuard, 6);
  const suppressCount = events.filter((e) => e === 'suppress:5').length;
  check('换火抑制窗内仅记录 suppressed 且不报警', events.includes('suppress:5') && !events.includes('raise:5'));
  check('同一次连续起振的抑制记录去重（仅 1 条）', suppressCount === 1, `got ${suppressCount}`);

  // 5g. 增长率分级
  const levels: string[] = [];
  const engine3 = new AlertEngine({
    onRaise: (r) => levels.push(`${r.ch}:${r.level}`),
    onUpgrade: () => {},
    onResolve: () => {},
    onSuppress: () => {},
  });
  evalN(engine3, snap({ ch: 10, growthRate: 0.8 }), noGuard, 3);
  evalN(engine3, snap({ ch: 11, growthRate: 2.2 }), noGuard, 3);
  evalN(engine3, snap({ ch: 12, growthRate: 5.1 }), noGuard, 3);
  check('三级阈值分级 watch/warning/danger', levels.includes('10:watch') && levels.includes('11:warning') && levels.includes('12:danger'), levels.join(','));
}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exit(1);
