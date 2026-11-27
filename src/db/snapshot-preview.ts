/**
 * 快照回退辅助视图：从正文中找出仍写着旧状态值的段落。
 * 只做文本提示，不自动改写正文——正文修改权始终在作者手里。
 */

import { splitParagraphs } from '../ai/diff.js';

export interface SnapshotConflictParagraph {
  paragraphIndex: number;
  text: string;
  reason: string;
}

interface ChangeLike {
  field: string;
  before: unknown;
}

function collectValues(value: unknown): string[] {
  if (typeof value === 'string') return value.trim().length >= 2 ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(collectValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectValues);
  return [];
}

export function findConflictParagraphs(
  content: string,
  changes: ChangeLike[],
  limit = 30,
): SnapshotConflictParagraph[] {
  const staleValues = new Map<string, string>();
  for (const change of changes) {
    for (const value of collectValues(change.before)) {
      if (!staleValues.has(value)) staleValues.set(value, change.field);
    }
  }

  const conflicts: SnapshotConflictParagraph[] = [];
  splitParagraphs(content).forEach((text, paragraphIndex) => {
    for (const [value, field] of staleValues) {
      if (text.includes(value)) {
        conflicts.push({
          paragraphIndex,
          text,
          reason: `正文写有当前事实源的「${value}」（字段 ${field}），回退后会与快照冲突`,
        });
        break;
      }
    }
  });
  return conflicts.slice(0, limit);
}
