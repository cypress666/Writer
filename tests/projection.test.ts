import { describe, expect, it } from 'vitest';
import { renderBookMarkdown, renderChapterMarkdown } from '../src/projection/markdown.js';
import { createTestHarness } from './helpers.js';

describe('Markdown 投影', () => {
  it('整书投影包含事实源与章节正文，且声明为只读投影', () => {
    const { books, facts, book } = createTestHarness();
    const chapter = books.createChapter({
      bookId: book.id,
      ordinal: 11,
      title: '雾中来客',
      outline: '渡口相遇',
      declaredCharacters: ['c-1'],
      content: '林风站在渡口。',
    });
    facts.createCharacter({
      id: 'c-1',
      bookId: book.id,
      name: '林风',
      initialState: { location: '青云城', knownFacts: ['钟声三响'] },
    });
    facts.createForeshadow({
      id: 'fs-1',
      bookId: book.id,
      title: '雾中的钟声',
      kind: 'main',
      plantedInChapterId: chapter.id,
      plannedResolveOrdinal: 20,
      resolutionMarkers: ['钟声三响'],
    });

    const md = renderBookMarkdown({ book, chapters: books.listChapters(book.id), state: facts.loadState(book.id) });
    expect(md).toContain('# 测试作品');
    expect(md).toContain('直接编辑不会回写数据库');
    expect(md).toContain('| 林风 | 是 | 青云城 |');
    expect(md).toContain('| 雾中的钟声 | main | planted |');
    expect(md).toContain('## 雾中来客');
    expect(md).toContain('林风站在渡口。');
  });

  it('单章投影带本章声明与事实源附录，不泄漏其他章节正文', () => {
    const { books, facts, book } = createTestHarness();
    const chapter = books.createChapter({
      bookId: book.id,
      ordinal: 11,
      title: '夜行',
      outline: '出城',
      declaredCharacters: ['c-1'],
      declaredLocations: ['青云城'],
      declaredForeshadows: [{ foreshadowId: 'fs-1', action: 'resolve' }],
      emotionTags: ['紧张'],
      content: '林风走出城门。',
    });
    books.updateChapterContent('ch-10', '【其他章正文不应出现】');
    facts.createCharacter({
      id: 'c-1',
      bookId: book.id,
      name: '林风',
      initialState: { location: '青云城' },
    });
    facts.createForeshadow({
      id: 'fs-1',
      bookId: book.id,
      title: '玉佩',
      kind: 'sub',
      plantedInChapterId: chapter.id,
    });

    const md = renderChapterMarkdown({ book, chapter, state: facts.loadState(book.id) });
    expect(md).toContain('### 本章声明');
    expect(md).toContain('出场角色：林风');
    expect(md).toContain('伏笔任务：玉佩（resolve）');
    expect(md).toContain('### 事实源附录');
    expect(md).not.toContain('其他章正文不应出现');
  });
});
