/**
 * 三级告警引擎
 *
 * 报警前置条件（需求 1）：
 *  - 峰值与按通道长度/炉温计算的声学共振模态偏差 ≤5%
 *  - 幅值增长率连续多帧为正（最小二乘斜率 dB/s 超阈且 R²≥0.5）
 *  - 源判定为 self（隔壁串扰只在记录中标注，不触发本路告警）
 * 门控：换火/风机抑制窗内的告警转为 suppressed 记录，不点亮告警
 * 三级：watch（关注）→ warning（预警）→ danger（临脱火，伴扑扑声优先升级）
 */
import {
  ALERT_CLEAR_SEC,
  ALERT_MAX_STORE,
  ALERT_STORE_KEY,
  GROWTH_ALARM_FRAMES,
  GROWTH_DANGER_DB_S,
  GROWTH_WARNING_DB_S,
  GROWTH_WATCH_DB_S,
} from '../shared/constants';
import type {
  AlertLevel,
  AlertRecord,
  BurnerSnapshot,
} from '../shared/types';
import type { GuardState } from './event-manager';

interface ActiveAlert {
  record: AlertRecord;
  level: AlertLevel;
  positiveFrames: number;
  lastSeen: number;
}

export interface AlertEngineEvents {
  onRaise: (rec: AlertRecord) => void;
  onUpgrade: (rec: AlertRecord) => void;
  onResolve: (rec: AlertRecord) => void;
  onSuppress: (rec: AlertRecord) => void;
}

export class AlertEngine {
  private active = new Map<number, ActiveAlert>();
  private store: AlertRecord[] = [];
  private events: AlertEngineEvents;
  /** 每路连续满足报警前置条件的 tick 数（增长率转正需连续确认） */
  private candidateStreak = new Map<number, number>();
  /** 门控期去重：每路抑制记录只保留一条，直到该路候选条件中断 */
  private suppressedChs = new Set<number>();

  constructor(events: AlertEngineEvents) {
    this.events = events;
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(ALERT_STORE_KEY);
      if (raw) this.store = JSON.parse(raw) as AlertRecord[];
    } catch {
      this.store = [];
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(ALERT_STORE_KEY, JSON.stringify(this.store.slice(-ALERT_MAX_STORE)));
    } catch {
      /* 存储不可用时静默降级 */
    }
  }

  get records(): AlertRecord[] {
    return this.store;
  }

  clearRecords(): void {
    this.store = [];
    this.persist();
  }

  /** 活跃告警（供总览页状态灯） */
  activeLevels(): Map<number, AlertLevel> {
    const m = new Map<number, AlertLevel>();
    for (const [ch, a] of this.active) m.set(ch, a.level);
    return m;
  }

  /**
   * 每个分析 tick 评估全部通道
   * @param wallNow 墙钟 ms
   */
  evaluate(snapshots: BurnerSnapshot[], guard: GuardState, wallNow: number): void {
    const seen = new Set<number>();

    for (const s of snapshots) {
      const candidate = this.evaluateOne(s);
      // 连续帧确认：前置条件不满足即清零，避免单帧抖动触发
      const streak = candidate ? (this.candidateStreak.get(s.ch) ?? 0) + 1 : 0;
      this.candidateStreak.set(s.ch, streak);
      if (!candidate) {
        this.suppressedChs.delete(s.ch);
        continue;
      }
      if (streak < GROWTH_ALARM_FRAMES) continue;
      seen.add(s.ch);

      if (guard.guardReason) {
        // 门控期：同一路在同一次连续起振中只记录一条抑制证据
        if (this.suppressedChs.has(s.ch)) continue;
        this.suppressedChs.add(s.ch);
        const rec = this.buildRecord(s, candidate.level, wallNow, guard.guardReason);
        rec.resolvedAt = wallNow + 1;
        this.store.push(rec);
        this.persist();
        this.events.onSuppress(rec);
        continue;
      }
      this.suppressedChs.delete(s.ch);

      const existing = this.active.get(s.ch);
      if (!existing) {
        const rec = this.buildRecord(s, candidate.level, wallNow, null);
        this.active.set(s.ch, { record: rec, level: candidate.level, positiveFrames: 1, lastSeen: wallNow });
        this.store.push(rec);
        this.persist();
        this.events.onRaise(rec);
      } else {
        existing.positiveFrames++;
        existing.lastSeen = wallNow;
        if (this.rank(candidate.level) > this.rank(existing.level)) {
          existing.level = candidate.level;
          existing.record.level = candidate.level;
          this.events.onUpgrade(existing.record);
        }
      }
    }

    // ---- 自动解除 ----
    for (const [ch, a] of this.active) {
      const stale = !seen.has(ch) || wallNow - a.lastSeen > ALERT_CLEAR_SEC * 1000;
      if (stale) {
        a.record.resolvedAt = wallNow;
        this.persist();
        this.events.onResolve(a.record);
        this.active.delete(ch);
      }
    }
  }

  private evaluateOne(s: BurnerSnapshot): { level: AlertLevel } | null {
    if (!s.match?.matched) return null;
    if (s.source && s.source.origin !== 'self') return null;
    if (!Number.isFinite(s.growthRate) || s.growthRate <= 0) return null;
    // 增长率转正 + 回归可信（R²≥0.5）
    if (s.fitR2 < 0.5) return null;

    let level: AlertLevel | null = null;
    if (s.growthRate >= GROWTH_DANGER_DB_S) level = 'danger';
    else if (s.growthRate >= GROWTH_WARNING_DB_S) level = 'warning';
    else if (s.growthRate >= GROWTH_WATCH_DB_S) level = 'watch';
    if (!level) return null;

    // 扑扑声出现 → 升级一级（低频扑扑是脱火前兆）
    if (s.puffing && level === 'watch') level = 'warning';
    else if (s.puffing && level === 'warning') level = 'danger';
    return { level };
  }

  private rank(l: AlertLevel): number {
    return l === 'danger' ? 3 : l === 'warning' ? 2 : 1;
  }

  private buildRecord(
    s: BurnerSnapshot,
    level: AlertLevel,
    wallNow: number,
    suppressedBy: 'reversal' | 'fan' | null,
  ): AlertRecord {
    const messages: Record<AlertLevel, string> = {
      watch: `热声振荡峰出现并正增长（${s.growthRate.toFixed(1)}dB/s），持续观察`,
      warning: `振荡峰快速增长，存在回火/脱火风险，请关注空燃比与风压`,
      danger: `振荡临近脱火边界（增长率 ${s.growthRate.toFixed(1)}dB/s），建议立即干预`,
    };
    return {
      id: `A${wallNow.toString(36)}-${s.ch}`,
      level,
      ch: s.ch,
      startedAt: wallNow,
      resolvedAt: null,
      peakFreq: Math.round(s.peakFreq * 10) / 10,
      growthRate: Math.round(s.growthRate * 100) / 100,
      errorPct: s.match ? Math.round(s.match.errorPct * 100) / 100 : -1,
      modeN: s.match?.mode.n ?? null,
      origin: s.source?.origin ?? 'self',
      sourceCh: s.source?.sourceCh ?? s.ch,
      puffing: s.puffing,
      suppressedBy,
      message: messages[level],
      evidence: [],
    };
  }

  /** attach 证据链（monitor 在触发/升级时调用） */
  attachEvidence(ch: number, evidence: AlertRecord['evidence']): void {
    const a = this.active.get(ch);
    if (a) {
      a.record.evidence = evidence;
      this.persist();
    }
  }

  get positiveFrameThreshold(): number {
    return GROWTH_ALARM_FRAMES;
  }
}
