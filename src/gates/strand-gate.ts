/**
 * Strand Weave 节奏门禁（取自 webnovel-writer 架构文档）。
 *
 * Quest 主线 60% / Fire 感情线 20% / Constellation 世界观扩展 20%
 * 硬红线：Quest 连续 <= 5 章、Fire 断档 <= 10 章、Constellation 断档 <= 15 章。
 *
 * 这些是可程序化判定的量化指标，属于"连载纪律"而非模型自评。
 * 节奏偏移记为 observation，不阻断定稿。
 */

import type { Chapter, Strand } from '../domain/models.js';
import type { GateContext, GateFinding, GateRule } from './types.js';
import { observation, result } from './types.js';

export const STRAND_TARGET: Record<Strand, number> = {
  quest: 0.6,
  fire: 0.2,
  constellation: 0.2,
};

export const STRAND_LIMITS = {
  questMaxConsecutive: 5,
  fireMaxGap: 10,
  constellationMaxGap: 15,
} as const;

export interface StrandOptions {
  /** 占比统计窗口，默认 20 章 */
  window?: number;
  /** 占比偏离容忍度，默认 0.15（绝对差值） */
  tolerance?: number;
}

export function createStrandRule(options: StrandOptions = {}): GateRule {
  const windowSize = options.window ?? 20;
  const tolerance = options.tolerance ?? 0.15;

  return {
    name: 'strand-rhythm',
    check(context: GateContext) {
      const findings: GateFinding[] = [];
      const recent: Chapter[] = [...context.previousChapters.slice(-(windowSize - 1)), context.chapter];
      const strands = recent.map((chapter) => chapter.strand);

      if (strands.every((strand) => strand == null)) {
        findings.push(
          observation('strand-rhythm', 'info', `最近 ${recent.length} 章均未标注 Strand，无法检查节奏分布`),
        );
        return result('strand-rhythm', findings);
      }

      // 红线 1：Quest 连续不得超过 5 章
      let questRun = 0;
      for (const strand of strands) {
        questRun = strand === 'quest' ? questRun + 1 : 0;
        if (questRun > STRAND_LIMITS.questMaxConsecutive) {
          findings.push(
            observation(
              'strand-rhythm',
              'warning',
              `Quest 主线已连续 ${questRun} 章，超过上限 ${STRAND_LIMITS.questMaxConsecutive}`,
              { strand: 'quest', consecutive: questRun },
            ),
          );
          break;
        }
      }

      // 红线 2/3：Fire 与 Constellation 的断档
      for (const [strand, limit] of [
        ['fire', STRAND_LIMITS.fireMaxGap],
        ['constellation', STRAND_LIMITS.constellationMaxGap],
      ] as const) {
        let gap = 0;
        for (const current of strands) {
          gap = current === strand ? 0 : gap + 1;
          if (gap > limit) {
            findings.push(
              observation(
                'strand-rhythm',
                'warning',
                `${strand} 已断档 ${gap} 章，超过上限 ${limit}`,
                { strand, gap },
              ),
            );
            break;
          }
        }
      }

      // 占比检查：只统计已标注的章节，避免未标注章节稀释比例
      const labeled = strands.filter((strand): strand is Strand => strand != null);
      for (const [strand, target] of Object.entries(STRAND_TARGET) as Array<[Strand, number]>) {
        const actual = labeled.filter((item) => item === strand).length / labeled.length;
        if (Math.abs(actual - target) > tolerance) {
          findings.push(
            observation(
              'strand-rhythm',
              'warning',
              `${strand} 占比 ${Math.round(actual * 100)}%，目标 ${Math.round(target * 100)}%（偏离超过 ${Math.round(tolerance * 100)}%）`,
              { strand, actual, target, window: labeled.length },
            ),
          );
        }
      }

      return result('strand-rhythm', findings);
    },
  };
}
