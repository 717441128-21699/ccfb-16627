# 玻璃熔窑燃烧器热声振荡声学监测系统

对熔窑两侧 24 支燃烧器持续"听音"，基于 Web Audio API + AudioWorklet 跟踪每路频谱，
在脱火/回火发生前识别热声振荡峰的出现、增长与频率漂移，并区分自身起振与邻炉串扰。

## 运行

```bash
npm install
npm run dev        # 开发
npm run build      # 类型检查 + 生产构建（dist/）
npm run preview    # 托管构建产物
```

打开页面后点击 **启动仿真**，即获得完整 24 路仿真声源（无需任何硬件）。
有多通道声卡时可点 **硬件接入**，分析管线与仿真完全一致（浏览器多通道采集受
ASIO/CoreAudio 能力限制，拿不到设备时自动回退仿真并提示）。

## 测试

```bash
npm run selftest       # 60 项：声学物理、6 组燃烧数据、λ 曲线、回归、告警准则
npm run worklet-smoke  # 13 项：Node 内模拟 worklet，验证 FFT 测频/扑扑/串扰
npm run e2e            # 16 项：puppeteer 驱动真实 Chrome 的端到端流程
```

## 四个页面

| 路由 | 内容 |
| --- | --- |
| `#/overview` | 24 支燃烧器卡片：实时迷你频谱、状态灯、峰频/增长率、串扰与扑扑标记、KPI 汇总 |
| `#/channel/:ch` | 单路完整 4096 点频谱、理论模态 5% 容差带、特征量、300s 历史、声音监听、故障注入 |
| `#/alerts` | 预警记录（等级/模态偏差/增长率/声源/门控/证据链），localStorage 持久化 |
| `#/reversal` | 换火周期倒计时、两小时时间轴、换火与风机事件、门控状态 |
| `#/datasets` | 6 组燃料×窑型数据、λ 1.05→0.95 先升后降曲线、实时扫描与手册值对照 |

## 架构

```
src/
  shared/
    acoustics.ts        声速 c=√(γRT)、1/4 与 1/2 波长驻波模态、5% 模态匹配
    datasets.ts         6 组燃料×窑型 + λ 曲线（不稳定区间钟形凸起，先升后降）
    constants.ts types.ts
  worklets/
    simulator-worklet.js  24 路声源：粉红噪声+振荡音+门控扑扑+风机，物理耦合矩阵串扰
    analyzer-worklet.js   每路 4096 Hann FFT：峰值拾取/插值测频/-3dB 带宽/Q/低频能量
  engine/
    audio-graph.ts      AudioContext 与 worklet 接线（仿真/硬件两种模式）
    tracker.ts          谱峰跨帧关联、15s 增长率与漂移最小二乘回归、历史缓冲
    source-attribution.ts  同源簇聚类 + 能量排名 + 耦合先验 → self/crosstalk
    alert-engine.ts     三级告警、连续帧确认、门控抑制、证据链、持久化
    event-manager.ts    20min 换火周期、75s 换火、90s 抑制窗、风机 4s 窗
    sim-controller.ts   70s 故障剧情（起振→增长→临脱火→恢复）与 λ 驱动
    channel-config.ts   24 路静态配置（数据组、炉温偏差、理论模态）
  ui/                   Canvas 图表（无第三方绘图库）+ hash 路由 + 五个视图
```

worklet 保持为纯 `.js`：生产构建必须以 JS MIME 提供给 `audioWorklet.addModule`，
TS 源直接构建会保留 `.ts` 扩展名被静态服务器识别为 `video/mp2t` 而拒绝执行。

## 报警准则（与需求对应）

1. **频率对得上**：实测峰与按小炉通道长度 + 炉内温度算出的共振模态偏差 ≤5% 才纳入候选；
   **增长率转正**：15s 窗幅值 dB 序列最小二乘斜率为正、R²≥0.5、且连续 3 个 tick 确认后才报警。
2. **λ 先升后降**：6 组数据在 1.05→0.95 扫描中，振荡峰在手册不稳定区间内抬升、
   区间中心达峰、富燃侧回落；`#/datasets` 页可实时扫描叠加实测点对照。
3. **串扰不误报**：同频同源簇内仅最强通道判 `self` 可触发告警，其余判 `crosstalk` 只标注。
4. **正常变化门控**：换火 90s 窗、风机启停 4s 窗内的候选只记"已抑制"，不点亮告警。

## 关键参数（src/shared/constants.ts）

采样率 16kHz · FFT 4096（Δf≈3.9Hz）· 帧移 2048 · 跟踪窗 15s ·
增长率阈值 watch 0.6 / warning 1.8 / danger 4.0 dB·s⁻¹ ·
模态容差 5% · 扑扑频段 5–40Hz · 换火周期 20min。
