/** 可读版整书导出：只保留卷/章标题与正文，空章节跳过 */
import { describe, expect, it } from 'vitest';
import { renderBookReadable } from '../src/projection/markdown.js';
import { makeChapter } from './helpers.js';
import type { Book } from '../src/domain/models.js';

const book: Book = {
  id: 'book-1',
  title: '雾港灯塔',
  outline: '这是创作笔记，不应出现在可读版正文里',
  genreId: 'suspense',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('整书可读导出', () => {
  it('按卷分组，跳过空章节，不输出元信息', () => {
    const chapters = [
      makeChapter({ id: 'c1', ordinal: 1, title: '第一章 潮声', content: '雾在灯塔周围凝成一层薄壳。', volumeId: 'v1' }),
      makeChapter({ id: 'c2', ordinal: 2, title: '第二章 空章', content: '   ', volumeId: 'v1' }),
      makeChapter({ id: 'c3', ordinal: 3, title: '第三章 回声', content: '他知道今晚不会有人来。', volumeId: 'v1' }),
    ];
    const text = renderBookReadable({
      book,
      chapters,
      volumes: [{ id: 'v1', title: '潮汐', ordinal: 1 }],
    });

    expect(text).toContain('雾港灯塔');
    expect(text).toContain('第 1 卷 潮汐');
    expect(text).toContain('第一章 潮声');
    expect(text).toContain('雾在灯塔周围凝成一层薄壳。');
    // 空章节跳过，不留占位
    expect(text).not.toContain('第二章 空章');
    expect(text).not.toContain('尚未撰写');
    // 创作笔记/状态元信息不进正文导出
    expect(text).not.toContain('这是创作笔记');
    expect(text).not.toContain('Strand');
  });

  it('章节按 ordinal 排序，与传入顺序无关', () => {
    const text = renderBookReadable({
      book,
      chapters: [
        makeChapter({ id: 'c2', ordinal: 2, title: '第二章', content: '二' }),
        makeChapter({ id: 'c1', ordinal: 1, title: '第一章', content: '一' }),
      ],
    });
    expect(text.indexOf('第一章')).toBeLessThan(text.indexOf('第二章'));
  });

  it('完全没有正文时给出明确提示而不是空文件', () => {
    const text = renderBookReadable({ book, chapters: [makeChapter({ content: '' })] });
    expect(text).toContain('本书还没有正文');
  });

  it('markdown 模式用标题层级，纯文本模式不用井号', () => {
    const chapters = [makeChapter({ ordinal: 1, title: '第一章 潮声', content: '正文' })];
    const md = renderBookReadable({ book, chapters, volumes: [{ id: 'v1', title: '潮汐', ordinal: 1 }], markdown: true });
    expect(md).toContain('# 雾港灯塔');
    const txt = renderBookReadable({ book, chapters });
    expect(txt.startsWith('雾港灯塔')).toBe(true);
    expect(txt.includes('#')).toBe(false);
  });
});
