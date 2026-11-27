import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseVault, scanVault, splitFrontmatter, titleFromFileName } from '../src/import/obsidian.js';

const root = mkdtempSync(join(tmpdir(), 'inkforge-vault-'));

function write(relativePath: string, content: string): void {
  const full = join(root, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('Obsidian 仓库解析', () => {
  it('frontmatter 提取 title 与 order，正文保留其余内容', () => {
    const { title, order, body } = splitFrontmatter('---\ntitle: 雾港\norder: 3\ntags: [a]\n---\n正文开始');
    expect(title).toBe('雾港');
    expect(order).toBe(3);
    expect(body).toBe('正文开始');
  });

  it('无 frontmatter 时原样返回正文', () => {
    const { title, order, body } = splitFrontmatter('# 标题\n内容');
    expect(title).toBeNull();
    expect(order).toBeNull();
    expect(body).toBe('# 标题\n内容');
  });

  it('文件名转标题时去掉扩展名与下划线', () => {
    expect(titleFromFileName('第01章_雾中来客.md')).toBe('第01章 雾中来客');
  });

  it('扫描时跳过 .obsidian 与附件目录，并按自然序排列', () => {
    write('第10章 收束.md', '末尾');
    write('第2章 雾起.md', '中间');
    write('.obsidian/workspace.md', '不该被读到');
    write('assets/图说明.md', '附件目录也不读');
    const { files, skippedDirs } = scanVault(root);
    expect(files).toEqual(['第2章 雾起.md', '第10章 收束.md']);
    expect(skippedDirs).toContain('.obsidian');
  });

  it('一个文件一章：标题取文件名，正文整篇保留', () => {
    const vault = mkdtempSync(join(tmpdir(), 'inkforge-vault-b-'));
    try {
      writeFileSync(join(vault, '第一章.md'), '雾在灯塔周围凝成一层薄壳。', 'utf8');
      const result = parseVault(vault);
      expect(result.fileCount).toBe(1);
      expect(result.chapters).toHaveLength(1);
      expect(result.chapters[0]?.title).toBe('第一章');
      expect(result.totalWords).toBeGreaterThan(0);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it('一个文件内多章：继续按标题拆分', () => {
    const vault = mkdtempSync(join(tmpdir(), 'inkforge-vault-c-'));
    try {
      writeFileSync(join(vault, '合集.md'), '# 第一章 起\n甲\n\n# 第二章 承\n乙', 'utf8');
      const result = parseVault(vault);
      expect(result.chapters.map((c) => c.title)).toEqual(['第一章 起', '第二章 承']);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it('显式 order 优先于文件名顺序', () => {
    const vault = mkdtempSync(join(tmpdir(), 'inkforge-vault-d-'));
    try {
      writeFileSync(join(vault, 'a.md'), '---\norder: 2\ntitle: 后写\n---\n乙', 'utf8');
      writeFileSync(join(vault, 'b.md'), '---\norder: 1\ntitle: 先写\n---\n甲', 'utf8');
      const result = parseVault(vault);
      expect(result.chapters.map((c) => c.title)).toEqual(['先写', '后写']);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it('空仓库返回空结果而不是抛错', () => {
    const vault = mkdtempSync(join(tmpdir(), 'inkforge-vault-e-'));
    try {
      const result = parseVault(vault);
      expect(result.chapters).toEqual([]);
      expect(result.fileCount).toBe(0);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
