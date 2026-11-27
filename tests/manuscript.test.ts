import { describe, expect, it } from 'vitest';
import { parseManuscript } from '../src/import/manuscript.js';

describe('旧稿解析', () => {
  it('按「第 N 章」拆分，前言进入序章', () => {
    const text = [
      '这是作者写在最前面的引子。',
      '',
      '第一章 雾港',
      '林风抵达雾港。',
      '',
      '第二章 钟声',
      '钟声在午夜响起。',
    ].join('\n');
    const chapters = parseManuscript(text, '测试稿');
    expect(chapters.map((c) => c.title)).toEqual(['序章', '第一章 雾港', '第二章 钟声']);
    expect(chapters[0]?.content).toContain('引子');
    expect(chapters[1]?.content).toBe('林风抵达雾港。');
    expect(chapters[2]?.content).toBe('钟声在午夜响起。');
    expect(chapters.reduce((sum, c) => sum + c.wordCount, 0)).toBeGreaterThan(0);
  });

  it('支持 Markdown 标题与 Chapter 标记', () => {
    const md = '# 第1章 开始\n正文一\n\n## 第2章 继续\n正文二';
    const chapters = parseManuscript(md, '稿件');
    expect(chapters).toHaveLength(2);
    expect(chapters[0]?.title).toBe('第1章 开始');

    const en = 'Chapter 1 Dawn\nText one\n\nChapter 2 Dusk\nText two';
    expect(parseManuscript(en, 'en')).toHaveLength(2);
  });

  it('没有标题时整篇作为一章，空内容返回空数组', () => {
    const single = parseManuscript('只有一段正文，没有任何章节标题。', '短篇');
    expect(single).toHaveLength(1);
    expect(single[0]?.title).toBe('短篇');
    expect(parseManuscript('   \n\n  ', '空稿')).toEqual([]);
  });
});

describe('无标题长文按字数切章', () => {
  const paragraph = '雾在灯塔周围凝成一层薄壳，他把手贴在铁门上，听见潮水在下面退去。';

  function longText(chars: number): string {
    const times = Math.ceil(chars / paragraph.length);
    return Array.from({ length: times }, () => paragraph).join('\n\n');
  }

  it('未指定 targetChars 时保持整篇一章', () => {
    const chapters = parseManuscript(longText(9000), '长文');
    expect(chapters).toHaveLength(1);
  });

  it('指定 targetChars 后切成多章且每章不超过目标太多', () => {
    const chapters = parseManuscript(longText(9000), '长文', { targetChars: 3000 });
    expect(chapters.length).toBeGreaterThanOrEqual(3);
    for (const chapter of chapters) {
      expect(chapter.content.length).toBeLessThanOrEqual(3300);
      expect(chapter.wordCount).toBeGreaterThan(0);
    }
    expect(chapters[0]?.title).toContain('第 1 部分');
  });

  it('超长单段会被硬切而不是挤成一章', () => {
    const chapters = parseManuscript(paragraph.repeat(200), '硬切', { targetChars: 2000 });
    expect(chapters.length).toBeGreaterThan(1);
  });
});
