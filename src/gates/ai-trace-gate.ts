/**
 * 去 AI 味的规则检测。
 *
 * 段落等长、套话密度、公式化转折都属于可确定性判定的项目，
 * 交给本地程序完成；"文风指纹"由作者定稿章节提取后作为软约束，不在此处判定。
 */

import type { GateContext, GateFinding, GateRule } from './types.js';
import { finding, result } from './types.js';
import { countWords } from './word-count.js';

const CLICHES = [
  '仿佛整个世界都',
  '这一刻，他终于明白',
  '在这一瞬间',
  '不禁倒吸一口凉气',
  '眼底闪过一丝',
  '嘴角勾起一抹',
  '心中五味杂陈',
  '不由得',
  '然而事实并非如此',
  '一切都是那么的',
  '深吸一口气',
  '缓缓闭上眼睛',
  '空气中弥漫着',
  '仿佛要凝固',
  '如同潮水般',
];

const TURN_MARKERS = ['然而', '但是', '就在这时', '突然', '与此同时', '不过', '可就在这时'];

function splitParagraphs(content: string): string[] {
  return content
    .split(/\n\s*\n|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface AiTraceOptions {
  /** 段落数达到该值才做等长检测 */
  minParagraphs?: number;
  /** 字数变异系数低于该值判定为段落等长 */
  maxCv?: number;
  /** 每千字套话告警阈值 */
  clichePerThousand?: number;
}

export function countCliches(content: string): number {
  let total = 0;
  for (const cliche of CLICHES) {
    let index = content.indexOf(cliche);
    while (index !== -1) {
      total += 1;
      index = content.indexOf(cliche, index + cliche.length);
    }
  }
  return total;
}

export function paragraphLengthCv(paragraphs: string[]): number {
  if (paragraphs.length === 0) return 0;
  const lengths = paragraphs.map(countWords);
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  if (mean === 0) return 0;
  const variance = lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length;
  return Math.sqrt(variance) / mean;
}

export function createAiTraceRule(options: AiTraceOptions = {}): GateRule {
  const minParagraphs = options.minParagraphs ?? 4;
  const maxCv = options.maxCv ?? 0.18;
  const clichePerThousand = options.clichePerThousand ?? 2;

  return {
    name: 'ai-trace',
    check(context: GateContext) {
      const findings: GateFinding[] = [];
      const content = context.chapter.content ?? '';
      const paragraphs = splitParagraphs(content);

      if (paragraphs.length >= minParagraphs) {
        const cv = paragraphLengthCv(paragraphs);
        if (cv <= maxCv) {
          findings.push(
            finding('ai-trace', 'warning', `段落长度过于整齐（变异系数 ${cv.toFixed(2)}），建议打散节奏`, {
              coefficientOfVariation: cv,
              paragraphCount: paragraphs.length,
            }),
          );
        }
      }

      const cliches = countCliches(content);
      const words = countWords(content);
      const density = words > 0 ? (cliches / words) * 1000 : 0;
      if (cliches >= 2 && density > clichePerThousand) {
        findings.push(
          finding('ai-trace', 'warning', `套话密度偏高：每千字 ${density.toFixed(1)} 处（共 ${cliches} 处）`, {
            count: cliches,
            densityPerThousand: density,
          }),
        );
      }

      let consecutiveTurns = 0;
      let turnStartOrdinal = 0;
      for (let index = 0; index < paragraphs.length; index += 1) {
        const paragraph = paragraphs[index]!;
        if (TURN_MARKERS.some((marker) => paragraph.startsWith(marker))) {
          consecutiveTurns += 1;
          if (consecutiveTurns === 1) turnStartOrdinal = index;
          if (consecutiveTurns >= 3) {
            findings.push(
              finding(
                'ai-trace',
                'warning',
                `连续 ${consecutiveTurns} 段以公式化转折词开头，建议改写`,
                { paragraphIndex: turnStartOrdinal, consecutive: consecutiveTurns },
              ),
            );
            break;
          }
        } else {
          consecutiveTurns = 0;
        }
      }

      return result('ai-trace', findings);
    },
  };
}
