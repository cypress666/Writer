/**
 * 旧稿解析：把 TXT / Markdown 按章节标题拆成章节草稿。
 *
 * 只做本地确定性解析，不猜测角色/伏笔；事实反推是后续可选的 AI 步骤，
 * 且必须以「候选清单 + 作者确认」的方式落地，不能直接覆盖事实源。
 */

export interface ManuscriptChapterDraft {
  title: string;
  content: string;
  wordCount: number;
}

const CHINESE_NUM = '0-9零〇一二三四五六七八九十百千万两';
const HEADING_PATTERNS = [
  /^#{1,3}\s+(.+)$/,
  new RegExp(`^\\s*第\\s*[${CHINESE_NUM}]+\\s*[章节回卷篇].*$`),
  /^\s*(?:Chapter|CHAPTER)\s+\d+\b.*$/,
  /^\s*序章\s*.*$/,
  /^\s*楔子\s*.*$/,
  /^\s*尾声\s*.*$/,
];

export function countManuscriptWords(text: string): number {
  const han = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? []).length;
  return han + latin;
}

function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 80) return false;
  return HEADING_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function cleanTitle(line: string): string {
  return line
    .replace(/^#{1,3}\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export interface ParseOptions {
  /**
   * 无章节标题时按目标字数自动切章；0 或省略表示整篇作为一章。
   * 旧稿常常整本一个大文件（几十上百万字），不切章就没法做按需装配。
   */
  targetChars?: number;
}

/** 按段落聚合切分长文，超长段落硬切，保证每章不超过目标字数太多 */
function splitByLength(text: string, fallbackTitle: string, target: number): ManuscriptChapterDraft[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const blocks: string[] = [];
  let buffer: string[] = [];
  let size = 0;

  const flush = (): void => {
    if (buffer.length > 0) {
      blocks.push(buffer.join('\n\n'));
      buffer = [];
      size = 0;
    }
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > target) {
      flush();
      for (let index = 0; index < paragraph.length; index += target) {
        blocks.push(paragraph.slice(index, index + target));
      }
      continue;
    }
    if (size + paragraph.length > target && buffer.length > 0) flush();
    buffer.push(paragraph);
    size += paragraph.length;
  }
  flush();

  return blocks.map((content, index) => ({
    title: blocks.length > 1 ? `${fallbackTitle} · 第 ${index + 1} 部分` : fallbackTitle,
    content,
    wordCount: countManuscriptWords(content),
  }));
}

export function parseManuscript(
  text: string,
  fallbackTitle = '导入章节',
  options: ParseOptions = {},
): ManuscriptChapterDraft[] {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const headings: Array<{ index: number; title: string }> = [];

  lines.forEach((line, index) => {
    if (isHeading(line)) headings.push({ index, title: cleanTitle(line) });
  });

  const drafts: ManuscriptChapterDraft[] = [];
  const pushDraft = (title: string, content: string): void => {
    const trimmed = content.trim();
    if (!trimmed) return;
    drafts.push({ title: title.trim() || fallbackTitle, content: trimmed, wordCount: countManuscriptWords(trimmed) });
  };

  if (headings.length === 0) {
    const target = options.targetChars ?? 0;
    // 只有明显超过目标体量时才切，避免把短篇硬拆成多章
    if (target > 0 && normalized.length > target * 1.5) {
      return splitByLength(normalized, fallbackTitle, target);
    }
    pushDraft(fallbackTitle, normalized);
    return drafts;
  }

  // 第一个标题之前的正文作为序章，避免前言被丢弃
  const preface = lines.slice(0, headings[0]!.index).join('\n').trim();
  if (preface) pushDraft('序章', preface);

  headings.forEach((heading, position) => {
    const next = headings[position + 1];
    const body = lines.slice(heading.index + 1, next?.index ?? lines.length).join('\n');
    pushDraft(heading.title, body);
  });

  return drafts;
}
