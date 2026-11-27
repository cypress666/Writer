import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiClient } from '../src/ai/client.js';
import { applyDecisions, diffParagraphs } from '../src/ai/diff.js';
import { AiService } from '../src/ai/service.js';
import type { AiConfiguration, ModelConfig } from '../src/ai/types.js';
import { assembleContext } from '../src/assembly/assembler.js';
import type { Chapter } from '../src/domain/models.js';
import { createTestHarness } from './helpers.js';

const model: ModelConfig = {
  id: 'm-writing',
  label: '测试写作模型',
  provider: 'openai-compatible',
  baseUrl: 'http://api.example.com/v1',
  credentialId: '',
  model: 'qwen-test',
  contextWindow: 8192,
  enabled: true,
};

const config: AiConfiguration = {
  defaults: { writing: model.id, audit: model.id },
  models: [model],
  requestTimeoutMs: 5000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('AI 闭环：事实源 → 装配 → 生成 → 裁决', () => {
  it('写作 prompt 只含按需切片，不含未来章节正文；新稿经逐段裁决才写入', async () => {
    const { books, facts } = createTestHarness();
    const chapter = books.createChapter({
      id: 'ch-ai',
      bookId: 'book-1',
      ordinal: 11,
      title: '雾中来客',
      outline: '主角在渡口遇见神秘人',
      declaredCharacters: ['char-ai'],
      declaredForeshadows: [{ foreshadowId: 'fs-ai', action: 'resolve' }],
      emotionTags: ['紧张'],
    });
    books.updateChapterContent('ch-10', '【未来章剧透内容】渡口之人其实是最终反派');
    facts.createCharacter({
      id: 'char-ai',
      bookId: 'book-1',
      name: '林风',
      initialState: { location: '青云城', knownFacts: ['渡口有钟声'] },
    });
    facts.createForeshadow({
      id: 'fs-ai',
      bookId: 'book-1',
      title: '雾中的钟声',
      kind: 'main',
      plantedInChapterId: 'ch-0',
      plannedResolveOrdinal: 11,
      resolutionMarkers: ['钟声三响'],
    });

    const state = facts.loadState('book-1');
    const assembled = assembleContext({
      spec: {
        ordinal: chapter.ordinal,
        title: chapter.title,
        outline: chapter.outline,
        characterIds: chapter.declaredCharacters,
        locations: chapter.declaredLocations,
        foreshadows: chapter.declaredForeshadows,
        emotionTags: chapter.emotionTags,
      },
      characters: state.characters,
      characterStates: state.characterStates,
      worldRules: state.worldRules,
      foreshadows: state.foreshadows,
      timelineEvents: state.timelineEvents,
      stateAt: (id, ordinal) => facts.stateAt(id, ordinal),
    });

    const paragraphs = ['林风站在渡口，雾里传来钟声三响。', '他认出了那声音，却装作什么都没发生。'];
    const revised = paragraphs.join('\n\n');
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse(
        paragraphs.map((text, index) =>
          JSON.stringify({ choices: [{ delta: { content: index === 0 ? `${text}\n\n` : text } }] }),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(new AiClient({ config, resolveKey: () => '' }));
    const tokens: string[] = [];

    const result = await service.generateWriting({
      chapter,
      assembled,
      facts: state,
      onToken: (token) => tokens.push(token),
    });

    expect(result.content).toBe(revised);
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.promptTokens).toBeGreaterThan(0);
    expect(tokens).toEqual([`${paragraphs[0]}\n\n`, paragraphs[1]]);

    const sentBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    const prompt = sentBody.messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('青云城');
    expect(prompt).toContain('钟声三响');
    expect(prompt).toContain('雾中来客');
    expect(prompt).not.toContain('未来章剧透内容');

    // 原稿不动；只有被作者接受的段落才进入正文
    books.updateChapterContent('ch-ai', '作者手写的第一段。\n\n作者手写的第二段。');
    const before = books.getChapter('ch-ai') as Chapter;
    const diff = diffParagraphs(before.content ?? '', result.content);
    expect(diff.stats.kept).toBe(0);
    const accepted = new Set(diff.changes.map((_, index) => index));
    const merged = applyDecisions(diff.changes, accepted);
    expect(merged).toBe(revised);
    books.updateChapterContent('ch-ai', merged);
    expect(books.getChapter('ch-ai')?.content).toBe(revised);
  });

  it('LLM 审稿只返回四类判断性观察，且 prompt 带权威状态而非正文推断', async () => {
    const { books, facts } = createTestHarness();
    const chapter = books.createChapter({
      id: 'ch-audit',
      bookId: 'book-1',
      ordinal: 12,
      title: '夜行',
      declaredCharacters: ['char-audit'],
    });
    const content = '林风走出城门，忽然说自己早已身在千里之外。';
    books.updateChapterContent('ch-audit', content);
    facts.createCharacter({
      id: 'char-audit',
      bookId: 'book-1',
      name: '林风',
      initialState: { location: '青云城' },
    });
    books.updateChapterContent('ch-10', '【不应出现在审稿 prompt 的未来正文】');

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify([
                { category: 'logic', severity: 'warning', paragraphIndex: 0, message: '地点跳跃', evidence: '千里之外' },
                { category: 'word-count', severity: 'error', message: '字数不足', evidence: '' },
              ]),
            },
          },
        ],
        usage: { totalTokens: 88 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(new AiClient({ config, resolveKey: () => '' }));
    const state = facts.loadState('book-1');

    const result = await service.runLlmAudit({
      chapter: books.getChapter('ch-audit') as Chapter,
      facts: state,
      previousSummaries: ['第 1 章 雾起'],
    });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.category).toBe('logic');
    expect(result.tokens).toBe(88);
    expect(result.promptTokens).toBeGreaterThan(0);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
      temperature: number;
    };
    const prompt = body.messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('青云城');
    expect(prompt).toContain(content);
    expect(prompt).not.toContain('不应出现在审稿 prompt 的未来正文');
    expect(body.temperature).toBe(0.2);
  });
});
