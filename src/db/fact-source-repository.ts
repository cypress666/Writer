/**
 * 单一事实源仓储 —— 所有角色状态、伏笔、资源、时间线、世界规则的唯一读写口。
 *
 * 关键纪律：
 * 1. 角色状态的权威来源是 character_state_facts（字段级、带来源与生效章）；
 *    character_states 是可重建的物化投影。
 * 2. 派生值（derived）永不覆盖作者值（author）；收据失效只标 stale，不删作者事实。
 * 3. 正文写入（BookRepository.updateChapterContent）不会隐式改变事实。
 * 4. restoreState 在事务中整体替换权威状态，供快照回退使用。
 */

import { createHash } from 'node:crypto';
import type { SqliteDatabase } from './sqlite.js';
import type {
  Ability,
  Character,
  CharacterState,
  CharacterStateEvent,
  CharacterStateFact,
  FactSourceState,
  FinalizationReceipt,
  Foreshadow,
  ForeshadowKind,
  Relation,
  Resource,
  StateEventType,
  StateProvenance,
  TimelineEvent,
  WorldRule,
} from '../domain/models.js';
import { newId } from './id.js';
import {
  mapCharacter,
  mapCharacterState,
  mapCharacterStateEvent,
  mapForeshadow,
  mapReceipt,
  mapResource,
  mapStateFact,
  mapTimelineEvent,
  mapWorldRule,
  now,
  toJson,
  type Row,
} from './mappers.js';

export interface CreateCharacterInput {
  id?: string;
  bookId: string;
  name: string;
  aliases?: string[];
  isAlive?: boolean;
  notes?: string;
  initialState?: CharacterStatePatch;
}

export interface CharacterStatePatch {
  location?: string | null;
  abilities?: Ability[];
  relations?: Relation[];
  knownFacts?: string[];
}

export interface CreateForeshadowInput {
  id?: string;
  bookId: string;
  title: string;
  description?: string;
  kind?: ForeshadowKind;
  plantedInChapterId?: string | null;
  plannedResolveOrdinal?: number | null;
  resolutionMarkers?: string[];
}

export interface CreateResourceInput {
  id?: string;
  bookId: string;
  name: string;
  category?: string;
  holderCharacterId?: string | null;
  quantity?: number;
  notes?: string;
}

export interface CreateTimelineEventInput {
  id?: string;
  bookId: string;
  chapterId?: string | null;
  storyTime: string;
  storyOrder: number;
  description: string;
}

export interface CreateWorldRuleInput {
  id?: string;
  bookId: string;
  category: string;
  rule: string;
  priority?: number;
}

export class FactSourceRepository {
  constructor(private readonly db: SqliteDatabase) {}

  // ---------------------------------------------------------------- 角色

  createCharacter(input: CreateCharacterInput): Character {
    const character: Character = {
      id: input.id ?? newId(),
      bookId: input.bookId,
      name: input.name,
      aliases: input.aliases ?? [],
      isAlive: input.isAlive ?? true,
      notes: input.notes ?? '',
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO characters (id, book_id, name, aliases, is_alive, notes, created_at)
         VALUES (@id, @bookId, @name, @aliases, @isAlive, @notes, @createdAt)`,
      )
      .run({
        id: character.id,
        bookId: character.bookId,
        name: character.name,
        aliases: toJson(character.aliases),
        isAlive: character.isAlive ? 1 : 0,
        notes: character.notes,
        createdAt: character.createdAt,
      });

    const patch = input.initialState ?? {};
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO character_states
            (character_id, location, abilities, relations, known_facts, updated_in_chapter_id, updated_at)
           VALUES (@characterId, @location, @abilities, @relations, @knownFacts, NULL, @updatedAt)`,
        )
        .run({
          characterId: character.id,
          location: patch.location ?? null,
          abilities: toJson(patch.abilities ?? []),
          relations: toJson(patch.relations ?? []),
          knownFacts: toJson(patch.knownFacts ?? []),
          updatedAt: now(),
        });

      // 初始状态是作者明确输入 → 记为 author 事实，生效章 0
      const initialFields: Array<[string, unknown]> = [
        ['location', patch.location ?? null],
        ['abilities', patch.abilities ?? []],
        ['relations', patch.relations ?? []],
        ['knownFacts', patch.knownFacts ?? []],
      ];
      for (const [field, value] of initialFields) {
        this.insertStateFact({
          bookId: input.bookId,
          characterId: character.id,
          field,
          value,
          provenance: 'author',
          effectiveChapter: 0,
          sourceReceiptId: null,
        });
      }
    })();
    return character;
  }

  getCharacter(id: string): Character | null {
    const row = this.db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as Row | undefined;
    return row ? mapCharacter(row) : null;
  }

  /** 只改角色元数据；存活状态与状态字段请走 setCharacterAlive / updateCharacterState */
  updateCharacter(
    id: string,
    patch: Partial<Pick<Character, 'name' | 'aliases' | 'notes'>>,
  ): Character {
    const current = this.getCharacter(id);
    if (!current) throw new Error(`Character not found: ${id}`);
    this.db
      .prepare('UPDATE characters SET name = ?, aliases = ?, notes = ? WHERE id = ?')
      .run(
        patch.name?.trim() || current.name,
        toJson(patch.aliases ?? current.aliases),
        patch.notes ?? current.notes,
        id,
      );
    return this.getCharacter(id)!;
  }

  deleteCharacter(id: string): void {
    this.db.prepare('DELETE FROM characters WHERE id = ?').run(id);
  }

  findCharacterByName(bookId: string, name: string): Character | null {
    const row = this.db
      .prepare('SELECT * FROM characters WHERE book_id = ? AND name = ?')
      .get(bookId, name) as Row | undefined;
    return row ? mapCharacter(row) : null;
  }

  listCharacters(bookId: string): Character[] {
    const rows = this.db
      .prepare('SELECT * FROM characters WHERE book_id = ? ORDER BY name')
      .all(bookId) as Row[];
    return rows.map(mapCharacter);
  }

  getCharacterState(characterId: string): CharacterState | null {
    const row = this.db
      .prepare('SELECT * FROM character_states WHERE character_id = ?')
      .get(characterId) as Row | undefined;
    return row ? mapCharacterState(row) : null;
  }

  // ------------------------------------------------- 字段级事实与来源分层

  /** 写入一条字段级事实。author 值一旦存在，derived 不得覆盖。 */
  insertStateFact(input: {
    bookId: string;
    characterId: string;
    field: string;
    value: unknown;
    provenance: StateProvenance;
    effectiveChapter: number;
    sourceReceiptId?: string | null;
  }): CharacterStateFact {
    // 派生值遇到已存在的作者值直接忽略，这是"派生不得反向覆盖作者事实"的硬约束
    if (input.provenance === 'derived') {
      const authorFact = this.db
        .prepare(
          `SELECT * FROM character_state_facts
           WHERE character_id = ? AND field = ? AND provenance = 'author' AND stale = 0
           ORDER BY effective_chapter DESC LIMIT 1`,
        )
        .get(input.characterId, input.field) as Row | undefined;
      // 只在同章（含更早）覆盖作者值时拒绝：作者值只在其已知时点有效，
      // 更晚生效章的派生值可以写入，由 stateAt 按章取值自然裁决。
      if (authorFact && input.effectiveChapter <= Number((authorFact as Row).effective_chapter)) {
        return mapStateFact(authorFact);
      }
    }

    const fact: CharacterStateFact = {
      id: newId(),
      bookId: input.bookId,
      characterId: input.characterId,
      field: input.field,
      valueJson: toJson(input.value),
      provenance: input.provenance,
      effectiveChapter: input.effectiveChapter,
      sourceReceiptId: input.sourceReceiptId ?? null,
      stale: false,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO character_state_facts
          (id, book_id, character_id, field, value_json, provenance, effective_chapter,
           source_receipt_id, stale, created_at)
         VALUES (@id, @bookId, @characterId, @field, @valueJson, @provenance,
                 @effectiveChapter, @sourceReceiptId, @stale, @createdAt)`,
      )
      .run({
        ...fact,
        valueJson: fact.valueJson,
        stale: fact.stale ? 1 : 0,
      });
    return fact;
  }

  listStateFacts(bookId: string, characterId?: string): CharacterStateFact[] {
    const rows = characterId
      ? (this.db
          .prepare('SELECT * FROM character_state_facts WHERE book_id = ? AND character_id = ? ORDER BY effective_chapter, created_at')
          .all(bookId, characterId) as Row[])
      : (this.db
          .prepare('SELECT * FROM character_state_facts WHERE book_id = ? ORDER BY effective_chapter, created_at')
          .all(bookId) as Row[]);
    return rows.map(mapStateFact);
  }

  /**
   * 按章取状态：对每个字段，先取 effectiveChapter<=N 的最大生效章，
   * 同章内再按来源优先级 author > derived > legacy 与创建时间裁决。
   * stale 的派生值不参与。补写前面的章不会读到后文才发生的状态。
   */
  stateAt(characterId: string, chapterOrdinal: number): Record<string, unknown> {
    const rows = this.db
      .prepare(
        `SELECT * FROM character_state_facts
         WHERE character_id = ? AND effective_chapter <= ?
         ORDER BY effective_chapter DESC, created_at DESC, rowid DESC`,
      )
      .all(characterId, chapterOrdinal) as Row[];
    const rank: Record<StateProvenance, number> = { author: 3, derived: 2, legacy: 1 };
    const chosen = new Map<string, { chapter: number; rank: number; value: unknown }>();

    for (const row of rows) {
      const fact = mapStateFact(row);
      if (fact.stale && fact.provenance === 'derived') continue;
      const current = chosen.get(fact.field);
      if (!current) {
        chosen.set(fact.field, {
          chapter: fact.effectiveChapter,
          rank: rank[fact.provenance],
          value: JSON.parse(fact.valueJson),
        });
        continue;
      }
      // 更大生效章优先；同章时来源优先级更高者才覆盖
      if (fact.effectiveChapter > current.chapter) continue; // 已按章倒序，理论上不会发生
      if (fact.effectiveChapter === current.chapter && rank[fact.provenance] > current.rank) {
        chosen.set(fact.field, {
          chapter: fact.effectiveChapter,
          rank: rank[fact.provenance],
          value: JSON.parse(fact.valueJson),
        });
      }
    }

    const plain: Record<string, unknown> = {};
    for (const [field, entry] of chosen) plain[field] = entry.value;
    return plain;
  }

  /** 从字段级事实重建 character_states 物化投影，可安全重放 */
  materializeProjection(bookId: string, currentOrdinal: number = Number.MAX_SAFE_INTEGER): void {
    for (const character of this.listCharacters(bookId)) {
      const state = this.stateAt(character.id, currentOrdinal);
      const fields: Record<string, unknown> = {
        location: state.location ?? null,
        abilities: state.abilities ?? [],
        relations: state.relations ?? [],
        knownFacts: state.knownFacts ?? [],
      };
      this.db
        .prepare(
          `UPDATE character_states SET
            location = @location, abilities = @abilities, relations = @relations,
            known_facts = @knownFacts, updated_at = @updatedAt
           WHERE character_id = @characterId`,
        )
        .run({
          characterId: character.id,
          location: fields.location,
          abilities: toJson(fields.abilities),
          relations: toJson(fields.relations),
          knownFacts: toJson(fields.knownFacts),
          updatedAt: now(),
        });
    }
  }

  // ------------------------------------------------------------ 定稿收据

  /** 以正文哈希定位不可变定稿；替换定稿时旧收据标记 superseded */
  finalizeChapter(input: {
    bookId: string;
    chapterId: string;
    chapterOrdinal: number;
    draftId: string;
    content: string;
  }): FinalizationReceipt {
    const contentHash = createHash('sha256').update(input.content, 'utf8').digest('hex');
    const receipt: FinalizationReceipt = {
      id: newId(),
      bookId: input.bookId,
      chapterId: input.chapterId,
      chapterOrdinal: input.chapterOrdinal,
      draftId: input.draftId,
      contentHash,
      finalizedAt: now(),
      supersededBy: null,
    };
    this.db.transaction(() => {
      // 先收集旧收据 id，再插入新收据，最后回填 superseded_by。
      // 顺序不能反：superseded_by 是自引用外键，指向尚未插入的行会违反约束。
      const oldIds = (
        this.db
          .prepare('SELECT id FROM finalization_receipts WHERE chapter_id = ? AND superseded_by IS NULL')
          .all(input.chapterId) as Array<{ id: string }>
      ).map((row) => row.id);

      this.db
        .prepare(
          `INSERT INTO finalization_receipts
            (id, book_id, chapter_id, chapter_ordinal, draft_id, content_hash, finalized_at, superseded_by)
           VALUES (@id, @bookId, @chapterId, @chapterOrdinal, @draftId, @contentHash, @finalizedAt, NULL)`,
        )
        .run(receipt);

      const mark = this.db.prepare('UPDATE finalization_receipts SET superseded_by = ? WHERE id = ?');
      for (const oldId of oldIds) mark.run(receipt.id, oldId);
      this.markStaleByReceipt(input.chapterId, receipt.id);
    })();
    return receipt;
  }

  /** 收据被替换时，只把绑定到旧收据的派生值标 stale，不删除作者事实 */
  private markStaleByReceipt(chapterId: string, newReceiptId: string): void {
    this.db
      .prepare(
        `UPDATE character_state_facts
         SET stale = 1
         WHERE provenance = 'derived'
           AND stale = 0
           AND source_receipt_id IN (
             SELECT id FROM finalization_receipts
             WHERE chapter_id = ? AND id != ? AND superseded_by IS NOT NULL
           )`,
      )
      .run(chapterId, newReceiptId);
  }

  listReceipts(bookId: string): FinalizationReceipt[] {
    const rows = this.db
      .prepare('SELECT * FROM finalization_receipts WHERE book_id = ? ORDER BY chapter_ordinal, finalized_at')
      .all(bookId) as Row[];
    return rows.map(mapReceipt);
  }

  getReceipt(id: string): FinalizationReceipt | null {
    const row = this.db.prepare('SELECT * FROM finalization_receipts WHERE id = ?').get(id) as Row | undefined;
    return row ? mapReceipt(row) : null;
  }

  /** 合并式更新状态；每个变化字段生成一条事件，供追溯与回退 */
  updateCharacterState(
    bookId: string,
    characterId: string,
    patch: CharacterStatePatch,
    chapterId: string | null = null,
  ): CharacterState {
    const existing = this.getCharacterState(characterId);
    if (!existing) throw new Error(`Character state not found: ${characterId}`);

    const next: CharacterState = {
      ...existing,
      location: patch.location !== undefined ? patch.location : existing.location,
      abilities: patch.abilities ?? existing.abilities,
      relations: patch.relations ?? existing.relations,
      knownFacts: patch.knownFacts ?? existing.knownFacts,
      updatedInChapterId: chapterId,
      updatedAt: now(),
    };

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE character_states SET
            location = @location, abilities = @abilities, relations = @relations,
            known_facts = @knownFacts, updated_in_chapter_id = @chapterId, updated_at = @updatedAt
           WHERE character_id = @characterId`,
        )
        .run({
          characterId,
          location: next.location,
          abilities: toJson(next.abilities),
          relations: toJson(next.relations),
          knownFacts: toJson(next.knownFacts),
          chapterId,
          updatedAt: next.updatedAt,
        });

      if (patch.location !== undefined && patch.location !== existing.location) {
        this.addStateEvent(bookId, characterId, chapterId, 'location', {
          from: existing.location,
          to: next.location,
        });
      }
      if (patch.abilities !== undefined) {
        this.addStateEvent(bookId, characterId, chapterId, 'ability', {
          from: existing.abilities,
          to: next.abilities,
        });
      }
      if (patch.relations !== undefined) {
        this.addStateEvent(bookId, characterId, chapterId, 'relation', {
          from: existing.relations,
          to: next.relations,
        });
      }
      if (patch.knownFacts !== undefined) {
        this.addStateEvent(bookId, characterId, chapterId, 'known_fact', {
          from: existing.knownFacts,
          to: next.knownFacts,
        });
      }

      // 作者显式修改 → 记为 author 事实，生效章由调用方指定（缺省 0）
      const effectiveChapter = chapterId ? this.chapterOrdinal(chapterId) : 0;
      const factFields: Array<[string, unknown, boolean]> = [
        ['location', next.location, patch.location !== undefined],
        ['abilities', next.abilities, patch.abilities !== undefined],
        ['relations', next.relations, patch.relations !== undefined],
        ['knownFacts', next.knownFacts, patch.knownFacts !== undefined],
      ];
      for (const [field, value, changed] of factFields) {
        if (changed) {
          this.insertStateFact({
            bookId,
            characterId,
            field,
            value,
            provenance: 'author',
            effectiveChapter,
          });
        }
      }
    })();

    return next;
  }

  setCharacterAlive(
    bookId: string,
    characterId: string,
    isAlive: boolean,
    chapterId: string | null = null,
  ): Character {
    const character = this.getCharacter(characterId);
    if (!character) throw new Error(`Character not found: ${characterId}`);
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE characters SET is_alive = ? WHERE id = ?')
        .run(isAlive ? 1 : 0, characterId);
      if (character.isAlive !== isAlive) {
        this.addStateEvent(bookId, characterId, chapterId, 'alive', {
          from: character.isAlive,
          to: isAlive,
        });
      }
    })();
    return this.getCharacter(characterId)!;
  }

  listStateEvents(bookId: string, characterId?: string): CharacterStateEvent[] {
    const rows = characterId
      ? (this.db
          .prepare(
            'SELECT * FROM character_state_events WHERE book_id = ? AND character_id = ? ORDER BY created_at, rowid',
          )
          .all(bookId, characterId) as Row[])
      : (this.db
          .prepare('SELECT * FROM character_state_events WHERE book_id = ? ORDER BY created_at, rowid')
          .all(bookId) as Row[]);
    return rows.map(mapCharacterStateEvent);
  }

  private chapterOrdinal(chapterId: string): number {
    const row = this.db.prepare('SELECT ordinal FROM chapters WHERE id = ?').get(chapterId) as
      | { ordinal: number }
      | undefined;
    return row ? Number(row.ordinal) : 0;
  }

  private addStateEvent(
    bookId: string,
    characterId: string,
    chapterId: string | null,
    eventType: StateEventType,
    payload: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO character_state_events
          (id, book_id, character_id, chapter_id, event_type, payload, created_at)
         VALUES (@id, @bookId, @characterId, @chapterId, @eventType, @payload, @createdAt)`,
      )
      .run({
        id: newId(),
        bookId,
        characterId,
        chapterId,
        eventType,
        payload: toJson(payload),
        createdAt: now(),
      });
  }

  // ---------------------------------------------------------------- 伏笔

  createForeshadow(input: CreateForeshadowInput): Foreshadow {
    const timestamp = now();
    const foreshadow: Foreshadow = {
      id: input.id ?? newId(),
      bookId: input.bookId,
      title: input.title,
      description: input.description ?? '',
      kind: input.kind ?? 'sub',
      plantedInChapterId: input.plantedInChapterId ?? null,
      plannedResolveOrdinal: input.plannedResolveOrdinal ?? null,
      resolvedInChapterId: null,
      resolutionMarkers: input.resolutionMarkers ?? [],
      status: 'planted',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO foreshadows (
          id, book_id, title, description, kind, planted_in_chapter_id,
          planned_resolve_ordinal, resolved_in_chapter_id, resolution_markers,
          status, created_at, updated_at
        ) VALUES (
          @id, @bookId, @title, @description, @kind, @plantedInChapterId,
          @plannedResolveOrdinal, @resolvedInChapterId, @resolutionMarkers,
          @status, @createdAt, @updatedAt
        )`,
      )
      .run({
        id: foreshadow.id,
        bookId: foreshadow.bookId,
        title: foreshadow.title,
        description: foreshadow.description,
        kind: foreshadow.kind,
        plantedInChapterId: foreshadow.plantedInChapterId,
        plannedResolveOrdinal: foreshadow.plannedResolveOrdinal,
        resolvedInChapterId: null,
        resolutionMarkers: toJson(foreshadow.resolutionMarkers),
        status: foreshadow.status,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    return foreshadow;
  }

  getForeshadow(id: string): Foreshadow | null {
    const row = this.db.prepare('SELECT * FROM foreshadows WHERE id = ?').get(id) as Row | undefined;
    return row ? mapForeshadow(row) : null;
  }

  listForeshadows(bookId: string): Foreshadow[] {
    const rows = this.db
      .prepare('SELECT * FROM foreshadows WHERE book_id = ? ORDER BY created_at')
      .all(bookId) as Row[];
    return rows.map(mapForeshadow);
  }

  updateForeshadow(
    id: string,
    patch: Partial<
      Pick<
        Foreshadow,
        'title' | 'description' | 'kind' | 'plantedInChapterId' | 'plannedResolveOrdinal' | 'resolutionMarkers' | 'status'
      >
    >,
  ): Foreshadow {
    const current = this.getForeshadow(id);
    if (!current) throw new Error(`Foreshadow not found: ${id}`);
    this.db
      .prepare(
        `UPDATE foreshadows SET
          title = @title, description = @description, kind = @kind,
          planted_in_chapter_id = @planted, planned_resolve_ordinal = @planned,
          resolution_markers = @markers, status = @status, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        title: patch.title?.trim() || current.title,
        description: patch.description ?? current.description,
        kind: patch.kind ?? current.kind,
        planted: patch.plantedInChapterId === undefined ? current.plantedInChapterId : patch.plantedInChapterId,
        planned:
          patch.plannedResolveOrdinal === undefined
            ? current.plannedResolveOrdinal
            : patch.plannedResolveOrdinal,
        markers: toJson(patch.resolutionMarkers ?? current.resolutionMarkers),
        status: patch.status ?? current.status,
        updatedAt: now(),
      });
    return this.getForeshadow(id)!;
  }

  deleteForeshadow(id: string): void {
    this.db.prepare('DELETE FROM foreshadows WHERE id = ?').run(id);
  }

  markForeshadowAdvancing(id: string, chapterId: string): Foreshadow {
    const current = this.getForeshadow(id);
    if (!current) throw new Error(`Foreshadow not found: ${id}`);
    if (current.status === 'resolved' || current.status === 'abandoned') return current;
    this.db
      .prepare('UPDATE foreshadows SET status = ?, updated_at = ? WHERE id = ?')
      .run('advancing', now(), id);
    return this.getForeshadow(id)!;
  }

  resolveForeshadow(id: string, chapterId: string): Foreshadow {
    const current = this.getForeshadow(id);
    if (!current) throw new Error(`Foreshadow not found: ${id}`);
    this.db
      .prepare(
        `UPDATE foreshadows SET status = 'resolved', resolved_in_chapter_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(chapterId, now(), id);
    return this.getForeshadow(id)!;
  }

  abandonForeshadow(id: string): Foreshadow {
    this.db
      .prepare(`UPDATE foreshadows SET status = 'abandoned', updated_at = ? WHERE id = ?`)
      .run(now(), id);
    return this.getForeshadow(id)!;
  }

  /** 逾期未回收：仅主线伏笔触发强制提醒，支线仅作提示 */
  listOverdueForeshadows(bookId: string, currentOrdinal: number): Foreshadow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM foreshadows
         WHERE book_id = ?
           AND status IN ('planted', 'advancing')
           AND planned_resolve_ordinal IS NOT NULL
           AND planned_resolve_ordinal < ?
         ORDER BY planned_resolve_ordinal`,
      )
      .all(bookId, currentOrdinal) as Row[];
    return rows.map(mapForeshadow);
  }

  // ---------------------------------------------------------------- 资源

  createResource(input: CreateResourceInput): Resource {
    const resource: Resource = {
      id: input.id ?? newId(),
      bookId: input.bookId,
      name: input.name,
      category: input.category ?? '',
      holderCharacterId: input.holderCharacterId ?? null,
      quantity: input.quantity ?? 0,
      notes: input.notes ?? '',
      updatedInChapterId: null,
      updatedAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO resources
          (id, book_id, name, category, holder_character_id, quantity, notes, updated_in_chapter_id, updated_at)
         VALUES (@id, @bookId, @name, @category, @holderCharacterId, @quantity, @notes, NULL, @updatedAt)`,
      )
      .run({
        id: resource.id,
        bookId: resource.bookId,
        name: resource.name,
        category: resource.category,
        holderCharacterId: resource.holderCharacterId,
        quantity: resource.quantity,
        notes: resource.notes,
        updatedAt: resource.updatedAt,
      });
    return resource;
  }

  updateResource(
    id: string,
    patch: Partial<Pick<Resource, 'quantity' | 'holderCharacterId' | 'notes'>>,
    chapterId: string | null = null,
  ): Resource {
    const current = this.db.prepare('SELECT * FROM resources WHERE id = ?').get(id) as Row | undefined;
    if (!current) throw new Error(`Resource not found: ${id}`);
    this.db
      .prepare(
        `UPDATE resources SET quantity = ?, holder_character_id = ?, notes = ?, updated_in_chapter_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.quantity ?? (current.quantity as number),
        patch.holderCharacterId !== undefined
          ? patch.holderCharacterId
          : (current.holder_character_id as string | null),
        patch.notes ?? (current.notes as string),
        chapterId,
        now(),
        id,
      );
    return mapResource(this.db.prepare('SELECT * FROM resources WHERE id = ?').get(id) as Row);
  }

  listResources(bookId: string): Resource[] {
    const rows = this.db
      .prepare('SELECT * FROM resources WHERE book_id = ? ORDER BY name')
      .all(bookId) as Row[];
    return rows.map(mapResource);
  }

  deleteResource(id: string): void {
    this.db.prepare('DELETE FROM resources WHERE id = ?').run(id);
  }

  // ---------------------------------------------------------------- 时间线与规则

  createTimelineEvent(input: CreateTimelineEventInput): TimelineEvent {
    const event: TimelineEvent = {
      id: input.id ?? newId(),
      bookId: input.bookId,
      chapterId: input.chapterId ?? null,
      storyTime: input.storyTime,
      storyOrder: input.storyOrder,
      description: input.description,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO timeline_events (id, book_id, chapter_id, story_time, story_order, description, created_at)
         VALUES (@id, @bookId, @chapterId, @storyTime, @storyOrder, @description, @createdAt)`,
      )
      .run({
        id: event.id,
        bookId: event.bookId,
        chapterId: event.chapterId,
        storyTime: event.storyTime,
        storyOrder: event.storyOrder,
        description: event.description,
        createdAt: event.createdAt,
      });
    return event;
  }

  listTimelineEvents(bookId: string): TimelineEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM timeline_events WHERE book_id = ? ORDER BY story_order')
      .all(bookId) as Row[];
    return rows.map(mapTimelineEvent);
  }

  updateTimelineEvent(
    id: string,
    patch: Partial<Pick<TimelineEvent, 'chapterId' | 'storyTime' | 'storyOrder' | 'description'>>,
  ): TimelineEvent {
    const row = this.db.prepare('SELECT * FROM timeline_events WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error(`Timeline event not found: ${id}`);
    this.db
      .prepare(
        `UPDATE timeline_events SET chapter_id = ?, story_time = ?, story_order = ?, description = ? WHERE id = ?`,
      )
      .run(
        patch.chapterId === undefined ? row.chapter_id : patch.chapterId,
        patch.storyTime?.trim() || String(row.story_time),
        patch.storyOrder ?? Number(row.story_order),
        patch.description ?? String(row.description),
        id,
      );
    return mapTimelineEvent(this.db.prepare('SELECT * FROM timeline_events WHERE id = ?').get(id) as Row);
  }

  deleteTimelineEvent(id: string): void {
    this.db.prepare('DELETE FROM timeline_events WHERE id = ?').run(id);
  }

  createWorldRule(input: CreateWorldRuleInput): WorldRule {
    const rule: WorldRule = {
      id: input.id ?? newId(),
      bookId: input.bookId,
      category: input.category,
      rule: input.rule,
      priority: input.priority ?? 0,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO world_rules (id, book_id, category, rule, priority, created_at)
         VALUES (@id, @bookId, @category, @rule, @priority, @createdAt)`,
      )
      .run({
        id: rule.id,
        bookId: rule.bookId,
        category: rule.category,
        rule: rule.rule,
        priority: rule.priority,
        createdAt: rule.createdAt,
      });
    return rule;
  }

  updateWorldRule(
    id: string,
    patch: Partial<Pick<WorldRule, 'category' | 'rule' | 'priority'>>,
  ): WorldRule {
    const row = this.db.prepare('SELECT * FROM world_rules WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error(`World rule not found: ${id}`);
    this.db
      .prepare('UPDATE world_rules SET category = ?, rule = ?, priority = ? WHERE id = ?')
      .run(
        patch.category?.trim() || String(row.category),
        patch.rule?.trim() || String(row.rule),
        patch.priority ?? Number(row.priority),
        id,
      );
    return mapWorldRule(this.db.prepare('SELECT * FROM world_rules WHERE id = ?').get(id) as Row);
  }

  deleteWorldRule(id: string): void {
    this.db.prepare('DELETE FROM world_rules WHERE id = ?').run(id);
  }

  listWorldRules(bookId: string, categories?: string[]): WorldRule[] {
    const rows = this.db
      .prepare('SELECT * FROM world_rules WHERE book_id = ? ORDER BY priority DESC, created_at')
      .all(bookId) as Row[];
    const all = rows.map(mapWorldRule);
    if (!categories || categories.length === 0) return all;
    const wanted = new Set(categories);
    return all.filter((rule) => wanted.has(rule.category));
  }

  // ---------------------------------------------------------------- 全量状态

  loadState(bookId: string): FactSourceState {
    return {
      characters: this.listCharacters(bookId),
      characterStates: this.listCharacters(bookId).map((character) =>
        this.getCharacterState(character.id)!,
      ),
      stateFacts: this.listStateFacts(bookId),
      receipts: this.listReceipts(bookId),
      foreshadows: this.listForeshadows(bookId),
      resources: this.listResources(bookId),
      timelineEvents: this.listTimelineEvents(bookId),
      worldRules: this.listWorldRules(bookId),
    };
  }

  /**
   * 事务化整体替换权威状态（回退专用）。
   * 不触碰 chapters 正文；正文的差分处理由作者在 GUI 中完成。
   */
  restoreState(bookId: string, state: FactSourceState): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM character_state_events WHERE book_id = ?').run(bookId);
      this.db.prepare('DELETE FROM character_state_facts WHERE book_id = ?').run(bookId);
      this.db.prepare('DELETE FROM character_states WHERE character_id IN (SELECT id FROM characters WHERE book_id = ?)').run(bookId);
      this.db.prepare('DELETE FROM characters WHERE book_id = ?').run(bookId);
      this.db.prepare('DELETE FROM finalization_receipts WHERE book_id = ?').run(bookId);
      this.db.prepare('DELETE FROM foreshadows WHERE book_id = ?').run(bookId);
      this.db.prepare('DELETE FROM resources WHERE book_id = ?').run(bookId);
      this.db.prepare('DELETE FROM timeline_events WHERE book_id = ?').run(bookId);
      this.db.prepare('DELETE FROM world_rules WHERE book_id = ?').run(bookId);

      for (const character of state.characters) {
        this.db
          .prepare(
            `INSERT INTO characters (id, book_id, name, aliases, is_alive, notes, created_at)
             VALUES (@id, @bookId, @name, @aliases, @isAlive, @notes, @createdAt)`,
          )
          .run({
            id: character.id,
            bookId,
            name: character.name,
            aliases: toJson(character.aliases),
            isAlive: character.isAlive ? 1 : 0,
            notes: character.notes,
            createdAt: character.createdAt,
          });
      }
      for (const s of state.characterStates) {
        this.db
          .prepare(
            `INSERT INTO character_states
              (character_id, location, abilities, relations, known_facts, updated_in_chapter_id, updated_at)
             VALUES (@characterId, @location, @abilities, @relations, @knownFacts, @chapterId, @updatedAt)`,
          )
          .run({
            characterId: s.characterId,
            location: s.location,
            abilities: toJson(s.abilities),
            relations: toJson(s.relations),
            knownFacts: toJson(s.knownFacts),
            chapterId: s.updatedInChapterId,
            updatedAt: s.updatedAt,
          });
      }
      for (const r of state.receipts) {
        this.db
          .prepare(
            `INSERT INTO finalization_receipts
              (id, book_id, chapter_id, chapter_ordinal, draft_id, content_hash, finalized_at, superseded_by)
             VALUES (@id, @bookId, @chapterId, @chapterOrdinal, @draftId, @contentHash, @finalizedAt, @supersededBy)`,
          )
          .run({
            id: r.id,
            bookId,
            chapterId: r.chapterId,
            chapterOrdinal: r.chapterOrdinal,
            draftId: r.draftId,
            contentHash: r.contentHash,
            finalizedAt: r.finalizedAt,
            supersededBy: r.supersededBy,
          });
      }
      for (const fact of state.stateFacts) {
        this.db
          .prepare(
            `INSERT INTO character_state_facts
              (id, book_id, character_id, field, value_json, provenance, effective_chapter,
               source_receipt_id, stale, created_at)
             VALUES (@id, @bookId, @characterId, @field, @valueJson, @provenance,
                     @effectiveChapter, @sourceReceiptId, @stale, @createdAt)`,
          )
          .run({
            id: fact.id,
            bookId,
            characterId: fact.characterId,
            field: fact.field,
            valueJson: fact.valueJson,
            provenance: fact.provenance,
            effectiveChapter: fact.effectiveChapter,
            sourceReceiptId: fact.sourceReceiptId,
            stale: fact.stale ? 1 : 0,
            createdAt: fact.createdAt,
          });
      }
      for (const f of state.foreshadows) {
        this.db
          .prepare(
            `INSERT INTO foreshadows (
              id, book_id, title, description, kind, planted_in_chapter_id,
              planned_resolve_ordinal, resolved_in_chapter_id, resolution_markers,
              status, created_at, updated_at
            ) VALUES (
              @id, @bookId, @title, @description, @kind, @plantedInChapterId,
              @plannedResolveOrdinal, @resolvedInChapterId, @resolutionMarkers,
              @status, @createdAt, @updatedAt
            )`,
          )
          .run({
            id: f.id,
            bookId,
            title: f.title,
            description: f.description,
            kind: f.kind,
            plantedInChapterId: f.plantedInChapterId,
            plannedResolveOrdinal: f.plannedResolveOrdinal,
            resolvedInChapterId: f.resolvedInChapterId,
            resolutionMarkers: toJson(f.resolutionMarkers),
            status: f.status,
            createdAt: f.createdAt,
            updatedAt: f.updatedAt,
          });
      }
      for (const r of state.resources) {
        this.db
          .prepare(
            `INSERT INTO resources
              (id, book_id, name, category, holder_character_id, quantity, notes, updated_in_chapter_id, updated_at)
             VALUES (@id, @bookId, @name, @category, @holderCharacterId, @quantity, @notes, @chapterId, @updatedAt)`,
          )
          .run({
            id: r.id,
            bookId,
            name: r.name,
            category: r.category,
            holderCharacterId: r.holderCharacterId,
            quantity: r.quantity,
            notes: r.notes,
            chapterId: r.updatedInChapterId,
            updatedAt: r.updatedAt,
          });
      }
      for (const t of state.timelineEvents) {
        this.db
          .prepare(
            `INSERT INTO timeline_events (id, book_id, chapter_id, story_time, story_order, description, created_at)
             VALUES (@id, @bookId, @chapterId, @storyTime, @storyOrder, @description, @createdAt)`,
          )
          .run({
            id: t.id,
            bookId,
            chapterId: t.chapterId,
            storyTime: t.storyTime,
            storyOrder: t.storyOrder,
            description: t.description,
            createdAt: t.createdAt,
          });
      }
      for (const r of state.worldRules) {
        this.db
          .prepare(
            `INSERT INTO world_rules (id, book_id, category, rule, priority, created_at)
             VALUES (@id, @bookId, @category, @rule, @priority, @createdAt)`,
          )
          .run({
            id: r.id,
            bookId,
            category: r.category,
            rule: r.rule,
            priority: r.priority,
            createdAt: r.createdAt,
          });
      }
    })();
  }
}
