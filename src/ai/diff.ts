/**
 * 段落级差分。AI 生成的新稿不直接覆盖原稿，而是拆成段落操作供作者逐段裁决。
 *
 * 使用 LCS（最长公共子序列）对齐段落，得到 keep / replace / add / remove 四类操作，
 * 保证作者手写的段落只要在新稿中原样出现就会被判为 keep，不会被悄悄改写。
 */

export type DiffOp = 'keep' | 'replace' | 'add' | 'remove';

export interface ParagraphChange {
  op: DiffOp;
  /** 原稿段落序号；新增段落为 null */
  originalIndex: number | null;
  original: string | null;
  revised: string | null;
}

export interface DiffResult {
  changes: ParagraphChange[];
  stats: { kept: number; replaced: number; added: number; removed: number };
}

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** LCS 表格：dp[i][j] = original[0..i) 与 revised[0..j) 的最长公共段落数 */
function lcsTable(original: string[], revised: string[]): number[][] {
  const dp: number[][] = Array.from({ length: original.length + 1 }, () =>
    new Array<number>(revised.length + 1).fill(0),
  );
  for (let i = 1; i <= original.length; i += 1) {
    for (let j = 1; j <= revised.length; j += 1) {
      dp[i]![j] = original[i - 1] === revised[j - 1]
        ? dp[i - 1]![j - 1]! + 1
        : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp;
}

export function diffParagraphs(originalText: string, revisedText: string): DiffResult {
  const original = splitParagraphs(originalText);
  const revised = splitParagraphs(revisedText);
  const dp = lcsTable(original, revised);
  const changes: ParagraphChange[] = [];

  let i = original.length;
  let j = revised.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && original[i - 1] === revised[j - 1]) {
      changes.push({ op: 'keep', originalIndex: i - 1, original: original[i - 1]!, revised: original[i - 1]! });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      changes.push({ op: 'add', originalIndex: null, original: null, revised: revised[j - 1]! });
      j -= 1;
    } else if (i > 0) {
      changes.push({ op: 'remove', originalIndex: i - 1, original: original[i - 1]!, revised: null });
      i -= 1;
    }
  }
  changes.reverse();

  // 相邻的 remove + add 合并为 replace，便于逐段裁决
  const merged: ParagraphChange[] = [];
  for (let index = 0; index < changes.length; index += 1) {
    const current = changes[index]!;
    const next = changes[index + 1];
    if (current.op === 'remove' && next?.op === 'add') {
      merged.push({
        op: 'replace',
        originalIndex: current.originalIndex,
        original: current.original,
        revised: next.revised,
      });
      index += 1;
    } else {
      merged.push(current);
    }
  }

  const stats = {
    kept: merged.filter((c) => c.op === 'keep').length,
    replaced: merged.filter((c) => c.op === 'replace').length,
    added: merged.filter((c) => c.op === 'add').length,
    removed: merged.filter((c) => c.op === 'remove').length,
  };
  return { changes: merged, stats };
}

/**
 * 按作者逐段裁决重建正文。acceptedIndices 表示「接受 AI 改动」的段落序号：
 * - replace：接受用新段，拒绝保留原段
 * - add：接受才插入，拒绝则丢弃
 * - remove：接受才删除，拒绝则保留原段
 * - keep：始终保留
 */
export function applyDecisions(changes: ParagraphChange[], acceptedIndices: Set<number>): string {
  const paragraphs: string[] = [];
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]!;
    const useRevised = acceptedIndices.has(index);
    if (change.op === 'keep') {
      if (change.revised) paragraphs.push(change.revised);
    } else if (change.op === 'add') {
      // 新增段落必须经作者接受；否则 AI 可以绕过裁决直接插入正文
      if (useRevised && change.revised) paragraphs.push(change.revised);
    } else if (change.op === 'replace') {
      paragraphs.push(useRevised ? (change.revised ?? '') : (change.original ?? ''));
    } else if (change.op === 'remove') {
      if (!useRevised && change.original) paragraphs.push(change.original);
    }
  }
  return paragraphs.join('\n\n');
}
