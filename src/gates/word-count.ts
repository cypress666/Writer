/**
 * 字数实测：中文按字计数，英文/数字按词计数，标点不计。
 *
 * 取自 InkOS v2 的明确边界：字数超 hard range 不把章节标失败，只记录遥测与
 * observation；不截断正文。因此本规则所有 finding 的 blocking 均为 false。
 */

import type { GateContext, GateRule, GateFinding } from './types.js';
import { observation, result } from './types.js';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LATIN_WORD = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;

export function countWords(text: string): number {
  const hanCount = (text.match(HAN) ?? []).length;
  const latinCount = (text.match(LATIN_WORD) ?? []).length;
  return hanCount + latinCount;
}

export interface WordCountOptions {
  /** 低于目标字数的这个比例视为不足，默认 0.9 */
  minRatio?: number;
  /** 高于目标字数的这个比例视为超长，默认 1.15 */
  maxRatio?: number;
  /** 无目标字数时的绝对下限，默认 100 */
  absoluteMin?: number;
}

export function createWordCountRule(options: WordCountOptions = {}): GateRule {
  const minRatio = options.minRatio ?? 0.9;
  const maxRatio = options.maxRatio ?? 1.15;
  const absoluteMin = options.absoluteMin ?? 100;

  return {
    name: 'word-count',
    check(context: GateContext) {
      const findings: GateFinding[] = [];
      const content = context.chapter.content ?? '';
      const actual = countWords(content);

      if (actual === 0) {
        findings.push(observation('word-count', 'error', '章节正文为空'));
        return result('word-count', findings);
      }

      const target = context.chapter.targetWords;
      if (target == null || target <= 0) {
        if (actual < absoluteMin) {
          findings.push(
            observation('word-count', 'warning', `正文仅 ${actual} 字，低于最低要求 ${absoluteMin} 字`, {
              actual,
              minimum: absoluteMin,
            }),
          );
        }
        return result('word-count', findings);
      }

      const lower = Math.floor(target * minRatio);
      const upper = Math.ceil(target * maxRatio);
      if (actual < lower) {
        findings.push(
          observation('word-count', 'warning', `正文 ${actual} 字，低于目标 ${target} 字的下限 ${lower}`, {
            actual,
            target,
            lower,
            upper,
            telemetry: { actual, target, deviation: (actual - target) / target },
          }),
        );
      } else if (actual > upper) {
        findings.push(
          observation('word-count', 'warning', `正文 ${actual} 字，超过目标 ${target} 字的上限 ${upper}`, {
            actual,
            target,
            lower,
            upper,
            telemetry: { actual, target, deviation: (actual - target) / target },
          }),
        );
      }

      return result('word-count', findings);
    },
  };
}
