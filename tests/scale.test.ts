import { describe, expect, it } from 'vitest';
import { AiClient } from '../src/ai/client.js';
import type { AiConfiguration } from '../src/ai/types.js';
import { assembleContext } from '../src/assembly/assembler.js';
import { BookRepository, FactSourceRepository, openDatabase } from '../src/index.js';
import { buildWritingMessages } from '../src/ai/prompts.js';
import type { Chapter } from '../src/domain/models.js';

const client = new AiClient({
  config: {
    defaults: {},
    models: [],
    requestTimeoutMs: 1000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  } satisfies AiConfiguration,
  resolveKey: () => '',
});

function promptTokens(chapter: Chapter, state: ReturnType<FactSourceRepository['loadState']>, facts: FactSourceRepository): number {
  const assembled = assembleContext({
    spec: {
      ordinal: chapter.ordinal,
      title: chapter.title,
      outline: '渡口夜雾，钟声再起',
      characterIds: ['c-1'],
      locations: ['青云城'],
      foreshadows: [{ foreshadowId: 'fs-1', action: 'advance' }],
      emotionTags: ['紧张'],
    },
    characters: state.characters,
    characterStates: state.characterStates,
    worldRules: state.worldRules,
    foreshadows: state.foreshadows,
    timelineEvents: state.timelineEvents,
    stateAt: (id, ordinal) => facts.stateAt(id, ordinal),
  });
  const messages = buildWritingMessages({ chapter, assembled, facts: state });
  return client.estimateTokens(messages.map((m) => m.content).join('\n'));
}

describe('百万字规模：按需装配的 token 不随章节数线性膨胀', () => {
  it('100 章模拟数据下，单章 prompt 保持有界', () => {
    const db = openDatabase(':memory:');
    const books = new BookRepository(db);
    const facts = new FactSourceRepository(db);
    books.createBook({ id: 'book-scale', title: '规模验证' });

    const makeChapter = (ordinal: number): Chapter =>
      books.createChapter({
        bookId: 'book-scale',
        ordinal,
        title: `第${ordinal}章 渡口`,
        outline: '渡口夜雾，钟声再起',
        declaredCharacters: ['c-1'],
        declaredLocations: ['青云城'],
        declaredForeshadows: [{ foreshadowId: 'fs-1', action: 'advance' }],
        emotionTags: ['紧张'],
      });

    const first = makeChapter(1);
    facts.createCharacter({
      id: 'c-1',
      bookId: 'book-scale',
      name: '林风',
      initialState: { location: '青云城', knownFacts: ['渡口有钟声'] },
    });
    facts.createForeshadow({
      id: 'fs-1',
      bookId: 'book-scale',
      title: '雾中的钟声',
      kind: 'main',
      plantedInChapterId: first.id,
      plannedResolveOrdinal: 500,
      resolutionMarkers: ['钟声三响'],
    });
    facts.createWorldRule({
      bookId: 'book-scale',
      category: 'travel',
      rule: '青云城夜间宵禁',
      priority: 0,
    });
    facts.createWorldRule({
      bookId: 'book-scale',
      category: 'combat',
      rule: '金丹期不可越阶击败元婴',
      priority: 100,
    });
    facts.createTimelineEvent({
      bookId: 'book-scale',
      storyTime: '第一年',
      storyOrder: 1,
      description: '林风抵达青云城',
    });

    const baselineState = facts.loadState('book-scale');
    const baseline = promptTokens(first, baselineState, facts);

    // 模拟 99 章增长：角色、伏笔、时间线、章节都线性增加
    for (let ordinal = 2; ordinal <= 100; ordinal += 1) {
      makeChapter(ordinal);
      facts.createCharacter({
        id: `c-${ordinal}`,
        bookId: 'book-scale',
        name: `配角${ordinal}`,
        initialState: { location: '青云城' },
      });
      facts.createForeshadow({
        id: `fs-${ordinal}`,
        bookId: 'book-scale',
        title: `支线伏笔${ordinal}`,
        kind: 'sub',
        plantedInChapterId: first.id,
        plannedResolveOrdinal: 500 + ordinal,
      });
      facts.createTimelineEvent({
        bookId: 'book-scale',
        storyTime: `第${ordinal}年`,
        storyOrder: ordinal,
        description: `林风在青云城经历事件${ordinal}`,
      });
    }

    const last = books.getChapterByOrdinal('book-scale', 100)!;
    const lateState = facts.loadState('book-scale');
    const late = promptTokens(last, lateState, facts);

    if (process.env['SCALE_VERBOSE']) {
      console.log(`[scale] 1章基线 ${baseline} token → 100章 ${late} token (${(late / baseline).toFixed(2)}x)`);
    }
    expect(lateState.characters).toHaveLength(100);
    expect(lateState.timelineEvents).toHaveLength(100);
    expect(late).toBeLessThan(baseline * 2);
  });

  it('同一批事实下，第 1 章与第 100 章的 prompt 基本一致', () => {
    const db = openDatabase(':memory:');
    const books = new BookRepository(db);
    const facts = new FactSourceRepository(db);
    books.createBook({ id: 'book-same', title: '同事实验证' });
    for (let ordinal = 1; ordinal <= 100; ordinal += 1) {
      books.createChapter({
        bookId: 'book-same',
        ordinal,
        title: `第${ordinal}章`,
        declaredCharacters: ['c-1'],
        declaredLocations: ['青云城'],
        declaredForeshadows: [{ foreshadowId: 'fs-1', action: 'advance' }],
      });
    }
    facts.createCharacter({
      id: 'c-1',
      bookId: 'book-same',
      name: '林风',
      initialState: { location: '青云城' },
    });
    facts.createForeshadow({
      id: 'fs-1',
      bookId: 'book-same',
      title: '主线谜题',
      kind: 'main',
      plantedInChapterId: books.getChapterByOrdinal('book-same', 1)!.id,
      plannedResolveOrdinal: 500,
      resolutionMarkers: ['谜底'],
    });
    for (let ordinal = 1; ordinal <= 100; ordinal += 1) {
      facts.createTimelineEvent({
        bookId: 'book-same',
        storyTime: `第${ordinal}年`,
        storyOrder: ordinal,
        description: `林风在青云城的事件${ordinal}`,
      });
    }

    const state = facts.loadState('book-same');
    const first = promptTokens(books.getChapterByOrdinal('book-same', 1)!, state, facts);
    const last = promptTokens(books.getChapterByOrdinal('book-same', 100)!, state, facts);
    if (process.env['SCALE_VERBOSE']) {
      console.log(`[scale] 同一批事实：第1章 ${first} token → 第100章 ${last} token`);
    }
    expect(Math.abs(last - first) / first).toBeLessThan(0.2);
  });

  it('逾期伏笔与时间线相关事件都有上限，超出部分进入 excluded', () => {
    const db = openDatabase(':memory:');
    const books = new BookRepository(db);
    const facts = new FactSourceRepository(db);
    books.createBook({ id: 'book-cap', title: '上限验证' });
    const chapter = books.createChapter({
      bookId: 'book-cap',
      ordinal: 100,
      title: '第100章',
      declaredCharacters: ['c-1'],
      declaredLocations: ['青云城'],
    });
    facts.createCharacter({
      id: 'c-1',
      bookId: 'book-cap',
      name: '林风',
      initialState: { location: '青云城' },
    });
    for (let i = 1; i <= 40; i += 1) {
      facts.createForeshadow({
        id: `fs-${i}`,
        bookId: 'book-cap',
        title: `逾期伏笔${i}`,
        kind: 'main',
        plantedInChapterId: chapter.id,
        plannedResolveOrdinal: i,
        resolutionMarkers: ['证据'],
      });
      facts.createTimelineEvent({
        bookId: 'book-cap',
        storyTime: `第${i}年`,
        storyOrder: i,
        description: `林风事件${i}`,
      });
    }

    const state = facts.loadState('book-cap');
    const assembled = assembleContext({
      spec: {
        ordinal: 100,
        title: '第100章',
        outline: '',
        characterIds: ['c-1'],
        locations: ['青云城'],
        foreshadows: [],
        emotionTags: [],
      },
      characters: state.characters,
      characterStates: state.characterStates,
      worldRules: state.worldRules,
      foreshadows: state.foreshadows,
      timelineEvents: state.timelineEvents,
      stateAt: (id, ordinal) => facts.stateAt(id, ordinal),
    });

    expect(assembled.overdueForeshadows).toHaveLength(5);
    expect(assembled.chapterTasks.filter((task) => task.source === 'overdue')).toHaveLength(5);
    expect(assembled.timelineSlice.length).toBeLessThanOrEqual(10);
    expect(assembled.excluded.foreshadows.filter((item) => item.reason.includes('上限'))).toHaveLength(35);
  });
});
