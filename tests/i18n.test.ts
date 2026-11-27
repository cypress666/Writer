/**
 * i18n 完整性守卫。
 *
 * 本项目用「中文原文当 key」，好处是不用起 key 名、漏翻自动回落中文；
 * 代价是中文文案一改，对应英文会静默失效。这个测试把「失效」变成「测试失败」：
 * 扫描渲染层所有 t('…') 调用，凡是含中文的都必须能在英文表里查到。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EN_MESSAGES } from '../src/renderer/i18n/en/index.js';

const ROOT = join(process.cwd(), 'src', 'renderer');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'i18n') continue; // 词表自身不算
      walk(full, out);
    } else if (entry.endsWith('.vue') || entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const CJK = /[\u4e00-\u9fa5]/;

/**
 * 源码里写的是 `t('…\n…')`，正则抓到的是**字面量**「反斜杠 + n」，
 * 而运行时 JS 已把它解码成真换行。所以比对前要按 JS 规则把转义还原一次。
 */
function decodeEscapes(raw: string): string {
  return raw.replace(/\\(.)/g, (_all, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      default:
        return ch;
    }
  });
}

/** 抓取 t('…') / t("…") 的第一个参数 */
function extractKeys(source: string): string[] {
  const keys: string[] = [];
  const pattern = /\bt\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    keys.push(match[2]!);
  }
  return keys;
}

describe('i18n 词表完整性', () => {
  const files = walk(ROOT);
  const missing: Array<{ file: string; key: string }> = [];
  let checked = 0;

  for (const file of files) {
    for (const raw of extractKeys(readFileSync(file, 'utf8'))) {
      const key = decodeEscapes(raw);
      if (!CJK.test(key)) continue;
      checked += 1;
      if (!Object.prototype.hasOwnProperty.call(EN_MESSAGES, key)) {
        missing.push({ file: relative(ROOT, file), key });
      }
    }
  }

  it('扫描到了足够多的词条（防止正则失效导致空跑）', () => {
    expect(checked).toBeGreaterThan(100);
  });

  it('每个含中文的 t() 都有英文翻译', () => {
    const report = missing
      .slice(0, 40)
      .map((item) => `${item.file}: ${item.key.replace(/\n/g, '\\n')}`)
      .join('\n');
    expect(missing, `缺少英文翻译：\n${report}`).toHaveLength(0);
  });

  it('带占位符的词条在两种语言里占位符一致', () => {
    const mismatched: string[] = [];
    for (const [zh, en] of Object.entries(EN_MESSAGES)) {
      const zhSlots = (zh.match(/\{[a-zA-Z]\w*\}/g) ?? []).sort();
      const enSlots = (en.match(/\{[a-zA-Z]\w*\}/g) ?? []).sort();
      if (zhSlots.join() !== enSlots.join()) {
        mismatched.push(`${zh} → ${en}（${zhSlots.join(' ')} vs ${enSlots.join(' ')}）`);
      }
    }
    expect(mismatched, `占位符不一致：\n${mismatched.join('\n')}`).toHaveLength(0);
  });
});
