/**
 * 端到端工作流验证：模拟 GUI 通过 IPC 调用核心层的完整路径。
 * 覆盖：新建作品 → 建角色/伏笔/世界规则 → 建章 → 写正文 → 门禁/审计 → 快照回退。
 */

import { describe, expect, it } from 'vitest';
import {
  AuditEngine,
  BookRepository,
  FactSourceRepository,
  GateEngine,
  SnapshotRepository,
  assembleContext,
  openDatabase,
} from '../src/index.js';

describe('端到端创作工作流', () => {
  function setup() {
    const db = openDatabase(':memory:');
    const facts = new FactSourceRepository(db);
    return {
      db,
      books: new BookRepository(db),
      facts,
      snapshots: new SnapshotRepository(db, facts),
    };
  }

  it('完整走通一章的创作闭环', () => {
    const { books, facts, snapshots } = setup();
    const book = books.createBook({ title: '雾港灯塔' });

    // 1. 建立事实源。先有埋设章，伏笔才能合法回收
    const planting = books.createChapter({
      bookId: book.id,
      ordinal: 1,
      title: '入雾',
      content: '林岚第一次听见雾中的钟声。',
      status: 'final',
    });
    const character = facts.createCharacter({
      bookId: book.id,
      name: '林岚',
      initialState: { location: '灯塔' },
    });
    const foreshadow = facts.createForeshadow({
      bookId: book.id,
      title: '雾中的钟声',
      kind: 'main',
      plantedInChapterId: planting.id,
      plannedResolveOrdinal: 3,
      resolutionMarkers: ['钟声停了'],
    });
    facts.createWorldRule({ bookId: book.id, category: 'combat', rule: '守塔人不可离开灯塔', priority: 100 });
    facts.createWorldRule({ bookId: book.id, category: 'language', rule: '禁用网络流行语', priority: 100 });

    // 2. 建章并声明章纲
    const chapter = books.createChapter({
      bookId: book.id,
      ordinal: 2,
      title: '雾钟',
      targetWords: 100,
      strand: 'quest',
      declaredCharacters: [character.id],
      declaredLocations: ['灯塔'],
      declaredForeshadows: [{ foreshadowId: foreshadow.id, action: 'resolve' }],
      emotionTags: ['悬念'],
      hookType: 'cliffhanger',
    });

    // 3. 按需装配：铁律无条件注入，本章任务生成
    const assembled = assembleContext({
      spec: {
        ordinal: 2,
        title: chapter.title,
        outline: chapter.outline,
        characterIds: chapter.declaredCharacters,
        locations: chapter.declaredLocations,
        foreshadows: chapter.declaredForeshadows,
        emotionTags: chapter.emotionTags,
        strand: chapter.strand,
      },
      characters: facts.listCharacters(book.id),
      characterStates: facts.listCharacters(book.id).map((c) => facts.getCharacterState(c.id)!),
      worldRules: facts.listWorldRules(book.id),
      foreshadows: facts.listForeshadows(book.id),
      timelineEvents: facts.listTimelineEvents(book.id),
      stateAt: (id, ordinal) => facts.stateAt(id, ordinal),
    });
    expect(assembled.worldRules).toHaveLength(2); // 两条铁律都注入
    expect(assembled.chapterTasks.some((t) => t.foreshadowId === foreshadow.id)).toBe(true);
    expect(assembled.characters[0]?.location).toBe('灯塔');

    // 4. 写正文（含伏笔回收证据词）
    const content = '林岚站在灯塔顶端，浓雾里传来悠长的钟声。她握紧栏杆，直到钟声停了，雾才渐渐散去。'.repeat(8);
    books.updateChapterContent(chapter.id, content, 'reviewed');

    // 5. 门禁 + 审计
    const saved = books.getChapter(chapter.id)!;
    const gate = new GateEngine().run({
      chapter: saved,
      previousChapters: [],
      foreshadows: facts.listForeshadows(book.id),
    });
    const audit = new AuditEngine().audit({
      chapter: saved,
      facts: facts.loadState(book.id),
      previousChapters: [],
    });

    // 伏笔证据词已出现 → 门禁无阻断
    expect(gate.passed).toBe(true);
    // 角色位置一致、无已死角色 → 审计无错误
    expect(audit.issues.filter((i) => i.severity === 'error')).toHaveLength(0);

    // 6. 定稿并创建快照
    books.updateChapterContent(chapter.id, content, 'final');
    const snapshot = snapshots.create(book.id, '第一章定稿', chapter.id);
    expect(snapshot.state.characters).toHaveLength(1);
    expect(snapshots.listViews(book.id)[0]?.label).toBe('第一章定稿');

    // 7. 改状态后回退，作者事实与正文都不受影响
    facts.updateCharacterState(book.id, character.id, { location: '天魔宗' });
    books.updateChapterContent(chapter.id, content + '\n（后加的一段）', 'final');
    snapshots.restore(snapshot.id);
    facts.materializeProjection(book.id);

    expect(facts.getCharacterState(character.id)?.location).toBe('灯塔');
    expect(books.getChapter(chapter.id)?.content).toContain('后加的一段'); // 正文未被回退
  });
});
