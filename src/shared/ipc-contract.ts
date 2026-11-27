/**
 * 主进程 ↔ 渲染进程的 IPC 契约。
 *
 * 渲染进程不直接访问 SQLite 或核心层，所有操作通过 contextBridge 暴露的
 * window.api 完成。此处定义的方法签名即双方共同遵守的接口。
 */

import type {
  Book,
  BookSummary,
  Chapter,
  ChapterStatus,
  ChapterTask,
  Character,
  CharacterState,
  Foreshadow,
  ForeshadowUse,
  GateReport,
  AuditReport,
  SnapshotView,
  WorldRule,
  Strand,
  HookType,
  Volume,
  Resource,
  TimelineEvent,
  Ability,
} from '../index.js';
import type { EmbeddingStatus, SearchHit } from '../retrieval/search.js';
import type {
  AiConfiguration,
  ConnectivityResult,
  LlmAuditResult,
  ModelConfig,
  ModelPurpose,
} from '../ai/types.js';
import type { CredentialMeta } from '../ai/secret-store.js';
import type { DiffResult } from '../ai/diff.js';
import type { StateChange } from '../db/snapshot-repository.js';
import type { VaultParseResult } from '../import/obsidian.js';
import type { FactProposalBody } from '../ai/extraction.js';

// 渲染进程统一从本模块导入领域类型，避免直接依赖核心层出口
export type {
  Book,
  BookSummary,
  Chapter,
  ChapterStatus,
  ChapterTask,
  Character,
  CharacterState,
  Foreshadow,
  ForeshadowUse,
  GateReport,
  AuditReport,
  SnapshotView,
  WorldRule,
  Strand,
  HookType,
  Volume,
  Resource,
  TimelineEvent,
  Ability,
  EmbeddingStatus,
  SearchHit,
  AiConfiguration,
  ConnectivityResult,
  CredentialMeta,
  DiffResult,
  LlmAuditResult,
  StateChange,
  VaultParseResult,
  FactProposalBody,
  ModelConfig,
  ModelPurpose,
};

export interface CreateBookPayload {  title: string;
  outline?: string;
  /** 可选题材模板 id，创建后自动写入对应世界规则 */
  genreId?: string | null;
}

export interface UpdateBookPayload {
  bookId: string;
  title?: string;
  outline?: string;
  /** 题材 id；传空字符串表示清除题材（门禁/审计回到全部 normal） */
  genreId?: string | null;
}

export interface DeleteBookPayload {
  bookId: string;
}

export interface CreateVolumePayload {
  bookId: string;
  title: string;
  outline?: string;
  ordinal?: number;
}

export interface UpdateVolumePayload {
  volumeId: string;
  title?: string;
  outline?: string;
  ordinal?: number;
}

export interface DeleteVolumePayload {
  volumeId: string;
}

export interface DeleteChapterPayload {
  chapterId: string;
}

/** 章节拖拽重排：orderedChapterIds 必须覆盖本书全部章节的新顺序 */
export interface ReorderChaptersPayload {
  bookId: string;
  orderedChapterIds: string[];
}

export interface UpdateChapterSpecPayload {
  chapterId: string;
  spec: ChapterSpecPayload;
}

export interface CreateChapterPayload {
  bookId: string;
  ordinal: number;
  title: string;
  volumeId?: string | null;
  outline?: string;
  targetWords?: number | null;
  strand?: Strand | null;
  declaredCharacters?: string[];
  declaredLocations?: string[];
  declaredForeshadows?: ForeshadowUse[];
  emotionTags?: string[];
  hookType?: Chapter['hookType'];
}

export interface ChapterSpecPayload {
  /** 章节标题，留空或省略表示不改 */
  title?: string;
  volumeId?: string | null;
  outline?: string;
  declaredCharacters?: string[];
  declaredLocations?: string[];
  declaredForeshadows?: ForeshadowUse[];
  emotionTags?: string[];
  hookType?: Chapter['hookType'];
  strand?: Strand | null;
  targetWords?: number | null;
}

export interface SaveChapterPayload {
  chapterId: string;
  content: string;
  status?: ChapterStatus;
  spec?: ChapterSpecPayload;
}

export interface RunChecksPayload {
  chapterId: string;
}

export interface CreateCharacterPayload {
  bookId: string;
  name: string;
  aliases?: string[];
  notes?: string;
  initialLocation?: string | null;
  abilities?: Ability[];
  knownFacts?: string[];
}

export interface UpdateCharacterPayload {
  characterId: string;
  name?: string;
  aliases?: string[];
  notes?: string;
  isAlive?: boolean;
  location?: string | null;
  abilities?: Ability[];
  knownFacts?: string[];
  chapterId?: string | null;
}

export interface DeleteCharacterPayload {
  characterId: string;
}

export interface CreateForeshadowPayload {
  bookId: string;
  title: string;
  kind: Foreshadow['kind'];
  description?: string;
  plantedInChapterId?: string | null;
  plannedResolveOrdinal?: number | null;
  resolutionMarkers?: string[];
}

export interface UpdateForeshadowPayload {
  foreshadowId: string;
  title?: string;
  description?: string;
  kind?: Foreshadow['kind'];
  plantedInChapterId?: string | null;
  plannedResolveOrdinal?: number | null;
  resolutionMarkers?: string[];
  status?: Foreshadow['status'];
}

export interface ForeshadowActionPayload {
  foreshadowId: string;
  chapterId?: string | null;
}

export interface DeleteForeshadowPayload {
  foreshadowId: string;
}

export interface CreateWorldRulePayload {
  bookId: string;
  category: string;
  rule: string;
  priority?: number;
}

export interface UpdateWorldRulePayload {
  ruleId: string;
  category?: string;
  rule?: string;
  priority?: number;
}

export interface DeleteWorldRulePayload {
  ruleId: string;
}

export interface CreateTimelineEventPayload {
  bookId: string;
  chapterId?: string | null;
  storyTime: string;
  storyOrder: number;
  description: string;
}

export interface UpdateTimelineEventPayload {
  eventId: string;
  chapterId?: string | null;
  storyTime?: string;
  storyOrder?: number;
  description?: string;
}

export interface DeleteTimelineEventPayload {
  eventId: string;
}

export interface CreateResourcePayload {
  bookId: string;
  name: string;
  category?: string;
  holderCharacterId?: string | null;
  quantity?: number;
  notes?: string;
}

export interface UpdateResourcePayload {
  resourceId: string;
  quantity?: number;
  holderCharacterId?: string | null;
  notes?: string;
  chapterId?: string | null;
}

export interface DeleteResourcePayload {
  resourceId: string;
}

export interface GenreRuleTemplate {
  category: string;
  rule: string;
  priority: number;
}

/** 与 src/domain/genres.ts 的 GenreProfile 保持一致（跨进程传输用） */
export type GenreRuleLevel = 'strict' | 'normal' | 'relaxed' | 'off';

export interface GenreProfile {
  gate?: Partial<Record<string, GenreRuleLevel>>;
  audit?: Partial<Record<string, GenreRuleLevel>>;
  auditFocus?: string[];
}

export interface GenreTemplate {
  id: string;
  name: string;
  description: string;
  rules: GenreRuleTemplate[];
  profile: GenreProfile;
}

export interface ApplyGenrePayload {
  bookId: string;
  genreId: string;
}

export interface ApplyGenreResult {
  genre: GenreTemplate;
  createdRules: number;
}

export interface CreateSnapshotPayload {
  bookId: string;
  label: string;
  chapterId?: string | null;
}

export interface RestoreSnapshotPayload {
  snapshotId: string;
}

export interface PreviewSnapshotRestorePayload {
  snapshotId: string;
  /** 需要扫描冲突段落的章节；不传则用快照绑定的章节 */
  chapterId?: string | null;
}

export interface SnapshotConflictParagraph {
  paragraphIndex: number;
  text: string;
  reason: string;
}

export interface SnapshotRestorePreview {
  snapshotId: string;
  label: string;
  changes: StateChange[];
  conflictParagraphs: SnapshotConflictParagraph[];
}

export interface ExportMarkdownPayload {
  bookId: string;
  /** 不传则导出整书 */
  chapterId?: string | null;
  /** read：可读版（只有卷/章标题+正文）；archive：含事实源表格的归档版。默认 read */
  mode?: 'read' | 'archive';
  /** 导出格式。默认 md */
  format?: 'md' | 'txt';
}

export interface ExportMarkdownResult {
  files: string[];
  directory: string;
}

export interface WorkbenchData {
  book: Book;
  volumes: Volume[];
  /** 不含正文的章节摘要；正文由 getChapterContent 按需拉取，避免全书正文跨进程传输 */
  chapters: Chapter[];
  /** 侧栏字数展示，key 为 chapterId */
  chapterWordCounts: Record<string, number>;
  characters: Character[];
  characterStates: CharacterState[];
  foreshadows: Foreshadow[];
  resources: Resource[];
  timelineEvents: TimelineEvent[];
  worldRules: WorldRule[];
  snapshots: SnapshotView[];
  receipts: Array<{ id: string; chapterId: string; chapterOrdinal: number; contentHash: string; finalizedAt: string; supersededBy: string | null }>;
  lastGate: GateReport | null;
  lastAudit: AuditReport | null;
  chapterTasks: ChapterTask[];
}

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/* ---------------- AI 设置与写作 ---------------- */

export interface AiConfigSnapshot {
  config: AiConfiguration;
  credentials: CredentialMeta[];
  encryptionAvailable: boolean;
}

export interface SaveAiModelPayload {
  model: ModelConfig;
  /** 留空表示沿用该模型已有凭据；本地模型可不填 */
  apiKey?: string;
}

export interface RemoveAiModelPayload {
  modelId: string;
}

export interface SetAiDefaultPayload {
  purpose: ModelPurpose;
  modelId: string | null;
}

export interface TestAiModelPayload {
  modelId: string;
}

export interface UpdateAiRuntimePayload {
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
}

export interface GenerateWritingPayload {
  chapterId: string;
  authorGuidance?: string;
}

export interface AiWritingResult {
  content: string;
  model: string;
  tokens: number;
  promptTokens: number;
}

export interface PreviewWritingDiffPayload {
  chapterId: string;
  revised: string;
}

export interface ApplyWritingDiffPayload {
  chapterId: string;
  /** 生成时缓存的新稿快照，保证裁决期间段落序号不漂移 */
  revised: string;
  /** 接受 AI 改动的段落序号；未包含的按原稿保留 */
  acceptedIndices: number[];
}

export interface RunLlmAuditPayload {
  chapterId: string;
}

export interface SuggestOutlinePayload {
  bookId: string;
}

export interface SuggestOutlineResult {
  outline: string;
  model: string;
}

export interface SearchChaptersPayload {
  bookId: string;
  query: string;
  volumeId?: string | null;
  limit?: number;
  /** 配置了 embedding 模型时启用向量召回；失败自动退化为 BM25 */
  useEmbedding?: boolean;
}

export interface SearchChaptersResult {
  hits: SearchHit[];
  embeddingStatus: EmbeddingStatus;
  usedEmbedding: boolean;
}

export interface IndexEmbeddingsPayload {
  bookId: string;
}

export interface IndexEmbeddingsResult {
  model: string;
  indexed: number;
  failed: number;
  skipped: number;
}

export interface ManuscriptChapterDraft {
  title: string;
  content: string;
  wordCount: number;
}

export interface PickManuscriptResult {
  fileName: string;
  filePath: string;
  text: string;
  size: number;
}

export interface PreviewManuscriptResult {
  fileName: string;
  chapters: ManuscriptChapterDraft[];
  totalWords: number;
}

export interface ExtractFactsPayload {
  bookId: string;
  /** 指定章节；不传则由后端抽样（前几章 + 均匀抽样） */
  chapterIds?: string[];
  /** 最多送几章给模型，默认 8 */
  maxChapters?: number;
  /** 每章截断字符数，默认 3500 */
  charsPerChapter?: number;
}

export interface ExtractedChapterRef {
  ordinal: number;
  title: string;
  chars: number;
}

export interface ExtractFactsResult {
  proposal: FactProposalBody;
  model: string;
  tokens: number;
  promptTokens: number;
  /** 实际送进模型的章节，便于作者判断抽样是否够用 */
  usedChapters: ExtractedChapterRef[];
}

export interface CommitManuscriptPayload {
  bookId: string;
  fileName: string;
  chapters: ManuscriptChapterDraft[];
  volumeId?: string | null;
}

export interface CommitManuscriptResult {
  created: number;
  firstOrdinal: number;
  lastOrdinal: number;
}

export type AiStreamEvent =
  | { phase: 'start'; chapterId: string; model: string }
  | { phase: 'token'; chapterId: string; token: string }
  | { phase: 'done'; chapterId: string; tokens: number }
  | { phase: 'error'; chapterId: string; message: string }
  | { phase: 'canceled'; chapterId: string };

/** 原生菜单能触发的动作，渲染层据此复用已有的按钮逻辑 */
export type MenuAction = 'new-book' | 'import' | 'backup' | 'export-txt';

export interface InkforgeApi {
  /** 切换界面语言；主进程据此重建原生菜单 */
  setLocale(payload: { locale: 'zh' | 'en' }): Promise<ApiResult<boolean>>;
  /** 原生菜单触发的动作（新建作品/导入/备份/导出） */
  onMenuAction(listener: (action: MenuAction) => void): () => void;
  /** 书架数据：作品 + 章节数/卷数/字数统计 */
  listBooks(): Promise<ApiResult<BookSummary[]>>;
  createBook(payload: CreateBookPayload): Promise<ApiResult<Book>>;
  updateBook(payload: UpdateBookPayload): Promise<ApiResult<Book>>;
  deleteBook(payload: DeleteBookPayload): Promise<ApiResult<boolean>>;
  getWorkbench(bookId: string): Promise<ApiResult<WorkbenchData>>;
  getChapterContent(payload: { chapterId: string }): Promise<ApiResult<string>>;
  createChapter(payload: CreateChapterPayload): Promise<ApiResult<Chapter>>;
  deleteChapter(payload: DeleteChapterPayload): Promise<ApiResult<boolean>>;
  reorderChapters(payload: ReorderChaptersPayload): Promise<ApiResult<Chapter[]>>;
  updateChapterSpec(payload: UpdateChapterSpecPayload): Promise<ApiResult<Chapter>>;
  saveChapter(payload: SaveChapterPayload): Promise<ApiResult<Chapter>>;
  runChecks(payload: RunChecksPayload): Promise<ApiResult<{ gate: GateReport; audit: AuditReport }>>;

  createVolume(payload: CreateVolumePayload): Promise<ApiResult<Volume>>;
  updateVolume(payload: UpdateVolumePayload): Promise<ApiResult<Volume>>;
  deleteVolume(payload: DeleteVolumePayload): Promise<ApiResult<boolean>>;

  createCharacter(payload: CreateCharacterPayload): Promise<ApiResult<Character>>;
  updateCharacter(payload: UpdateCharacterPayload): Promise<ApiResult<Character>>;
  deleteCharacter(payload: DeleteCharacterPayload): Promise<ApiResult<boolean>>;

  createForeshadow(payload: CreateForeshadowPayload): Promise<ApiResult<Foreshadow>>;
  updateForeshadow(payload: UpdateForeshadowPayload): Promise<ApiResult<Foreshadow>>;
  advanceForeshadow(payload: ForeshadowActionPayload): Promise<ApiResult<Foreshadow>>;
  resolveForeshadow(payload: ForeshadowActionPayload): Promise<ApiResult<Foreshadow>>;
  abandonForeshadow(payload: ForeshadowActionPayload): Promise<ApiResult<Foreshadow>>;
  deleteForeshadow(payload: DeleteForeshadowPayload): Promise<ApiResult<boolean>>;

  createWorldRule(payload: CreateWorldRulePayload): Promise<ApiResult<WorldRule>>;
  updateWorldRule(payload: UpdateWorldRulePayload): Promise<ApiResult<WorldRule>>;
  deleteWorldRule(payload: DeleteWorldRulePayload): Promise<ApiResult<boolean>>;

  createTimelineEvent(payload: CreateTimelineEventPayload): Promise<ApiResult<TimelineEvent>>;
  updateTimelineEvent(payload: UpdateTimelineEventPayload): Promise<ApiResult<TimelineEvent>>;
  deleteTimelineEvent(payload: DeleteTimelineEventPayload): Promise<ApiResult<boolean>>;

  createResource(payload: CreateResourcePayload): Promise<ApiResult<Resource>>;
  updateResource(payload: UpdateResourcePayload): Promise<ApiResult<Resource>>;
  deleteResource(payload: DeleteResourcePayload): Promise<ApiResult<boolean>>;

  listGenres(): Promise<ApiResult<GenreTemplate[]>>;
  applyGenre(payload: ApplyGenrePayload): Promise<ApiResult<ApplyGenreResult>>;

  createSnapshot(payload: CreateSnapshotPayload): Promise<ApiResult<SnapshotView>>;
  previewSnapshotRestore(payload: PreviewSnapshotRestorePayload): Promise<ApiResult<SnapshotRestorePreview>>;
  restoreSnapshot(payload: RestoreSnapshotPayload): Promise<ApiResult<{ changes: number }>>;

  searchChapters(payload: SearchChaptersPayload): Promise<ApiResult<SearchChaptersResult>>;
  indexEmbeddings(payload: IndexEmbeddingsPayload): Promise<ApiResult<IndexEmbeddingsResult>>;

  pickManuscript(): Promise<ApiResult<PickManuscriptResult>>;
  /** 选择 Obsidian 仓库目录并解析为章节草稿 */
  pickVault(): Promise<ApiResult<VaultParseResult>>;
  /** 按给定目录解析（不弹窗），用于脚本与巡检 */
  parseVault(payload: { folder: string }): Promise<ApiResult<VaultParseResult>>;
  previewManuscript(payload: { text: string; fileName: string }): Promise<ApiResult<PreviewManuscriptResult>>;
  /** 拖拽导入：按本地路径读取并解析（txt / md） */
  importPath(payload: { path: string }): Promise<ApiResult<PreviewManuscriptResult>>;
  /** 拖拽文件时取本地绝对路径（Electron 32+ 不再提供 File.path） */
  getFilePath(file: unknown): string;
  commitManuscript(payload: CommitManuscriptPayload): Promise<ApiResult<CommitManuscriptResult>>;

  /** 打开作品所在目录，便于作者用外部编辑器查看 Markdown 投影 */
  revealDataDir(): Promise<ApiResult<string>>;
  /** 在系统文件管理器中定位一个已产出的文件（导出/备份），路径必须在数据目录内 */
  revealPath(payload: { path: string }): Promise<ApiResult<boolean>>;
  /** 用 VACUUM INTO 生成一致性快照，作为整库备份 */
  backupDatabase(): Promise<ApiResult<{ file: string; directory: string; sizeBytes: number }>>;
  exportMarkdown(payload: ExportMarkdownPayload): Promise<ApiResult<ExportMarkdownResult>>;

  // ---- AI 设置 ----
  getAiConfig(): Promise<ApiResult<AiConfigSnapshot>>;
  saveAiModel(payload: SaveAiModelPayload): Promise<ApiResult<AiConfiguration>>;
  removeAiModel(payload: RemoveAiModelPayload): Promise<ApiResult<AiConfiguration>>;
  setAiDefault(payload: SetAiDefaultPayload): Promise<ApiResult<AiConfiguration>>;
  updateAiRuntime(payload: UpdateAiRuntimePayload): Promise<ApiResult<AiConfiguration>>;
  testAiModel(payload: TestAiModelPayload): Promise<ApiResult<ConnectivityResult>>;

  // ---- 写作与审计 ----
  generateWriting(payload: GenerateWritingPayload): Promise<ApiResult<AiWritingResult>>;
  cancelWriting(): Promise<ApiResult<boolean>>;
  previewWritingDiff(payload: PreviewWritingDiffPayload): Promise<ApiResult<DiffResult>>;
  applyWritingDiff(payload: ApplyWritingDiffPayload): Promise<ApiResult<Chapter>>;
  runLlmAudit(payload: RunLlmAuditPayload): Promise<ApiResult<LlmAuditResult>>;
  suggestOutline(payload: SuggestOutlinePayload): Promise<ApiResult<SuggestOutlineResult>>;
  /** 旧稿反推设定候选（只读，不写库） */
  extractFacts(payload: ExtractFactsPayload): Promise<ApiResult<ExtractFactsResult>>;
  /** 注册流式事件监听，返回取消监听函数 */
  onAiEvent(listener: (event: AiStreamEvent) => void): () => void;
}

declare global {
  interface Window {
    api: InkforgeApi;
  }
}
