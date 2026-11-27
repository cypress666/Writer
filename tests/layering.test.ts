import { describe, expect, it } from 'vitest';
import { assembleContext, createStrandRule, GateEngine, type GateContext } from '../src/index.js';
import { chineseText, createTestHarness, makeChapter, makeForeshadow, makeSpec } from './helpers.js';

describe('作者事实 / 派生投影分层', () => {
  it('派生值不能覆盖同章的作者值', () => {
    const { facts } = createTestHarness();
    facts.createCharacter({ id: 'char-1', bookId: 'book-1', name: '林风', initialState: { location: '青云城' } });

    facts.insertStateFact({
      bookId: 'book-1',
      characterId: 'char-1',
      field: 'location',
      value: '天魔宗',
      provenance: 'derived',
      effectiveChapter: 0,
      sourceReceiptId: null,
    });

    expect(facts.stateAt('char-1', 10).location).toBe('青云城');
    expect(facts.listStateFacts('book-1', 'char-1').filter((f) => f.provenance === 'derived')).toHaveLength(0);
  });

  it('按章取值：补写第 3 章不会读到第 8 章才发生的状态', () => {
    const { db, facts } = createTestHarness();
    facts.createCharacter({ id: 'char-1', bookId: 'book-1', name: '林风', initialState: { location: '青云城' } });
    // 手动插入一条第 8 章生效的 derived 事实（绕过 author 覆盖需换字段）
    facts.insertStateFact({
      bookId: 'book-1',
      characterId: 'char-1',
      field: 'knownFacts',
      value: ['第八章才知道的秘密'],
      provenance: 'legacy',
      effectiveChapter: 8,
    });

    expect(facts.stateAt('char-1', 3).knownFacts).toEqual([]);
    expect(facts.stateAt('char-1', 9).knownFacts).toEqual(['第八章才知道的秘密']);
  });

  it('定稿收据以正文哈希定位；替换定稿后旧派生值标 stale 而非删除', () => {
    const { facts } = createTestHarness();
    facts.createCharacter({ id: 'char-1', bookId: 'book-1', name: '林风' });

    const first = facts.finalizeChapter({
      bookId: 'book-1',
      chapterId: 'ch-1',
      chapterOrdinal: 1,
      draftId: 'draft-1',
      content: '第一版正文',
    });
    facts.insertStateFact({
      bookId: 'book-1',
      characterId: 'char-1',
      field: 'knownFacts',
      value: ['来自第一版的事实'],
      provenance: 'derived',
      effectiveChapter: 1,
      sourceReceiptId: first.id,
    });

    const second = facts.finalizeChapter({
      bookId: 'book-1',
      chapterId: 'ch-1',
      chapterOrdinal: 1,
      draftId: 'draft-2',
      content: '第二版正文',
    });

    const authorFact = facts.listStateFacts('book-1', 'char-1').find((f) => f.provenance === 'author');
    const derivedFact = facts.listStateFacts('book-1', 'char-1').find((f) => f.provenance === 'derived');
    expect(authorFact).toBeDefined();
    expect(facts.getReceipt(first.id)?.supersededBy).toBe(second.id);
    expect(derivedFact?.stale).toBe(true);
    expect(facts.stateAt('char-1', 1).knownFacts).toEqual([]); // stale 派生不参与取值
  });

  it('物化投影可从字段级事实重建，且作者事实不丢失', () => {
    const { facts } = createTestHarness();
    facts.createCharacter({ id: 'char-1', bookId: 'book-1', name: '林风', initialState: { location: '青云城' } });
    facts.updateCharacterState('book-1', 'char-1', { location: '天魔宗' });
    facts.materializeProjection('book-1');
    expect(facts.getCharacterState('char-1')?.location).toBe('天魔宗');
    expect(facts.listStateFacts('book-1', 'char-1').some((f) => f.provenance === 'author')).toBe(true);
  });
});

describe('Strand Weave 节奏门禁', () => {
  function ctxWithStrands(strands: Array<GateContext['chapter']['strand']>): GateContext {
    const chapters = strands.map((strand, index) => makeChapter({ ordinal: index + 1, strand }));
    return {
      chapter: chapters[chapters.length - 1]!,
      previousChapters: chapters.slice(0, -1),
      foreshadows: [],
    };
  }

  it('Quest 连续超过 5 章触发告警', () => {
    const findings = createStrandRule().check(ctxWithStrands([
      'quest', 'quest', 'quest', 'quest', 'quest', 'quest',
    ])).findings;
    expect(findings.some((f) => f.message.includes('连续 6 章'))).toBe(true);
    expect(findings.every((f) => f.blocking === false)).toBe(true);
  });

  it('Fire 断档超过 10 章触发告警', () => {
    const findings = createStrandRule().check(ctxWithStrands([
      'fire', ...Array(11).fill('quest') as GateContext['chapter']['strand'][],
    ])).findings;
    expect(findings.some((f) => f.message.includes('fire 已断档'))).toBe(true);
  });

  it('占比偏离目标触发告警，但不阻断定稿', () => {
    const findings = createStrandRule().check(ctxWithStrands([
      'quest', 'quest', 'quest', 'quest', 'quest', 'quest', 'quest', 'quest', 'quest', 'quest',
    ])).findings;
    expect(findings.some((f) => f.message.includes('占比'))).toBe(true);
    const report = new GateEngine([createStrandRule()]).run(ctxWithStrands(Array(10).fill('quest')));
    expect(report.passed).toBe(true);
  });

  it('未标注 Strand 时给出 info 而非静默跳过', () => {
    const findings = createStrandRule().check(ctxWithStrands([null, null])).findings;
    expect(findings[0]?.severity).toBe('info');
  });
});

describe('本章任务装配', () => {
  it('到期章的伏笔变成 due 任务', () => {
    const result = assembleContext({
      spec: makeSpec({ ordinal: 5 }),
      characters: [], characterStates: [], worldRules: [],
      foreshadows: [makeForeshadow({ id: 'f1', plannedResolveOrdinal: 5, status: 'planted' })],
      timelineEvents: [],
    });
    expect(result.chapterTasks).toEqual([
      expect.objectContaining({ foreshadowId: 'f1', source: 'due', action: 'resolve' }),
    ]);
  });

  it('逾期主线伏笔变成 overdue 任务并保留证据词', () => {
    const result = assembleContext({
      spec: makeSpec({ ordinal: 9 }),
      characters: [], characterStates: [], worldRules: [],
      foreshadows: [makeForeshadow({ id: 'f1', plannedResolveOrdinal: 5, status: 'advancing' })],
      timelineEvents: [],
    });
    expect(result.chapterTasks).toEqual([
      expect.objectContaining({
        foreshadowId: 'f1',
        source: 'overdue',
        action: 'advance',
        markers: ['玉佩碎裂'],
      }),
    ]);
  });

  it('装配时按章取角色状态，不剧透后文', () => {
    const result = assembleContext({
      spec: makeSpec({ ordinal: 3, characterIds: ['c1'] }),
      characters: [{ id: 'c1', bookId: 'book-1', name: '林风', aliases: [], isAlive: true, notes: '', createdAt: '' }],
      characterStates: [],
      worldRules: [],
      foreshadows: [],
      timelineEvents: [],
      stateAt: () => ({ location: '第三章时的青云城' }),
    });
    expect(result.characters[0]?.location).toBe('第三章时的青云城');
  });
});
