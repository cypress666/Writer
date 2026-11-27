/**
 * 密钥加密存储。
 *
 * 使用 Electron safeStorage（Windows DPAPI / macOS Keychain / Linux libsecret）
 * 加密后写入独立文件，绝不明文进 SQLite、绝不随作品数据导出。
 *
 * 本文件只依赖注入的 safeStorage 接口，便于在测试中换成内存实现。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SecretStoreOptions {
  filePath: string;
  storage: SafeStorageLike;
}

export interface CredentialRecord {
  id: string;
  label: string;
  createdAt: string;
  cipherText: string;
}

/** 给设置页展示的凭据元数据，永不包含明文或密文 */
export interface CredentialMeta {
  id: string;
  label: string;
  createdAt: string;
}

export class SecretStore {
  constructor(private readonly options: SecretStoreOptions) {}

  get encrypted(): boolean {
    return this.options.storage.isEncryptionAvailable();
  }

  private readAll(): CredentialRecord[] {
    if (!existsSync(this.options.filePath)) return [];
    try {
      return JSON.parse(readFileSync(this.options.filePath, 'utf8')) as CredentialRecord[];
    } catch {
      return [];
    }
  }

  private writeAll(records: CredentialRecord[]): void {
    writeFileSync(this.options.filePath, JSON.stringify(records, null, 2), { mode: 0o600 });
  }

  save(id: string, label: string, plainSecret: string): CredentialRecord {
    if (!plainSecret.trim()) throw new Error('密钥不能为空');
    if (!this.encrypted) {
      throw new Error('系统加密不可用，拒绝以明文保存密钥');
    }
    const cipher = this.options.storage.encryptString(plainSecret).toString('base64');
    const records = this.readAll();
    const existing = records.find((item) => item.id === id);
    if (existing) {
      existing.label = label;
      existing.cipherText = cipher;
      existing.createdAt = new Date().toISOString();
      this.writeAll(records);
      return existing;
    }
    const record: CredentialRecord = {
      id,
      label,
      createdAt: new Date().toISOString(),
      cipherText: cipher,
    };
    records.push(record);
    this.writeAll(records);
    return record;
  }

  /** 凭据 id → 明文密钥。找不到时返回空串（Ollama 等本地服务允许无密钥） */
  reveal(id: string): string {
    if (!id) return '';
    const record = this.readAll().find((item) => item.id === id);
    if (!record) return '';
    if (!this.encrypted) throw new Error('系统加密不可用，无法读取密钥');
    return this.options.storage.decryptString(Buffer.from(record.cipherText, 'base64'));
  }

  /** 仅返回元数据，绝不返回密文或明文 */
  list(): CredentialMeta[] {
    return this.readAll().map(({ id, label, createdAt }) => ({ id, label, createdAt }));
  }

  remove(id: string): void {
    this.writeAll(this.readAll().filter((item) => item.id !== id));
  }
}
