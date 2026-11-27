/**
 * 领域模型定义 —— 单一事实源的类型契约。
 *
 * 所有上层模块（门禁、审计、装配、检索）都依赖这些类型，
 * 不依赖 SQLite 的具体实现细节。
 *
 * 分层原则（取自书童 Pagekin docs/product-domain.md）：
 * - 作者事实：作者明确输入或人工确认的前提、角色、世界观、大纲、蓝图、线索、章节内容。
 * - 派生投影：可从作者事实重建的状态、摘要、连续性信息。派生不得反向覆盖作者事实，
 *   派生失败不得破坏已有事实或上一次成功快照。
 */

export type ChapterStatus = 'outline' | 'draft' | 'reviewed' | 'final';

/** 状态字段的来源分层。优先级 author > derived > legacy；派生值永不覆盖作者值。 */
export type StateProvenance = 'author' | 'derived' | 'legacy';

/** Strand Weave 节奏分类（取自 webnovel-writer）：主线/感情线/世界观扩展 */
export type Strand = 'quest' | 'fire' | 'constellation';

/** 本章线索任务的来源 */
export type ChapterTaskSource = 'due' | 'overdue' | 'assigned';

/** 单个状态字段的事实记录。按章取值 = 生效章<=N 中来源优先级最高者。 */
export interface CharacterStateFact {
  id: string;
  bookId: string;
  characterId: string;
  /** location / abilities / relations / knownFacts / alive */
  field: string;
  /** 字段值，JSON 编码 */
  valueJson: string;
  provenance: StateProvenance;
  /** 从第几章起生效；补写中间章不会剧透后文 */
  effectiveChapter: number;
  /** derived 值绑定的定稿收据；收据失效时该值标记 stale 而非删除 */
  sourceReceiptId: string | null;
  stale: boolean;
  createdAt: string;
}

/**
 * 定稿收据：由草稿身份、收据 ID、章节号与正文哈希共同定位的不可变正文。
 * 摘要、连续性事实与派生角色状态都绑定到实际定稿来源。
 */
export interface FinalizationReceipt {
  id: string;
  bookId: string;
  chapterId: string;
  chapterOrdinal: number;
  draftId: string;
  contentHash: string;
  finalizedAt: string;
  /** 替换定稿后原收据作废，但正文历史保留 */
  supersededBy: string | null;
}

/** 本章必须处理的线索任务，由到期章/逾期/作者指派三种来源汇合 */
export interface ChapterTask {
  foreshadowId: string;
  title: string;
  action: ForeshadowAction;
  source: ChapterTaskSource;
  markers: string[];
  plannedResolveOrdinal: number | null;
}
export type ForeshadowKind = 'main' | 'sub';
export type ForeshadowStatus = 'planted' | 'advancing' | 'resolved' | 'abandoned';
export type ForeshadowAction = 'plant' | 'advance' | 'resolve';
export type HookType =
  | 'cliffhanger'
  | 'revelation'
  | 'conflict'
  | 'emotional'
  | 'question'
  | 'none';

export interface Book {
  id: string;
  title: string;
  /** 作品总纲：写前事实，AI 大纲建议可直接回写 */
  outline: string;
  /** 题材 id，决定门禁与审计的侧重；null 表示未选择（全部按 normal） */
  genreId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 书架卡片用的作品摘要：带上章节数、卷数与总字数，避免前端逐本再查 */
export interface BookSummary extends Book {
  chapterCount: number;
  volumeCount: number;
  wordCount: number;
}

export interface Volume {
  id: string;
  bookId: string;
  title: string;
  /** 卷纲：写前事实，按需装配可读取 */
  outline: string;
  ordinal: number;
  createdAt: string;
}

/** 章纲对本章的声明 —— 按需装配与门禁核对的输入 */
export interface ForeshadowUse {
  foreshadowId: string;
  action: ForeshadowAction;
  /** 覆盖伏笔上定义的默认回收证据词；仅 action='resolve' 时有效 */
  evidenceOverride?: string[];
}

export interface Chapter {
  id: string;
  bookId: string;
  volumeId: string | null;
  /** 全书范围内的章序，从 1 开始 */
  ordinal: number;
  title: string;
  outline: string;
  content: string | null;
  status: ChapterStatus;
  declaredCharacters: string[];
  declaredLocations: string[];
  declaredForeshadows: ForeshadowUse[];
  emotionTags: string[];
  hookType: HookType | null;
  /** 本章在 Strand Weave 中的节奏分类；null 表示未标注 */
  strand: Strand | null;
  targetWords: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Character {
  id: string;
  bookId: string;
  name: string;
  aliases: string[];
  isAlive: boolean;
  notes: string;
  createdAt: string;
}

export interface Ability {
  id: string;
  name: string;
  /** 境界/强度的量化值，用于能力越界审计 */
  level: number;
  category?: string;
}

export interface Relation {
  characterId: string;
  type: string;
  description?: string;
}

/** 单个字段的来源元数据。作者值只在其已知时点有效，派生值绑定定稿收据。 */
export interface FieldProvenance {
  provenance: StateProvenance;
  sourceReceiptId: string | null;
  stale: boolean;
  effectiveChapter: number | null;
}

/** 角色当前状态视图（物化投影）。权威来源是 character_state_facts，此表可由其重建。 */
export interface CharacterState {
  characterId: string;
  location: string | null;
  abilities: Ability[];
  relations: Relation[];
  knownFacts: string[];
  updatedInChapterId: string | null;
  updatedAt: string;
  /** 字段级来源标注；缺省字段视为 legacy，供旧数据兼容 */
  fieldProvenance: Partial<
    Record<'location' | 'abilities' | 'relations' | 'knownFacts', FieldProvenance>
  >;
}

export type StateEventType =
  | 'location'
  | 'ability'
  | 'relation'
  | 'known_fact'
  | 'alive';

/** 状态变更事件日志 —— 用于时间线追溯与定向回退 */
export interface CharacterStateEvent {
  id: string;
  bookId: string;
  characterId: string;
  chapterId: string | null;
  eventType: StateEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Foreshadow {
  id: string;
  bookId: string;
  title: string;
  description: string;
  kind: ForeshadowKind;
  plantedInChapterId: string | null;
  plannedResolveOrdinal: number | null;
  resolvedInChapterId: string | null;
  /** 正文中出现这些词才认定伏笔真实落地，防止"声明回收但正文没写" */
  resolutionMarkers: string[];
  status: ForeshadowStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Resource {
  id: string;
  bookId: string;
  name: string;
  category: string;
  holderCharacterId: string | null;
  quantity: number;
  notes: string;
  updatedInChapterId: string | null;
  updatedAt: string;
}

export interface TimelineEvent {
  id: string;
  bookId: string;
  chapterId: string | null;
  storyTime: string;
  /** 故事内严格时间顺序，与章节顺序可以不一致（倒叙等） */
  storyOrder: number;
  description: string;
  createdAt: string;
}

export interface WorldRule {
  id: string;
  bookId: string;
  category: string;
  rule: string;
  priority: number;
  createdAt: string;
}

/** 完整结构化状态快照（JSON 持久化），用于定向回退 */
export interface StorySnapshot {
  id: string;
  bookId: string;
  chapterId: string | null;
  label: string;
  state: FactSourceState;
  createdAt: string;
}

/** GUI 展示用的快照摘要，避免把完整状态序列化到渲染进程 */
export interface SnapshotView {
  id: string;
  bookId: string;
  chapterId: string | null;
  label: string;
  createdAt: string;
  characterCount: number;
  foreshadowCount: number;
  worldRuleCount: number;
}

/** 一次快照所覆盖的全部权威状态 */
export interface FactSourceState {
  characters: Character[];
  characterStates: CharacterState[];
  stateFacts: CharacterStateFact[];
  receipts: FinalizationReceipt[];
  foreshadows: Foreshadow[];
  resources: Resource[];
  timelineEvents: TimelineEvent[];
  worldRules: WorldRule[];
}

/** 章纲声明 —— 驱动按需装配 */
export interface ChapterSpec {
  volumeId?: string | null;
  ordinal: number;
  title: string;
  outline: string;
  characterIds: string[];
  locations: string[];
  foreshadows: ForeshadowUse[];
  emotionTags: string[];
  hookType?: HookType | null;
  strand?: Strand | null;
  worldRuleCategories?: string[];
}
