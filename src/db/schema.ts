/**
 * SQLite Schema —— 单一事实源的物理存储层。
 *
 * 设计要点：
 * 1. 权威状态（character_state_facts / foreshadows / resources / timeline_events /
 *    world_rules）与正文分离；character_states 是自 character_state_facts 重建的
 *    物化投影，派生失败不得破坏作者事实或上一次成功快照。
 * 2. 所有状态表带 book_id 冗余，保证跨表查询可在单卷范围内完成，配合索引
 *    支撑百万字规模。
 * 3. character_state_events 保留每次变更的完整轨迹，是快照回退与审计追溯的基础。
 * 4. finalization_receipts 以正文哈希定位不可变定稿；派生状态绑定收据，
 *    收据被替换时只标 stale，不删除作者事实。
 * 5. chapter_fts 为 FTS5 虚拟表，中文分词在写入层做 bigram 展开（见 retrieval）。
 */

import { openSqlite, type SqliteDatabase } from './sqlite.js';

export const SCHEMA_VERSION = 5;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS books (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  outline     TEXT NOT NULL DEFAULT '',
  genre_id    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS volumes (
  id          TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  outline     TEXT NOT NULL DEFAULT '',
  ordinal     INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (book_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_volumes_book ON volumes(book_id, ordinal);

CREATE TABLE IF NOT EXISTS chapters (
  id                    TEXT PRIMARY KEY,
  book_id               TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  volume_id             TEXT REFERENCES volumes(id) ON DELETE SET NULL,
  ordinal               INTEGER NOT NULL,
  title                 TEXT NOT NULL,
  outline               TEXT NOT NULL DEFAULT '',
  content               TEXT,
  status                TEXT NOT NULL DEFAULT 'outline',
  declared_characters   TEXT NOT NULL DEFAULT '[]',
  declared_locations    TEXT NOT NULL DEFAULT '[]',
  declared_foreshadows  TEXT NOT NULL DEFAULT '[]',
  emotion_tags          TEXT NOT NULL DEFAULT '[]',
  hook_type             TEXT,
  strand                TEXT,
  target_words          INTEGER,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (book_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_chapters_volume ON chapters(volume_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_chapters_book_status ON chapters(book_id, status);

CREATE TABLE IF NOT EXISTS characters (
  id          TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',
  is_alive    INTEGER NOT NULL DEFAULT 1,
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  UNIQUE (book_id, name)
);
CREATE INDEX IF NOT EXISTS idx_characters_book ON characters(book_id);

CREATE TABLE IF NOT EXISTS character_states (
  character_id            TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  location                TEXT,
  abilities               TEXT NOT NULL DEFAULT '[]',
  relations               TEXT NOT NULL DEFAULT '[]',
  known_facts             TEXT NOT NULL DEFAULT '[]',
  updated_in_chapter_id   TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  updated_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS character_state_events (
  id            TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  chapter_id    TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  event_type    TEXT NOT NULL,
  payload       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_state_events_char ON character_state_events(character_id, created_at);
CREATE INDEX IF NOT EXISTS idx_state_events_book ON character_state_events(book_id, created_at);

-- 字段级权威事实。同一字段可有多条来源记录，按章取值时取生效章<=N 且来源优先级最高者。
-- author 值永不覆盖；derived 值绑定收据，收据失效只标 stale。
CREATE TABLE IF NOT EXISTS character_state_facts (
  id                  TEXT PRIMARY KEY,
  book_id             TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  character_id        TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  field               TEXT NOT NULL,
  value_json          TEXT NOT NULL,
  provenance          TEXT NOT NULL,
  effective_chapter   INTEGER NOT NULL,
  source_receipt_id   TEXT REFERENCES finalization_receipts(id) ON DELETE SET NULL,
  stale               INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_state_facts_lookup
  ON character_state_facts(book_id, character_id, field, effective_chapter);

-- 定稿收据：草稿身份 + 章号 + 正文哈希共同定位不可变正文。
CREATE TABLE IF NOT EXISTS finalization_receipts (
  id              TEXT PRIMARY KEY,
  book_id         TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_id      TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  chapter_ordinal INTEGER NOT NULL,
  draft_id        TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  finalized_at    TEXT NOT NULL,
  superseded_by   TEXT REFERENCES finalization_receipts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_chapter ON finalization_receipts(chapter_id, finalized_at);

CREATE TABLE IF NOT EXISTS foreshadows (
  id                      TEXT PRIMARY KEY,
  book_id                 TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  kind                    TEXT NOT NULL DEFAULT 'sub',
  planted_in_chapter_id   TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  planned_resolve_ordinal INTEGER,
  resolved_in_chapter_id  TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  resolution_markers      TEXT NOT NULL DEFAULT '[]',
  status                  TEXT NOT NULL DEFAULT 'planted',
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_foreshadows_book_status ON foreshadows(book_id, status);
CREATE INDEX IF NOT EXISTS idx_foreshadows_resolve ON foreshadows(book_id, planned_resolve_ordinal);

CREATE TABLE IF NOT EXISTS resources (
  id                    TEXT PRIMARY KEY,
  book_id               TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  category              TEXT NOT NULL DEFAULT '',
  holder_character_id   TEXT REFERENCES characters(id) ON DELETE SET NULL,
  quantity              REAL NOT NULL DEFAULT 0,
  notes                 TEXT NOT NULL DEFAULT '',
  updated_in_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (book_id, name)
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id            TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_id    TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  story_time    TEXT NOT NULL,
  story_order   INTEGER NOT NULL,
  description   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_order ON timeline_events(book_id, story_order);

CREATE TABLE IF NOT EXISTS world_rules (
  id          TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  rule        TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_world_rules_category ON world_rules(book_id, category);

CREATE TABLE IF NOT EXISTS snapshots (
  id          TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_id  TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  label       TEXT NOT NULL,
  state_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_book_created ON snapshots(book_id, created_at DESC);

-- 章级向量索引。向量由配置的 Embedding 模型生成，未配置时检索退化为 BM25。
CREATE TABLE IF NOT EXISTS chapter_embeddings (
  chapter_id   TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  book_id      TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  model        TEXT NOT NULL,
  dimensions   INTEGER NOT NULL,
  vector_json  TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chapter_embeddings_book ON chapter_embeddings(book_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chapter_fts USING fts5(
  chapter_id UNINDEXED,
  book_id UNINDEXED,
  volume_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 0'
);
`;

/** 打开数据库并完成 schema 初始化。默认内存库用于测试。 */
export function openDatabase(filename: string = ':memory:'): SqliteDatabase {
  const db = openSqlite(filename);
  db.pragma('foreign_keys = ON');
  // WAL 提升并发读性能；内存库下该 pragma 无副作用
  if (filename !== ':memory:') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  initializeSchema(db);
  return db;
}

export function initializeSchema(db: SqliteDatabase): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;

  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    // v1 → v2：旧库已存在 chapters 表时 CREATE TABLE IF NOT EXISTS 不会补列，
    // 必须显式 ALTER。用 table_info 探测保证全新库与旧库都能安全执行。
    const chapters = db.pragma('table_info(chapters)') as Array<{ name: string }>;
    if (!chapters.some((column) => column.name === 'strand')) {
      db.exec('ALTER TABLE chapters ADD COLUMN strand TEXT');
    }
    const books = db.pragma('table_info(books)') as Array<{ name: string }>;
    if (!books.some((column) => column.name === 'outline')) {
      db.exec("ALTER TABLE books ADD COLUMN outline TEXT NOT NULL DEFAULT ''");
    }
    // v4 → v5：题材决定门禁/审计侧重，可空表示未选（等价全 normal）
    if (!books.some((column) => column.name === 'genre_id')) {
      db.exec('ALTER TABLE books ADD COLUMN genre_id TEXT');
    }
    const volumes = db.pragma('table_info(volumes)') as Array<{ name: string }>;
    if (!volumes.some((column) => column.name === 'outline')) {
      db.exec("ALTER TABLE volumes ADD COLUMN outline TEXT NOT NULL DEFAULT ''");
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}
