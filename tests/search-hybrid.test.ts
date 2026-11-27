import { describe, expect, it } from 'vitest';
import { HybridSearch } from '../src/retrieval/search.js';
import { createTestHarness } from './helpers.js';

describe('混合检索', () => {
  it('BM25 能命中中文子串，并在保存后失效旧向量', () => {
    const { db, books } = createTestHarness();
    const chapter = books.getChapter('ch-1')!;
    books.updateChapterContent('ch-1', '林风在雾港听见钟声，钟声三响。');
    const search = new HybridSearch(db);
    search.reindexBook(books.listChapters('book-1'));

    const hits = search.search('book-1', '钟声');
    expect(hits[0]?.chapterId).toBe('ch-1');
    expect(hits[0]?.snippet).toContain('钟声');

    search.upsertEmbedding({ chapterId: 'ch-1', bookId: 'book-1', model: 'test', vector: [1, 0] });
    expect(search.embeddingStatus('book-1').embeddedChapters).toBe(1);
    search.indexChapter(chapter);
    expect(search.embeddingStatus('book-1').embeddedChapters).toBe(0);
  });

  it('提供 queryVector 时能把语义相近但无关键词命中的章节召回', () => {
    const { db, books } = createTestHarness();
    books.updateChapterContent('ch-1', '林风在雾港听见钟声。');
    books.updateChapterContent('ch-2', '海面升起白雾，灯塔忽明忽暗。');
    const search = new HybridSearch(db);
    search.reindexBook(books.listChapters('book-1'));
    search.upsertEmbedding({ chapterId: 'ch-2', bookId: 'book-1', model: 'test', vector: [1, 0] });

    const hits = search.searchHybrid('book-1', '完全无关的词', { queryVector: [1, 0] });
    expect(hits.some((hit) => hit.chapterId === 'ch-2')).toBe(true);
    expect(hits.find((hit) => hit.chapterId === 'ch-2')?.vectorScore).toBeCloseTo(1, 5);
  });

  it('可按卷过滤检索结果', () => {
    const { db, books } = createTestHarness();
    const volume = books.createVolume({ bookId: 'book-1', title: '第一卷', ordinal: 1 });
    const chapter = books.getChapter('ch-1')!;
    books.updateChapterSpec('ch-1', {
      volumeId: volume.id,
      outline: chapter.outline,
      declaredCharacters: chapter.declaredCharacters,
      declaredLocations: chapter.declaredLocations,
      declaredForeshadows: chapter.declaredForeshadows,
      emotionTags: chapter.emotionTags,
      hookType: chapter.hookType,
      strand: chapter.strand,
      targetWords: chapter.targetWords,
    });
    books.updateChapterContent('ch-1', '第一卷里的钟声。');
    books.updateChapterContent('ch-2', '第二卷里的钟声。');
    const search = new HybridSearch(db);
    search.reindexBook(books.listChapters('book-1'));

    const hits = search.search('book-1', '钟声', { volumeId: volume.id });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.chapterId).toBe('ch-1');
  });
});
