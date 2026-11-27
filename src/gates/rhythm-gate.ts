/** 钩子形状轮换 + 情绪节奏分布。两项都属于"可程序化判定"的连载纪律。 */

import type { HookType } from '../domain/models.js';
import type { GateContext, GateFinding, GateRule } from './types.js';
import { finding, result } from './types.js';

interface RhythmOptions {
  /** 检查窗口大小，默认 6 章 */
  window?: number;
  /** 连续同类型的告警阈值，默认 3 章 */
  maxConsecutive?: number;
}

export function createHookRotationRule(options: RhythmOptions = {}): GateRule {
  const windowSize = options.window ?? 6;
  const maxConsecutive = options.maxConsecutive ?? 3;

  return {
    name: 'hook-rotation',
    check(context: GateContext) {
      const findings: GateFinding[] = [];
      const hookType = context.chapter.hookType;

      if (hookType == null) {
        findings.push(finding('hook-rotation', 'warning', '本章未声明钩子类型，无法参与轮换检查'));
      } else if (hookType === 'none') {
        findings.push(finding('hook-rotation', 'warning', '本章钩子类型为 none，连载章节建议保留钩子'));
      }

      const sequence: Array<{ ordinal: number; type: HookType | null }> = [
        ...context.previousChapters.slice(-(windowSize - 1)).map((chapter) => ({
          ordinal: chapter.ordinal,
          type: chapter.hookType,
        })),
        { ordinal: context.chapter.ordinal, type: hookType },
      ];

      let run = 1;
      for (let index = 1; index < sequence.length; index += 1) {
        const current = sequence[index]!.type;
        const previous = sequence[index - 1]!.type;
        if (current != null && current === previous) {
          run += 1;
        } else {
          run = 1;
        }
        if (run >= maxConsecutive && current != null && current !== 'none') {
          findings.push(
            finding(
              'hook-rotation',
              'warning',
              `钩子类型「${current}」已连续 ${run} 章（截至第 ${sequence[index]!.ordinal} 章），建议轮换`,
              { hookType: current, consecutive: run, fromOrdinal: sequence[index - run + 1]!.ordinal },
            ),
          );
          break;
        }
      }

      return result('hook-rotation', findings);
    },
  };
}

const HEAVY_TAGS = new Set(['压抑', '绝望', '悲痛', '窒息', '崩溃']);

export function createEmotionRhythmRule(options: RhythmOptions = {}): GateRule {
  const windowSize = options.window ?? 6;
  const maxConsecutive = options.maxConsecutive ?? 3;

  return {
    name: 'emotion-rhythm',
    check(context: GateContext) {
      const findings: GateFinding[] = [];
      const tags = context.chapter.emotionTags;

      if (tags.length === 0) {
        findings.push(finding('emotion-rhythm', 'warning', '本章未标注情绪标签'));
      }

      const recent = [...context.previousChapters.slice(-(windowSize - 1)), context.chapter];
      const allTags = recent.flatMap((chapter) => chapter.emotionTags);
      const distinct = new Set(allTags);
      if (allTags.length > 0 && distinct.size < 2) {
        findings.push(
          finding('emotion-rhythm', 'warning', `最近 ${recent.length} 章情绪标签单一（仅「${[...distinct][0]}」）`, {
            distinct: [...distinct],
          }),
        );
      }

      let run = 1;
      for (let index = 1; index < recent.length; index += 1) {
        const current = recent[index]!.emotionTags;
        const previous = recent[index - 1]!.emotionTags;
        const overlap = current.filter((tag) => previous.includes(tag));
        run = overlap.length > 0 ? run + 1 : 1;
        if (run >= maxConsecutive && overlap.length > 0) {
          findings.push(
            finding(
              'emotion-rhythm',
              'warning',
              `情绪标签「${overlap.join('、')}」已连续 ${run} 章，建议插入调剂章节`,
              { tags: overlap, consecutive: run, fromOrdinal: recent[index - run + 1]!.ordinal },
            ),
          );
          break;
        }
      }

      const heavyRun = recent.filter((chapter) =>
        chapter.emotionTags.some((tag) => HEAVY_TAGS.has(tag)),
      ).length;
      if (heavyRun >= maxConsecutive) {
        findings.push(
          finding('emotion-rhythm', 'warning', `最近 ${heavyRun} 章持续处于高压情绪，读者疲劳风险上升`, {
            consecutive: heavyRun,
          }),
        );
      }

      return result('emotion-rhythm', findings);
    },
  };
}
