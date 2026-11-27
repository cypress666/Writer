/** 状态快照与定向回退。快照只保存结构化事实，不复制正文。 */

import type { SqliteDatabase } from './sqlite.js';
import type { FactSourceState, SnapshotView, StorySnapshot } from '../domain/models.js';
import { newId } from './id.js';
import { mapCharacter, mapCharacterState, mapForeshadow, mapResource, now, parseJson, type Row } from './mappers.js';
import type { FactSourceRepository } from './fact-source-repository.js';

export interface StateChange {
  entity: 'character' | 'characterState' | 'foreshadow' | 'resource' | 'timeline' | 'worldRule';
  entityId: string;
  field: string;
  before: unknown;
  after: unknown;
}

const TRACKED_FIELDS: Record<StateChange['entity'], readonly string[]> = {
  character: ['name', 'aliases', 'isAlive', 'notes'],
  characterState: ['location', 'abilities', 'relations', 'knownFacts'],
  foreshadow: ['status', 'plannedResolveOrdinal', 'resolvedInChapterId', 'resolutionMarkers'],
  resource: ['quantity', 'holderCharacterId', 'notes'],
  timeline: ['storyTime', 'storyOrder', 'description'],
  worldRule: ['category', 'rule', 'priority'],
};

export class SnapshotRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly facts: FactSourceRepository,
  ) {}

  create(bookId: string, label: string, chapterId: string | null = null): StorySnapshot {
    const snapshot: StorySnapshot = {
      id: newId(),
      bookId,
      chapterId,
      label,
      state: this.facts.loadState(bookId),
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO snapshots (id, book_id, chapter_id, label, state_json, created_at)
         VALUES (@id, @bookId, @chapterId, @label, @stateJson, @createdAt)`,
      )
      .run({
        id: snapshot.id,
        bookId,
        chapterId,
        label,
        stateJson: JSON.stringify(snapshot.state),
        createdAt: snapshot.createdAt,
      });
    return snapshot;
  }

  get(id: string): StorySnapshot | null {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapSnapshot(row) : null;
  }

  list(bookId: string): StorySnapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM snapshots WHERE book_id = ? ORDER BY created_at DESC')
      .all(bookId) as Row[];
    return rows.map((row) => this.mapSnapshot(row));
  }

  /** 渲染进程用的轻量摘要，避免传输完整状态 JSON */
  listViews(bookId: string): SnapshotView[] {
    return this.list(bookId).map((snapshot) => ({
      id: snapshot.id,
      bookId: snapshot.bookId,
      chapterId: snapshot.chapterId,
      label: snapshot.label,
      createdAt: snapshot.createdAt,
      characterCount: snapshot.state.characters.length,
      foreshadowCount: snapshot.state.foreshadows.length,
      worldRuleCount: snapshot.state.worldRules.length,
    }));
  }

  /** 将事实源整体回退到快照状态，返回可供作者审阅的字段级差异 */
  restore(snapshotId: string): StateChange[] {
    const snapshot = this.get(snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);
    const current = this.facts.loadState(snapshot.bookId);
    const changes = diffStates(current, snapshot.state);
    this.facts.restoreState(snapshot.bookId, snapshot.state);
    return changes;
  }

  private mapSnapshot(row: Row): StorySnapshot {
    return {
      id: String(row.id),
      bookId: String(row.book_id),
      chapterId: row.chapter_id == null ? null : String(row.chapter_id),
      label: String(row.label),
      state: parseJson<FactSourceState>(row.state_json, {
        characters: [],
        characterStates: [],
        stateFacts: [],
        receipts: [],
        foreshadows: [],
        resources: [],
        timelineEvents: [],
        worldRules: [],
      }),
      createdAt: String(row.created_at),
    };
  }
}

function stableEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 字段级状态差异。实体新增/删除以 field='<entity>' 表示，便于 GUI 分组展示。 */
export function diffStates(current: FactSourceState, target: FactSourceState): StateChange[] {
  const changes: StateChange[] = [];

  const compare = <T extends Record<string, unknown>>(
    entity: StateChange['entity'],
    before: T[],
    after: T[],
    idOf: (item: T) => string,
  ): void => {
    const beforeMap = new Map(before.map((item) => [idOf(item), item]));
    const afterMap = new Map(after.map((item) => [idOf(item), item]));

    for (const [id, afterItem] of afterMap) {
      const beforeItem = beforeMap.get(id);
      if (!beforeItem) {
        changes.push({ entity, entityId: id, field: entity, before: null, after: afterItem });
        continue;
      }
      for (const field of TRACKED_FIELDS[entity]) {
        if (!stableEqual(beforeItem[field], afterItem[field])) {
          changes.push({ entity, entityId: id, field, before: beforeItem[field], after: afterItem[field] });
        }
      }
    }
    for (const id of beforeMap.keys()) {
      if (!afterMap.has(id)) {
        changes.push({ entity, entityId: id, field: entity, before: beforeMap.get(id), after: null });
      }
    }
  };

  compare(
    'character',
    current.characters as unknown as Record<string, unknown>[],
    target.characters as unknown as Record<string, unknown>[],
    (item) => String(item.id),
  );
  compare(
    'characterState',
    current.characterStates as unknown as Record<string, unknown>[],
    target.characterStates as unknown as Record<string, unknown>[],
    (item) => String(item.characterId),
  );
  compare(
    'foreshadow',
    current.foreshadows as unknown as Record<string, unknown>[],
    target.foreshadows as unknown as Record<string, unknown>[],
    (item) => String(item.id),
  );
  compare(
    'resource',
    current.resources as unknown as Record<string, unknown>[],
    target.resources as unknown as Record<string, unknown>[],
    (item) => String(item.id),
  );
  compare(
    'timeline',
    current.timelineEvents as unknown as Record<string, unknown>[],
    target.timelineEvents as unknown as Record<string, unknown>[],
    (item) => String(item.id),
  );
  compare(
    'worldRule',
    current.worldRules as unknown as Record<string, unknown>[],
    target.worldRules as unknown as Record<string, unknown>[],
    (item) => String(item.id),
  );

  return changes;
}

// 以下 mapper 保留给需要对快照内实体做展示的场景复用
export const snapshotMappers = { mapCharacter, mapCharacterState, mapForeshadow, mapResource };
