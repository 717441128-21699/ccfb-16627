/**
 * SimulatorWorklet —— 24 路燃烧器仿真声源（纯 JS，AudioWorklet 线程）
 *
 * 每路原始声源 = 宽带粉红噪声（平稳呼呼声）
 *              + 窄带振荡音（热声振荡峰，频率可漂移）
 *              + 随机门控低频扑扑声（5–40Hz）
 *              + 风机带通扰动
 * 然后按物理布置的耦合矩阵混入相邻燃烧器串扰，输出 24 声道总线。
 *
 * 主线程每 ~250ms 下发一次 24 路状态（增益/频率/换火静音），
 * worklet 内按块做线性斜坡，避免 zipper 噪声。
 */

const CHANNELS = 24;

function defaultState() {
  return {
    noiseGain: 0.12,
    toneGain: 0,
    toneFreq: 100,
    targetFreq: 100,
    puffGain: 0,
    puffFreq: 12,
    puffDuty: 0.4,
    mute: 0,
    fanGain: 0,
  };
}

/** 一阶状态变量振荡器（稳定、无 sin 查表噪声累积） */
class ChirpOsc {
  constructor() {
    this.y1 = 0;
    this.y2 = 1;
    this.freq = 100;
  }

  setFreq(f) {
    this.freq = f;
  }

  next(sr) {
    const w = (2 * Math.PI * this.freq) / sr;
    const y0 = 2 * Math.cos(w) * this.y1 - this.y2;
    this.y2 = this.y1;
    this.y1 = y0;
    return y0;
  }
}

/** Paul Kellet 粉红噪声近似（每路独立实例） */
class PinkNoise {
  constructor() {
    this.b0 = this.b1 = this.b2 = this.b3 = this.b4 = this.b5 = this.b6 = 0;
  }

  next(white) {
    this.b0 = 0.99886 * this.b0 + white * 0.0555179;
    this.b1 = 0.99332 * this.b1 + white * 0.0750759;
    this.b2 = 0.969 * this.b2 + white * 0.153852;
    this.b3 = 0.8665 * this.b3 + white * 0.3104856;
    this.b4 = 0.55 * this.b4 + white * 0.5329522;
    this.b5 = -0.7616 * this.b5 - white * 0.016898;
    const pink =
      this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + white * 0.5362;
    this.b6 = white * 0.115926;
    return pink * 0.11;
  }
}

class SimulatorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {ReturnType<typeof defaultState>[]} */
    this.states = [];
    /** @type {ChirpOsc[]} */
    this.osc = [];
    /** @type {PinkNoise[]} */
    this.pink = [];
    /** 扑扑声随机门控（每路独立） */
    this.puffOn = new Uint8Array(CHANNELS);
    /** 风机一阶带通状态 */
    this.fanLp = new Float32Array(CHANNELS);
    this.fanHp = new Float32Array(CHANNELS);
    this.monitorCh = 0;
    this.monitorGain = 0;
    this.fanRunning = true;

    for (let ch = 0; ch < CHANNELS; ch++) {
      this.states.push(defaultState());
      this.osc.push(new ChirpOsc());
      this.pink.push(new PinkNoise());
      this.puffOn[ch] = 0;
    }
    this.coupling = this.buildCoupling();

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'state' && Array.isArray(msg.states)) {
        for (const s of msg.states) {
          if (s.ch < 0 || s.ch >= CHANNELS) continue;
          const cur = this.states[s.ch];
          cur.noiseGain = s.noiseGain ?? cur.noiseGain;
          cur.toneGain = s.toneGain ?? cur.toneGain;
          cur.targetFreq = s.targetFreq ?? cur.targetFreq;
          cur.toneFreq = s.toneFreq ?? cur.toneFreq;
          cur.puffGain = s.puffGain ?? cur.puffGain;
          cur.puffFreq = s.puffFreq ?? cur.puffFreq;
          cur.puffDuty = s.puffDuty ?? cur.puffDuty;
          cur.mute = s.mute ?? cur.mute;
          cur.fanGain = s.fanGain ?? cur.fanGain;
        }
      } else if (msg.type === 'fan') {
        this.fanRunning = !!msg.running;
      } else if (msg.type === 'monitor') {
        this.monitorCh = msg.ch | 0;
        this.monitorGain = +msg.gain || 0;
      }
    };
  }

  /**
   * 按熔窑物理布置生成耦合矩阵：
   *  - 同侧相邻小炉 0.18，隔一个 0.06，再远 0.02
   *  - 对侧（穿越熔化池）衰减到 0.01
   */
  buildCoupling() {
    const m = new Float32Array(CHANNELS * CHANNELS);
    const sideOf = (ch) => (ch < 12 ? 0 : 1);
    const portOf = (ch) => ch % 12;
    for (let i = 0; i < CHANNELS; i++) {
      for (let j = 0; j < CHANNELS; j++) {
        if (i === j) {
          m[i * CHANNELS + j] = 1;
          continue;
        }
        if (sideOf(i) === sideOf(j)) {
          const d = Math.abs(portOf(i) - portOf(j));
          m[i * CHANNELS + j] = d === 1 ? 0.18 : d === 2 ? 0.06 : 0.02;
        } else {
          m[i * CHANNELS + j] = 0.01;
        }
      }
    }
    return m;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length < CHANNELS) return true;
    const block = out[0].length;
    const sr = sampleRate;
    const raw = new Float32Array(CHANNELS);

    // ---- 0. 块级扑扑门控（时有时无的低频扑扑，每块约 1.5% 概率翻转）----
    for (let ch = 0; ch < CHANNELS; ch++) {
      const st0 = this.states[ch];
      const gateT = currentTime + ch * 1.37;
      const gphase = (gateT % 2.4) / 2.4;
      const wantOn = gphase < st0.puffDuty ? 1 : 0;
      if (wantOn !== this.puffOn[ch] && Math.random() < 0.015) {
        this.puffOn[ch] = wantOn;
      }
    }

    for (let n = 0; n < block; n++) {
      // ---- 1. 每路原始声源 ----
      for (let ch = 0; ch < CHANNELS; ch++) {
        const st = this.states[ch];
        // 频率向目标斜坡（按比例平滑趋近）
        st.toneFreq += (st.targetFreq - st.toneFreq) * 0.02;
        this.osc[ch].setFreq(st.toneFreq);

        const white = Math.random() * 2 - 1;
        const pink = this.pink[ch].next(white);
        const noise = pink * st.noiseGain;

        const tone = this.osc[ch].next(sr) * st.toneGain;

        // 扑扑声：块级门控控制的低频正弦（门控在 process 顶部更新）
        this.puffPhase = this.puffPhase ?? new Float32Array(CHANNELS);
        this.puffPhase[ch] += st.puffFreq / sr;
        const puff =
          this.puffOn[ch] === 1
            ? Math.sin(2 * Math.PI * this.puffPhase[ch]) * st.puffGain
            : 0;

        // 风机扰动：白噪声经低通+高通形成 ~150-900Hz 带通
        const lp = this.fanLp[ch] + 0.05 * (white - this.fanLp[ch]);
        const hp = lp - this.fanHp[ch];
        this.fanHp[ch] += 0.02 * hp;
        const fan = this.fanRunning ? hp * st.fanGain : 0;

        raw[ch] = (noise + tone + puff + fan) * (1 - st.mute);
      }

      // ---- 2. 串扰混合 ----
      for (let i = 0; i < CHANNELS; i++) {
        let v = 0;
        const row = i * CHANNELS;
        for (let j = 0; j < CHANNELS; j++) {
          v += raw[j] * this.coupling[row + j];
        }
        // 软限幅
        out[i][n] = Math.tanh(v * 1.4) * 0.9;
      }
    }

    // ---- 3. 立体声监听（输出口 1，可选）----
    if (outputs[1] && outputs[1].length >= 2 && this.monitorGain > 0) {
      const src = out[this.monitorCh];
      for (let n = 0; n < block; n++) {
        const v = src[n] * this.monitorGain;
        outputs[1][0][n] = v;
        outputs[1][1][n] = v;
      }
    }
    return true;
  }
}

registerProcessor('simulator-worklet', SimulatorProcessor);
