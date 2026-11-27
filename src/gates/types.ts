import type { Chapter, Foreshadow } from '../domain/models.js';

export type Severity = 'error' | 'warning' | 'info';

export interface GateFinding {
  rule: string;
  severity: Severity;
  message: string;
  /**
   * 是否阻断定稿。与 severity 解耦：字数偏差是 error 但不阻断（记 observation），
   * 事实矛盾是 error 且阻断。缺省时 error 视为阻断。
   */
  blocking: boolean;
  details?: Record<string, unknown>;
}

export interface GateResult {
  rule: string;
  passed: boolean;
  findings: GateFinding[];
}

export interface GateReport {
  chapterId: string;
  results: GateResult[];
  /** 无任何 blocking finding 即通过；observation 交由作者裁决 */
  passed: boolean;
  checkedAt: string;
  durationMs: number;
}

export interface GateContext {
  chapter: Chapter;
  /** 按章序排列的历史章节，用于跨章检查；不含本章 */
  previousChapters: Chapter[];
  /** 本书全部伏笔，用于核对声明的回收动作 */
  foreshadows: Foreshadow[];
}

export interface GateRule {
  readonly name: string;
  check(context: GateContext): GateResult;
}

export function finding(
  rule: string,
  severity: Severity,
  message: string,
  details?: Record<string, unknown>,
  blocking: boolean = severity === 'error',
): GateFinding {
  return { rule, severity, message, blocking, ...(details ? { details } : {}) };
}

/** 观察项：记录但不阻断定稿（如字数偏差、节奏偏移） */
export function observation(
  rule: string,
  severity: Severity,
  message: string,
  details?: Record<string, unknown>,
): GateFinding {
  return finding(rule, severity, message, details, false);
}

export function result(rule: string, findings: GateFinding[]): GateResult {
  return {
    rule,
    passed: !findings.some((item) => item.blocking),
    findings,
  };
}
