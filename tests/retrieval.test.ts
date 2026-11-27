import { describe, expect, it } from 'vitest';
import { HybridSearch, NoopEmbeddingProvider, toIndexText, toQueryExpression } from '../src/retrieval/index.js';
import { createTestHarness, makeChapter } from './helpers.js';

describe('中文检索索引', () => {
  it('汉字串展开为 bigram 并保留原文', () => {
    const indexed = toIndexText('灵气复苏');
    expect(indexed).toContain('灵气复苏');
    expect(indexed).toContain('灵气');
    expect(indexed).toContain('气复');
    expect(indexed).toContain('复苏');
  });

  it('查询生成 FTS5 MATCH 表达式', () => {
    expect(toQueryExpression('灵气')).toBe('"灵气"');
    expect(toQueryExpression('灵气复苏')).toContain('"气复"');
    expect(toQueryExpression('   ')).toBe('');
  });

  it('无 embedding 配置时检索退化为纯 BM25，行为可预期', async () => {
    await expect(new NoopEmbeddingProvider().embed('test')).resolves.toEqual([]);
  });
});

describe('分卷全文检索', () => {
  it('中文子串可召回正文，并按相关度排序', () => {
    const { db, books } = createTestHarness();
    const search = new HybridSearch(db);
    const first = books.createChapter({
      ...makeChapter({ id: 'ch-a', ordinal: 11, content: '少年在青云城中感受到了灵气复苏的迹象。' }),
    });
    const second = books.createChapter({
      ...makeChapter({ id: 'ch-b', ordinal: 12, content: '远方天魔宗的旗帜在风中猎猎作响。' }),
    });
    search.reindexBook([first, second]);

    const hits = search.search('book-1', '灵气复苏');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chapterId).toBe('ch-a');
    expect(hits[0]?.snippet).toContain('灵气复苏');
  });

  it('卷过滤只返回指定卷的章节', () => {
    const { db, books } = createTestHarness();
    const search = new HybridSearch(db);
    const volume = books.createVolume({ id: 'vol-1', bookId: 'book-1', title: '第一卷', ordinal: 1 });
    search.indexChapter(
      makeChapter({ id: 'ch-1', ordinal: 1, volumeId: volume.id, content: '灵气复苏的都市传说' }),
    );
    search.indexChapter(
      makeChapter({ id: 'ch-2', ordinal: 2, volumeId: null, content: '灵气复苏的另一段记载' }),
    );

    const hits = search.search('book-1', '灵气', { volumeId: 'vol-1' });
    expect(hits.map((hit) => hit.chapterId)).toEqual(['ch-1']);
  });

  it('空查询不触发全表扫描', () => {
    const { db, books } = createTestHarness();
    expect(new HybridSearch(db).search('book-1', '')).toEqual([]);
  });
});
