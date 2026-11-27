import { describe, expect, it } from 'vitest';
import { GENRE_TEMPLATES } from '../src/domain/genres.js';
import { createTestHarness } from './helpers.js';

describe('书籍 / 卷 / 章节 CRUD', () => {
  it('作品改名、删除会级联清理章节与检索索引', () => {
    const { db, books } = createTestHarness();
    books.renameBook('book-1', '新书名');
    expect(books.getBook('book-1')?.title).toBe('新书名');

    books.deleteBook('book-1');
    expect(books.getBook('book-1')).toBeNull();
    const chapters = db.prepare('SELECT COUNT(*) AS count FROM chapters').get() as { count: number };
    const fts = db.prepare('SELECT COUNT(*) AS count FROM chapter_fts').get() as { count: number };
    expect(Number(chapters.count)).toBe(0);
    expect(Number(fts.count)).toBe(0);
  });

  it('卷可创建/改名/删除，删除卷不删章节只置空归属', () => {
    const { books } = createTestHarness();
    const volume = books.createVolume({ bookId: 'book-1', title: '第一卷', ordinal: 1 });
    const chapter = books.getChapter('ch-1')!;
    books.updateChapterSpec('ch-1', {
      volumeId: volume.id,
      outline: '开篇',
      declaredCharacters: chapter.declaredCharacters,
      declaredLocations: chapter.declaredLocations,
      declaredForeshadows: chapter.declaredForeshadows,
      emotionTags: chapter.emotionTags,
      hookType: chapter.hookType,
      strand: chapter.strand,
      targetWords: chapter.targetWords,
    });
    expect(books.getChapter('ch-1')?.volumeId).toBe(volume.id);
    expect(books.getChapter('ch-1')?.outline).toBe('开篇');

    const renamed = books.updateVolume(volume.id, { title: '第一卷·雾起' });
    expect(renamed.title).toBe('第一卷·雾起');

    books.deleteVolume(volume.id);
    expect(books.getChapter('ch-1')?.volumeId).toBeNull();
    expect(books.getChapter('ch-1')).not.toBeNull();
  });

  it('删除章节会清理全文索引，其余章节保留', () => {
    const { db, books } = createTestHarness();
    books.deleteChapter('ch-3');
    expect(books.getChapter('ch-3')).toBeNull();
    const fts = db.prepare('SELECT COUNT(*) AS count FROM chapter_fts WHERE chapter_id = ?').get('ch-3') as {
      count: number;
    };
    expect(Number(fts.count)).toBe(0);
    expect(books.getChapter('ch-2')).not.toBeNull();
  });

  it('重排章节：序号连续且不撞唯一约束', () => {
    const { books } = createTestHarness();
    const before = books.listChapters('book-1');
    const ids = before.map((chapter) => chapter.id);
    // 把最后一章拖到最前
    const reordered = [ids[ids.length - 1]!, ...ids.slice(0, -1)];

    const after = books.reorderChapters('book-1', reordered);
    expect(after.map((chapter) => chapter.id)).toEqual(reordered);
    // 起点沿用原最小值，序号连续
    const ordinals = after.map((chapter) => chapter.ordinal);
    const base = Math.min(...before.map((chapter) => chapter.ordinal));
    expect(ordinals).toEqual(reordered.map((_, index) => base + index));
  });

  it('重排顺序非法时报错，且不改动任何序号', () => {
    const { books } = createTestHarness();
    const before = books.listChapters('book-1');
    expect(() => books.reorderChapters('book-1', ['ch-1'])).toThrow(/全部/);
    const withForeign = before.map((chapter) => chapter.id);
    withForeign[0] = 'not-exist';
    expect(() => books.reorderChapters('book-1', withForeign)).toThrow(/不属于本书/);
    const dup = before.map((chapter) => chapter.id);
    dup[1] = dup[0]!;
    expect(() => books.reorderChapters('book-1', dup)).toThrow(/重复/);
    expect(books.listChapters('book-1').map((c) => c.id)).toEqual(before.map((c) => c.id));
  });
});

describe('事实源 CRUD', () => {
  it('作者状态编辑按章节生效，补写中间章不会剧透后文', () => {
    const { facts } = createTestHarness();
    facts.createCharacter({
      id: 'c-1',
      bookId: 'book-1',
      name: '林风',
      initialState: { location: '青云城' },
    });
    facts.updateCharacterState('book-1', 'c-1', { location: '天魔宗' }, 'ch-3');

    expect(facts.stateAt('c-1', 2)?.location).toBe('青云城');
    expect(facts.stateAt('c-1', 3)?.location).toBe('天魔宗');
    expect(facts.getCharacterState('c-1')?.location).toBe('天魔宗');
  });

  it('角色元数据、存活状态、伏笔状态均可更新，删除角色级联清理状态', () => {
    const { facts } = createTestHarness();
    facts.createCharacter({
      id: 'c-1',
      bookId: 'book-1',
      name: '林风',
      initialState: { location: '青云城' },
    });
    const updated = facts.updateCharacter('c-1', { name: '林惊风', aliases: ['风子'], notes: '主角' });
    expect(updated.name).toBe('林惊风');
    expect(updated.aliases).toEqual(['风子']);

    facts.setCharacterAlive('book-1', 'c-1', false, 'ch-3');
    expect(facts.getCharacter('c-1')?.isAlive).toBe(false);

    facts.createForeshadow({
      id: 'fs-1',
      bookId: 'book-1',
      title: '钟声',
      kind: 'main',
      plantedInChapterId: 'ch-1',
      plannedResolveOrdinal: 5,
    });
    expect(facts.resolveForeshadow('fs-1', 'ch-5').status).toBe('resolved');
    expect(facts.updateForeshadow('fs-1', { status: 'advancing', plannedResolveOrdinal: 8 }).plannedResolveOrdinal).toBe(8);
    facts.deleteForeshadow('fs-1');
    expect(facts.getForeshadow('fs-1')).toBeNull();

    facts.deleteCharacter('c-1');
    expect(facts.getCharacter('c-1')).toBeNull();
    expect(facts.getCharacterState('c-1')).toBeNull();
  });

  it('世界规则、时间线、资源支持增改删', () => {
    const { facts } = createTestHarness();
    const rule = facts.createWorldRule({
      bookId: 'book-1',
      category: '力量体系',
      rule: '境界不可越阶',
      priority: 100,
    });
    expect(facts.updateWorldRule(rule.id, { rule: '越阶需付出代价', priority: 90 }).rule).toBe('越阶需付出代价');
    facts.deleteWorldRule(rule.id);
    expect(facts.listWorldRules('book-1')).toHaveLength(0);

    const event = facts.createTimelineEvent({
      bookId: 'book-1',
      chapterId: 'ch-1',
      storyTime: '第一年',
      storyOrder: 1,
      description: '抵达青云城',
    });
    expect(facts.updateTimelineEvent(event.id, { description: '抵达雾港' }).description).toBe('抵达雾港');
    facts.deleteTimelineEvent(event.id);
    expect(facts.listTimelineEvents('book-1')).toHaveLength(0);

    const resource = facts.createResource({
      bookId: 'book-1',
      name: '灵石',
      quantity: 10,
    });
    expect(facts.updateResource(resource.id, { quantity: 20 }).quantity).toBe(20);
    facts.deleteResource(resource.id);
    expect(facts.listResources('book-1')).toHaveLength(0);
  });
});

describe('题材规则集', () => {
  it('每个题材都有可落地的世界规则', () => {
    expect(GENRE_TEMPLATES.length).toBeGreaterThanOrEqual(5);
    for (const genre of GENRE_TEMPLATES) {
      expect(genre.rules.length).toBeGreaterThan(0);
      expect(genre.rules.some((rule) => rule.priority >= 100)).toBe(true);
    }
  });
});
