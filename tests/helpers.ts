import type { SqliteDatabase } from '../src/db/sqlite.js';
import type {
  Ability,
  Book,
  Chapter,
  ChapterSpec,
  Character,
  CharacterState,
  CharacterStateFact,
  FactSourceState,
  FinalizationReceipt,
  Foreshadow,
  HookType,
  Resource,
  StateProvenance,
  Strand,
  TimelineEvent,
  WorldRule,
} from '../src/domain/models.js';
import { BookRepository, FactSourceRepository, SnapshotRepository, openDatabase } from '../src/index.js';

export function createTestHarness(): {
  db: SqliteDatabase;
  books: BookRepository;
  facts: FactSourceRepository;
  snapshots: SnapshotRepository;
  book: Book;
} {
  const db = openDatabase(':memory:');
  const books = new BookRepository(db);
  const facts = new FactSourceRepository(db);
  const snapshots = new SnapshotRepository(db, facts);
  const book: Book = books.createBook({ id: 'book-1', title: '测试作品' });
  // 预置标准章节，使事实源中的章节引用（埋设章、变更章、回收章）满足外键约束
  for (let ordinal = 0; ordinal <= 10; ordinal += 1) {
    books.createChapter({ id: `ch-${ordinal}`, bookId: 'book-1', ordinal, title: `第${ordinal}章` });
  }
  return { db, books, facts, snapshots, book };
}

export function makeChapter(overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: 'ch-1',
    bookId: 'book-1',
    volumeId: null,
    ordinal: 1,
    title: '第一章',
    outline: '',
    content: '',
    status: 'draft',
    declaredCharacters: [],
    declaredLocations: [],
    declaredForeshadows: [],
    emotionTags: [],
    hookType: null,
    strand: null as Strand | null,
    targetWords: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeSpec(overrides: Partial<ChapterSpec> = {}): ChapterSpec {
  return {
    ordinal: 1,
    title: '第一章',
    outline: '',
    characterIds: [],
    locations: [],
    foreshadows: [],
    emotionTags: [],
    ...overrides,
  };
}

export function makeForeshadow(overrides: Partial<Foreshadow> = {}): Foreshadow {
  return {
    id: 'fs-1',
    bookId: 'book-1',
    title: '神秘玉佩',
    description: '',
    kind: 'main',
    plantedInChapterId: 'ch-0',
    plannedResolveOrdinal: 5,
    resolvedInChapterId: null,
    resolutionMarkers: ['玉佩碎裂'],
    status: 'planted',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-1',
    bookId: 'book-1',
    name: '林风',
    aliases: [],
    isAlive: true,
    notes: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    characterId: 'char-1',
    location: '青云城',
    abilities: [],
    relations: [],
    knownFacts: [],
    updatedInChapterId: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    fieldProvenance: {},
    ...overrides,
  };
}

export function makeStateFact(overrides: Partial<CharacterStateFact> = {}): CharacterStateFact {
  return {
    id: 'fact-1',
    bookId: 'book-1',
    characterId: 'char-1',
    field: 'location',
    valueJson: '"青云城"',
    provenance: 'author' as StateProvenance,
    effectiveChapter: 0,
    sourceReceiptId: null,
    stale: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeReceipt(overrides: Partial<FinalizationReceipt> = {}): FinalizationReceipt {
  return {
    id: 'receipt-1',
    bookId: 'book-1',
    chapterId: 'ch-1',
    chapterOrdinal: 1,
    draftId: 'draft-1',
    contentHash: 'abc123',
    finalizedAt: '2026-01-01T00:00:00.000Z',
    supersededBy: null,
    ...overrides,
  };
}

export function makeAbility(overrides: Partial<Ability> = {}): Ability {
  return { id: 'ab-1', name: '灵力', level: 1, ...overrides };
}

export function makeWorldRule(overrides: Partial<WorldRule> = {}): WorldRule {
  return {
    id: 'rule-1',
    bookId: 'book-1',
    category: 'combat',
    rule: '金丹期不可越阶击败元婴',
    priority: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeResource(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'res-1',
    bookId: 'book-1',
    name: '灵石',
    category: 'currency',
    holderCharacterId: null,
    quantity: 100,
    notes: '',
    updatedInChapterId: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeTimelineEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: 'tl-1',
    bookId: 'book-1',
    chapterId: null,
    storyTime: '第三年',
    storyOrder: 3,
    description: '宗门大比',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeFactSourceState(overrides: Partial<FactSourceState> = {}): FactSourceState {
  return {
    characters: [],
    characterStates: [],
    stateFacts: [],
    receipts: [],
    foreshadows: [],
    resources: [],
    timelineEvents: [],
    worldRules: [],
    ...overrides,
  };
}

/** 生成指定长度的中文正文，避免测试中出现无意义的短文本 */
export function chineseText(length: number, seed = '灵气复苏的都市之中少年缓缓睁开双眼'): string {
  let result = '';
  while (result.length < length) result += seed;
  return result.slice(0, length);
}

export const HOOK_TYPES: HookType[] = ['cliffhanger', 'revelation', 'conflict', 'emotional', 'question'];
