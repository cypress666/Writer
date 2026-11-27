/** SQLite 行 → 领域模型的转换工具。集中处理 snake_case、JSON 列与布尔值。 */

import type {
  Ability,
  Book,
  Chapter,
  Character,
  CharacterState,
  CharacterStateEvent,
  CharacterStateFact,
  ChapterStatus,
  FinalizationReceipt,
  Foreshadow,
  ForeshadowKind,
  ForeshadowStatus,
  ForeshadowUse,
  HookType,
  Relation,
  StateProvenance,
  Resource,
  TimelineEvent,
  Volume,
  WorldRule,
} from '../domain/models.js';

export type Row = Record<string, unknown>;

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function toBool(value: unknown): boolean {
  return value === 1 || value === true;
}

export function now(): string {
  return new Date().toISOString();
}

export function str(value: unknown): string {
  return value == null ? '' : String(value);
}

export function nullableStr(value: unknown): string | null {
  return value == null ? null : String(value);
}

export function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export function nullableNum(value: unknown): number | null {
  return value == null ? null : num(value);
}

export function mapBook(row: Row): Book {
  return {
    id: str(row.id),
    title: str(row.title),
    outline: str(row.outline),
    genreId: row.genre_id == null ? null : str(row.genre_id),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapVolume(row: Row): Volume {
  return {
    id: str(row.id),
    bookId: str(row.book_id),
    outline: str(row.outline),
    title: str(row.title),
    ordinal: num(row.ordinal),
    createdAt: str(row.created_at),
  };
}

export function mapChapter(row: Row): Chapter {
  return {
    id: str(row.id),
    bookId: str(row.book_id),
    volumeId: nullableStr(row.volume_id),
    ordinal: num(row.ordinal),
    title: str(row.title),
    outline: str(row.outline),
    content: nullableStr(row.content),
    status: str(row.status) as ChapterStatus,
    declaredCharacters: parseJson<string[]>(row.declared_characters, []),
    declaredLocations: parseJson<string[]>(row.declared_locations, []),
    declaredForeshadows: parseJson<ForeshadowUse[]>(row.declared_foreshadows, []),
    emotionTags: parseJson<string[]>(row.emotion_tags, []),
    hookType: nullableStr(row.hook_type) as HookType | null,
    strand: nullableStr(row.strand) as Chapter['strand'],
    targetWords: nullableNum(row.target_words),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapCharacter(row: Row): Character {
  return {
    id: str(row.id),
    bookId: str(row.book_id),
    name: str(row.name),
    aliases: parseJson<string[]>(row.aliases, []),
    isAlive: toBool(row.is_alive),
    notes: str(row.notes),
    createdAt: str(row.created_at),
  };
}

export function mapCharacterState(row: Row): CharacterState {
  return {
    characterId: str(row.character_id),
    location: nullableStr(row.location),
    abilities: parseJson<Ability[]>(row.abilities, []),
    relations: parseJson<Relation[]>(row.relations, []),
    knownFacts: parseJson<string[]>(row.known_facts, []),
    updatedInChapterId: nullableStr(row.updated_in_chapter_id),
    updatedAt: str(row.updated_at),
    fieldProvenance: parseJson<CharacterState['fieldProvenance']>(row.field_provenance, {}),
  };
}

export function mapCharacterStateEvent(row: Row): CharacterStateEvent {
  return {
    id: str(row.id),
    bookId: str(row.book_id),
    characterId: str(row.character_id),
    chapterId: nullableStr(row.chapter_id),
    eventType: str(row.event_type) as CharacterStateEvent['eventType'],
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    createdAt: str(row.created_at),
  };
}

export function mapStateFact(row: Row): CharacterStateFact {
  return {
    id: str(row.id),
    bookId: str(row.book_id),
    characterId: str(row.character_id),
    field: str(row.field),
    valueJson: str(row.value_json),
    provenance: str(row.provenance) as StateProvenance,
    effectiveChapter: num(row.effective_chapter),
    sourceReceiptId: nullableStr(row.source_receipt_id),
    stale: toBool(row.stale),
    createdAt: str(row.created_at),
  };
}

export function mapReceipt(row: Row): FinalizationReceipt {
  return {
    id: str(row.id),
    bookId: str(row.book_id),
    chapterId: str(row.chapter_id),
    chapterOrdinal: num(row.chapter_ordinal),
    draftId: str(row.draft_id),
    contentHash: str(row.content_hash),
    finalizedAt: str(row.finalized_at),
    supersededBy: nullableStr(row.superseded_by),
  };
}

export function mapForeshadow(row: Row): Foreshadow {
  return {
    id: str(row.id),
    bookId: str(row.book_id),
    title: str(row.title),
    description: str(row.description),
    kind: str(row.kind) as ForeshadowKind,
    plantedInChapterId: nullableStr(row.planted_in_chapter_id),
    plannedResolveOrdinal: nullableNum(row.planned_resolve_ordinal),
    resolvedInChapterId: nullableStr(row.resolved_in_chapter_id),
    resolutionMarkers: parseJson<string[]>(row.resolution_markers, []),
    status: str(row.status) as ForeshadowStatus,
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapResource(row: Row): Resource {
  return {
    id: str(row.id),
    bookId: str(row.book_id),
    name: str(row.name),
    category: str(row.category),
    holderCharacterId: nullableStr(row.holder_character_id),
    quantity: num(row.quantity),
    notes: str(row.notes),
    updatedInChapterId: nullableStr(row.updated_in_chapter_id),
    updatedAt: str(row.updated_at),
  };
}

export function mapTimelineEvent(row: Row): TimelineEvent {
  return {
    id: str(row.id),
    bookId: str(row.book_id),
    chapterId: nullableStr(row.chapter_id),
    storyTime: str(row.story_time),
    storyOrder: num(row.story_order),
    description: str(row.description),
    createdAt: str(row.created_at),
  };
}

export function mapWorldRule(row: Row): WorldRule {
  return {
    id: str(row.id),
    bookId: str(row.book_id),
    category: str(row.category),
    rule: str(row.rule),
    priority: num(row.priority),
    createdAt: str(row.created_at),
  };
}
