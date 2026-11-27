/**
 * BM25 全文检索。中文采用 bigram 展开写入索引，避免 unicode61 把整段汉字
 * 当成一个 token 导致子串检索失效。按 book_id / volume_id 过滤实现分卷索引，
 * 检索时只扫描目标卷，避免百万字全量召回。
 *
 * Embedding 部分：预留 Provider 接口，本轮不引入模型依赖（见 EmbeddingProvider）。
 */

import type { SqliteDatabase } from '../db/sqlite.js';
import type { Chapter } from '../domain/models.js';

const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

function isHan(char: string): boolean {
  return HAN_RE.test(char);
}

/** 写入索引时将汉字串展开为 bigram，同时保留原文与英文词 */
export function toIndexText(text: string): string {
  const han = [...text].filter(isHan);
  const grams: string[] = [];
  for (let index = 0; index + 1 < han.length; index += 1) {
    grams.push(`${han[index]}${han[index + 1]}`);
  }
  const latin = text.match(/[A-Za-z0-9]+/g) ?? [];
  return [text, ...grams, ...latin].join(' ');
}

/** 查询同样 bigram 化，生成 FTS5 MATCH 表达式 */
export function toQueryExpression(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) return '';
  const han = [...trimmed].filter(isHan);
  const terms: string[] = [];
  if (han.length === 1) {
    terms.push(han[0]!);
  } else {
    for (let index = 0; index + 1 < han.length; index += 1) {
      terms.push(`${han[index]}${han[index + 1]}`);
    }
  }
  terms.push(...(trimmed.match(/[A-Za-z0-9]+/g) ?? []));
  if (terms.length === 0) terms.push(trimmed);
  return [...new Set(terms)]
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' OR ');
}

export interface SearchHit {
  chapterId: string;
  ordinal: number;
  title: string;
  snippet: string;
  /** 混合检索的综合得分，越大越相关 */
  score: number;
  bm25Score?: number;
  vectorScore?: number;
}

export interface SearchOptions {
  volumeId?: string;
  limit?: number;
  /** 摘要半径（字符数），默认 40 */
  contextChars?: number;
  /** 提供时启用 BM25 + 余弦相似度的混合排序 */
  queryVector?: number[];
  /** 向量得分权重，默认 0.6；BM25 权重为 1 - 该值 */
  embeddingWeight?: number;
}

export interface EmbeddingStatus {
  totalChapters: number;
  embeddedChapters: number;
  model: string | null;
}

export interface EmbeddingProvider {
  readonly name: string;
  embed(text: string): Promise<number[]>;
}

/** 未配置模型时的空实现：检索退化为纯 BM25，行为可预期 */
export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'none';
  async embed(_text: string = ''): Promise<number[]> {
    return [];
  }
}

export class HybridSearch {
  constructor(private readonly db: SqliteDatabase) {}

  indexChapter(chapter: Chapter): void {
    this.db.prepare('DELETE FROM chapter_fts WHERE chapter_id = ?').run(chapter.id);
    // 正文变化后旧向量失效，等下一次重建向量索引
    this.db.prepare('DELETE FROM chapter_embeddings WHERE chapter_id = ?').run(chapter.id);
    this.db
      .prepare(
        `INSERT INTO chapter_fts (chapter_id, book_id, volume_id, title, body)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        chapter.id,
        chapter.bookId,
        chapter.volumeId ?? '',
        toIndexText(chapter.title),
        toIndexText(chapter.content ?? ''),
      );
  }

  reindexBook(chapters: Chapter[]): void {
    if (chapters.length === 0) return;
    const bookId = chapters[0]!.bookId;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM chapter_fts WHERE book_id = ?').run(bookId);
      for (const chapter of chapters) this.indexChapter(chapter);
    })();
  }

  search(bookId: string, query: string, options: SearchOptions = {}): SearchHit[] {
    const expression = toQueryExpression(query);
    if (expression === '') return [];
    const limit = options.limit ?? 20;
    const volumeClause = options.volumeId ? 'AND volume_id = ?' : '';
    const params: unknown[] = options.volumeId
      ? [expression, bookId, options.volumeId, limit]
      : [expression, bookId, limit];

    const rows = this.db
      .prepare(
        `SELECT chapter_id, title, bm25(chapter_fts, 0, 0, 0, 5.0, 1.0) AS score
         FROM chapter_fts
         WHERE chapter_fts MATCH ? AND book_id = ? ${volumeClause}
         ORDER BY score
         LIMIT ?`,
      )
      .all(...params) as Array<{ chapter_id: string; title: string; score: number }>;

    return rows.map((row) => {
      const chapter = this.db
        .prepare('SELECT content, ordinal FROM chapters WHERE id = ?')
        .get(row.chapter_id) as { content: string | null; ordinal: number } | undefined;
      return {
        chapterId: row.chapter_id,
        ordinal: chapter?.ordinal ?? 0,
        title: row.title,
        snippet: makeSnippet(chapter?.content ?? '', query, options.contextChars ?? 40),
        score: row.score,
        bm25Score: row.score,
      };
    });
  }

  upsertEmbedding(input: {
    chapterId: string;
    bookId: string;
    model: string;
    vector: number[];
  }): void {
    if (input.vector.length === 0) return;
    this.db
      .prepare(
        `INSERT INTO chapter_embeddings (chapter_id, book_id, model, dimensions, vector_json, updated_at)
         VALUES (@chapterId, @bookId, @model, @dimensions, @vectorJson, @updatedAt)
         ON CONFLICT(chapter_id) DO UPDATE SET
           model = excluded.model,
           dimensions = excluded.dimensions,
           vector_json = excluded.vector_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        chapterId: input.chapterId,
        bookId: input.bookId,
        model: input.model,
        dimensions: input.vector.length,
        vectorJson: JSON.stringify(input.vector),
        updatedAt: new Date().toISOString(),
      });
  }

  clearEmbeddings(bookId: string): void {
    this.db.prepare('DELETE FROM chapter_embeddings WHERE book_id = ?').run(bookId);
  }

  embeddingStatus(bookId: string): EmbeddingStatus {
    const total = this.db
      .prepare('SELECT COUNT(*) AS count FROM chapters WHERE book_id = ?')
      .get(bookId) as { count: number };
    const embedded = this.db
      .prepare('SELECT COUNT(*) AS count FROM chapter_embeddings WHERE book_id = ?')
      .get(bookId) as { count: number };
    const modelRow = this.db
      .prepare('SELECT model FROM chapter_embeddings WHERE book_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(bookId) as { model: string } | undefined;
    return {
      totalChapters: Number(total.count),
      embeddedChapters: Number(embedded.count),
      model: modelRow?.model ?? null,
    };
  }

  /**
   * 混合检索：BM25 负责关键词命中，向量负责语义召回。
   * 未提供 queryVector 时行为与 search() 完全一致，保证 Embedding 未配置时可用。
   */
  searchHybrid(bookId: string, query: string, options: SearchOptions = {}): SearchHit[] {
    const limit = options.limit ?? 20;
    const bm25Hits = this.search(bookId, query, { ...options, limit: Math.max(limit * 2, 20) });
    const queryVector = options.queryVector;
    if (!queryVector?.length) return bm25Hits.slice(0, limit);

    const rows = this.db
      .prepare(
        `SELECT e.chapter_id, e.vector_json, c.title, c.ordinal, c.content
         FROM chapter_embeddings e JOIN chapters c ON c.id = e.chapter_id
         WHERE e.book_id = ? ${options.volumeId ? 'AND c.volume_id = ?' : ''}`,
      )
      .all(...(options.volumeId ? [bookId, options.volumeId] : [bookId])) as Array<{
      chapter_id: string;
      vector_json: string;
      title: string;
      ordinal: number;
      content: string | null;
    }>;

    const maxBm25 = Math.max(1, ...bm25Hits.map((hit) => Math.abs(hit.score)));
    const weight = options.embeddingWeight ?? 0.6;
    const merged = new Map<string, SearchHit>();

    for (const hit of bm25Hits) {
      merged.set(hit.chapterId, {
        ...hit,
        score: (1 - weight) * (Math.abs(hit.score) / maxBm25),
      });
    }

    for (const row of rows) {
      let vector: number[];
      try {
        vector = JSON.parse(row.vector_json) as number[];
      } catch {
        continue;
      }
      const cosine = cosineSimilarity(queryVector, vector);
      if (cosine <= 0) continue;
      const existing = merged.get(row.chapter_id);
      if (existing) {
        existing.vectorScore = cosine;
        existing.score += weight * cosine;
      } else {
        merged.set(row.chapter_id, {
          chapterId: row.chapter_id,
          ordinal: row.ordinal,
          title: row.title,
          snippet: makeSnippet(row.content ?? '', query, options.contextChars ?? 40),
          score: weight * cosine,
          vectorScore: cosine,
        });
      }
    }

    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function makeSnippet(content: string, query: string, radius: number): string {
  if (content.length === 0) return '';
  const index = content.indexOf(query.trim());
  if (index === -1) return content.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + query.trim().length + radius);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}
