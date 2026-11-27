/**
 * Obsidian 仓库（vault）导入。
 *
 * 只做本地确定性解析：递归扫描 .md → 按文件名/`order` 排序 → 每个文件解析成章节草稿。
 * 单个文件内部若已含「第 N 章 / # 标题」等章节标题，则继续按标题拆分（复用 manuscript 解析器）。
 * 不猜测角色与伏笔，事实反推仍是后续可选的人工/AI 步骤。
 */
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { countManuscriptWords, parseManuscript, type ManuscriptChapterDraft } from './manuscript.js';

export interface VaultParseResult {
  folder: string;
  /** 参与解析的 Markdown 文件数 */
  fileCount: number;
  /** 被跳过的目录名（.obsidian、附件目录等） */
  skippedDirs: string[];
  chapters: ManuscriptChapterDraft[];
  totalWords: number;
}

export interface VaultFileInfo {
  relativePath: string;
  title: string;
  order: number | null;
  size: number;
}

/** 这些目录不属于正文内容，扫描时直接跳过（跳过项会回报给前端，避免"文件不见了"的困惑） */
const SKIP_DIRS = new Set([
  '.obsidian',
  '.trash',
  '.git',
  '.github',
  'node_modules',
  '.workbuddy',
  // Obsidian 常见附件目录
  'assets',
  'attachments',
  'images',
  'media',
  '附件',
]);
/** 单文件与总量上限，避免误选一个包含大量附件的仓库把内存打满 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const MAX_DEPTH = 6;

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

interface Frontmatter {
  title: string | null;
  order: number | null;
  body: string;
}

/** 解析 YAML frontmatter 中我们关心的字段，其余原样保留在正文里 */
export function splitFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return { title: null, order: null, body: normalized };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { title: null, order: null, body: normalized };
  const header = normalized.slice(4, end);
  const rest = normalized.slice(end + 4).replace(/^\n/, '');
  let title: string | null = null;
  let order: number | null = null;
  for (const line of header.split('\n')) {
    const match = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = (match[1] ?? '').toLowerCase();
    const raw = (match[2] ?? '').trim().replace(/^["']|["']$/g, '');
    if (!raw) continue;
    if (key === 'title') title = raw.slice(0, 120);
    if (key === 'order' || key === 'chapter') {
      const parsed = Number(raw.replace(/[^\d.-]/g, ''));
      if (Number.isFinite(parsed)) order = parsed;
    }
  }
  return { title, order, body: rest };
}

/** 文件名 → 章节标题：去掉扩展名，保留「第 12 章」之类的序号信息 */
export function titleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.md$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function walk(folder: string, current: string, depth: number, out: string[], skipped: Set<string>): void {
  if (depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || isHidden(entry.name)) {
        skipped.add(entry.name);
        continue;
      }
      walk(folder, full, depth + 1, out, skipped);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.md$/i.test(entry.name)) continue;
    out.push(relative(folder, full));
  }
}

/** 递归收集仓库内的 Markdown 文件（不读内容，便于先估算规模） */
export function scanVault(folder: string): { files: string[]; skippedDirs: string[] } {
  const files: string[] = [];
  const skipped = new Set<string>();
  walk(folder, folder, 0, files, skipped);
  files.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
  return { files, skippedDirs: [...skipped].sort() };
}

/**
 * 解析整个仓库为章节草稿。
 *
 * 排序策略：显式 `order` 优先，其次按相对路径自然序（`第2章` 在 `第10章` 之前）。
 */
export function parseVault(folder: string): VaultParseResult {
  const { files, skippedDirs } = scanVault(folder);
  const entries: Array<{ info: VaultFileInfo; chapters: ManuscriptChapterDraft[] }> = [];
  let totalBytes = 0;

  for (const relativePath of files) {
    const full = join(folder, relativePath);
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }
    if (size === 0 || size > MAX_FILE_BYTES) continue;
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) break;

    let raw = '';
    try {
      raw = readFileSync(full, 'utf8');
    } catch {
      continue;
    }

    const { title, order, body } = splitFrontmatter(raw);
    const fileName = relativePath.split(sep).pop() ?? relativePath;
    const fallbackTitle = title ?? titleFromFileName(fileName);

    // 文件内已按章节组织时继续拆分；否则整篇算一章
    const inner = parseManuscript(body, fallbackTitle, { targetChars: 3000 });
    const chapters =
      inner.length > 1
        ? inner
        : [
            {
              title: fallbackTitle,
              content: body.trim(),
              wordCount: countManuscriptWords(body),
            },
          ].filter((chapter) => chapter.content.length > 0);

    if (chapters.length === 0) continue;
    entries.push({ info: { relativePath, title: fallbackTitle, order, size }, chapters });
  }

  // order 显式指定时优先，其余保持路径自然序
  const ordered = entries
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => {
      const left = a.info.order;
      const right = b.info.order;
      if (left !== null && right !== null && left !== right) return left - right;
      if (left !== null && right === null) return -1;
      if (left === null && right !== null) return 1;
      return a.index - b.index;
    });

  const chapters = ordered.flatMap((entry) => entry.chapters);
  return {
    folder,
    fileCount: ordered.length,
    skippedDirs,
    chapters,
    totalWords: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
  };
}
