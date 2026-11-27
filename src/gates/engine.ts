/** 门禁引擎：汇总所有确定性规则，输出结构化检查报告。全程不调用 LLM。 */

import type { GateContext, GateReport, GateResult, GateRule } from './types.js';
import { createWordCountRule } from './word-count.js';
import { createForeshadowRule } from './foreshadow-gate.js';
import { createEmotionRhythmRule, createHookRotationRule } from './rhythm-gate.js';
import { createRepetitionRule } from './repetition-gate.js';
import { createAiTraceRule } from './ai-trace-gate.js';
import { createStrandRule } from './strand-gate.js';
import { applyGateLevel, type GenreProfile } from '../domain/genres.js';
import { now } from '../db/mappers.js';

export function defaultGateRules(): GateRule[] {
  return [
    createWordCountRule(),
    createForeshadowRule(),
    createHookRotationRule(),
    createEmotionRhythmRule(),
    createStrandRule(),
    createRepetitionRule(),
    createAiTraceRule(),
  ];
}

export class GateEngine {
  constructor(private readonly rules: GateRule[] = defaultGateRules()) {}

  /**
   * @param genre 题材侧重。只对 finding 做严格度升降级，不改规则判定逻辑，
   *              保证「同正文 + 同题材」结果可复现。
   */
  run(context: GateContext, genre?: GenreProfile): GateReport {
    const started = Date.now();
    const policy = genre?.gate;
    const results: GateResult[] = this.rules.map((rule) => {
      const checked = rule.check(context);
      if (!policy) return checked;
      // word-count 的 observation 语义是「作者自行裁决」，题材也不该把它变成阻断，
      // 所以只对规则内已有 finding 做升降级，不额外新增
      const findings = applyGateLevel(checked.findings, policy);
      return { ...checked, findings, passed: !findings.some((item) => item.blocking) };
    });
    return {
      chapterId: context.chapter.id,
      results,
      passed: results.every((item) => item.passed),
      checkedAt: now(),
      durationMs: Date.now() - started,
    };
  }

  /** 只保留真正阻断定稿的问题；字数偏差等 observation 不在此列 */
  static blockers(report: GateReport) {
    return report.results.flatMap((item) =>
      item.findings.filter((finding) => finding.blocking),
    );
  }

  /** 观察项：记录但不阻断，供作者裁决是否修稿 */
  static observations(report: GateReport) {
    return report.results.flatMap((item) =>
      item.findings.filter((finding) => !finding.blocking),
    );
  }
}
