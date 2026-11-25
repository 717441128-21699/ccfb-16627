/**
 * 换火周期与风机启停事件管理
 *  - 自动换火按 20min 周期仿真，也支持手动触发
 *  - 换火持续 75s，前后 90s 为告警抑制窗（正常声音变化门控）
 *  - 风机启停事件提供 4s 抑制窗
 */
import {
  FAN_GUARD_SEC,
  REVERSAL_DURATION_SEC,
  REVERSAL_GUARD_SEC,
  REVERSAL_PERIOD_SEC,
} from '../shared/constants';
import type { FanEvent, ReversalEvent, Side } from '../shared/types';

export interface GuardState {
  inReversal: boolean;
  reversalRemaining: number;
  reversalGuarded: boolean;
  fanGuarded: boolean;
  guardReason: 'reversal' | 'fan' | null;
}

export class EventManager {
  private reversals: ReversalEvent[] = [];
  private fanEvents: FanEvent[] = [];
  private firingSide: Side = 'left';
  private reversalId = 0;
  private fanId = 0;
  private fanRunning = true;
  private autoReversal = true;
  private nextAutoAt = 0;
  private nowProvider: () => number;

  constructor(nowProvider: () => number) {
    this.nowProvider = nowProvider;
  }

  reset(): void {
    this.reversals = [];
    this.fanEvents = [];
    this.firingSide = 'left';
    this.fanRunning = true;
    this.autoReversal = true;
    this.nextAutoAt = 0;
  }

  /** 每个分析 tick 调用，wallNow 为墙钟 ms */
  tick(wallNow: number): void {
    if (this.autoReversal && this.nextAutoAt > 0 && wallNow >= this.nextAutoAt) {
      this.triggerReversal('auto', wallNow);
    }
  }

  triggerReversal(kind: 'auto' | 'manual', at?: number): ReversalEvent {
    const wallNow = at ?? this.nowProvider();
    const firingBefore = this.firingSide;
    const firingAfter: Side = firingBefore === 'left' ? 'right' : 'left';
    const ev: ReversalEvent = {
      id: ++this.reversalId,
      startedAt: wallNow,
      durationSec: REVERSAL_DURATION_SEC,
      firingBefore,
      firingAfter,
      kind,
    };
    this.reversals.push(ev);
    this.firingSide = firingAfter;
    this.nextAutoAt = wallNow + REVERSAL_PERIOD_SEC * 1000;
    return ev;
  }

  setFanRunning(running: boolean, at?: number): FanEvent {
    const wallNow = at ?? this.nowProvider();
    this.fanRunning = running;
    const ev: FanEvent = {
      id: ++this.fanId,
      at: wallNow,
      running,
      reason: 'manual',
    };
    this.fanEvents.push(ev);
    return ev;
  }

  setAutoReversal(on: boolean): void {
    this.autoReversal = on;
    if (on && this.nextAutoAt === 0) {
      this.nextAutoAt = this.nowProvider() + REVERSAL_PERIOD_SEC * 1000;
    }
  }

  get isFanRunning(): boolean {
    return this.fanRunning;
  }

  get currentFiringSide(): Side {
    return this.firingSide;
  }

  get reversalList(): ReversalEvent[] {
    return this.reversals;
  }

  get fanList(): FanEvent[] {
    return this.fanEvents;
  }

  /** 距离下次自动换火的秒数（-1 表示关闭自动） */
  get nextReversalInSec(): number {
    if (!this.autoReversal || this.nextAutoAt === 0) return -1;
    return Math.max(0, (this.nextAutoAt - this.nowProvider()) / 1000);
  }

  /** 当前门控状态 */
  guardState(wallNow: number): GuardState {
    let inReversal = false;
    let reversalRemaining = 0;
    let reversalGuarded = false;
    for (const r of this.reversals) {
      const endMs = r.startedAt + r.durationSec * 1000;
      if (wallNow >= r.startedAt && wallNow < endMs) {
        inReversal = true;
        reversalRemaining = (endMs - wallNow) / 1000;
      }
      const guardEnd = endMs + (REVERSAL_GUARD_SEC - REVERSAL_DURATION_SEC) * 1000;
      if (wallNow >= r.startedAt - 2000 && wallNow < guardEnd) {
        reversalGuarded = true;
      }
    }
    let fanGuarded = false;
    const latest = this.fanEvents[this.fanEvents.length - 1];
    if (latest && wallNow - latest.at < FAN_GUARD_SEC * 1000) {
      fanGuarded = true;
    }
    return {
      inReversal,
      reversalRemaining,
      reversalGuarded,
      fanGuarded,
      guardReason: reversalGuarded ? 'reversal' : fanGuarded ? 'fan' : null,
    };
  }
}
