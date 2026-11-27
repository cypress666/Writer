/**
 * Electron 主进程。
 *
 * 职责边界：持有核心层实例、管理作品数据库连接、处理 IPC。
 * 不实现任何创作逻辑——门禁、审计、事实源裁决全部复用 src/ 下的核心机制层。
 *
 * 存储采用单库 + book_id 过滤（与 Pagekin 一致）：百万字级 SQLite 单库完全够用，
 * 避免多库带来的跨库反查与作品元数据不一致问题。
 */

// 主进程以 CJS 输出（package.json type=commonjs），Electron 内置模块直接 require
import type { BrowserWindow as BrowserWindowType, IpcMain, App, Dialog } from 'electron';
const electron = require('electron') as {
  app: App;
  BrowserWindow: typeof BrowserWindowType;
  ipcMain: IpcMain;
  safeStorage: SafeStorageLike;
  dialog: Dialog;
  shell: {
    openPath(path: string): Promise<string>;
    showItemInFolder(path: string): void;
    openExternal(url: string): Promise<void>;
  };
};
const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell } = electron;
import { join, basename, resolve } from 'node:path';
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import type {
  Book,
  BookSummary,
  Chapter,
  ChapterStatus,
  Character,
  Foreshadow,
  GateReport,
  AuditReport,
  Volume,
  WorldRule,
  TimelineEvent,
  Resource,
  GenreTemplate,
} from '../src/index.js';
import {
  AuditEngine,
  BookRepository,
  FactSourceRepository,
  GateEngine,
  SnapshotRepository,
  HybridSearch,
  GENRE_TEMPLATES,
  findGenre,
  genreProfile,
  parseManuscript,
  parseVault as parseVaultFolder,
  assembleContext,
  openDatabase,
} from '../src/index.js';
import { AiClient } from '../src/ai/client.js';
import { AiConfigStore } from '../src/ai/config.js';
import { applyDecisions, diffParagraphs } from '../src/ai/diff.js';
import { SecretStore, type SafeStorageLike } from '../src/ai/secret-store.js';
import { AiService } from '../src/ai/service.js';
import type {
  ApiResult,
  AiConfigSnapshot,
  AiStreamEvent,
  AiWritingResult,
  ApplyWritingDiffPayload,
  CreateBookPayload,
  CreateChapterPayload,
  ExportMarkdownPayload,
  ExportMarkdownResult,
  CreateCharacterPayload,
  CreateForeshadowPayload,
  CreateSnapshotPayload,
  GenerateWritingPayload,
  PreviewSnapshotRestorePayload,
  PreviewWritingDiffPayload,
  RemoveAiModelPayload,
  SnapshotRestorePreview,
  RestoreSnapshotPayload,
  RunChecksPayload,
  RunLlmAuditPayload,
  SaveAiModelPayload,
  SaveChapterPayload,
  SetAiDefaultPayload,
  TestAiModelPayload,
  UpdateAiRuntimePayload,
  WorkbenchData,
  UpdateBookPayload,
  DeleteBookPayload,
  CreateVolumePayload,
  UpdateVolumePayload,
  DeleteVolumePayload,
  DeleteChapterPayload,
  ReorderChaptersPayload,
  UpdateChapterSpecPayload,
  UpdateCharacterPayload,
  DeleteCharacterPayload,
  UpdateForeshadowPayload,
  ForeshadowActionPayload,
  DeleteForeshadowPayload,
  CreateWorldRulePayload,
  UpdateWorldRulePayload,
  DeleteWorldRulePayload,
  CreateTimelineEventPayload,
  UpdateTimelineEventPayload,
  DeleteTimelineEventPayload,
  CreateResourcePayload,
  UpdateResourcePayload,
  DeleteResourcePayload,
  ApplyGenrePayload,
  ApplyGenreResult,
  SearchChaptersPayload,
  SearchChaptersResult,
  IndexEmbeddingsPayload,
  IndexEmbeddingsResult,
  PickManuscriptResult,
  PreviewManuscriptResult,
  CommitManuscriptPayload,
  CommitManuscriptResult,
  SuggestOutlinePayload,
  SuggestOutlineResult,
  VaultParseResult,
  ExtractFactsPayload,
  ExtractFactsResult,
} from '../src/shared/ipc-contract.js';
import type { LlmAuditResult } from '../src/ai/types.js';
import { diffStates } from '../src/db/snapshot-repository.js';
import { findConflictParagraphs } from '../src/db/snapshot-preview.js';
import { renderBookMarkdown, renderBookReadable } from '../src/projection/markdown.js';
import { buildAppMenu, defaultMenuLocale } from './menu.js';
import type { MenuAction } from '../src/shared/ipc-contract.js';

interface Core {
  db: ReturnType<typeof openDatabase>;
  books: BookRepository;
  facts: FactSourceRepository;
  snapshots: SnapshotRepository;
  search: HybridSearch;
  aiConfig: AiConfigStore;
  secrets: SecretStore;
}

let core: Core | null = null;
let mainWindow: BrowserWindowType | null = null;
let activeWriting: { chapterId: string; controller: AbortController } | null = null;

// 巡检/便携模式：允许把整个用户数据目录指到临时位置，避免污染真实书库
const userDataOverride = process.env['INKFORGE_USER_DATA_DIR'];
if (userDataOverride) app.setPath('userData', userDataOverride);

function dataDir(): string {
  const dir = join(app.getPath('userData'), 'workbench');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** safeStorage 在部分 Linux 环境不可用；封装后由 SecretStore 明确拒绝明文保存 */
function aiStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () =>
      typeof safeStorage?.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => {
      if (!safeStorage?.isEncryptionAvailable()) throw new Error('系统加密不可用');
      return safeStorage.encryptString(plain);
    },
    decryptString: (cipher) => {
      if (!safeStorage?.isEncryptionAvailable()) throw new Error('系统加密不可用');
      return safeStorage.decryptString(cipher);
    },
  };
}

function getCore(): Core {
  if (!core) {
    const dir = dataDir();
    const db = openDatabase(join(dir, 'inkforge.db'));
    const facts = new FactSourceRepository(db);
    const books = new BookRepository(db);
    const search = new HybridSearch(db);
    // 旧库升级或首次启动时补建全文索引；已有索引则跳过，避免百万字重复扫描
    for (const book of books.listAllBooks()) {
      const chapters = books.listChapters(book.id);
      const indexed = db
        .prepare('SELECT COUNT(*) AS count FROM chapter_fts WHERE book_id = ?')
        .get(book.id) as { count: number };
      if (Number(indexed.count) === 0 && chapters.length > 0) search.reindexBook(chapters);
    }
    core = {
      db,
      books,
      facts,
      // snapshots 必须复用同一个 facts 实例，否则回退写的是另一个连接
      snapshots: new SnapshotRepository(db, facts),
      search,
      aiConfig: new AiConfigStore(join(dir, 'ai-config.json')),
      secrets: new SecretStore({ filePath: join(dir, 'credentials.json'), storage: aiStorage() }),
    };
  }
  return core;
}

/** 每次调用重新读取配置，设置页保存后无需重启进程 */
function getAi(): { config: ReturnType<AiConfigStore['load']>; client: AiClient; service: AiService } {
  const { aiConfig, secrets } = getCore();
  const config = aiConfig.load();
  const client = new AiClient({ config, resolveKey: (id) => secrets.reveal(id) });
  return { config, client, service: new AiService(client) };
}

/** 本章最小上下文：事实源 + 按章状态 + 按需装配，绝不拼全书正文 */
function chapterContext(chapter: Chapter, facts: FactSourceRepository) {
  const state = facts.loadState(chapter.bookId);
  const assembled = assembleContext({
    spec: {
      ordinal: chapter.ordinal,
      title: chapter.title,
      outline: chapter.outline,
      characterIds: chapter.declaredCharacters,
      locations: chapter.declaredLocations,
      foreshadows: chapter.declaredForeshadows,
      emotionTags: chapter.emotionTags,
      hookType: chapter.hookType,
      strand: chapter.strand,
    },
    characters: state.characters,
    characterStates: state.characterStates,
    worldRules: state.worldRules,
    foreshadows: state.foreshadows,
    timelineEvents: state.timelineEvents,
    stateAt: (id, ordinal) => facts.stateAt(id, ordinal),
  });
  return { state, assembled };
}

function emitAiEvent(event: AiStreamEvent): void {
  mainWindow?.webContents.send('ai:event', event);
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'untitled';
}

/** 题材模板只补充缺失规则，重复应用不会产生重复条目 */
/**
 * 抽样章节：保留开头几章（建立世界观与主角）＋ 其余均匀抽样。
 * 旧稿可能上千章，不能整本塞进上下文。
 */
/** 稿件文本 → 章节预览；无标题长文按 3000 字切章，避免整本聚成单章 */
function previewFromText(text: string, fileName: string): PreviewManuscriptResult {
  if (!text.trim()) throw new Error('稿件内容为空');
  const fallback = fileName.replace(/\.(txt|md|markdown)$/i, '') || '导入章节';
  const chapters = parseManuscript(text, fallback, { targetChars: 3000 });
  if (chapters.length === 0) throw new Error('未解析到任何章节内容');
  return {
    fileName,
    chapters,
    totalWords: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
  };
}

function sampleChapters(chapters: Chapter[], maxChapters: number): Chapter[] {
  if (chapters.length <= maxChapters) return chapters;
  const head = Math.min(3, maxChapters);
  const headChapters = chapters.slice(0, head);
  const rest = chapters.slice(head);
  const slots = maxChapters - head;
  if (slots <= 0) return headChapters;
  const step = rest.length / slots;
  const picked: Chapter[] = [...headChapters];
  for (let index = 0; index < slots; index += 1) {
    const chapter = rest[Math.min(rest.length - 1, Math.floor(index * step))];
    if (chapter && !picked.includes(chapter)) picked.push(chapter);
  }
  return picked;
}

function applyGenreRules(bookId: string, genreId: string): ApplyGenreResult {
  const genre = findGenre(genreId);
  if (!genre) throw new Error(`未知题材: ${genreId}`);
  const { books, facts } = getCore();
  // 记到书上：门禁/审计要靠它决定侧重，否则规则写进去了也不会生效
  books.setGenre(bookId, genre.id);
  const existing = new Set(facts.listWorldRules(bookId).map((rule) => `${rule.category}\u0000${rule.rule}`));
  let createdRules = 0;
  for (const rule of genre.rules) {
    if (existing.has(`${rule.category}\u0000${rule.rule}`)) continue;
    facts.createWorldRule({ bookId, category: rule.category, rule: rule.rule, priority: rule.priority });
    createdRules += 1;
  }
  return { genre: genre as GenreTemplate, createdRules };
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function fail<T>(error: unknown): ApiResult<T> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function handle<T>(fn: () => T): ApiResult<T> {
  try {
    return ok(fn());
  } catch (error) {
    return fail<T>(error);
  }
}

async function handleAsync<T>(fn: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    return fail<T>(error);
  }
}

/** 菜单项需要的能力由主进程注入，menu.ts 本身不直接碰窗口与文件系统 */
function menuHost() {
  return {
    sendAction(action: MenuAction) {
      mainWindow?.webContents.send('menu:action', action);
    },
    openDataDir() {
      void shell.openPath(dataDir());
    },
    openUsageGuide() {
      // 开发时读仓库里的文档；打包后没有 docs 目录就回落到 GitHub 页面
      const candidates = [
        resolve(app.getAppPath(), 'docs', 'USAGE.md'),
        resolve(process.cwd(), 'docs', 'USAGE.md'),
        resolve(app.getAppPath(), 'README.md'),
      ];
      const local = candidates.find((file) => existsSync(file));
      if (local) void shell.openPath(local);
      else void shell.openExternal('https://github.com/cypress666/Writer/blob/main/docs/USAGE.md');
    },
    getWindow() {
      return mainWindow;
    },
  };
}

function createWindow(): void {  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#f7f8fa',
    webPreferences: {
      // 构建产物：out/main/main.js 与 out/preload/preload.js 同级目录
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // 渲染层日志：烟测据此判断模板运行时错误，避免只测到主进程就绪
  mainWindow.webContents.on('console-message', (...args: unknown[]) => {
    const details = args[1] as { level?: string; message?: string } | number | undefined;
    const message =
      typeof details === 'object' && details ? (details.message ?? '') : String(args[2] ?? '');
    const rawLevel = typeof details === 'object' && details ? details.level : details;
    const level =
      rawLevel === 'error' || rawLevel === 3
        ? 'error'
        : rawLevel === 'warning' || rawLevel === 2
          ? 'warning'
          : 'info';
    if (process.env['INKFORGE_LOG_RENDERER'] === '1') {
      console.log(`[renderer:${level}] ${message}`);
    }
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    console.log(`[renderer:error] 页面加载失败 ${code} ${description}`);
  });

  if (process.env['VITE_DEV_SERVER_URL']) {
    void mainWindow.loadURL(process.env['VITE_DEV_SERVER_URL']);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle('api:setLocale', (_event, payload: { locale: 'zh' | 'en' }) =>
    handle<boolean>(() => {
      // 界面语言变了，原生菜单必须跟着重建，否则顶栏文案和界面不一致
      buildAppMenu(payload.locale === 'en' ? 'en' : 'zh', menuHost());
      return true;
    }),
  );

  ipcMain.handle('api:listBooks', () => handle<BookSummary[]>(() => getCore().books.listBookSummaries()));

  ipcMain.handle('api:createBook', (_event, payload: CreateBookPayload) =>
    handle<Book>(() => {
      const { books } = getCore();
      let book = books.createBook({
        title: payload.title,
        outline: payload.outline ?? '',
        genreId: payload.genreId ?? null,
      });
      if (payload.genreId) {
        applyGenreRules(book.id, payload.genreId);
        book = books.getBook(book.id) ?? book;
      }
      return book;
    }),
  );

  ipcMain.handle('api:updateBook', (_event, payload: UpdateBookPayload) =>
    handle<Book>(() => {
      const { books } = getCore();
      let book = books.getBook(payload.bookId);
      if (!book) throw new Error(`作品不存在: ${payload.bookId}`);
      if (payload.genreId !== undefined) book = books.setGenre(payload.bookId, payload.genreId || null);
      if (payload.title !== undefined) book = books.renameBook(payload.bookId, payload.title);
      if (payload.outline !== undefined) book = books.updateBookOutline(payload.bookId, payload.outline);
      return book;
    }),
  );

  ipcMain.handle('api:deleteBook', (_event, payload: DeleteBookPayload) =>
    handle<boolean>(() => {
      getCore().books.deleteBook(payload.bookId);
      return true;
    }),
  );

  ipcMain.handle('api:getWorkbench', (_event, bookId: string) =>
    handle<WorkbenchData>(() => {
      const { books, facts, snapshots } = getCore();
      const book = books.getBook(bookId);
      if (!book) throw new Error(`作品不存在: ${bookId}`);

      // 只带摘要：百万字作品的正文按需由 getChapterContent 拉取
      const chapters = books.listChapterSummaries(bookId);
      const state = facts.loadState(bookId);
      const lastSummary = chapters[chapters.length - 1] ?? null;
      const lastChapter = lastSummary ? books.getChapter(lastSummary.id) : null;
      const chapterTasks = lastChapter ? chapterContext(lastChapter, facts).assembled.chapterTasks : [];

      return {
        book,
        volumes: books.listVolumes(bookId),
        chapters,
        chapterWordCounts: books.chapterWordCounts(bookId),
        characters: state.characters,
        characterStates: state.characterStates,
        foreshadows: state.foreshadows,
        resources: state.resources,
        timelineEvents: state.timelineEvents,
        worldRules: state.worldRules,
        snapshots: snapshots.listViews(bookId),
        receipts: state.receipts.map((receipt) => ({
          id: receipt.id,
          chapterId: receipt.chapterId,
          chapterOrdinal: receipt.chapterOrdinal,
          contentHash: receipt.contentHash,
          finalizedAt: receipt.finalizedAt,
          supersededBy: receipt.supersededBy,
        })),
        lastGate: null,
        lastAudit: null,
        chapterTasks,
      };
    }),
  );

  ipcMain.handle('api:getChapterContent', (_event, payload: { chapterId: string }) =>
    handle<string>(() => getCore().books.getChapterContent(payload.chapterId)),
  );

  ipcMain.handle('api:createChapter', (_event, payload: CreateChapterPayload) =>
    handle<Chapter>(() =>
      getCore().books.createChapter({
        bookId: payload.bookId,
        ordinal: payload.ordinal,
        title: payload.title,
        volumeId: payload.volumeId ?? null,
        outline: payload.outline ?? '',
        targetWords: payload.targetWords ?? null,
        strand: payload.strand ?? null,
        declaredCharacters: payload.declaredCharacters ?? [],
        declaredLocations: payload.declaredLocations ?? [],
        declaredForeshadows: payload.declaredForeshadows ?? [],
        emotionTags: payload.emotionTags ?? [],
        hookType: payload.hookType ?? null,
      }),
    ),
  );

  ipcMain.handle('api:deleteChapter', (_event, payload: DeleteChapterPayload) =>
    handle<boolean>(() => {
      getCore().books.deleteChapter(payload.chapterId);
      return true;
    }),
  );

  ipcMain.handle('api:reorderChapters', (_event, payload: ReorderChaptersPayload) =>
    handle<Chapter[]>(() =>
      getCore().books.reorderChapters(payload.bookId, payload.orderedChapterIds),
    ),
  );

  ipcMain.handle('api:updateChapterSpec', (_event, payload: UpdateChapterSpecPayload) =>
    handle<Chapter>(() => {
      const { books, search } = getCore();
      const chapter = books.getChapter(payload.chapterId);
      if (!chapter) throw new Error(`章节不存在: ${payload.chapterId}`);
      const updated = books.updateChapterSpec(payload.chapterId, {
        title: payload.spec.title,
        volumeId: payload.spec.volumeId === undefined ? chapter.volumeId : payload.spec.volumeId,
        outline: payload.spec.outline === undefined ? chapter.outline : payload.spec.outline,
        declaredCharacters: payload.spec.declaredCharacters ?? chapter.declaredCharacters,
        declaredLocations: payload.spec.declaredLocations ?? chapter.declaredLocations,
        declaredForeshadows: payload.spec.declaredForeshadows ?? chapter.declaredForeshadows,
        emotionTags: payload.spec.emotionTags ?? chapter.emotionTags,
        hookType: payload.spec.hookType === undefined ? chapter.hookType : payload.spec.hookType,
        strand: payload.spec.strand === undefined ? chapter.strand : payload.spec.strand,
        targetWords: payload.spec.targetWords === undefined ? chapter.targetWords : payload.spec.targetWords,
      });
      search.indexChapter(updated);
      return updated;
    }),
  );

  ipcMain.handle('api:createVolume', (_event, payload: CreateVolumePayload) =>
    handle<Volume>(() => {
      const { books } = getCore();
      const volumes = books.listVolumes(payload.bookId);
      return books.createVolume({
        bookId: payload.bookId,
        title: payload.title,
        outline: payload.outline ?? '',
        ordinal: payload.ordinal ?? (volumes.at(-1)?.ordinal ?? 0) + 1,
      });
    }),
  );

  ipcMain.handle('api:updateVolume', (_event, payload: UpdateVolumePayload) =>
    handle<Volume>(() =>
      getCore().books.updateVolume(payload.volumeId, {
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.outline !== undefined ? { outline: payload.outline } : {}),
        ...(payload.ordinal !== undefined ? { ordinal: payload.ordinal } : {}),
      }),
    ),
  );

  ipcMain.handle('api:deleteVolume', (_event, payload: DeleteVolumePayload) =>
    handle<boolean>(() => {
      getCore().books.deleteVolume(payload.volumeId);
      return true;
    }),
  );

  ipcMain.handle('api:saveChapter', (_event, payload: SaveChapterPayload) =>
    handle<Chapter>(() => {
      const { books, search } = getCore();
      let chapter = books.updateChapterContent(
        payload.chapterId,
        payload.content,
        payload.status as ChapterStatus | undefined,
      );
      if (payload.spec) {
        chapter = books.updateChapterSpec(payload.chapterId, {
          title: payload.spec.title,
          volumeId: payload.spec.volumeId === undefined ? chapter.volumeId : payload.spec.volumeId,
          outline: payload.spec.outline === undefined ? chapter.outline : payload.spec.outline,
          declaredCharacters: payload.spec.declaredCharacters ?? chapter.declaredCharacters,
          declaredLocations: payload.spec.declaredLocations ?? chapter.declaredLocations,
          declaredForeshadows: payload.spec.declaredForeshadows ?? chapter.declaredForeshadows,
          emotionTags: payload.spec.emotionTags ?? chapter.emotionTags,
          hookType: payload.spec.hookType === undefined ? chapter.hookType : payload.spec.hookType,
          strand: payload.spec.strand === undefined ? chapter.strand : payload.spec.strand,
          targetWords: payload.spec.targetWords === undefined ? chapter.targetWords : payload.spec.targetWords,
        });
      }
      search.indexChapter(chapter);
      return chapter;
    }),
  );

  ipcMain.handle('api:runChecks', (_event, payload: RunChecksPayload) =>
    handle<{ gate: GateReport; audit: AuditReport }>(() => {
      const { books, facts } = getCore();
      const chapter = books.getChapter(payload.chapterId);
      if (!chapter) throw new Error(`章节不存在: ${payload.chapterId}`);
      const chapters = books.listChapters(chapter.bookId);
      const previous = chapters.filter((c) => c.ordinal < chapter.ordinal);
      const state = facts.loadState(chapter.bookId);
      // 题材决定门禁/审计的严格度侧重（例如悬疑把伏笔逾期提到阻断级）
      const genre = genreProfile(books.getBook(chapter.bookId)?.genreId);
      const findings =
        new GateEngine().run(
          { chapter, previousChapters: previous, foreshadows: state.foreshadows },
          genre,
        );
      const issues = new AuditEngine().audit(
        { chapter, facts: state, previousChapters: previous },
        genre,
      );
      return { gate: findings, audit: issues };
    }),
  );

  ipcMain.handle('api:createCharacter', (_event, payload: CreateCharacterPayload) =>
    handle<Character>(() =>
      getCore().facts.createCharacter({
        bookId: payload.bookId,
        name: payload.name,
        aliases: payload.aliases ?? [],
        notes: payload.notes ?? '',
        initialState: {
          location: payload.initialLocation ?? null,
          abilities: payload.abilities ?? [],
          knownFacts: payload.knownFacts ?? [],
        },
      }),
    ),
  );

  ipcMain.handle('api:updateCharacter', (_event, payload: UpdateCharacterPayload) =>
    handle<Character>(() => {
      const { facts } = getCore();
      if (payload.name !== undefined || payload.aliases !== undefined || payload.notes !== undefined) {
        facts.updateCharacter(payload.characterId, {
          ...(payload.name !== undefined ? { name: payload.name } : {}),
          ...(payload.aliases !== undefined ? { aliases: payload.aliases } : {}),
          ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
        });
      }
      if (payload.location !== undefined || payload.abilities !== undefined || payload.knownFacts !== undefined) {
        const character = facts.getCharacter(payload.characterId);
        if (!character) throw new Error(`角色不存在: ${payload.characterId}`);
        facts.updateCharacterState(
          character.bookId,
          payload.characterId,
          {
            ...(payload.location !== undefined ? { location: payload.location } : {}),
            ...(payload.abilities !== undefined ? { abilities: payload.abilities } : {}),
            ...(payload.knownFacts !== undefined ? { knownFacts: payload.knownFacts } : {}),
          },
          payload.chapterId ?? null,
        );
      }
      if (payload.isAlive !== undefined) {
        const character = facts.getCharacter(payload.characterId);
        if (!character) throw new Error(`角色不存在: ${payload.characterId}`);
        if (character.isAlive !== payload.isAlive) {
          facts.setCharacterAlive(character.bookId, payload.characterId, payload.isAlive, payload.chapterId ?? null);
        }
      }
      const updated = facts.getCharacter(payload.characterId);
      if (!updated) throw new Error(`角色不存在: ${payload.characterId}`);
      return updated;
    }),
  );

  ipcMain.handle('api:deleteCharacter', (_event, payload: DeleteCharacterPayload) =>
    handle<boolean>(() => {
      getCore().facts.deleteCharacter(payload.characterId);
      return true;
    }),
  );

  ipcMain.handle('api:createForeshadow', (_event, payload: CreateForeshadowPayload) =>
    handle<Foreshadow>(() =>
      getCore().facts.createForeshadow({
        bookId: payload.bookId,
        title: payload.title,
        kind: payload.kind,
        description: payload.description ?? '',
        plantedInChapterId: payload.plantedInChapterId ?? null,
        plannedResolveOrdinal: payload.plannedResolveOrdinal ?? null,
        resolutionMarkers: payload.resolutionMarkers ?? [],
      }),
    ),
  );

  ipcMain.handle('api:updateForeshadow', (_event, payload: UpdateForeshadowPayload) =>
    handle<Foreshadow>(() =>
      getCore().facts.updateForeshadow(payload.foreshadowId, {
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
        ...(payload.plantedInChapterId !== undefined ? { plantedInChapterId: payload.plantedInChapterId } : {}),
        ...(payload.plannedResolveOrdinal !== undefined
          ? { plannedResolveOrdinal: payload.plannedResolveOrdinal }
          : {}),
        ...(payload.resolutionMarkers !== undefined ? { resolutionMarkers: payload.resolutionMarkers } : {}),
        ...(payload.status !== undefined ? { status: payload.status } : {}),
      }),
    ),
  );

  ipcMain.handle('api:advanceForeshadow', (_event, payload: ForeshadowActionPayload) =>
    handle<Foreshadow>(() =>
      getCore().facts.markForeshadowAdvancing(payload.foreshadowId, payload.chapterId ?? ''),
    ),
  );

  ipcMain.handle('api:resolveForeshadow', (_event, payload: ForeshadowActionPayload) =>
    handle<Foreshadow>(() => {
      if (!payload.chapterId) throw new Error('回收伏笔必须指定章节');
      return getCore().facts.resolveForeshadow(payload.foreshadowId, payload.chapterId);
    }),
  );

  ipcMain.handle('api:abandonForeshadow', (_event, payload: ForeshadowActionPayload) =>
    handle<Foreshadow>(() => getCore().facts.abandonForeshadow(payload.foreshadowId)),
  );

  ipcMain.handle('api:deleteForeshadow', (_event, payload: DeleteForeshadowPayload) =>
    handle<boolean>(() => {
      getCore().facts.deleteForeshadow(payload.foreshadowId);
      return true;
    }),
  );

  ipcMain.handle('api:createWorldRule', (_event, payload: CreateWorldRulePayload) =>
    handle<WorldRule>(() =>
      getCore().facts.createWorldRule({
        bookId: payload.bookId,
        category: payload.category,
        rule: payload.rule,
        priority: payload.priority ?? 0,
      }),
    ),
  );

  ipcMain.handle('api:updateWorldRule', (_event, payload: UpdateWorldRulePayload) =>
    handle<WorldRule>(() =>
      getCore().facts.updateWorldRule(payload.ruleId, {
        ...(payload.category !== undefined ? { category: payload.category } : {}),
        ...(payload.rule !== undefined ? { rule: payload.rule } : {}),
        ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
      }),
    ),
  );

  ipcMain.handle('api:deleteWorldRule', (_event, payload: DeleteWorldRulePayload) =>
    handle<boolean>(() => {
      getCore().facts.deleteWorldRule(payload.ruleId);
      return true;
    }),
  );

  ipcMain.handle('api:createTimelineEvent', (_event, payload: CreateTimelineEventPayload) =>
    handle<TimelineEvent>(() =>
      getCore().facts.createTimelineEvent({
        bookId: payload.bookId,
        chapterId: payload.chapterId ?? null,
        storyTime: payload.storyTime,
        storyOrder: payload.storyOrder,
        description: payload.description,
      }),
    ),
  );

  ipcMain.handle('api:updateTimelineEvent', (_event, payload: UpdateTimelineEventPayload) =>
    handle<TimelineEvent>(() =>
      getCore().facts.updateTimelineEvent(payload.eventId, {
        ...(payload.chapterId !== undefined ? { chapterId: payload.chapterId } : {}),
        ...(payload.storyTime !== undefined ? { storyTime: payload.storyTime } : {}),
        ...(payload.storyOrder !== undefined ? { storyOrder: payload.storyOrder } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
      }),
    ),
  );

  ipcMain.handle('api:deleteTimelineEvent', (_event, payload: DeleteTimelineEventPayload) =>
    handle<boolean>(() => {
      getCore().facts.deleteTimelineEvent(payload.eventId);
      return true;
    }),
  );

  ipcMain.handle('api:createResource', (_event, payload: CreateResourcePayload) =>
    handle<Resource>(() =>
      getCore().facts.createResource({
        bookId: payload.bookId,
        name: payload.name,
        category: payload.category ?? '',
        holderCharacterId: payload.holderCharacterId ?? null,
        quantity: payload.quantity ?? 0,
        notes: payload.notes ?? '',
      }),
    ),
  );

  ipcMain.handle('api:updateResource', (_event, payload: UpdateResourcePayload) =>
    handle<Resource>(() =>
      getCore().facts.updateResource(
        payload.resourceId,
        {
          ...(payload.quantity !== undefined ? { quantity: payload.quantity } : {}),
          ...(payload.holderCharacterId !== undefined
            ? { holderCharacterId: payload.holderCharacterId }
            : {}),
          ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
        },
        payload.chapterId ?? null,
      ),
    ),
  );

  ipcMain.handle('api:deleteResource', (_event, payload: DeleteResourcePayload) =>
    handle<boolean>(() => {
      getCore().facts.deleteResource(payload.resourceId);
      return true;
    }),
  );

  ipcMain.handle('api:listGenres', () => handle<GenreTemplate[]>(() => GENRE_TEMPLATES));

  ipcMain.handle('api:applyGenre', (_event, payload: ApplyGenrePayload) =>
    handle<ApplyGenreResult>(() => applyGenreRules(payload.bookId, payload.genreId)),
  );

  ipcMain.handle('api:createSnapshot', (_event, payload: CreateSnapshotPayload) =>
    handle(() => {
      const { snapshots } = getCore();
      const snapshot = snapshots.create(payload.bookId, payload.label, payload.chapterId ?? null);
      return snapshots.listViews(payload.bookId).find((view) => view.id === snapshot.id)!;
    }),
  );

  ipcMain.handle('api:previewSnapshotRestore', (_event, payload: PreviewSnapshotRestorePayload) =>
    handle<SnapshotRestorePreview>(() => {
      const { books, facts, snapshots } = getCore();
      const snapshot = snapshots.get(payload.snapshotId);
      if (!snapshot) throw new Error(`找不到快照: ${payload.snapshotId}`);
      const current = facts.loadState(snapshot.bookId);
      const changes = diffStates(current, snapshot.state);

      const chapterId = payload.chapterId ?? snapshot.chapterId;
      const chapter = chapterId ? books.getChapter(chapterId) : null;
      return {
        snapshotId: snapshot.id,
        label: snapshot.label,
        changes,
        conflictParagraphs: findConflictParagraphs(chapter?.content ?? '', changes),
      };
    }),
  );

  ipcMain.handle('api:restoreSnapshot', (_event, payload: RestoreSnapshotPayload) =>
    handle<{ changes: number }>(() => {
      const { books, facts, snapshots } = getCore();
      // 从快照列表反查 bookId：单库下直接遍历所有作品
      let bookId = '';
      for (const book of books.listAllBooks()) {
        if (snapshots.listViews(book.id).some((view) => view.id === payload.snapshotId)) {
          bookId = book.id;
          break;
        }
      }
      if (!bookId) throw new Error(`找不到快照: ${payload.snapshotId}`);
      const changes = snapshots.restore(payload.snapshotId);
      facts.materializeProjection(bookId);
      return { changes: changes.length };
    }),
  );

  /* ---------------- AI 设置 ---------------- */

  ipcMain.handle('api:getAiConfig', () =>
    handle<AiConfigSnapshot>(() => {
      const { aiConfig, secrets } = getCore();
      return {
        config: aiConfig.load(),
        credentials: secrets.list(),
        encryptionAvailable: secrets.encrypted,
      };
    }),
  );

  ipcMain.handle('api:saveAiModel', (_event, payload: SaveAiModelPayload) =>
    handle(() => {
      const { aiConfig, secrets } = getCore();
      const model = { ...payload.model };
      if (!model.label.trim() || !model.baseUrl.trim() || !model.model.trim()) {
        throw new Error('请填写名称、base_url 与模型名');
      }
      if (payload.apiKey?.trim()) {
        // 凭据 id 与模型 id 绑定；密钥只进加密文件，配置里只留 id
        secrets.save(model.id, `${model.label} · 密钥`, payload.apiKey.trim());
        model.credentialId = model.id;
      } else if (!model.credentialId) {
        const existing = aiConfig.load().models.find((item) => item.id === model.id);
        model.credentialId = existing?.credentialId ?? '';
      }
      return aiConfig.addOrUpdateModel(model);
    }),
  );

  ipcMain.handle('api:removeAiModel', (_event, payload: RemoveAiModelPayload) =>
    handle(() => {
      const { aiConfig, secrets } = getCore();
      const config = aiConfig.load();
      config.models = config.models.filter((item) => item.id !== payload.modelId);
      for (const purpose of Object.keys(config.defaults) as Array<keyof typeof config.defaults>) {
        if (config.defaults[purpose] === payload.modelId) delete config.defaults[purpose];
      }
      aiConfig.save(config);
      secrets.remove(payload.modelId);
      return config;
    }),
  );

  ipcMain.handle('api:setAiDefault', (_event, payload: SetAiDefaultPayload) =>
    handle(() => {
      const config = getCore().aiConfig.load();
      if (payload.modelId && !config.models.some((item) => item.id === payload.modelId)) {
        throw new Error(`模型不存在: ${payload.modelId}`);
      }
      return getCore().aiConfig.setDefault(payload.purpose, payload.modelId);
    }),
  );

  ipcMain.handle('api:updateAiRuntime', (_event, payload: UpdateAiRuntimePayload) =>
    handle(() => {
      const { aiConfig } = getCore();
      const config = aiConfig.load();
      config.requestTimeoutMs = Math.max(5000, payload.requestTimeoutMs);
      config.maxRetries = Math.min(5, Math.max(0, payload.maxRetries));
      config.retryBaseDelayMs = Math.max(100, payload.retryBaseDelayMs);
      aiConfig.save(config);
      return config;
    }),
  );

  ipcMain.handle('api:testAiModel', (_event, payload: TestAiModelPayload) =>
    handleAsync(async () => {
      const { client } = getAi();
      const model = client.listModels().find((item) => item.id === payload.modelId);
      if (!model) throw new Error(`模型不存在: ${payload.modelId}`);
      return client.connectivity(model);
    }),
  );

  /* ---------------- 写作与 LLM 审计 ---------------- */

  ipcMain.handle('api:generateWriting', (_event, payload: GenerateWritingPayload) =>
    handleAsync<AiWritingResult>(async () => {
      const { books, facts } = getCore();
      const chapter = books.getChapter(payload.chapterId);
      if (!chapter) throw new Error(`章节不存在: ${payload.chapterId}`);
      if (activeWriting) throw new Error('已有写作任务在进行中，请先等待或取消');
      const { client, service } = getAi();
      const model = client.resolveFor('writing');
      const { state, assembled } = chapterContext(chapter, facts);
      const book = books.getBook(chapter.bookId);
      const volume = chapter.volumeId
        ? books.listVolumes(chapter.bookId).find((item) => item.id === chapter.volumeId)
        : null;
      const controller = new AbortController();
      activeWriting = { chapterId: chapter.id, controller };
      emitAiEvent({ phase: 'start', chapterId: chapter.id, model: model.label });

      try {
        const result = await service.generateWriting({
          chapter,
          assembled,
          facts: state,
          bookOutline: book?.outline,
          volumeOutline: volume?.outline,
          authorGuidance: payload.authorGuidance?.trim() || undefined,
          signal: controller.signal,
          onToken: (token) => emitAiEvent({ phase: 'token', chapterId: chapter.id, token }),
        });
        emitAiEvent({ phase: 'done', chapterId: chapter.id, tokens: result.tokens });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitAiEvent(
          controller.signal.aborted
            ? { phase: 'canceled', chapterId: chapter.id }
            : { phase: 'error', chapterId: chapter.id, message },
        );
        throw error;
      } finally {
        if (activeWriting?.controller === controller) activeWriting = null;
      }
    }),
  );

  ipcMain.handle('api:cancelWriting', () =>
    handle<boolean>(() => {
      if (!activeWriting) return false;
      activeWriting.controller.abort(new Error('作者取消写作'));
      return true;
    }),
  );

  ipcMain.handle('api:previewWritingDiff', (_event, payload: PreviewWritingDiffPayload) =>
    handle(() => {
      const chapter = getCore().books.getChapter(payload.chapterId);
      if (!chapter) throw new Error(`章节不存在: ${payload.chapterId}`);
      return diffParagraphs(chapter.content ?? '', payload.revised);
    }),
  );

  ipcMain.handle('api:applyWritingDiff', (_event, payload: ApplyWritingDiffPayload) =>
    handle<Chapter>(() => {
      const { books } = getCore();
      const chapter = books.getChapter(payload.chapterId);
      if (!chapter) throw new Error(`章节不存在: ${payload.chapterId}`);
      // 差分基于生成时缓存的 revised 快照，避免作者编辑期间正文变化导致错位
      const changes = diffParagraphs(chapter.content ?? '', payload.revised).changes;
      const content = applyDecisions(changes, new Set(payload.acceptedIndices));
      const updated = books.updateChapterContent(payload.chapterId, content);
      getCore().search.indexChapter(updated);
      return updated;
    }),
  );

  ipcMain.handle('api:runLlmAudit', (_event, payload: RunLlmAuditPayload) =>
    handleAsync<LlmAuditResult>(async () => {
      const { books, facts } = getCore();
      const chapter = books.getChapter(payload.chapterId);
      if (!chapter) throw new Error(`章节不存在: ${payload.chapterId}`);
      if (!chapter.content?.trim()) throw new Error('章节正文为空，无需 AI 审稿');
      const previous = books
        .listChapters(chapter.bookId)
        .filter((item) => item.ordinal < chapter.ordinal)
        .slice(-5)
        // 只取章纲文本作为连续性背景；正文不作为状态判断依据
        .map((item) => item.outline || `第 ${item.ordinal} 章 ${item.title}`);
      const { state } = chapterContext(chapter, facts);
      // 题材侧重只追加「关注点」提示，不改变四类判断维度
      const genreId = books.getBook(chapter.bookId)?.genreId ?? null;
      const template = genreId ? findGenre(genreId) : null;
      return getAi().service.runLlmAudit({
        chapter,
        facts: state,
        previousSummaries: previous,
        ...(template ? { genreName: template.name } : {}),
        ...(template?.profile.auditFocus?.length ? { genreFocus: template.profile.auditFocus } : {}),
      });
    }),
  );

  ipcMain.handle('api:searchChapters', (_event, payload: SearchChaptersPayload) =>
    handleAsync<SearchChaptersResult>(async () => {
      const { search } = getCore();
      const embeddingStatus = search.embeddingStatus(payload.bookId);
      let queryVector: number[] | undefined;
      let usedEmbedding = false;
      if (payload.useEmbedding && embeddingStatus.embeddedChapters > 0) {
        try {
          const { client } = getAi();
          const response = await client.embed('embedding', { inputs: [payload.query] });
          queryVector = response.vectors[0];
          usedEmbedding = Boolean(queryVector?.length);
        } catch {
          // 向量模型不可用不应阻断检索，静默退化为 BM25
          usedEmbedding = false;
        }
      }
      return {
        hits: search.searchHybrid(payload.bookId, payload.query, {
          ...(payload.volumeId ? { volumeId: payload.volumeId } : {}),
          ...(payload.limit ? { limit: payload.limit } : {}),
          ...(queryVector ? { queryVector } : {}),
        }),
        embeddingStatus,
        usedEmbedding,
      };
    }),
  );

  ipcMain.handle('api:indexEmbeddings', (_event, payload: IndexEmbeddingsPayload) =>
    handleAsync<IndexEmbeddingsResult>(async () => {
      const { books, search } = getCore();
      const { client } = getAi();
      const model = client.resolveFor('embedding');
      const chapters = books.listChapters(payload.bookId);
      let indexed = 0;
      let failed = 0;
      let skipped = 0;
      const batchSize = 8;

      for (let offset = 0; offset < chapters.length; offset += batchSize) {
        const batch = chapters.slice(offset, offset + batchSize);
        const withContent = batch.filter((chapter) => (chapter.content ?? '').trim().length > 0);
        skipped += batch.length - withContent.length;
        if (withContent.length === 0) continue;
        try {
          const response = await client.embed('embedding', {
            // 控制单章输入长度，避免超长章节撑爆 embedding 请求
            inputs: withContent.map((chapter) => `${chapter.title}\n${(chapter.content ?? '').slice(0, 4000)}`),
          });
          withContent.forEach((chapter, index) => {
            const vector = response.vectors[index];
            if (!vector?.length) {
              failed += 1;
              return;
            }
            search.upsertEmbedding({
              chapterId: chapter.id,
              bookId: payload.bookId,
              model: model.label,
              vector,
            });
            indexed += 1;
          });
        } catch {
          failed += withContent.length;
        }
      }

      return { model: model.label, indexed, failed, skipped };
    }),
  );

  ipcMain.handle('api:pickManuscript', () =>
    handleAsync<PickManuscriptResult>(async () => {
      const options = {
        properties: ['openFile' as const],
        filters: [
          { name: '文本稿件', extensions: ['txt', 'md', 'markdown'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) throw new Error('已取消选择文件');
      const filePath = result.filePaths[0];
      const stat = statSync(filePath);
      if (stat.size > 30 * 1024 * 1024) throw new Error('文件超过 30MB，请先拆分后再导入');
      return {
        fileName: basename(filePath),
        filePath,
        text: readFileSync(filePath, 'utf8'),
        size: stat.size,
      };
    }),
  );

  ipcMain.handle('api:previewManuscript', (_event, payload: { text: string; fileName: string }) =>
    handle<PreviewManuscriptResult>(() => previewFromText(payload.text, payload.fileName)),
  );

  // 拖拽导入：渲染层拿到真实路径后交给主进程读文件，避免把整本书塞进 IPC 消息
  ipcMain.handle('api:importPath', (_event, payload: { path: string }) =>
    handle<PreviewManuscriptResult>(() => {
      if (!payload.path) throw new Error('缺少文件路径');
      const stat = statSync(payload.path);
      if (!stat.isFile()) throw new Error('请选择一个 txt / md 文件（暂不支持直接拖文件夹）');
      if (stat.size > 60 * 1024 * 1024) throw new Error('文件超过 60MB，请先拆分后再导入');
      if (!/\.(txt|md|markdown)$/i.test(payload.path)) throw new Error('仅支持 txt / md / markdown');
      const text = readFileSync(payload.path, 'utf8');
      return previewFromText(text, basename(payload.path));
    }),
  );

  ipcMain.handle('api:pickVault', () =>
    handleAsync<VaultParseResult>(async () => {
      const result = await dialog.showOpenDialog({
        title: '选择 Obsidian 仓库（文件夹）',
        properties: ['openDirectory'],
      });
      const folder = result.filePaths[0];
      if (result.canceled || !folder) throw new Error('未选择目录');
      const parsed = parseVaultFolder(folder);
      if (parsed.fileCount === 0) throw new Error('该目录下没有找到 Markdown 文件');
      return parsed;
    }),
  );

  ipcMain.handle('api:parseVault', (_event, payload: { folder: string }) =>
    handle<VaultParseResult>(() => {
      if (!payload.folder) throw new Error('缺少目录路径');
      const parsed = parseVaultFolder(payload.folder);
      if (parsed.fileCount === 0) throw new Error('该目录下没有找到 Markdown 文件');
      return parsed;
    }),
  );

  ipcMain.handle('api:commitManuscript', (_event, payload: CommitManuscriptPayload) =>
    handle<CommitManuscriptResult>(() => {
      const { books, search } = getCore();
      const existing = books.listChapters(payload.bookId);
      const startOrdinal = existing.reduce((max, chapter) => Math.max(max, chapter.ordinal), 0) + 1;
      let created = 0;
      for (const [index, draft] of payload.chapters.entries()) {
        const chapter = books.createChapter({
          bookId: payload.bookId,
          volumeId: payload.volumeId ?? null,
          ordinal: startOrdinal + index,
          title: draft.title,
          content: draft.content,
          status: 'draft',
          targetWords: draft.wordCount,
        });
        search.indexChapter(chapter);
        created += 1;
      }
      return {
        created,
        firstOrdinal: startOrdinal,
        lastOrdinal: startOrdinal + Math.max(0, created - 1),
      };
    }),
  );

  ipcMain.handle('api:exportMarkdown', (_event, payload: ExportMarkdownPayload) =>
    handle<ExportMarkdownResult>(() => {
      const { books, facts } = getCore();
      const book = books.getBook(payload.bookId);
      if (!book) throw new Error(`作品不存在: ${payload.bookId}`);
      const chapters = books.listChapters(book.id);
      const state = facts.loadState(book.id);
      const directory = join(dataDir(), 'exports');
      mkdirSync(directory, { recursive: true });

      const format = payload.format ?? 'md';
      const archive = payload.mode === 'archive';
      const suffix = format === 'txt' ? 'txt' : 'md';

      if (payload.chapterId) {
        const chapter = books.getChapter(payload.chapterId);
        if (!chapter || chapter.bookId !== book.id) throw new Error(`章节不属于该作品: ${payload.chapterId}`);
        const base = `${safeFileName(book.title)}-第${String(chapter.ordinal).padStart(3, '0')}章`;
        const file = join(directory, `${base}.${suffix}`);
        // 单章可读导出：只要标题 + 正文，不带事实源
        const body = renderBookReadable({
          book,
          chapters: [chapter],
          volumes: books.listVolumes(book.id),
          markdown: format === 'md' && archive,
        });
        writeFileSync(file, body, 'utf8');
        return { files: [file], directory };
      }

      if (archive && format === 'md') {
        const file = join(directory, `${safeFileName(book.title)}-全书-归档.md`);
        writeFileSync(file, renderBookMarkdown({ book, chapters, state }), 'utf8');
        return { files: [file], directory };
      }

      const file = join(directory, `${safeFileName(book.title)}-全书.${suffix}`);
      writeFileSync(
        file,
        renderBookReadable({
          book,
          chapters,
          volumes: books.listVolumes(book.id),
          markdown: format === 'md',
        }),
        'utf8',
      );
      return { files: [file], directory };
    }),
  );
  ipcMain.handle('api:extractFacts', (_event, payload: ExtractFactsPayload) =>
    handleAsync<ExtractFactsResult>(async () => {
      const { books } = getCore();
      const book = books.getBook(payload.bookId);
      if (!book) throw new Error(`作品不存在: ${payload.bookId}`);

      const all = books.listChapters(payload.bookId).filter((chapter) => (chapter.content ?? '').trim().length > 0);
      if (all.length === 0) throw new Error('该作品还没有正文，无法反推');

      const maxChapters = Math.max(1, Math.min(payload.maxChapters ?? 6, 20));
      let picked = payload.chapterIds?.length
        ? all.filter((chapter) => payload.chapterIds!.includes(chapter.id))
        : sampleChapters(all, maxChapters);
      if (picked.length === 0) picked = sampleChapters(all, maxChapters);

      const { service, client } = getAi();
      // 每章素材量按模型上下文窗口推算：中文约 1.4 字/token，
      // 留 40% 给 system 提示词与输出，剩下均分给各章。
      // 本地 7B 模型上下文小，硬塞 4×3500 字会把 system 指令挤出窗口。
      const contextWindow = client.resolveFor('outline').contextWindow || 8192;
      // 上限按 8192 计：再大对 7B 级本地模型没帮助，只会拖慢生成并挤占显存
      const budgetTokens = Math.min(contextWindow, 8192);
      const autoPerChapter = Math.floor((budgetTokens * 0.6 * 1.4) / picked.length);
      const perChapter = Math.max(
        500,
        Math.min(payload.charsPerChapter ?? Math.max(800, autoPerChapter), 8000),
      );
      const result = await service.extractFacts({
        bookTitle: book.title,
        chapters: picked.map((chapter) => ({
          ordinal: chapter.ordinal,
          title: chapter.title,
          content: (chapter.content ?? '').slice(0, perChapter),
        })),
      });
      return {
        ...result,
        usedChapters: picked.map((chapter) => ({
          ordinal: chapter.ordinal,
          title: chapter.title,
          chars: Math.min((chapter.content ?? '').length, perChapter),
        })),
        model: client.resolveFor('outline').label || result.model,
      };
    }),
  );

  ipcMain.handle('api:suggestOutline', (_event, payload: SuggestOutlinePayload) =>
    handleAsync<SuggestOutlineResult>(async () => {
      const { books, facts } = getCore();
      const book = books.getBook(payload.bookId);
      if (!book) throw new Error(`作品不存在: ${payload.bookId}`);
      const chapters = books.listChapters(payload.bookId);
      const { service, client } = getAi();
      const model = client.resolveFor('outline');
      const outline = await service.suggestOutline({
        bookTitle: book.title,
        existingOutline: book.outline,
        facts: facts.loadState(book.id),
        chapterCount: chapters.length,
      });
      return { outline, model: model.label };
    }),
  );

  ipcMain.handle('api:revealPath', (_event, payload: { path: string }) =>
    handle<boolean>(() => {
      const base = dataDir();
      const target = resolve(payload.path);
      // 只允许定位数据目录内的产物，避免被当成任意文件探测接口
      if (!target.startsWith(resolve(base))) throw new Error('只能定位数据目录内的文件');
      shell.showItemInFolder(target);
      return true;
    }),
  );

  ipcMain.handle('api:backupDatabase', () =>
    handle<{ file: string; directory: string; sizeBytes: number }>(() => {
      const { db } = getCore();
      const directory = join(dataDir(), 'backups');
      mkdirSync(directory, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = join(directory, `inkforge-${stamp}.db`);
      // VACUUM INTO 生成一致性快照：即使应用正在写入，备份文件也是完整可用的库
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      const sizeBytes = statSync(file).size;
      return { file, directory, sizeBytes };
    }),
  );

  ipcMain.handle('api:revealDataDir', () =>
    handleAsync<string>(async () => {
      const dir = dataDir();
      const message = await shell.openPath(dir);
      if (message) throw new Error(message);
      return dir;
    }),
  );
}

/**
 * 单实例：双击第二次启动时不再开新窗口，而是聚焦已有窗口。
 * 这既符合「一键打开」的使用直觉，也避免两个进程同时写同一个 SQLite 文件。
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    // 原生菜单必须显式设置：不设的话 Electron 会给英文默认菜单（File/Edit/View/Help），
    // 中文界面下顶栏就成了唯一的英文区域。
    buildAppMenu(defaultMenuLocale(), menuHost());
    // 供无头烟测等待主进程就绪
    console.log('[inkforge] ready');
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
