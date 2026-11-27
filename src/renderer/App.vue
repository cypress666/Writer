<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type {
  Book,
  BookSummary,
  Chapter,
  GateReport,
  AuditReport,
  GenreTemplate,
  LlmAuditResult,
  WorkbenchData,
} from '../shared/ipc-contract.js';
import ChapterEditor from './components/ChapterEditor.vue';
import ChapterSettingsDialog from './components/ChapterSettingsDialog.vue';
import ChecksPanel from './components/ChecksPanel.vue';
import FactsPanel from './components/FactsPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import BookSettingsDialog from './components/BookSettingsDialog.vue';
import ImportDialog from './components/ImportDialog.vue';
import SearchPanel from './components/SearchPanel.vue';
import { isEn, locale, t, toggleLocale } from './i18n/index.js';

const books = ref<BookSummary[]>([]);
const shelfQuery = ref('');
const workbench = ref<WorkbenchData | null>(null);
const activeChapterId = ref<string | null>(null);
const activeTab = ref<'editor' | 'checks' | 'facts' | 'search' | 'settings'>('editor');
const gate = ref<GateReport | null>(null);
const audit = ref<AuditReport | null>(null);
const llmAudit = ref<LlmAuditResult | null>(null);
const llmBusy = ref(false);
const busy = ref(false);
const toast = ref('');
const showNewBook = ref(false);
const newBookTitle = ref('');
/** 新建时即可选题材：决定门禁/审计侧重，创建后再改也能改 */
const newBookGenre = ref('');
const showNewChapter = ref(false);
const newChapterTitle = ref('');
/** 新建作品后立刻打开导入对话框，省去"建空书再进作品导入"的绕路 */
const importAfterCreate = ref(false);
/** 拖拽进来的文件路径，交给导入对话框自动解析 */
const droppedPath = ref<string | null>(null);
const dragging = ref(false);
const showBookSettings = ref(false);
const showImport = ref(false);
const showChapterSettings = ref(false);
const genres = ref<GenreTemplate[]>([]);
/** 章节正文按需加载，key 为 chapterId；避免百万字全书正文一次性进入渲染层 */
const chapterContents = ref<Record<string, string>>({});
const contentLoading = ref(false);
/** 编辑器是否有未保存修改；用于切章/返回书房前拦截 */
const editorDirty = ref(false);

const activeChapter = computed(
  () => workbench.value?.chapters.find((c) => c.id === activeChapterId.value) ?? null,
);

/** 正文就绪后的完整章节对象；未加载完成时为 null，编辑器据此显示占位 */
const activeChapterFull = computed(() => {
  const chapter = activeChapter.value;
  if (!chapter) return null;
  const content = chapterContents.value[chapter.id];
  if (content === undefined) return null;
  return { ...chapter, content };
});

/** 用 computed 包装，避免模板里 v-if 链把 activeTab 收窄到不可比较 */
const isSearchTab = computed(() => activeTab.value === 'search');

/** 侧栏按卷分组；未归卷的章节归入末尾的「未归卷」组 */
const chapterGroups = computed(() => {
  const data = workbench.value;
  if (!data) return [] as { key: string; label: string; chapters: Chapter[] }[];
  const chapters = data.chapters;
  const groups = [...data.volumes]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((volume) => ({
      key: volume.id,
      label: t('第 {n} 卷 · {title}', { n: volume.ordinal, title: volume.title }),
      chapters: chapters.filter((chapter) => chapter.volumeId === volume.id),
    }));
  const loose = chapters.filter((chapter) => !chapter.volumeId);
  if (loose.length > 0) groups.push({ key: '__loose__', label: t('未归卷'), chapters: loose });
  return groups;
});

const totalWords = computed(() => books.value.reduce((sum, book) => sum + book.wordCount, 0));

/** 侧栏折叠：只影响显示，不影响章序 */
const collapsedGroups = ref<Set<string>>(new Set());

function toggleGroup(key: string): void {
  const next = new Set(collapsedGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedGroups.value = next;
}

/** 拖拽重排：记录被拖章节与当前悬停目标 */
const draggingChapterId = ref<string | null>(null);
const dragOverChapterId = ref<string | null>(null);

function onChapterDragStart(chapterId: string, event: DragEvent): void {
  draggingChapterId.value = chapterId;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    // Firefox 必须 setData 才会真正开始拖拽
    event.dataTransfer.setData('text/plain', chapterId);
  }
}

function onChapterDragEnd(): void {
  draggingChapterId.value = null;
  dragOverChapterId.value = null;
}

/** 只允许同卷内重排：跨卷拖拽会同时改变归属，容易误操作，交给章节设置改卷 */
async function onChapterDrop(target: Chapter, groupKey: string): Promise<void> {
  const draggedId = draggingChapterId.value;
  onChapterDragEnd();
  if (!draggedId || draggedId === target.id) return;
  const data = workbench.value;
  if (!data) return;

  const dragged = data.chapters.find((chapter) => chapter.id === draggedId);
  if (!dragged) return;
  const groupOf = (chapter: Chapter): string => chapter.volumeId ?? '__loose__';
  if (groupOf(dragged) !== groupKey) {
    flash(t('只能在同一卷内拖动排序；要换卷请用「章节设置」调整归属'));
    return;
  }

  const current = [...data.chapters].sort((a, b) => a.ordinal - b.ordinal).map((chapter) => chapter.id);
  const from = current.indexOf(draggedId);
  const to = current.indexOf(target.id);
  if (from < 0 || to < 0 || from === to) return;
  current.splice(from, 1);
  current.splice(to, 0, draggedId);

  // 章序是伏笔回收章、时间线、状态生效章的引用依据，重排前必须让作者知情
  const affectedForeshadows = data.foreshadows.filter(
    (item) => item.status !== 'resolved' && item.plannedResolveOrdinal != null,
  ).length;
  const affectedTimeline = data.timelineEvents.length;
  if (affectedForeshadows + affectedTimeline > 0) {
    const ok = window.confirm(
      t('重排会改变第 {a} 章与第 {b} 章之间的顺序。\n\n已登记 {f} 条伏笔的回收章号、{t} 条时间线的章序不会自动跟随，重排后需要你复核。\n\n继续？', {
        a: dragged.ordinal,
        b: target.ordinal,
        f: affectedForeshadows,
        t: affectedTimeline,
      }),
    );
    if (!ok) return;
  }

  busy.value = true;
  try {
    const res = await window.api.reorderChapters({ bookId: data.book.id, orderedChapterIds: current });
    if (!res.ok) throw new Error(res.error ?? t('重排失败'));
    await refreshWorkbench();
    flash(t('章序已更新'));
  } catch (error) {
    flash(error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

const filteredBooks = computed(() => {
  const keyword = shelfQuery.value.trim().toLowerCase();
  if (!keyword) return books.value;
  return books.value.filter(
    (book) =>
      book.title.toLowerCase().includes(keyword) || (book.outline || '').toLowerCase().includes(keyword),
  );
});

function genreLabel(id: string | null): string {
  if (!id) return '';
  const genre = genres.value.find((item) => item.id === id);
  return genre ? t(genre.name) : '';
}

function formatWords(count: number): string {
  if (isEn()) {
    if (count >= 10000) return t('{n} 万字', { n: (count / 10000).toFixed(1) });
    return t('{n} 字', { n: count });
  }
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`;
  return `${count} 字`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) {
    return t('今天 {time}', {
      time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
    });
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 按 id 稳定生成封面配色，同一本书每次打开颜色一致 */
function coverStyle(id: string): Record<string, string> {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) % 360;
  const hue = hash;
  return {
    background: `linear-gradient(145deg, hsl(${hue} 62% 58%), hsl(${(hue + 38) % 360} 58% 42%))`,
  };
}

function flash(message: string): void {
  toast.value = message;
  window.setTimeout(() => (toast.value = ''), 2600);
}

function statusLabel(status: string): string {
  return t({ outline: '章纲', draft: '草稿', reviewed: '已审稿', final: '已定稿' }[status] ?? status);
}
function statusBadgeClass(status: string): string {
  return { outline: 'muted', draft: 'info', reviewed: 'warning', final: 'success' }[status] ?? 'muted';
}
function strandLabel(strand: string): string {
  return t({ quest: '主线', fire: '感情线', constellation: '世界观' }[strand] ?? strand);
}

async function loadBooks(): Promise<void> {
  const res = await window.api.listBooks();
  if (res.ok && res.data) books.value = res.data;
  else flash(res.error ?? t('加载作品失败'));
}

async function loadGenres(): Promise<void> {
  if (genres.value.length > 0) return;
  const res = await window.api.listGenres();
  if (res.ok && res.data) genres.value = res.data;
}

async function openBook(bookId: string): Promise<void> {
  if (!confirmDiscard()) return;
  busy.value = true;
  try {
    const res = await window.api.getWorkbench(bookId);
    if (!res.ok || !res.data) throw new Error(res.error ?? t('打开作品失败'));
    workbench.value = res.data;
    gate.value = null;
    audit.value = null;
    llmAudit.value = null;
    const last = res.data.chapters[res.data.chapters.length - 1];
    activeChapterId.value = last?.id ?? null;
    activeTab.value = last ? 'editor' : 'facts';
    await ensureContent(activeChapterId.value);
  } catch (error) {
    flash(error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

/** 刷新工作台数据但保留当前章节与标签，避免编辑器被卸载重建 */
async function refreshWorkbench(): Promise<void> {
  const current = workbench.value;
  if (!current) return;
  const res = await window.api.getWorkbench(current.book.id);
  if (!res.ok || !res.data) return flash(res.error ?? t('刷新失败'));
  workbench.value = res.data;
  if (!activeChapterId.value || !res.data.chapters.some((c) => c.id === activeChapterId.value)) {
    activeChapterId.value = res.data.chapters.at(-1)?.id ?? null;
  }
  await ensureContent(activeChapterId.value);
}

/** 编辑器保存后：先把最新正文写回缓存，再刷新结构化数据 */
async function onChapterSaved(content?: string): Promise<void> {
  const chapterId = activeChapterId.value;
  if (chapterId && typeof content === 'string') {
    chapterContents.value = { ...chapterContents.value, [chapterId]: content };
  }
  await refreshWorkbench();
}

/** 按需拉取章节正文并缓存；force 用于保存后同步最新内容 */
async function ensureContent(chapterId: string | null, force = false): Promise<void> {
  if (!chapterId) return;
  if (!force && chapterContents.value[chapterId] !== undefined) return;
  contentLoading.value = true;
  try {
    const res = await window.api.getChapterContent({ chapterId });
    if (!res.ok) throw new Error(res.error ?? t('加载正文失败'));
    chapterContents.value = { ...chapterContents.value, [chapterId]: res.data ?? '' };
  } catch (error) {
    flash(error instanceof Error ? error.message : String(error));
  } finally {
    contentLoading.value = false;
  }
}

async function createBook(): Promise<void> {
  const title = newBookTitle.value.trim();
  if (!title) return;
  const res = await window.api.createBook({
    title,
    ...(newBookGenre.value ? { genreId: newBookGenre.value } : {}),
  });
  if (!res.ok || !res.data) return flash(res.error ?? t('新建作品失败'));
  showNewBook.value = false;
  const shouldImport = importAfterCreate.value;
  newBookTitle.value = '';
  newBookGenre.value = '';
  importAfterCreate.value = false;
  await loadBooks();
  await openBook(res.data.id);
  if (shouldImport) showImport.value = true;
}

async function createChapter(): Promise<void> {
  const data = workbench.value;
  if (!data) return;
  const nextOrdinal = data.chapters.reduce((max, c) => Math.max(max, c.ordinal), 0) + 1;
  const title = newChapterTitle.value.trim() || t('第 {n} 章', { n: nextOrdinal });
  const res = await window.api.createChapter({
    bookId: data.book.id,
    ordinal: nextOrdinal,
    title,
    volumeId: activeChapter.value?.volumeId ?? null,
  });
  if (!res.ok || !res.data) return flash(res.error ?? t('新建章节失败'));
  showNewChapter.value = false;
  newChapterTitle.value = '';
  await openBook(data.book.id);
  activeChapterId.value = res.data.id;
  activeTab.value = 'editor';
  await ensureContent(res.data.id, true);
}

function confirmDiscard(): boolean {
  if (!editorDirty.value) return true;
  return window.confirm(t('当前章节有未保存的修改，继续操作会丢失这些改动。是否继续？'));
}

function backToShelf(): void {
  if (!confirmDiscard()) return;
  workbench.value = null;
  editorDirty.value = false;
}

function selectChapter(id: string): void {
  if (id === activeChapterId.value) return;
  if (!confirmDiscard()) return;
  editorDirty.value = false;
  activeChapterId.value = id;
  gate.value = null;
  audit.value = null;
  llmAudit.value = null;
  activeTab.value = 'editor';
  void ensureContent(id);
}

async function runChecks(): Promise<void> {
  if (!activeChapterId.value) return;
  busy.value = true;
  try {
    const res = await window.api.runChecks({ chapterId: activeChapterId.value });
    if (!res.ok || !res.data) throw new Error(res.error ?? t('检查失败'));
    gate.value = res.data.gate;
    audit.value = res.data.audit;
    activeTab.value = 'checks';
    flash(res.data.gate.passed ? t('检查完成：无阻断项') : t('检查完成：存在阻断项'));
  } catch (error) {
    flash(error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function runAiAudit(): Promise<void> {
  if (!activeChapterId.value) return;
  llmBusy.value = true;
  try {
    const res = await window.api.runLlmAudit({ chapterId: activeChapterId.value });
    if (!res.ok || !res.data) throw new Error(res.error ?? t('AI 审稿失败'));
    llmAudit.value = res.data;
    activeTab.value = 'checks';
    flash(t('AI 审稿完成：{n} 条观察', { n: res.data.observations.length }));
  } catch (error) {
    flash(error instanceof Error ? error.message : String(error));
  } finally {
    llmBusy.value = false;
  }
}

async function exportBook(format: 'md' | 'txt', mode: 'read' | 'archive' = 'read'): Promise<void> {
  if (!workbench.value) return;
  const res = await window.api.exportMarkdown({ bookId: workbench.value.book.id, format, mode });
  if (!res.ok || !res.data) return flash(res.error ?? t('导出失败'));
  const first = res.data.files[0];
  flash(t('已导出到 {path}', { path: res.data.directory }));
  if (first) window.setTimeout(() => void window.api.revealPath({ path: first }), 400);
}

async function backupDatabase(): Promise<void> {
  busy.value = true;
  try {
    const res = await window.api.backupDatabase();
    if (!res.ok || !res.data) throw new Error(res.error ?? t('备份失败'));
    const size = (res.data.sizeBytes / 1024 / 1024).toFixed(1);
    flash(t('已备份书库（{size} MB）：{file}', { size, file: res.data.file.split(/[\\/]/).pop() ?? '' }));
    window.setTimeout(() => void window.api.revealPath({ path: res.data!.file }), 400);
  } catch (error) {
    flash(error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function revealDataDir(): Promise<void> {
  const res = await window.api.revealDataDir();
  if (!res.ok) return flash(res.error ?? t('打开数据目录失败'));
  flash(t('数据目录：{path}', { path: res.data ?? '' }));
}

async function afterBookDeleted(): Promise<void> {
  workbench.value = null;
  activeChapterId.value = null;
  showBookSettings.value = false;
  activeTab.value = 'editor';
  await loadBooks();
  flash(t('作品已删除'));
}

function onDragOver(event: DragEvent): void {
  if (!workbench.value) return;
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragging.value = true;
}

function onDragLeave(event: DragEvent): void {
  if (event.relatedTarget && (event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) return;
  dragging.value = false;
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  if (!workbench.value) return;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  event.preventDefault();
  const path = window.api.getFilePath(file);
  if (!path) return flash(t('无法读取文件路径，请改用「导入旧稿 → 选择文件」'));
  droppedPath.value = path;
  showImport.value = true;
}

function openBookSettings(): void {
  void loadGenres();
  showBookSettings.value = true;
}

onMounted(() => {
  void loadBooks();
  // 把持久化的语言同步给主进程，重建原生菜单；否则顶栏会停在默认语言
  void window.api.setLocale({ locale: locale.value });
  window.api.onMenuAction((action) => {
    if (action === 'new-book') showNewBook.value = true;
    else if (action === 'import') {
      if (workbench.value) showImport.value = true;
      else flash(t('请先打开一本作品再导入旧稿'));
    } else if (action === 'backup') void backupDatabase();
    else if (action === 'export-txt') {
      if (workbench.value) void exportBook('txt');
      else flash(t('请先打开一本作品再导出'));
    }
  });
});
</script>

<template>
  <div
    class="app-shell"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">✒</span>
        <div>
          <div class="brand-name">Inkforge</div>
          <div class="brand-sub">{{ t('小说创作工作台') }}</div>
        </div>
      </div>

      <template v-if="!workbench">
        <div class="side-section-title">
          <span>{{ t('书房') }}</span>
          <button class="icon-btn" :title="t('重新读取书库（外部改动数据目录后使用）')" @click="loadBooks">🔄</button>
        </div>
        <button class="primary full" @click="showNewBook = true">{{ t('+ 新建作品') }}</button>
        <div class="book-list">
          <button
            v-for="book in books"
            :key="book.id"
            class="book-item"
            @click="openBook(book.id)"
          >
            <span class="book-icon">📖</span>
            <span class="book-title">{{ book.title }}</span>
          </button>
          <div v-if="books.length === 0" class="side-empty">{{ t('还没有作品') }}</div>
        </div>
      </template>

      <template v-else>
        <button class="side-back" @click="backToShelf">{{ t('← 返回书房') }}</button>
        <div class="side-book-title">
          <span>{{ workbench.book.title }}</span>
          <button class="icon-btn" :title="t('作品设置')" @click="openBookSettings">⚙</button>
        </div>
        <div class="side-actions">
          <button class="primary full" @click="showNewChapter = true">{{ t('+ 新建章节') }}</button>
          <button class="full" @click="showImport = true">{{ t('导入旧稿') }}</button>
          <div class="export-row">
            <button class="full" @click="exportBook('txt')" :title="t('卷/章标题 + 正文，可直接投稿')">
              {{ t('导出 TXT') }}
            </button>
            <button class="full" @click="exportBook('md')" :title="t('Markdown 可读版')">
              {{ t('导出 MD') }}
            </button>
          </div>
          <button class="full subtle" @click="exportBook('md', 'archive')" :title="t('含事实源表格，用于归档备份')">
            {{ t('导出归档版') }}
          </button>
        </div>
        <div class="chapter-list">
          <template v-for="group in chapterGroups" :key="group.key">
            <div class="group-title" @click="toggleGroup(group.key)">
              <span class="group-arrow">{{ collapsedGroups.has(group.key) ? '▸' : '▾' }}</span>
              <span class="group-label">{{ group.label }}</span>
              <span class="group-count">{{ group.chapters.length }}</span>
            </div>
            <template v-if="!collapsedGroups.has(group.key)">
              <button
                v-for="chapter in group.chapters"
                :key="chapter.id"
                class="chapter-item"
                :class="{
                  active: chapter.id === activeChapterId,
                  dragging: draggingChapterId === chapter.id,
                  'drop-target': dragOverChapterId === chapter.id && draggingChapterId !== chapter.id,
                }"
                draggable="true"
                @click="selectChapter(chapter.id)"
                @dragstart="onChapterDragStart(chapter.id, $event)"
                @dragend="onChapterDragEnd"
                @dragover.prevent="dragOverChapterId = chapter.id"
                @dragleave="dragOverChapterId === chapter.id && (dragOverChapterId = null)"
                @drop.prevent="onChapterDrop(chapter, group.key)"
              >
                <span class="chapter-no">{{ chapter.ordinal }}</span>
                <span class="chapter-title">{{ chapter.title }}</span>
                <span v-if="workbench.chapterWordCounts[chapter.id]" class="chapter-words">
                  {{ workbench.chapterWordCounts[chapter.id] }}
                </span>
                <span class="chapter-status" :class="chapter.status">{{ statusLabel(chapter.status) }}</span>
              </button>
            </template>
          </template>
          <div v-if="workbench.chapters.length === 0" class="side-empty">{{ t('还没有章节') }}</div>
        </div>
      </template>

      <div class="side-footer">
        <button @click="runChecks" :disabled="!activeChapterId || busy">{{ t('▶ 运行检查') }}</button>
        <button @click="activeTab = 'settings'">{{ t('⚙ AI 设置') }}</button>
        <button @click="backupDatabase" :disabled="busy">{{ t('💾 备份书库') }}</button>
        <button @click="revealDataDir">{{ t('📁 数据目录') }}</button>
        <button class="lang-switch" @click="toggleLocale">
          {{ locale === 'zh' ? '中 / EN' : 'EN / 中' }}
        </button>
      </div>
    </aside>

    <main class="main-area">
      <template v-if="activeTab === 'settings'">
        <header class="content-header">
          <div><h1>{{ t('AI 设置') }}</h1></div>
          <div class="header-actions">
            <button v-if="workbench" @click="activeTab = 'editor'">{{ t('返回工作台') }}</button>
          </div>
        </header>
        <div class="tab-content">
          <SettingsPanel @flash="flash" />
        </div>
      </template>

      <template v-else-if="!workbench">
        <header class="content-header">
          <div>
            <h1>{{ t('我的书架') }}</h1>
            <div class="header-meta">
              <span class="badge muted">{{ t('{n} 本作品', { n: books.length }) }}</span>
              <span class="badge muted">{{ formatWords(totalWords) }}</span>
            </div>
          </div>
          <div class="header-actions">
            <input v-model="shelfQuery" class="shelf-search" :placeholder="t('搜索书名或总纲…')" />
            <button class="lang-toggle" :title="isEn() ? t('切换到中文') : t('切换到英文')" @click="toggleLocale">
              {{ locale === 'zh' ? 'EN' : '中文' }}
            </button>
            <button class="primary" @click="showNewBook = true">{{ t('+ 新建作品') }}</button>
          </div>
        </header>

        <div class="shelf-area">
          <div v-if="filteredBooks.length === 0" class="empty-state">
            <div class="icon">📚</div>
            <h2>{{ books.length === 0 ? t('书架还空着') : t('没有匹配的作品') }}</h2>
            <p>
              {{
                books.length === 0
                  ? t('新建一本作品，或从 Obsidian 仓库导入旧稿。')
                  : t('换个关键词试试。')
              }}
            </p>
          </div>

          <div v-else class="shelf-grid">
            <button
              v-for="book in filteredBooks"
              :key="book.id"
              class="shelf-card"
              @click="openBook(book.id)"
            >
              <div class="shelf-cover" :style="coverStyle(book.id)">
                <span class="cover-badge">{{ t('{n} 章', { n: book.chapterCount }) }}</span>
                <span class="cover-title">{{ book.title }}</span>
                <span class="cover-foot">{{ formatWords(book.wordCount) }}</span>
              </div>
              <div class="shelf-meta">
                <div class="shelf-book-title">{{ book.title }}</div>
                <div class="shelf-sub">
                  <span v-if="genreLabel(book.genreId)" class="shelf-genre">{{ genreLabel(book.genreId) }}</span>
                  {{ book.volumeCount > 0 ? t('{n} 卷', { n: book.volumeCount }) : t('未分卷') }} ·
                  {{ t('{n} 章', { n: book.chapterCount }) }}
                </div>
                <div v-if="book.outline" class="shelf-outline">{{ book.outline }}</div>
                <div class="shelf-foot">
                  <span class="shelf-date">{{ formatDate(book.updatedAt) }}</span>
                  <span class="shelf-open">{{ t('继续写 →') }}</span>
                </div>
              </div>
            </button>

            <button class="shelf-card shelf-new" @click="showNewBook = true">
              <div class="shelf-new-inner">
                <span class="plus">＋</span>
                <span>{{ t('新建作品') }}</span>
              </div>
            </button>
          </div>
        </div>
      </template>

      <template v-else-if="isSearchTab">
        <header class="content-header">
          <div>
            <h1>{{ t('全书检索') }}</h1>
            <div class="header-meta">
              <span class="badge muted">{{ t('{n} 章', { n: workbench.chapters.length }) }}</span>
              <span class="badge muted">{{ t('{n} 卷', { n: workbench.volumes.length }) }}</span>
            </div>
          </div>
          <div class="header-actions">
            <button @click="activeTab = activeChapter ? 'editor' : 'facts'">{{ t('返回') }}</button>
          </div>
        </header>
        <div class="tab-content">
          <SearchPanel
            :book-id="workbench.book.id"
            :volumes="workbench.volumes"
            @open-chapter="selectChapter"
            @flash="flash"
          />
        </div>
      </template>

      <template v-else-if="!activeChapter">
        <!-- 占位：没有章节时的引导 -->
        <div class="empty-state">
          <div class="icon">✍️</div>
          <h2>{{ t('选择或新建一章') }}</h2>
          <p>{{ t('每一章都经过门禁检查与事实源审计，由你定稿。') }}</p>
          <div class="empty-actions">
            <button class="primary" @click="showNewChapter = true">{{ t('+ 新建章节') }}</button>
            <button @click="showImport = true">{{ t('导入旧稿') }}</button>
            <button @click="activeTab = 'facts'">{{ t('事实源') }}</button>
            <button @click="activeTab = 'search'">{{ t('检索') }}</button>
          </div>
        </div>
      </template>

      <template v-else>
        <header class="content-header">
          <div>
            <h1>{{ activeChapter.title }}</h1>
            <div class="header-meta">
              <span class="badge muted">{{ t('第 {n} 章', { n: activeChapter.ordinal }) }}</span>
              <span class="badge" :class="statusBadgeClass(activeChapter.status)">
                {{ statusLabel(activeChapter.status) }}
              </span>
              <span v-if="activeChapter.strand" class="badge info">{{ strandLabel(activeChapter.strand) }}</span>
              <span v-if="activeChapter.targetWords" class="badge muted">
                {{ t('目标 {n} 字', { n: activeChapter.targetWords }) }}
              </span>
            </div>
          </div>
          <div class="header-actions">
            <button @click="showChapterSettings = true">{{ t('章节设置') }}</button>
            <button @click="runChecks" :disabled="busy">{{ t('▶ 检查本章') }}</button>
          </div>
        </header>

        <nav class="tabs">
          <button :class="{ active: activeTab === 'editor' }" @click="activeTab = 'editor'">
            {{ t('正文与章纲') }}
          </button>
          <button :class="{ active: activeTab === 'checks' }" @click="activeTab = 'checks'">
            {{ t('检查报告') }}
            <span v-if="gate && !gate.passed" class="tab-alert">!</span>
          </button>
          <button :class="{ active: activeTab === 'facts' }" @click="activeTab = 'facts'">{{ t('事实源') }}</button>
          <button :class="{ active: isSearchTab }" @click="activeTab = 'search'">{{ t('全书检索') }}</button>
        </nav>

        <div class="tab-content">
          <div v-if="activeTab === 'editor' && !activeChapterFull" class="editor-placeholder">
            <div class="icon">{{ contentLoading ? '⏳' : '📄' }}</div>
            <h3>{{ contentLoading ? t('正在加载正文…') : t('正文尚未载入') }}</h3>
            <p v-if="!contentLoading">{{ t('可以重试加载，也可以先看检查报告与事实源。') }}</p>
            <button class="primary" @click="ensureContent(activeChapterId, true)">{{ t('重新加载') }}</button>
          </div>
          <ChapterEditor
            v-else-if="activeTab === 'editor'"
            :key="activeChapter.id"
            :chapter="activeChapterFull!"
            :characters="workbench.characters"
            :foreshadows="workbench.foreshadows"
            :chapter-tasks="workbench.chapterTasks"
            @saved="onChapterSaved"
            @dirty="editorDirty = $event"
            @flash="flash"
          />
          <ChecksPanel
            v-else-if="activeTab === 'checks'"
            :gate="gate"
            :audit="audit"
            :llm-audit="llmAudit"
            :llm-busy="llmBusy"
            @run-llm="runAiAudit"
            @flash="flash"
          />
          <FactsPanel
            v-else
            :workbench="workbench"
            :chapter-id="activeChapterId"
            @flash="flash"
            @refresh="refreshWorkbench"
          />
        </div>
      </template>
    </main>

    <div v-if="showNewBook" class="modal-backdrop" @click.self="showNewBook = false">
      <div class="modal">
        <h3>{{ t('新建作品') }}</h3>
        <label>{{ t('作品名称') }}</label>
        <input v-model="newBookTitle" :placeholder="t('例如：雾港灯塔')" @keyup.enter="createBook" />
        <select v-model="newBookGenre" class="new-book-genre">
          <option value="">{{ t('题材（可选，决定门禁与审计侧重）') }}</option>
          <option v-for="genre in genres" :key="genre.id" :value="genre.id">
            {{ t(genre.name) }} · {{ t(genre.description) }}
          </option>
        </select>
        <label class="modal-check">
          <input v-model="importAfterCreate" type="checkbox" />
          {{ t('创建后导入旧稿（支持 Obsidian 仓库文件夹）') }}
        </label>
        <div class="modal-actions">
          <button @click="showNewBook = false">{{ t('取消') }}</button>
          <button class="primary" @click="createBook">{{ t('创建') }}</button>
        </div>
      </div>
    </div>

    <div v-if="showNewChapter" class="modal-backdrop" @click.self="showNewChapter = false">
      <div class="modal">
        <h3>{{ t('新建章节') }}</h3>
        <label>{{ t('章节标题') }}</label>
        <input v-model="newChapterTitle" :placeholder="t('留空则自动生成')" @keyup.enter="createChapter" />
        <p v-if="activeChapter?.volumeId" class="modal-hint">
          {{ t('新章将归入当前章节所属的卷。') }}
        </p>
        <div class="modal-actions">
          <button @click="showNewChapter = false">{{ t('取消') }}</button>
          <button class="primary" @click="createChapter">{{ t('创建') }}</button>
        </div>
      </div>
    </div>

    <BookSettingsDialog
      v-if="showBookSettings && workbench"
      :book="workbench.book"
      :genres="genres"
      @close="showBookSettings = false"
      @refresh="refreshWorkbench"
      @flash="flash"
      @deleted="afterBookDeleted"
    />

    <ImportDialog
      v-if="showImport && workbench"
      :book-id="workbench.book.id"
      :volumes="workbench.volumes"
      :initial-path="droppedPath"
      @close="showImport = false; droppedPath = null"
      @imported="refreshWorkbench"
      @flash="flash"
    />

    <ChapterSettingsDialog
      v-if="showChapterSettings && activeChapter && workbench"
      :chapter="activeChapter"
      :volumes="workbench.volumes"
      @close="showChapterSettings = false"
      @saved="refreshWorkbench"
      @deleted="refreshWorkbench"
      @flash="flash"
    />

    <div v-if="dragging" class="drop-hint">{{ t('松开即可导入 txt / md 旧稿') }}</div>

    <div v-if="toast" class="toast">{{ toast }}</div>
    <div v-if="busy" class="busy-overlay">{{ t('处理中…') }}</div>
  </div>
</template>

<style scoped>
.app-shell { display: flex; height: 100vh; overflow: hidden; }
.sidebar {
  width: 260px; flex-shrink: 0; background: #fff; border-right: 1px solid var(--border);
  display: flex; flex-direction: column; padding: 16px 12px; gap: 10px;
}
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 6px 14px; }
.brand-mark { font-size: 26px; color: var(--accent); }
.brand-name { font-weight: 700; font-size: 16px; }
.brand-sub { font-size: 11px; color: var(--text-muted); }
.side-section-title {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; color: var(--text-muted); font-weight: 600; padding: 6px;
  text-transform: uppercase; letter-spacing: 0.5px;
}
.side-back { text-align: left; border: none; background: none; color: var(--text-muted); padding: 4px 6px; }
.side-book-title { display: flex; align-items: center; gap: 6px; padding: 0 6px; font-weight: 600; font-size: 14px; }
.side-book-title > span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon-btn { border: none; background: none; padding: 2px 4px; color: var(--text-muted); border-radius: 4px; }
.icon-btn:hover { background: var(--accent-soft); color: var(--accent); }
.side-actions { display: flex; flex-direction: column; gap: 6px; }
.export-row { display: flex; gap: 6px; }
.export-row button { flex: 1; }
button.subtle { font-size: 11px; opacity: .82; }
.full { width: 100%; }
.book-list, .chapter-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
.book-item, .chapter-item {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  border: none; background: transparent; padding: 9px 10px; border-radius: 6px;
}
/* 千章规模下让浏览器跳过视口外的布局计算 */
.chapter-item { content-visibility: auto; contain-intrinsic-size: auto 34px; }
.book-item:hover, .chapter-item:hover { background: var(--accent-soft); color: var(--accent); border: none; }
.chapter-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.book-icon { font-size: 15px; }
.book-title, .chapter-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chapter-no { font-size: 11px; color: var(--text-muted); min-width: 22px; }
.chapter-words { font-size: 10px; color: var(--text-muted); opacity: .7; }
.chapter-status { font-size: 10px; color: var(--text-muted); }
.chapter-status.final { color: var(--success); }
.group-title {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 10px; color: var(--text-muted); padding: 10px 8px 4px; text-transform: uppercase; letter-spacing: .4px;
  cursor: pointer; user-select: none;
}
.group-title:hover { color: var(--accent); }
.group-arrow { width: 10px; flex-shrink: 0; }
.group-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chapter-item.dragging { opacity: .45; }
.chapter-item.drop-target {
  box-shadow: inset 0 2px 0 var(--accent);
  background: var(--accent-soft);
}
.group-count { background: var(--accent-soft); color: var(--accent); border-radius: 8px; padding: 0 6px; font-size: 10px; }
.side-empty { padding: 20px 8px; text-align: center; color: var(--text-muted); font-size: 12px; }
.side-footer { border-top: 1px solid var(--border); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.side-footer button { width: 100%; }
.lang-switch { font-size: 11px; color: var(--text-muted); }

.main-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.shelf-area { flex: 1; overflow-y: auto; padding: 24px 28px; }
.shelf-grid {
  display: grid; gap: 20px;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
}
.shelf-card {
  display: flex; flex-direction: column; padding: 0; border: 1px solid var(--border);
  border-radius: 10px; background: var(--panel); overflow: hidden; text-align: left;
  box-shadow: var(--shadow); transition: transform .12s ease, box-shadow .12s ease;
}
.shelf-card:hover {
  transform: translateY(-3px); box-shadow: 0 10px 24px rgba(16,24,40,.12);
  border-color: var(--border); background: var(--panel); color: var(--text);
}
.shelf-cover {
  position: relative; height: 180px; padding: 16px 14px; display: flex; flex-direction: column;
  justify-content: center; color: #fff; overflow: hidden;
}
/* 封面上的斜向高光，避免纯色块显得死板 */
.shelf-cover::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(120deg, rgba(255,255,255,.18) 0%, rgba(255,255,255,0) 42%);
  pointer-events: none;
}
.cover-title {
  font-size: 17px; font-weight: 700; line-height: 1.55; letter-spacing: 1px;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  text-shadow: 0 1px 8px rgba(0,0,0,.28); position: relative; z-index: 1;
}
.cover-foot {
  position: absolute; left: 14px; bottom: 14px; font-size: 11px; opacity: .85; z-index: 1;
}
.cover-badge {
  position: absolute; top: 12px; right: 12px; z-index: 1;
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: rgba(255,255,255,.24); backdrop-filter: blur(2px);
}
.shelf-meta { flex: 1; padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 4px; }
.shelf-book-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shelf-sub { font-size: 11px; color: var(--text-muted); }
.shelf-genre {
  display: inline-block;
  padding: 1px 6px;
  margin-right: 4px;
  border-radius: 3px;
  background: var(--surface-2, rgba(0, 0, 0, .06));
  color: var(--info, #2563eb);
  font-weight: 600;
}
.shelf-outline {
  font-size: 11px; color: var(--text-muted); line-height: 1.6; margin-top: 2px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.shelf-foot { display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--text-muted); margin-top: auto; padding-top: 6px; }
.shelf-open { color: var(--accent); opacity: 0; transition: opacity .12s ease; }
.shelf-card:hover .shelf-open { opacity: 1; }
.shelf-new { align-items: center; justify-content: center; min-height: 268px; border-style: dashed; color: var(--text-muted); }
.shelf-new-inner { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.shelf-new .plus { font-size: 26px; line-height: 1; }
.shelf-search { width: 200px; }.shelf-area .empty-state { min-height: 420px; }
.content-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 18px 28px; background: #fff; border-bottom: 1px solid var(--border);
}
.content-header h1 { margin: 0 0 8px; font-size: 20px; }
.header-meta { display: flex; gap: 6px; flex-wrap: wrap; }
.header-actions { display: flex; gap: 8px; }
.lang-toggle { min-width: 46px; font-size: 12px; }
.tabs { display: flex; gap: 2px; padding: 0 28px; background: #fff; border-bottom: 1px solid var(--border); }
.tabs button {
  border: none; border-bottom: 2px solid transparent; background: none; border-radius: 0;
  padding: 12px 16px; color: var(--text-muted);
}
.tabs button:hover { background: none; color: var(--accent); }
.tabs button.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.tab-alert { display: inline-block; background: var(--error); color: #fff; border-radius: 50%; width: 15px; height: 15px; line-height: 15px; font-size: 10px; margin-left: 4px; }
.tab-content { flex: 1; overflow: hidden; padding: 20px 28px; display: flex; flex-direction: column; }
.empty-actions { display: flex; gap: 8px; justify-content: center; margin-top: 8px; }
.editor-placeholder { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-muted); }
.editor-placeholder .icon { font-size: 34px; }
.editor-placeholder h3 { margin: 0; font-size: 15px; color: var(--text); }
.editor-placeholder p { margin: 0; font-size: 12px; }

.modal-backdrop { position: fixed; inset: 0; background: rgba(16,24,40,.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: #fff; border-radius: 10px; padding: 24px; width: 380px; box-shadow: 0 20px 40px rgba(0,0,0,.15); }
.modal h3 { margin: 0 0 18px; font-size: 16px; }
.modal label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
.modal input { width: 100%; }
.modal-hint { font-size: 11px; color: var(--text-muted); margin: 10px 0 0; }
.modal-check { display: flex; align-items: center; gap: 6px; margin-top: 12px; font-size: 12px; color: var(--text-muted); }
.new-book-genre { width: 100%; margin-top: 10px; }
.modal-check input { width: auto; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.drop-hint {
  position: fixed; inset: 16px; display: flex; align-items: center; justify-content: center;
  border: 2px dashed var(--accent); border-radius: 12px; background: rgba(37,99,235,.06);
  color: var(--accent); font-size: 15px; font-weight: 600; z-index: 180; pointer-events: none;
}
.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #1f2329; color: #fff; padding: 10px 20px; border-radius: 6px; z-index: 200; font-size: 13px; }
.busy-overlay { position: fixed; inset: 0; background: rgba(255,255,255,.6); display: flex; align-items: center; justify-content: center; z-index: 150; font-size: 15px; color: var(--text-muted); }
</style>
