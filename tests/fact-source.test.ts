import { describe, expect, it } from 'vitest';
import {
  chineseText,
  createTestHarness,
  makeAbility,
  makeCharacter,
  makeForeshadow,
  makeWorldRule,
} from './helpers.js';

describe('单一事实源 · 仓储层', () => {
  it('作品/卷/章节的层级关系可正确落库与读取', () => {
    const { books } = createTestHarness();
    const volume = books.createVolume({ id: 'vol-1', bookId: 'book-1', title: '第一卷', ordinal: 1 });
    const chapter = books.createChapter({
      id: 'ch-custom',
      bookId: 'book-1',
      volumeId: volume.id,
      ordinal: 11,
      title: '开端',
      targetWords: 3000,
    });

    expect(books.getBook('book-1')?.title).toBe('测试作品');
    expect(books.listVolumes('book-1')).toHaveLength(1);
    expect(books.getChapter(chapter.id)?.volumeId).toBe('vol-1');
    expect(books.getChapterByOrdinal('book-1', 11)?.targetWords).toBe(3000);
  });

  it('角色初始状态与事实源一一对应', () => {
    const { facts } = createTestHarness();
    const character = facts.createCharacter({
      ...makeCharacter(),
      initialState: { location: '青云城', knownFacts: ['玉佩藏有秘密'] },
    });

    expect(facts.getCharacter(character.id)?.isAlive).toBe(true);
    expect(facts.getCharacterState(character.id)?.location).toBe('青云城');
    expect(facts.getCharacterState(character.id)?.knownFacts).toEqual(['玉佩藏有秘密']);
  });

  it('状态更新是合并式的，且每个变化字段留下事件轨迹', () => {
    const { facts } = createTestHarness();
    facts.createCharacter({
      ...makeCharacter(),
      initialState: { location: '青云城', knownFacts: ['旧情报'] },
    });

    facts.updateCharacterState(
      'book-1',
      'char-1',
      { abilities: [makeAbility()], knownFacts: ['新情报'] },
      'ch-3',
    );

    const state = facts.getCharacterState('char-1')!;
    expect(state.location).toBe('青云城'); // 未提交的字段保持不变
    expect(state.abilities).toHaveLength(1);
    expect(state.knownFacts).toEqual(['新情报']);
    expect(state.updatedInChapterId).toBe('ch-3');

    const events = facts.listStateEvents('book-1');
    expect(events.map((event) => event.eventType).sort()).toEqual(['ability', 'known_fact']);
    expect(events.every((event) => event.chapterId === 'ch-3')).toBe(true);
  });

  it('角色生死变更写入事件，供已故角色审计追溯', () => {
    const { facts } = createTestHarness();
    facts.createCharacter(makeCharacter());
    facts.setCharacterAlive('book-1', 'char-1', false, 'ch-9');

    expect(facts.getCharacter('char-1')?.isAlive).toBe(false);
    expect(facts.listStateEvents('book-1', 'char-1')[0]?.payload).toEqual({
      from: true,
      to: false,
    });
  });

  it('伏笔从埋设、推进到回收的状态流转', () => {
    const { facts } = createTestHarness();
    facts.createForeshadow(makeForeshadow());

    facts.markForeshadowAdvancing('fs-1', 'ch-3');
    expect(facts.getForeshadow('fs-1')?.status).toBe('advancing');

    facts.resolveForeshadow('fs-1', 'ch-5');
    const resolved = facts.getForeshadow('fs-1')!;
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedInChapterId).toBe('ch-5');
  });

  it('逾期未回收只列出计划章已过的主线伏笔', () => {
    const { facts } = createTestHarness();
    facts.createForeshadow(makeForeshadow({ id: 'fs-main', plannedResolveOrdinal: 5 }));
    facts.createForeshadow(
      makeForeshadow({ id: 'fs-later', title: '后续伏笔', plannedResolveOrdinal: 20 }),
    );

    const overdue = facts.listOverdueForeshadows('book-1', 8);
    expect(overdue.map((item) => item.id)).toEqual(['fs-main']);
  });

  it('快照回退恢复结构化状态并给出字段级差异，且不触碰正文', () => {
    const { books, facts, snapshots } = createTestHarness();
    facts.createCharacter({
      ...makeCharacter(),
      initialState: { location: '青云城' },
    });
    const snapshot = snapshots.create('book-1', '第一卷定稿', 'ch-1');

    facts.updateCharacterState('book-1', 'char-1', { location: '天魔宗' }, 'ch-2');
    books.updateChapterContent('ch-1', chineseText(200), 'final');
    expect(facts.getCharacterState('char-1')?.location).toBe('天魔宗');

    const changes = snapshots.restore(snapshot.id);

    expect(facts.getCharacterState('char-1')?.location).toBe('青云城');
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: 'characterState', field: 'location', after: '青云城' }),
      ]),
    );
    expect(books.getChapter('ch-1')?.content).toHaveLength(200); // 正文未被回退
  });

  it('世界规则按题材分类过滤，铁律可通过高优先级标记', () => {
    const { facts } = createTestHarness();
    facts.createWorldRule(makeWorldRule({ id: 'r1', category: 'combat', priority: 0 }));
    facts.createWorldRule(makeWorldRule({ id: 'r2', category: 'language', priority: 100 }));

    expect(facts.listWorldRules('book-1', ['combat']).map((rule) => rule.id)).toEqual(['r1']);
    expect(facts.listWorldRules('book-1').map((rule) => rule.id)).toEqual(['r2', 'r1']);
  });
});
