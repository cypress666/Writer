/**
 * SQLite 访问层适配器。
 *
 * 使用 Node/Electron 内置的 `node:sqlite`（Electron 37 内置 SQLite 3.50.4，含 FTS5），
 * 避免 better-sqlite3 原生模块在「Node 跑测试 / Electron 跑应用」两个 ABI 之间反复重编。
 *
 * 对上层暴露的接口刻意保持 better-sqlite3 风格（prepare/exec/pragma/transaction），
 * 让仓储代码不需要改动调用方式。
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** SQLite 可绑定的值；布尔与 undefined 在绑定前被归一化 */
export type SqlValue = string | number | bigint | Uint8Array | null;

export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...args: unknown[]): SqliteRunResult;
  get<T = Record<string, unknown>>(...args: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(...args: unknown[]): T[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  /** better-sqlite3 风格：返回一个可重复调用的函数 */
  transaction<T>(fn: () => T): () => T;
  /** 兼容 `pragma('foreign_keys = ON')` 与 `pragma('user_version', { simple: true })` */
  pragma(text: string, options?: { simple?: boolean }): unknown;
  close(): void;
  readonly raw: DatabaseSync;
}

function toSqlValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  // 对象/数组按 JSON 存，避免调用方漏做序列化时静默绑定失败
  return JSON.stringify(value);
}

function normalizeRecord(input: Record<string, unknown>): Record<string, SqlValue> {
  const output: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(input)) output[key] = toSqlValue(value);
  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

class Statement implements SqliteStatement {
  constructor(private readonly stmt: StatementSync) {
    // 仓储层使用 `@name` 占位、传裸键对象；开启两项宽松绑定避免逐个改 SQL
    this.stmt.setAllowBareNamedParameters(true);
    this.stmt.setAllowUnknownNamedParameters(true);
  }

  run(...args: unknown[]): SqliteRunResult {
    if (args.length === 1 && isPlainObject(args[0])) return this.stmt.run(normalizeRecord(args[0]));
    return this.stmt.run(...(args.map(toSqlValue) as SqlValue[]));
  }

  get<T = Record<string, unknown>>(...args: unknown[]): T | undefined {
    if (args.length === 1 && isPlainObject(args[0])) {
      return this.stmt.get(normalizeRecord(args[0])) as T | undefined;
    }
    return this.stmt.get(...(args.map(toSqlValue) as SqlValue[])) as T | undefined;
  }

  all<T = Record<string, unknown>>(...args: unknown[]): T[] {
    if (args.length === 1 && isPlainObject(args[0])) {
      return this.stmt.all(normalizeRecord(args[0])) as T[];
    }
    return this.stmt.all(...(args.map(toSqlValue) as SqlValue[])) as T[];
  }
}

class Database implements SqliteDatabase {
  private depth = 0;

  constructor(private readonly db: DatabaseSync) {}

  get raw(): DatabaseSync {
    return this.db;
  }

  prepare(sql: string): SqliteStatement {
    return new Statement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(text: string, options?: { simple?: boolean }): unknown {
    if (text.includes('=')) {
      this.db.exec(`PRAGMA ${text}`);
      return undefined;
    }
    const rows = this.db.prepare(`PRAGMA ${text}`).all() as Record<string, unknown>[];
    if (!options?.simple) return rows;
    const first = rows[0];
    if (!first) return undefined;
    const keys = Object.keys(first);
    const key = keys[0];
    return key === undefined ? undefined : first[key];
  }

  transaction<T>(fn: () => T): () => T {
    return () => {
      // 嵌套时用 SAVEPOINT，语义与 better-sqlite3 一致
      if (this.depth > 0) {
        const savepoint = `sp_${this.depth}`;
        this.db.exec(`SAVEPOINT ${savepoint}`);
        this.depth += 1;
        try {
          const result = fn();
          this.db.exec(`RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          this.db.exec(`ROLLBACK TO ${savepoint}`);
          this.db.exec(`RELEASE ${savepoint}`);
          throw error;
        } finally {
          this.depth -= 1;
        }
      }

      this.db.exec('BEGIN IMMEDIATE');
      this.depth = 1;
      try {
        const result = fn();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* 回滚失败时保留原始错误 */
        }
        throw error;
      } finally {
        this.depth = 0;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}

export function openSqlite(filename: string = ':memory:'): SqliteDatabase {
  return new Database(new DatabaseSync(filename));
}
