/**
 * 提示词构建。所有 AI 调用的输入都来自结构化事实源 + 本章按需切片，
 * 不把全书正文塞进上下文。
 */

import type { Chapter, ChapterTask, FactSourceState, HookType, Strand } from '../domain/models.js';
import type { AssembledContext } from '../assembly/assembler.js';
import type { ChatMessage, LlmObservation } from './types.js';

export interface WritingRequest {
  chapter: Chapter;
  assembled: AssembledContext;
  facts: FactSourceState;
  bookOutline?: string;
  volumeOutline?: string;
  authorGuidance?: string;
}

const WRITING_SYSTEM = `你是一位中文网文写手，为作者起草一章正文。严格遵守：
1. 角色状态、位置、能力、已知信息、世界规则以提供的「事实源」为准。不要从正文推断状态，不要自行添加事实。
2. 本章必须处理的线索任务（到期/逾期/指派）要在正文中体现；回收类任务必须出现给出的证据词。
3. 章纲声明的出场角色、地点、情绪标签、钩子类型、Strand 都要落实。
4. 不使用套话（如"仿佛整个世界都""深吸一口气""嘴角勾起一抹"），段落长度要有变化。
5. 只输出正文，不要解释、不要标题、不要 Markdown 标记。`;

export function buildWritingMessages(request: WritingRequest): ChatMessage[] {
  const { chapter, assembled, facts } = request;
  const taskLines = assembled.chapterTasks.length
    ? assembled.chapterTasks
        .map(
          (t: ChapterTask) =>
            `- [${t.source}] ${t.title}：${t.action === 'resolve' ? '回收' : '推进'}，证据词 ${t.markers.join(' / ') || '未定义'}`,
        )
        .join('\n')
    : '（无）';

  const characterLines = assembled.characters.length
    ? assembled.characters
        .map(
          (c) =>
            `- ${c.name}（${c.isAlive ? '在世' : '已故'}）：位置 ${c.location ?? '未记录'}；能力 ${c.abilities.map((a) => `${a.name}${a.level}`).join('、') || '无'}；已知 ${c.knownFacts.join('；') || '无'}`,
        )
        .join('\n')
    : '（本章无出场角色）';

  const ruleLines = assembled.worldRules.length
    ? assembled.worldRules.map((r) => `- [${r.category}] ${r.rule}`).join('\n')
    : '（无适用规则）';

  const timelineLines = assembled.timelineSlice.length
    ? assembled.timelineSlice.map((e) => `- 第${e.storyOrder}位 ${e.storyTime}：${e.description}`).join('\n')
    : '（无）';

  const overdueLines = assembled.overdueForeshadows.length
    ? assembled.overdueForeshadows.map((f) => `- ${f.title}（计划第${f.plannedResolveOrdinal}章）`).join('\n')
    : '（无）';

  const outline = facts.timelineEvents.length ? timelineLines : '（无）';
  const target = chapter.targetWords ?? 3000;

  const user = `【本章】第 ${chapter.ordinal} 章《${chapter.title}》，目标 ${target} 字。
【作品总纲】${request.bookOutline?.trim() || '（未提供）'}
【本卷卷纲】${request.volumeOutline?.trim() || '（未提供）'}
【章纲】${chapter.outline || '（未提供，按出场角色与线索任务推进）'}
【Strand】${chapter.strand ?? '未标注'}　【钩子】${chapter.hookType ?? '未标注'}　【情绪】${chapter.emotionTags.join('、') || '未标注'}
【本章出场角色状态（事实源按本章时点取值）】
${characterLines}
【本章必须处理的线索任务】
${taskLines}
【逾期未回收的主线伏笔（留意但不强行回收）】
${overdueLines}
【命中的世界规则（铁律优先）】
${ruleLines}
【时间线切片】
${outline}
${request.authorGuidance ? `【作者额外指导】${request.authorGuidance}` : ''}

请按以上约束写出本章正文。`;

  return [
    { role: 'system', content: WRITING_SYSTEM },
    { role: 'user', content: user },
  ];
}

export interface AuditRequest {
  chapter: Chapter;
  facts: FactSourceState;
  previousSummaries: string[];
  /** 题材侧重：只作为「额外关注点」提示，不改变四类判断维度，也不引入脚本该做的判定 */
  genreName?: string;
  genreFocus?: string[];
}

const AUDIT_SYSTEM = `你是中文网文的审稿编辑，只做判断性审稿。严格限制：
1. 不检查字数、不检查伏笔回收证据词、不检查钩子轮换——这些由本地脚本判定，不要重复。
2. 不要从正文推断角色状态。角色位置、能力、已知信息以提供的「事实源」为准；正文与之冲突时报告问题，而不是修改事实。
3. 只在确有证据时报告问题，每条必须引用正文原句并指出段落序号。
4. 只输出 JSON 数组，每个元素形如：
   {"category":"ooc|logic|style|emotion","severity":"error|warning|info","paragraphIndex":0,"evidence":"原文句子","message":"问题说明","suggestion":"修改建议"}
   没有问题输出 []。`;

export function buildAuditMessages(request: AuditRequest): ChatMessage[] {
  const { chapter, facts } = request;
  const stateLines = facts.characterStates
    .filter((s) => chapter.declaredCharacters.includes(s.characterId))
    .map((s) => {
      const c = facts.characters.find((item) => item.id === s.characterId);
      return `- ${c?.name ?? s.characterId}：位置 ${s.location ?? '未记录'}；已知 ${s.knownFacts.join('；') || '无'}`;
    })
    .join('\n');

  const ruleLines = facts.worldRules
    .filter((r) => r.priority >= 100)
    .map((r) => `- [${r.category}] ${r.rule}`)
    .join('\n');

  const focusLines = (request.genreFocus ?? []).map((line) => `- ${line}`).join('\n');

  const user = `【第 ${chapter.ordinal} 章《${chapter.title}》正文】
${chapter.content ?? ''}

【事实源 · 本章出场角色的权威状态（不要从正文推断）】
${stateLines || '（无）'}
【事实源 · 铁律】
${ruleLines || '（无）'}
【前文摘要（仅用于理解连续性）】
${request.previousSummaries.slice(-5).join('\n') || '（无）'}
${focusLines ? `【题材侧重：${request.genreName ?? '当前题材'}】\n${focusLines}` : ''}

请只针对人物一致性(OOC)、逻辑合理性、文风自然度、情感弧线四类做判断性审稿，输出 JSON 数组。`;

  return [
    { role: 'system', content: AUDIT_SYSTEM },
    { role: 'user', content: user },
  ];
}

/** 解析 LLM 输出，容忍 markdown 代码围栏 */
export function parseLlmObservations(raw: string): LlmObservation[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): LlmObservation[] => {
      if (typeof item !== 'object' || item === null) return [];
      const o = item as Record<string, unknown>;
      if (
        typeof o.message !== 'string' ||
        typeof o.evidence !== 'string' ||
        !['ooc', 'logic', 'style', 'emotion'].includes(String(o.category))
      ) {
        return [];
      }
      const severity = ['error', 'warning', 'info'].includes(String(o.severity))
        ? (o.severity as LlmObservation['severity'])
        : 'info';
      const paragraphIndex =
        typeof o.paragraphIndex === 'number' && Number.isInteger(o.paragraphIndex) && o.paragraphIndex >= 0
          ? o.paragraphIndex
          : null;
      return [
        {
          category: o.category as LlmObservation['category'],
          severity,
          message: o.message,
          paragraphIndex,
          evidence: o.evidence,
          ...(typeof o.suggestion === 'string' ? { suggestion: o.suggestion } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

/* ---------------- 旧稿反推 ---------------- */

export interface ExtractionChapter {
  ordinal: number;
  title: string;
  content: string;
}

export interface ExtractionRequest {
  bookTitle: string;
  chapters: ExtractionChapter[];
}

const EXTRACTION_SYSTEM = `你是中文小说设定整理助手。任务是从给定正文节选中抽取「可长期复用的事实」。
硬规则：
1. 只依据给定正文，不补充任何未出现的信息；不确定就留空或省略该条。
2. 角色只记录姓名、别名/称呼、当前所在位置、能力（名称+等级数字）、别人告诉过他或他亲历的关键信息。
3. 伏笔只记录正文中明确提出、但尚未解答的悬念；已知解答的不要记为伏笔。
4. 世界规则只记录世界运作的硬设定（物理/社会/体系规则），不记录情节。
5. 时间线只记录有明确先后顺序的关键事件。
6. 若发现前后矛盾（同一事实在不同章节写法不一致），写进 conflicts，不要替作者裁决。
7. 只输出 JSON，不要输出解释、不要用 Markdown 围栏。

输出结构：
{
  "characters": [{"name": "", "aliases": [], "location": "", "abilities": [{"name": "", "level": 1}], "knownFacts": []}],
  "foreshadows": [{"title": "", "kind": "main", "plannedResolveOrdinal": null, "resolutionMarkers": []}],
  "worldRules": [{"category": "", "rule": "", "priority": 0}],
  "timelineEvents": [{"chapterOrdinal": 1, "storyTime": "", "description": ""}],
  "conflicts": [{"chapterOrdinal": 1, "description": ""}]
}`;

export function buildExtractionMessages(request: ExtractionRequest): ChatMessage[] {
  const body = request.chapters
    .map(
      (chapter) =>
        `【第 ${chapter.ordinal} 章《${chapter.title}》】\n${chapter.content.slice(0, 4000)}`,
    )
    .join('\n\n');

  const user = `【书名】${request.bookTitle}
【说明】以下是从旧稿中抽取的章节节选，请按系统要求抽取设定。章节可能不连续，请只依据看到的文字。

${body}

请输出 JSON。`;

  return [
    { role: 'system', content: EXTRACTION_SYSTEM },
    { role: 'user', content: user },
  ];
}
