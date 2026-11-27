/**
 * AI 服务：写作生成、判断性审计、大纲建议。
 * 所有调用都经过 AiClient（分模型路由 + 重试），输入由 prompts.ts 构建。
 */

import type { Chapter, FactSourceState } from '../domain/models.js';
import type { AssembledContext } from '../assembly/assembler.js';
import { AiClient } from './client.js';
import {
  buildAuditMessages,
  buildExtractionMessages,
  buildWritingMessages,
  parseLlmObservations,
  type ExtractionChapter,
} from './prompts.js';
import { parseFactProposal, type FactProposalBody } from './extraction.js';
import type { LlmAuditResult } from './types.js';

export interface GenerateWritingInput {
  chapter: Chapter;
  assembled: AssembledContext;
  facts: FactSourceState;
  bookOutline?: string;
  volumeOutline?: string;
  authorGuidance?: string;
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

export interface RunAuditInput {
  chapter: Chapter;
  facts: FactSourceState;
  previousSummaries: string[];
  /** 题材侧重：来自作品题材的 auditFocus，仅作为额外关注点注入 */
  genreName?: string;
  genreFocus?: string[];
}

export class AiService {
  constructor(private readonly client: AiClient) {}

  async generateWriting(input: GenerateWritingInput): Promise<{
    content: string;
    model: string;
    tokens: number;
    promptTokens: number;
  }> {
    const messages = buildWritingMessages({
      chapter: input.chapter,
      assembled: input.assembled,
      facts: input.facts,
      bookOutline: input.bookOutline,
      volumeOutline: input.volumeOutline,
      authorGuidance: input.authorGuidance,
    });
    const promptTokens = this.client.estimateTokens(messages.map((m) => m.content).join('\n'));
    const response = await this.client.chat('writing', {
      messages,
      onToken: input.onToken,
      signal: input.signal,
    });
    return {
      content: response.content.trim(),
      model: response.model,
      tokens: response.usage?.completionTokens ?? this.client.estimateTokens(response.content),
      promptTokens: response.usage?.promptTokens ?? promptTokens,
    };
  }

  async runLlmAudit(input: RunAuditInput): Promise<LlmAuditResult> {
    const messages = buildAuditMessages({
      chapter: input.chapter,
      facts: input.facts,
      previousSummaries: input.previousSummaries,
      ...(input.genreName ? { genreName: input.genreName } : {}),
      ...(input.genreFocus?.length ? { genreFocus: input.genreFocus } : {}),
    });
    const promptTokens = this.client.estimateTokens(messages.map((m) => m.content).join('\n'));
    const response = await this.client.chat('audit', { messages, temperature: 0.2 });
    const observations = parseLlmObservations(response.content);
    return {
      observations,
      model: response.model,
      tokens: response.usage?.totalTokens ?? this.client.estimateTokens(response.content),
      promptTokens: response.usage?.promptTokens ?? promptTokens,
    };
  }

  /** 大纲建议：只基于已有事实源与章纲，不读取未来章节正文 */
  async suggestOutline(input: {
    bookTitle: string;
    existingOutline: string;
    facts: FactSourceState;
    chapterCount: number;
  }): Promise<string> {
    const stateSummary = input.facts.characters
      .map((c) => `- ${c.name}：${c.notes.slice(0, 120)}`)
      .join('\n');
    const hooks = input.facts.foreshadows
      .filter((f) => f.status !== 'resolved')
      .map((f) => `- ${f.title}（计划第${f.plannedResolveOrdinal ?? '?'}章）`)
      .join('\n');
    const response = await this.client.chat('outline', {
      messages: [
        {
          role: 'system',
          content: '你是网文结构编辑。基于已有设定与未回收伏笔给出卷纲建议，不要凭空发明与设定冲突的实体。输出 Markdown。',
        },
        {
          role: 'user',
          content: `【书名】${input.bookTitle}\n【已有大纲】${input.existingOutline || '（无）'}\n【角色】\n${stateSummary || '（无）'}\n【未回收伏笔】\n${hooks || '（无）'}\n【当前章数】${input.chapterCount}\n请给出下一卷的卷纲建议。`,
        },
      ],
    });
    return response.content.trim();
  }

  /**
   * 旧稿反推：只产出候选，不写库。
   * 用 outline 用途的模型（结构理解），低温度以保证可解析性。
   */
  async extractFacts(input: {
    bookTitle: string;
    chapters: ExtractionChapter[];
  }): Promise<{ proposal: FactProposalBody; model: string; tokens: number; promptTokens: number }> {
    const messages = buildExtractionMessages({ bookTitle: input.bookTitle, chapters: input.chapters });
    const promptTokens = this.client.estimateTokens(messages.map((m) => m.content).join('\n'));
    const response = await this.client.chat('outline', { messages, temperature: 0.1 });
    const proposal = parseFactProposal(response.content);
    const total =
      proposal.characters.length +
      proposal.foreshadows.length +
      proposal.worldRules.length +
      proposal.timelineEvents.length +
      proposal.conflicts.length;
    // 抽出 0 条但模型确实回了内容 —— 说明模型没按 JSON 契约作答（上下文被截断、
    // 小模型跑偏、或把正文当续写材料）。静默返回空列表会让作者以为"这本书没有设定"，
    // 所以这里直接把原始开头抛出来，便于定位。
    if (total === 0 && response.content.trim().length > 0) {
      const head = response.content.replace(/\s+/g, ' ').slice(0, 120);
      throw new Error(
        `模型未按 JSON 格式返回设定候选（可能是上下文不足或模型能力不够）。模型原话开头：「${head}」\n` +
          '可在设置页把该模型的「上下文窗口」调大，或减少反推章节数后重试。',
      );
    }
    return {
      proposal,
      model: response.model,
      tokens: response.usage?.totalTokens ?? this.client.estimateTokens(response.content),
      promptTokens: response.usage?.promptTokens ?? promptTokens,
    };
  }

  connectivity(modelId: string) {
    const model = this.client.listModels().find((item) => item.id === modelId);
    if (!model) return Promise.resolve({ ok: false, latencyMs: 0, message: '模型不存在' });
    return this.client.connectivity(model);
  }
}
