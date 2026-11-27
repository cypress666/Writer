/** 作品 / 卷 / 章节的持久化。章节的章纲声明是按需装配与门禁的输入。 */

import type { SqliteDatabase } from './sqlite.js';
import type {
  Book,
  BookSummary,
  Chapter,
  ChapterStatus,
  ForeshadowUse,
  HookType,
  Strand,
  Volume,
} from '../domain/models.js';
import { newId } from './id.js';
import {
  mapBook,
  mapChapter,
  mapVolume,
  now,
  num,
  nullableStr,
  toJson,
  type Row,
} from './mappers.js';

export interface CreateBookInput {
  id?: string;
  title: string;
  outline?: string;
  genreId?: string | null;
}

export interface CreateVolumeInput {
  id?: string;
  bookId: string;
  title: string;
  outline?: string;
  ordinal: number;
}

export interface CreateChapterInput {
  id?: string;
  bookId: string;
  volumeId?: string | null;
  ordinal: number;
  title: string;
  outline?: string;
  content?: string | null;
  status?: ChapterStatus;
  declaredCharacters?: string[];
  declaredLocations?: string[];
  declaredForeshadows?: ForeshadowUse[];
  emotionTags?: string[];
  hookType?: HookType | null;
  strand?: Strand | null;
  targetWords?: number | null;
}

export class BookRepository {
  constructor(private readonly db: SqliteDatabase) {}

  createBook(input: CreateBookInput): Book {
    const timestamp = now();
    const book: Book = {
      id: input.id ?? newId(),
      title: input.title,
      outline: input.outline ?? '',
      genreId: input.genreId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO books (id, title, outline, genre_id, created_at, updated_at)
         VALUES (@id, @title, @outline, @genreId, @createdAt, @updatedAt)`,
      )
      .run(book);
    return book;
  }

  getBook(id: string): Book | null {
    const row = this.db.prepare('SELECT * FROM books WHERE id = ?').get(id) as Row | undefined;
    return row ? mapBook(row) : null;
  }

  listAllBooks(): Book[] {
    const rows = this.db.prepare('SELECT * FROM books ORDER BY updated_at DESC').all() as Row[];
    return rows.map(mapBook);
  }

  /** 书架用：一次聚合出章节数、卷数与去空白字数，避免前端逐本查询 */
  listBookSummaries(): BookSummary[] {
    const rows = this.db
      .prepare(
        `SELECT b.*,
                (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS chapter_count,
                (SELECT COUNT(*) FROM volumes v WHERE v.book_id = b.id) AS volume_count,
                (SELECT COALESCE(SUM(LENGTH(REPLACE(REPLACE(COALESCE(c.content, ''), ' ', ''), CHAR(10), ''))), 0)
                   FROM chapters c WHERE c.book_id = b.id) AS word_count
           FROM books b
          ORDER BY b.updated_at DESC`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      ...mapBook(row),
      chapterCount: num(row.chapter_count),
      volumeCount: num(row.volume_count),
      wordCount: num(row.word_count),
    }));
  }

  renameBook(id: string, title: string): Book {
    if (!title.trim()) throw new Error('作品名称不能为空');
    this.db.prepare('UPDATE books SET title = ?, updated_at = ? WHERE id = ?').run(title.trim(), now(), id);
    const book = this.getBook(id);
    if (!book) throw new Error(`Book not found: ${id}`);
    return book;
  }

  updateBookOutline(id: string, outline: string): Book {
    this.db.prepare('UPDATE books SET outline = ?, updated_at = ? WHERE id = ?').run(outline, now(), id);
    const book = this.getBook(id);
    if (!book) throw new Error(`Book not found: ${id}`);
    return book;
  }

  /** 设置题材：只影响门禁/审计侧重与规则模板，不改动已有正文与事实 */
  setGenre(id: string, genreId: string | null): Book {
    this.db
      .prepare('UPDATE books SET genre_id = ?, updated_at = ? WHERE id = ?')
      .run(genreId, now(), id);
    const book = this.getBook(id);
    if (!book) throw new Error(`Book not found: ${id}`);
    return book;
  }

  /** 删除作品：先清 FTS（虚拟表无外键级联），其余表由 SQLite ON DELETE CASCADE 处理 */
  deleteBook(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM chapter_fts WHERE book_id = ?').run(id);
      this.db.prepare('DELETE FROM snapshots WHERE book_id = ?').run(id);
      this.db.prepare('DELETE FROM books WHERE id = ?').run(id);
    })();
  }

  touchBook(id: string): void {
    this.db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').run(now(), id);
  }

  createVolume(input: CreateVolumeInput): Volume {
    const volume: Volume = {
      id: input.id ?? newId(),
      bookId: input.bookId,
      title: input.title,
      outline: input.outline ?? '',
      ordinal: input.ordinal,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO volumes (id, book_id, title, outline, ordinal, created_at)
         VALUES (@id, @bookId, @title, @outline, @ordinal, @createdAt)`,
      )
      .run({
        id: volume.id,
        bookId: volume.bookId,
        title: volume.title,
        outline: volume.outline,
        ordinal: volume.ordinal,
        createdAt: volume.createdAt,
      });
    return volume;
  }

  listVolumes(bookId: string): Volume[] {
    const rows = this.db
      .prepare('SELECT * FROM volumes WHERE book_id = ? ORDER BY ordinal, created_at')
      .all(bookId) as Row[];
    return rows.map(mapVolume);
  }

  updateVolume(id: string, patch: { title?: string; outline?: string; ordinal?: number }): Volume {
    const row = this.db.prepare('SELECT * FROM volumes WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error(`Volume not found: ${id}`);
    this.db
      .prepare('UPDATE volumes SET title = ?, outline = ?, ordinal = ? WHERE id = ?')
      .run(
        patch.title?.trim() || String(row.title),
        patch.outline ?? String(row.outline ?? ''),
        patch.ordinal ?? Number(row.ordinal),
        id,
      );
    const updated = this.db.prepare('SELECT * FROM volumes WHERE id = ?').get(id) as Row;
    return mapVolume(updated);
  }

  /** 删除卷：章节不删，volume_id 由外键 ON DELETE SET NULL 置空 */
  deleteVolume(id: string): void {
    this.db.prepare('DELETE FROM volumes WHERE id = ?').run(id);
  }

  createChapter(input: CreateChapterInput): Chapter {
    const timestamp = now();
    const chapter: Chapter = {
      id: input.id ?? newId(),
      bookId: input.bookId,
      volumeId: input.volumeId ?? null,
      ordinal: input.ordinal,
      title: input.title,
      outline: input.outline ?? '',
      content: input.content ?? null,
      status: input.status ?? 'outline',
      declaredCharacters: input.declaredCharacters ?? [],
      declaredLocations: input.declaredLocations ?? [],
      declaredForeshadows: input.declaredForeshadows ?? [],
      emotionTags: input.emotionTags ?? [],
      hookType: input.hookType ?? null,
      strand: input.strand ?? null,
      targetWords: input.targetWords ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO chapters (
          id, book_id, volume_id, ordinal, title, outline, content, status,
          declared_characters, declared_locations, declared_foreshadows,
          emotion_tags, hook_type, strand, target_words, created_at, updated_at
        ) VALUES (
          @id, @bookId, @volumeId, @ordinal, @title, @outline, @content, @status,
          @declaredCharacters, @declaredLocations, @declaredForeshadows,
          @emotionTags, @hookType, @strand, @targetWords, @createdAt, @updatedAt
        )`,
      )
      .run({
        id: chapter.id,
        bookId: chapter.bookId,
        volumeId: chapter.volumeId,
        ordinal: chapter.ordinal,
        title: chapter.title,
        outline: chapter.outline,
        content: chapter.content,
        status: chapter.status,
        declaredCharacters: toJson(chapter.declaredCharacters),
        declaredLocations: toJson(chapter.declaredLocations),
        declaredForeshadows: toJson(chapter.declaredForeshadows),
        emotionTags: toJson(chapter.emotionTags),
        hookType: chapter.hookType,
        strand: chapter.strand,
        targetWords: chapter.targetWords,
        createdAt: chapter.createdAt,
        updatedAt: chapter.updatedAt,
      });
    return chapter;
  }

  getChapter(id: string): Chapter | null {
    const row = this.db.prepare('SELECT * FROM chapters WHERE id = ?').get(id) as Row | undefined;
    return row ? mapChapter(row) : null;
  }

  getChapterByOrdinal(bookId: string, ordinal: number): Chapter | null {
    const row = this.db
      .prepare('SELECT * FROM chapters WHERE book_id = ? AND ordinal = ?')
      .get(bookId, ordinal) as Row | undefined;
    return row ? mapChapter(row) : null;
  }

  listChapters(bookId: string): Chapter[] {
    const rows = this.db
      .prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY ordinal')
      .all(bookId) as Row[];
    return rows.map(mapChapter);
  }

  /**
   * 章节列表（不含正文）。
   *
   * 百万字作品全书正文可达数 MB，工作台只需要标题/状态/章纲来渲染侧栏与标签；
   * 一次性把正文跨进程传给渲染层会让每次保存后的刷新都变慢，因此单独提供摘要查询，
   * 正文由 getChapterContent 按需拉取。
   */
  listChapterSummaries(bookId: string): Chapter[] {
    const rows = this.db
      .prepare(
        `SELECT id, book_id, volume_id, ordinal, title, outline, NULL AS content, status,
                declared_characters, declared_locations, declared_foreshadows, emotion_tags,
                hook_type, strand, target_words, created_at, updated_at
           FROM chapters WHERE book_id = ? ORDER BY ordinal`,
      )
      .all(bookId) as Row[];
    return rows.map(mapChapter);
  }

  /** 单章正文；未写过正文时返回空串，便于编辑层直接使用 */
  getChapterContent(chapterId: string): string {
    const row = this.db
      .prepare('SELECT content FROM chapters WHERE id = ?')
      .get(chapterId) as { content: string | null } | undefined;
    return row?.content ?? '';
  }

  /** 侧栏展示用的字数统计（按去空白字符计数，与门禁口径近似） */
  chapterWordCounts(bookId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT id, LENGTH(REPLACE(REPLACE(COALESCE(content, \'\'), \' \', \'\'), CHAR(10), \'\')) AS size FROM chapters WHERE book_id = ?')
      .all(bookId) as Array<{ id: string; size: number | null }>;
    const map: Record<string, number> = {};
    for (const row of rows) map[row.id] = Number(row.size ?? 0);
    return map;
  }

  /** 更新正文与状态。正文写入不触碰事实源——事实变更必须走 FactSourceRepository。 */
  updateChapterContent(
    id: string,
    content: string,
    status?: ChapterStatus,
  ): Chapter {
    const existing = this.getChapter(id);
    if (!existing) throw new Error(`Chapter not found: ${id}`);
    const nextStatus = status ?? existing.status;
    this.db
      .prepare('UPDATE chapters SET content = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(content, nextStatus, now(), id);
    this.touchBook(existing.bookId);
    return this.getChapter(id)!;
  }

  updateChapterStatus(id: string, status: ChapterStatus): Chapter {
    const existing = this.getChapter(id);
    if (!existing) throw new Error(`Chapter not found: ${id}`);
    this.db.prepare('UPDATE chapters SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    this.touchBook(existing.bookId);
    return this.getChapter(id)!;
  }

  /**
   * 按给定顺序重排章节序号。
   *
   * 两个关键约束：
   * 1. `(book_id, ordinal)` 有唯一约束，直接逐个写会在中途撞车，
   *    所以先整批搬到负数区再写正式值（同一事务内完成）。
   * 2. 序号起点沿用当前最小值，不强行改成 1，避免把 0 基或跳号的库整体位移。
   *
   * 注意：ordinal 是伏笔回收章、时间线、状态生效章的引用依据，
   * 重排会让这些引用指向不同章节，调用方必须提示作者复核。
   */
  reorderChapters(bookId: string, orderedIds: string[]): Chapter[] {
    const chapters = this.listChapters(bookId);
    if (chapters.length === 0) return chapters;
    if (orderedIds.length !== chapters.length) {
      throw new Error(`重排列表必须包含本书全部 ${chapters.length} 章，实际收到 ${orderedIds.length} 个`);
    }
    const owned = new Set(chapters.map((chapter) => chapter.id));
    for (const id of orderedIds) {
      if (!owned.has(id)) throw new Error(`章节不属于本书: ${id}`);
    }
    if (new Set(orderedIds).size !== orderedIds.length) throw new Error('重排列表存在重复章节');

    const base = Math.min(...chapters.map((chapter) => chapter.ordinal));
    const timestamp = now();
    this.db.transaction(() => {
      const statement = this.db.prepare('UPDATE chapters SET ordinal = ?, updated_at = ? WHERE id = ?');
      // 第一遍搬到负数区，第二遍写正式序号，规避唯一约束
      orderedIds.forEach((id, index) => statement.run(base - (index + 1), timestamp, id));
      orderedIds.forEach((id, index) => statement.run(base + index, timestamp, id));
    })();
    this.touchBook(bookId);
    return this.listChapters(bookId);
  }

  /** 更新章纲声明（出场角色、地点、伏笔推进、情绪标签、钩子类型、Strand） */
  updateChapterSpec(
    id: string,
    spec: Pick<
      Chapter,
      | 'declaredCharacters'
      | 'declaredLocations'
      | 'declaredForeshadows'
      | 'emotionTags'
      | 'hookType'
      | 'targetWords'
      | 'strand'
      | 'outline'
      | 'volumeId'
    > & { title?: string },
  ): Chapter {
    const existing = this.getChapter(id);
    if (!existing) throw new Error(`Chapter not found: ${id}`);
    this.db
      .prepare(
        `UPDATE chapters SET
          title = @title,
          volume_id = @volumeId,
          outline = @outline,
          declared_characters = @characters,
          declared_locations = @locations,
          declared_foreshadows = @foreshadows,
          emotion_tags = @emotions,
          hook_type = @hookType,
          strand = @strand,
          target_words = @targetWords,
          updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        title: spec.title?.trim() || existing.title,
        volumeId: spec.volumeId,
        outline: spec.outline,
        characters: toJson(spec.declaredCharacters),
        locations: toJson(spec.declaredLocations),
        foreshadows: toJson(spec.declaredForeshadows),
        emotions: toJson(spec.emotionTags),
        hookType: spec.hookType,
        strand: spec.strand ?? null,
        targetWords: spec.targetWords ?? null,
        updatedAt: now(),
      });
    this.touchBook(existing.bookId);
    return this.getChapter(id)!;
  }

  /** 删除章节：清 FTS 与章节；事实源中引用该章的字段由外键 SET NULL 处理 */
  deleteChapter(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM chapter_fts WHERE chapter_id = ?').run(id);
      this.db.prepare('DELETE FROM chapters WHERE id = ?').run(id);
    })();
  }

  /** 供检索层核对：读取某章正文，兼容正文尚未写入的情况 */
  getContent(bookId: string, ordinal: number): string {
    const row = this.db
      .prepare('SELECT content FROM chapters WHERE book_id = ? AND ordinal = ?')
      .get(bookId, ordinal) as Row | undefined;
    return row ? nullableStr(row.content) ?? '' : '';
  }
}
