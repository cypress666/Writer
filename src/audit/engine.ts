/** 审计引擎：对照事实源逐条核对草稿，产出问题清单。不自动修订原稿。 */

import { now } from '../db/mappers.js';
import { applyAuditLevel, type GenreProfile } from '../domain/genres.js';
import type { AuditContext, AuditReport, AuditRule } from './types.js';
import { defaultAuditRules } from './rules.js';

export class AuditEngine {
  constructor(private readonly rules: AuditRule[] = defaultAuditRules) {}

  /**
   * @param genre 题材侧重。strict 把「能力越界」「伏笔矛盾」这类升级为 error（阻断），
   *              relaxed 降级为 warning（只提示）。判定逻辑本身不随题材变化。
   */
  audit(context: AuditContext, genre?: GenreProfile): AuditReport {
    const policy = genre?.audit;
    const issues = this.rules.flatMap((rule) => {
      const checked = rule.check(context).map((issue, index) => ({
        ...issue,
        id: `${rule.name}:${context.chapter.id}:${index}`,
      }));
      if (!policy) return checked;
      return applyAuditLevel(checked, policy);
    });

    return {
      chapterId: context.chapter.id,
      issues,
      passed: !issues.some((issue) => issue.severity === 'error'),
      checkedAt: now(),
    };
  }

  /** 供 GUI 审稿面板分组展示 */
  static groupBySeverity(report: AuditReport) {
    return {
      errors: report.issues.filter((issue) => issue.severity === 'error'),
      warnings: report.issues.filter((issue) => issue.severity === 'warning'),
      infos: report.issues.filter((issue) => issue.severity === 'info'),
    };
  }
}
