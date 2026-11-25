/**
 * 音频图管理：AudioContext、两个 AudioWorklet 的装载与接线
 *  - 仿真模式：SimulatorWorklet(24 出声) → AnalyzerWorklet(24 入)；另有立体声监听口
 *  - 硬件模式：getUserMedia 多通道采集 → AnalyzerWorklet
 */
import { CHANNEL_COUNT, TARGET_SAMPLE_RATE } from '../shared/constants';
import type { AnalyzerMessage, ChannelFrame } from '../shared/types';

export type AudioMode = 'sim' | 'hardware';

export class AudioEngine {
  ctx: AudioContext | null = null;
  private analyzer: AudioWorkletNode | null = null;
  private simulator: AudioWorkletNode | null = null;
  private monitorGain: GainNode | null = null;
  private mediaStream: MediaStream | null = null;
  private mode: AudioMode = 'sim';
  private frameHandlers = new Set<(f: ChannelFrame) => void>();

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  get currentMode(): AudioMode {
    return this.mode;
  }

  onFrame(h: (f: ChannelFrame) => void): () => void {
    this.frameHandlers.add(h);
    return () => this.frameHandlers.delete(h);
  }

  private async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' });
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  /** 装载分析 worklet 并接线（两种模式共用） */
  private async buildAnalyzer(ctx: AudioContext): Promise<AudioWorkletNode> {
    await ctx.audioWorklet.addModule(new URL('../worklets/analyzer-worklet.js', import.meta.url));
    const node = new AudioWorkletNode(ctx, 'analyzer-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      outputChannelCount: [],
      // inputChannelCount 在部分 TS DOM lib 版本中缺失；未提供时规范默认取 [channelCount]
      channelCount: CHANNEL_COUNT,
      channelInterpretation: 'discrete',
    } as AudioWorkletNodeOptions);
    node.port.onmessage = (e: MessageEvent<AnalyzerMessage>) => {
      const msg = e.data;
      if (msg.type === 'frame') {
        const f = msg.frame;
        f.miniSpectrum = Array.from(f.miniSpectrum as Float32Array);
        if (f.detailSpectrum) f.detailSpectrum = Array.from(f.detailSpectrum as Float32Array);
        for (const h of this.frameHandlers) h(f);
      }
    };
    this.analyzer = node;
    return node;
  }

  async startSim(): Promise<void> {
    await this.teardownGraph();
    const ctx = await this.ensureContext();
    const analyzer = await this.buildAnalyzer(ctx);

    await ctx.audioWorklet.addModule(new URL('../worklets/simulator-worklet.js', import.meta.url));
    const sim = new AudioWorkletNode(ctx, 'simulator-worklet', {
      numberOfInputs: 0,
      numberOfOutputs: 2,
      outputChannelCount: [CHANNEL_COUNT, 2],
      channelInterpretation: 'discrete',
    });
    sim.connect(analyzer);

    const monitor = ctx.createGain();
    monitor.gain.value = 0;
    sim.connect(monitor, 1);
    monitor.connect(ctx.destination);

    this.simulator = sim;
    this.monitorGain = monitor;
    this.mode = 'sim';
  }

  async startHardware(): Promise<{ requested: number; actual: number }> {
    await this.teardownGraph();
    const ctx = await this.ensureContext();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: CHANNEL_COUNT },
          sampleRate: { ideal: TARGET_SAMPLE_RATE },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      // 拿不到多通道设备时回退仿真，保证页面可用
      await this.startSim();
      throw new Error(
        `无法访问多通道音频设备（${(err as Error).message}），已回退到仿真模式。` +
          '生产部署需支持 24 通道 ASIO/CoreAudio 接口的浏览器采集方案。',
      );
    }
    this.mediaStream = stream;
    const source = ctx.createMediaStreamSource(stream);
    const analyzer = await this.buildAnalyzer(ctx);
    source.connect(analyzer);
    const actual = source.channelCount;
    this.mode = 'hardware';
    return { requested: CHANNEL_COUNT, actual };
  }

  /** 向仿真器下发控制 */
  postSim(msg: unknown): void {
    this.simulator?.port.postMessage(msg);
  }

  /** 请求/取消单路完整频谱 */
  requestDetail(ch: number): void {
    this.analyzer?.port.postMessage({ type: 'detail', ch });
  }

  setMonitor(ch: number, gain: number): void {
    this.postSim({ type: 'monitor', ch, gain });
    if (this.monitorGain && this.ctx) {
      this.monitorGain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.1);
    }
  }

  private async teardownGraph(): Promise<void> {
    try {
      this.simulator?.disconnect();
      this.analyzer?.disconnect();
      this.monitorGain?.disconnect();
    } catch {
      /* 节点未连接时忽略 */
    }
    this.simulator = null;
    this.analyzer = null;
    this.monitorGain = null;
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
  }

  async suspend(): Promise<void> {
    await this.ctx?.suspend();
  }

  async resume(): Promise<void> {
    await this.ctx?.resume();
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? TARGET_SAMPLE_RATE;
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }
}
