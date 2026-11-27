/**
 * Markdown 投影。
 *
 * 重要：这是 SQLite 结构化事实源与章节正文的「人类可读视图」，不是权威数据源。
 * 直接编辑导出的 Markdown 不会回写事实源；旧稿导入后的差量反推属于 3B 的导入裁决流程。
 */

import type { Book, Chapter, FactSourceState } from '../domain/models.js';

const HEADER =
  '> 本文件由 Inkforge 从结构化事实源投影生成。直接编辑不会回写数据库；事实修改请在工作台完成。';

function display(value: unknown): string {
  if (value == null || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.map(display).join('、') : '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function chapterHeader(chapter: Chapter): string {
  const meta = [
    `第 ${chapter.ordinal} 章`,
    `状态：${chapter.status}`,
    chapter.strand ? `Strand：${chapter.strand}` : null,
    chapter.hookType ? `钩子：${chapter.hookType}` : null,
    chapter.targetWords ? `目标字数：${chapter.targetWords}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return `## ${chapter.title}\n\n${meta}\n`;
}

export function renderChapterMarkdown(input: {
  book: Book;
  chapter: Chapter;
  state: FactSourceState;
}): string {
  const { book, chapter, state } = input;
  const nameOf = (id: string): string => state.characters.find((c) => c.id === id)?.name ?? id;
  const declaredCharacters = chapter.declaredCharacters.map(nameOf).join('、') || '—';
  const declaredForeshadows =
    chapter.declaredForeshadows
      .map((use) => {
        const f = state.foreshadows.find((item) => item.id === use.foreshadowId);
        return f ? `${f.title}（${use.action}）` : use.foreshadowId;
      })
      .join('、') || '—';

  return [
    `# ${book.title} · ${chapter.title}`,
    '',
    HEADER,
    '',
    chapterHeader(chapter),
    '',
    '### 章纲',
    '',
    chapter.outline || '（未填写）',
    '',
    '### 本章声明',
    '',
    `- 出场角色：${declaredCharacters}`,
    `- 地点：${chapter.declaredLocations.join('、') || '—'}`,
    `- 伏笔任务：${declaredForeshadows}`,
    `- 情绪标签：${chapter.emotionTags.join('、') || '—'}`,
    '',
    '### 正文',
    '',
    chapter.content?.trim() || '（尚未撰写）',
    '',
    '### 事实源附录（本章出场角色）',
    '',
    '| 角色 | 位置 | 已知信息 |',
    '| --- | --- | --- |',
    ...chapter.declaredCharacters.map((id) => {
      const s = state.characterStates.find((item) => item.characterId === id);
      return `| ${display(nameOf(id))} | ${display(s?.location)} | ${display(s?.knownFacts)} |`;
    }),
    '',
  ].join('\n');
}

export function renderBookMarkdown(input: {
  book: Book;
  chapters: Chapter[];
  state: FactSourceState;
}): string {
  const { book, chapters, state } = input;
  const nameOf = (id: string | null): string =>
    id ? (state.characters.find((c) => c.id === id)?.name ?? id) : '—';

  return [
    `# ${book.title}`,
    '',
    HEADER,
    '',
    `作品 ID：${book.id} · 章节数：${chapters.length} · 导出时间：${new Date().toISOString()}`,
    '',
    '## 事实源',
    '',
    '### 角色状态',
    '',
    '| 角色 | 在世 | 位置 | 能力 | 已知信息 |',
    '| --- | --- | --- | --- | --- |',
    ...state.characters.map((c) => {
      const s = state.characterStates.find((item) => item.characterId === c.id);
      return `| ${display(c.name)} | ${c.isAlive ? '是' : '否'} | ${display(s?.location)} | ${display(s?.abilities)} | ${display(s?.knownFacts)} |`;
    }),
    '',
    '### 伏笔账本',
    '',
    '| 伏笔 | 类型 | 状态 | 埋设章 | 计划回收 | 证据词 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...state.foreshadows.map((f) => {
      const planted = chapters.find((c) => c.id === f.plantedInChapterId);
      return `| ${display(f.title)} | ${f.kind} | ${f.status} | ${planted?.ordinal ?? '—'} | ${f.plannedResolveOrdinal ?? '—'} | ${display(f.resolutionMarkers)} |`;
    }),
    '',
    '### 世界规则',
    '',
    '| 分类 | 规则 | 优先级 |',
    '| --- | --- | --- |',
    ...state.worldRules.map((r) => `| ${display(r.category)} | ${display(r.rule)} | ${r.priority} |`),
    '',
    '## 章节',
    '',
    ...chapters.flatMap((chapter) => [
      chapterHeader(chapter),
      '',
      `章纲：${chapter.outline || '（未填写）'}`,
      '',
      `出场角色：${chapter.declaredCharacters.map(nameOf).join('、') || '—'}`,
      '',
      chapter.content?.trim() || '（尚未撰写）',
      '',
      '---',
      '',
    ]),
  ].join('\n');
}

/**
 * 可读版整书导出（TXT / 纯文本 Markdown 都走这里）。
 *
 * 与 renderBookMarkdown 的区别：不带事实源表格、不带状态/Strand 等元信息，
 * 只保留「卷标题 → 章节标题 → 正文」，是作者拿去投稿或给读者看的版本。
 * 空章节直接跳过，不输出「尚未撰写」占位。
 */
export function renderBookReadable(input: {
  book: Book;
  chapters: Chapter[];
  volumes?: Array<{ id: string; title: string; ordinal: number }>;
  /** true 时用 Markdown 标题层级，false 时用纯文本排版 */
  markdown?: boolean;
}): string {
  const { book, chapters, markdown = false } = input;
  const volumes = [...(input.volumes ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  const sorted = [...chapters].sort((a, b) => a.ordinal - b.ordinal);
  const lines: string[] = [];

  lines.push(markdown ? `# ${book.title}` : book.title, '');

  let lastVolumeId: string | null | undefined;
  for (const chapter of sorted) {
    const content = (chapter.content ?? '').trim();
    if (!content) continue;

    if (chapter.volumeId !== lastVolumeId) {
      if (chapter.volumeId) {
        const volume = volumes.find((item) => item.id === chapter.volumeId);
        if (volume) lines.push(markdown ? `## 第 ${volume.ordinal} 卷 ${volume.title}` : `第 ${volume.ordinal} 卷 ${volume.title}`, '');
      }
      lastVolumeId = chapter.volumeId;
    }

    lines.push(markdown ? `### ${chapter.title}` : chapter.title, '');
    lines.push(content, '');
  }

  if (lines.length <= 2) {
    return `${book.title}\n\n（本书还没有正文）\n`;
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
