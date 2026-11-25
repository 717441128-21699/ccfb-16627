/**
 * AudioWorklet 运行级冒烟（Node 内模拟 worklet 全局作用域）：
 *  - 加载 analyzer-worklet，喂 120Hz 纯音 → 验证 FFT 测频误差 <2%、Q 值、带宽
 *  - 喂 15Hz 低频音 → 验证低频能量占比（扑扑通道）
 *  - 加载 simulator-worklet → 验证 24 路输出非零且串扰使相邻通道相关
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SR = 16000;
const BLOCK = 128;
const CH = 24;

interface CapturedFrame {
  ch: number;
  t: number;
  rms: number;
  lowRatio: number;
  peakFreq: number;
  peakQ: number;
  peakBW: number;
  miniSpectrum: number[];
}

function installWorkletGlobals(): { frames: CapturedFrame[] } {
  const frames: CapturedFrame[] = [];
  let now = 0;
  (globalThis as Record<string, unknown>).sampleRate = SR;
  Object.defineProperty(globalThis, 'currentTime', {
    get: () => now,
    configurable: true,
  });
  (globalThis as Record<string, unknown>).AudioWorkletProcessor = class {
    port = {
      postMessage(msg: unknown) {
        const data = msg as { type: string; frame?: CapturedFrame };
        if (data.type === 'frame' && data.frame) frames.push(data.frame);
      },
      onmessage: null as ((e: MessageEvent) => void) | null,
    };
  };
  (globalThis as Record<string, unknown>).registerProcessor = () => {};
  return { frames };
}

/** 拦截 registerProcessor 拿到处理器构造器（带 cache-buster 保证重复加载时重新执行） */
async function loadProcessor(workletPath: string): Promise<new () => {
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
  port: { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown) => void };
}> {
  let Ctor: any = null;
  (globalThis as Record<string, unknown>).registerProcessor = (_name: string, ctor: any) => {
    Ctor = ctor;
  };
  const abs = join(here, '..', workletPath);
  await import(`${pathToFileURL(abs).href}?t=${Date.now()}`);
  if (!Ctor) throw new Error(`registerProcessor 未被调用: ${workletPath}`);
  return Ctor;
}

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

console.log('\n[A] AnalyzerWorklet：120Hz 纯音测频');
{
  const { frames } = installWorkletGlobals();
  const Ctor = await loadProcessor('src/worklets/analyzer-worklet.js');
  const proc = new Ctor();
  const N_TOTAL = 4096 + 2048 * 2; // 覆盖至少两次分析
  for (let n = 0; n < N_TOTAL; n += BLOCK) {
    const inputs: Float32Array[][] = [
      Array.from({ length: CH }, (_unused, ch) => {
        const buf = new Float32Array(BLOCK);
        for (let i = 0; i < BLOCK; i++) {
          const idx = n + i;
          if (ch === 0) buf[i] = 0.5 * Math.sin(2 * Math.PI * 120 * (idx / SR));
          else if (ch === 1) buf[i] = 0.002 * (Math.random() * 2 - 1); // 近似静音
        }
        return buf;
      }),
    ];
    proc.process(inputs, []);
  }
  const ch0 = frames.filter((f) => f.ch === 0);
  const ch1 = frames.filter((f) => f.ch === 1);
  check('CH0 产出至少 2 帧分析结果', ch0.length >= 2, `got ${ch0.length}`);
  const last = ch0[ch0.length - 1];
  const errPct = (Math.abs(last.peakFreq - 120) / 120) * 100;
  check(
    `测频 120Hz 误差 <2%（实测 ${last.peakFreq.toFixed(2)}Hz, 偏差 ${errPct.toFixed(2)}%）`,
    errPct < 2,
  );
  // 4096 点 Hann 窗在 120Hz 的物理 -3dB 带宽约 11.7Hz（Q≈10），实测应接近该极限
  check('纯音 Q 值达到窗函数分辨极限（Q≈8–14）', last.peakQ >= 8 && last.peakQ <= 16, `Q=${last.peakQ.toFixed(1)}`);
  check('峰值带宽合理（<15Hz）', last.peakBW > 0 && last.peakBW < 15, `BW=${last.peakBW.toFixed(1)}`);
  check('mini 频谱含 48 个对数频带', last.miniSpectrum.length === 48);
  check('静音通道 RMS 远小于纯音通道', ch1[ch1.length - 1].rms < last.rms * 0.1);
}

console.log('\n[B] AnalyzerWorklet：15Hz 低频扑扑能量占比');
{
  const { frames } = installWorkletGlobals();
  const Ctor = await loadProcessor('src/worklets/analyzer-worklet.js');
  const proc = new Ctor();
  const N_TOTAL = 4096 + 2048;
  for (let n = 0; n < N_TOTAL; n += BLOCK) {
    const inputs: Float32Array[][] = [
      Array.from({ length: CH }, (_unused, ch) => {
        const buf = new Float32Array(BLOCK);
        for (let i = 0; i < BLOCK; i++) {
          const idx = n + i;
          // CH2：15Hz 强低频；CH3：2000Hz 高频对照（同总能量量级）
          buf[i] =
            ch === 2
              ? 0.4 * Math.sin(2 * Math.PI * 15 * (idx / SR))
              : ch === 3
                ? 0.4 * Math.sin(2 * Math.PI * 2000 * (idx / SR))
                : 0;
        }
        return buf;
      }),
    ];
    proc.process(inputs, []);
  }
  const low = frames.filter((f) => f.ch === 2).slice(-1)[0];
  const high = frames.filter((f) => f.ch === 3).slice(-1)[0];
  check('15Hz 通道低频占比 >0.5（扑扑可检）', low.lowRatio > 0.5, `ratio=${low.lowRatio.toFixed(2)}`);
  check('2000Hz 通道低频占比 <0.05', high.lowRatio < 0.05, `ratio=${high.lowRatio.toFixed(3)}`);
  check(
    '15Hz 通道被识别为谱峰',
    low.peakFreq > 0 && Math.abs(low.peakFreq - 15) / 15 < 0.15,
    `f=${low.peakFreq}`,
  );
}

console.log('\n[C] SimulatorWorklet：24 路发声与邻炉串扰');
{
  const { frames } = installWorkletGlobals();
  const Ctor = await loadProcessor('src/worklets/simulator-worklet.js');
  const proc = new Ctor();
  // 只让 CH7 有强振荡音
  const states = Array.from({ length: CH }, (_u, ch) => ({
    ch,
    noiseGain: 0.1,
    toneGain: ch === 7 ? 0.3 : 0,
    toneFreq: 200,
    targetFreq: 200,
    puffGain: 0,
    puffFreq: 12,
    puffDuty: 0.3,
    mute: 0,
    fanGain: 0,
  }));
  proc.port.onmessage?.({ data: { type: 'state', states } } as MessageEvent);

  const N_BLOCKS = 64;
  const energy = new Float32Array(CH);
  const ch7 = new Float32Array(N_BLOCKS * BLOCK);
  const ch8 = new Float32Array(N_BLOCKS * BLOCK);
  for (let b = 0; b < N_BLOCKS; b++) {
    const outputs: Float32Array[][] = [
      Array.from({ length: CH }, () => new Float32Array(BLOCK)),
      [new Float32Array(BLOCK), new Float32Array(BLOCK)],
    ];
    proc.process([], outputs);
    for (let ch = 0; ch < CH; ch++) {
      for (let i = 0; i < BLOCK; i++) {
        const v = outputs[0][ch][i];
        energy[ch] += v * v;
        if (ch === 7) ch7[b * BLOCK + i] = v;
        if (ch === 8) ch8[b * BLOCK + i] = v;
      }
    }
  }
  check('24 路全部有输出能量', energy.every((e) => e > 0));
  check('声源 CH7 能量高于相邻 CH8（自声 > 串扰）', energy[7] > energy[8]);
  check(
    '相邻 CH8 能量高于远端 CH0（串扰衰减梯度）',
    energy[8] > energy[0] * 1.5,
    `e8=${energy[8].toExponential(2)} e0=${energy[0].toExponential(2)}`,
  );

  // CH7/CH8 相关性：串扰应带来正相关
  let cov = 0;
  let v7 = 0;
  let v8 = 0;
  for (let i = 0; i < ch7.length; i++) {
    cov += ch7[i] * ch8[i];
    v7 += ch7[i] * ch7[i];
    v8 += ch8[i] * ch8[i];
  }
  const corr = cov / Math.sqrt(v7 * v8);
  check('CH7 与相邻 CH8 输出正相关（串扰证据，r>0.3）', corr > 0.3, `r=${corr.toFixed(2)}`);
}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exit(1);
