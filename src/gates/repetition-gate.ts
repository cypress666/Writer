/** 章节内与跨章重复用语检测。纯字符串统计，不调用模型。 */

import type { GateContext, GateFinding, GateRule } from './types.js';
import { finding, result } from './types.js';

const STOP_CHARS = new Set([
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '及', '或', '着', '过', '被',
]);

export function extractNgrams(text: string, n: number): Map<string, number> {
  const cleaned = text.replace(/[^\u4e00-\u9fffA-Za-z]/g, '');
  const counts = new Map<string, number>();
  for (let index = 0; index + n <= cleaned.length; index += 1) {
    const gram = cleaned.slice(index, index + n);
    const stopRatio = [...gram].filter((char) => STOP_CHARS.has(char)).length / n;
    if (stopRatio >= 0.5) continue;
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function topNgrams(counts: Map<string, number>, minCount: number, limit: number): string[] {
  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([gram]) => gram);
}

export interface RepetitionOptions {
  ngramSize?: number;
  /** 章节内同一 n-gram 达到该次数即告警 */
  intraThreshold?: number;
  /** 跨章比对的历史章数 */
  crossChapterWindow?: number;
}

export function createRepetitionRule(options: RepetitionOptions = {}): GateRule {
  const n = options.ngramSize ?? 4;
  const intraThreshold = options.intraThreshold ?? 3;
  const crossWindow = options.crossChapterWindow ?? 3;

  return {
    name: 'repetition',
    check(context: GateContext) {
      const findings: GateFinding[] = [];
      const content = context.chapter.content ?? '';
      const counts = extractNgrams(content, n);

      const intra = topNgrams(counts, intraThreshold, 5);
      if (intra.length > 0) {
        findings.push(
          finding('repetition', 'warning', `本章出现高频重复片段：${intra.map((g) => `「${g}」`).join('、')}`, {
            ngrams: intra,
            threshold: intraThreshold,
          }),
        );
      }

      const currentTop = new Set(topNgrams(counts, 2, 20));
      for (const previous of context.previousChapters.slice(-crossWindow)) {
        const previousTop = topNgrams(extractNgrams(previous.content ?? '', n), 2, 20);
        const overlap = previousTop.filter((gram) => currentTop.has(gram));
        if (overlap.length >= 2) {
          findings.push(
            finding(
              'repetition',
              'info',
              `与第 ${previous.ordinal} 章存在重复表达：${overlap.slice(0, 4).map((g) => `「${g}」`).join('、')}`,
              { chapterOrdinal: previous.ordinal, ngrams: overlap },
            ),
          );
        }
      }

      return result('repetition', findings);
    },
  };
}
