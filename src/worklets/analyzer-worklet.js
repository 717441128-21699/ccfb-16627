/**
 * AnalyzerWorklet —— 24 路音频的持续频谱跟踪（运行在 AudioWorklet 线程）
 *
 * 每路独立环形缓冲，攒满 HOP(2048) 样本做一次 4096 点 Hann 窗 FFT：
 *  - 全频带 RMS、5–40Hz 低频能量占比（扑扑声）
 *  - 8–4000Hz 内最强局部谱峰：抛物线插值频率、-3dB 带宽、Q 值
 *  - 48 个对数频带 mini 频谱；单路页请求时附带完整频谱
 *
 * 注意：worklet 保持为纯 JS（.js），确保生产构建产物以 JS MIME 提供给 addModule。
 * @typedef {(inputs: Float32Array[][]) => boolean} ProcessFn
 */

const N = 4096;
const HOP = 2048;
const CHANNELS = 24;
const MINI_BINS = 48;
const F_MIN = 8;
const F_MAX = 4000;
const PUFF_F_MIN = 5;
const PUFF_F_MAX = 40;
const EPS = 1e-10;

/** 迭代基-2 FFT（就地，拆成实/虚两个数组） */
class FFT {
  constructor(size) {
    this.size = size;
    const bits = Math.log2(size);
    this.rev = new Int32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let k = 0; k < size / 2; k++) {
      const a = (-2 * Math.PI * k) / size;
      this.cos[k] = Math.cos(a);
      this.sin[k] = Math.sin(a);
    }
    // Hann 窗，配套 1.63 相干增益修正
    this.window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
  }

  /** 输入时域信号，输出幅度谱（长度 size/2，已做窗增益修正） */
  magnitude(input) {
    const n = this.size;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      re[this.rev[i]] = input[i] * this.window[i];
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        let wIdx = 0;
        for (let j = 0; j < half; j++) {
          const a = re[i + j];
          const b = im[i + j];
          const c = re[i + j + half];
          const d = im[i + j + half];
          const wr = this.cos[wIdx];
          const wi = this.sin[wIdx];
          const tr = c * wr - d * wi;
          const ti = c * wi + d * wr;
          re[i + j] = a + tr;
          im[i + j] = b + ti;
          re[i + j + half] = a - tr;
          im[i + j + half] = b - ti;
          wIdx += step;
        }
      }
    }
    const mag = new Float32Array(n / 2);
    const gainCorr = 2 / 1.633; // 单边谱 + Hann 相干增益
    for (let k = 0; k < n / 2; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * gainCorr / n;
    }
    return mag;
  }
}

class AnalyzerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fft = new FFT(N);
    /** @type {{ring: Float32Array, filled: number, detailPending: boolean}[]} */
    this.ctxs = [];
    for (let ch = 0; ch < CHANNELS; ch++) {
      this.ctxs.push({ ring: new Float32Array(N), filled: 0, detailPending: false });
    }
    // Hann 窗能量修正因子 ≈ 1.5
    let w2 = 0;
    for (let i = 0; i < N; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
      w2 += w * w;
    }
    this.hannEnergyCorr = N / w2;
    this.detailCh = -1;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg?.type === 'detail') {
        this.detailCh = msg.ch;
        if (this.detailCh >= 0) this.ctxs[this.detailCh].detailPending = true;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const block = input[0]?.length ?? 0;
    const sr = sampleRate;
    const df = sr / N;

    for (let ch = 0; ch < Math.min(input.length, CHANNELS); ch++) {
      const data = input[ch];
      const cx = this.ctxs[ch];
      cx.ring.set(cx.ring.subarray(block), 0);
      cx.ring.set(data, N - block);
      cx.filled = Math.min(N, cx.filled + block);
      if (cx.filled < N) continue;

      // 每 HOP 样本分析一次（block=128，HOP=2048 → 每 16 块一次）
      cx.filled = N - HOP;
      const mag = this.fft.magnitude(cx.ring);

      // ---- 能量类指标（由谱域按 Parseval 求和）----
      let totalE = 0;
      let lowE = 0;
      const kPuffLo = Math.max(1, Math.round(PUFF_F_MIN / df));
      const kPuffHi = Math.round(PUFF_F_MAX / df);
      for (let k = 1; k < mag.length; k++) {
        const e = mag[k] * mag[k];
        totalE += e;
        if (k >= kPuffLo && k <= kPuffHi) lowE += e;
      }
      const rms = Math.sqrt((totalE * this.hannEnergyCorr) / (N / 2));
      const rmsLow = Math.sqrt((lowE * this.hannEnergyCorr) / (N / 2));
      const lowRatio = totalE > EPS ? lowE / totalE : 0;

      // ---- 峰值拾取 ----
      const kLo = Math.max(2, Math.round(F_MIN / df));
      const kHi = Math.min(mag.length - 2, Math.round(F_MAX / df));
      let bestK = -1;
      let bestAmp = 0;
      for (let k = kLo; k <= kHi; k++) {
        const a = mag[k];
        if (a > bestAmp && a > mag[k - 1] && a >= mag[k + 1]) {
          bestAmp = a;
          bestK = k;
        }
      }

      let peakFreq = 0;
      let peakAmp = 0;
      let peakBW = 0;
      let peakQ = 0;
      if (bestK > 0 && bestAmp > EPS) {
        // 抛物线插值
        const al = mag[bestK - 1];
        const ac = mag[bestK];
        const ar = mag[bestK + 1];
        const denom = al - 2 * ac + ar;
        const shift = denom !== 0 ? (0.5 * (al - ar)) / denom : 0;
        peakFreq = (bestK + shift) * df;
        peakAmp = ac - 0.25 * (al - ar) * shift;

        // -3dB 带宽
        const half = ac / Math.SQRT2;
        let l = bestK;
        while (l > kLo && mag[l] > half) l--;
        let r = bestK;
        while (r < kHi && mag[r] > half) r++;
        peakBW = Math.max(df, (r - l) * df);
        peakQ = peakFreq / peakBW;
      }

      // ---- 48 个对数频带 ----
      const mini = new Float32Array(MINI_BINS);
      const logLo = Math.log10(F_MIN);
      const logHi = Math.log10(F_MAX);
      for (let b = 0; b < MINI_BINS; b++) {
        const f1 = Math.pow(10, logLo + ((logHi - logLo) * b) / MINI_BINS);
        const f2 = Math.pow(10, logLo + ((logHi - logLo) * (b + 1)) / MINI_BINS);
        const i1 = Math.max(1, Math.round(f1 / df));
        const i2 = Math.min(mag.length - 1, Math.round(f2 / df));
        let sum = 0;
        let cnt = 0;
        for (let k = i1; k <= i2; k++) {
          sum += mag[k] * mag[k];
          cnt++;
        }
        const bandRms = cnt > 0 ? Math.sqrt(sum / cnt) : 0;
        mini[b] = 20 * Math.log10(Math.max(bandRms, EPS));
      }

      const wantDetail = cx.detailPending || ch === this.detailCh;
      /** @type {Record<string, unknown>} */
      const frame = {
        ch,
        t: currentTime,
        rms,
        rmsLow,
        lowRatio,
        peakFreq,
        peakAmp,
        peakBW,
        peakQ,
        miniSpectrum: Array.from(mini),
      };
      if (wantDetail) {
        const full = new Float32Array(mag.length);
        for (let k = 0; k < mag.length; k++) {
          full[k] = 20 * Math.log10(Math.max(mag[k], EPS));
        }
        frame.detailSpectrum = Array.from(full);
        cx.detailPending = false;
      }
      this.port.postMessage({ type: 'frame', frame });
    }
    return true;
  }
}

registerProcessor('analyzer-worklet', AnalyzerProcessor);
