/**
 * docstore/core/domain/line-diff.ts
 *
 * Pure line-based diff (LCS) producing unified-diff text, hunks and stats.
 * Framework-free domain logic used by history/version diff endpoints.
 */

export type DiffOp = { type: 'equal' | 'add' | 'remove'; line: string };

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface LineDiffResult {
  ops: DiffOp[];
  hunks: DiffHunk[];
  unified: string;
  stats: { additions: number; deletions: number; unchanged: number };
}

const MAX_CELLS = 25_000_000;

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split('\n');
}

export function diffLines(a: string[], b: string[]): DiffOp[] {
  // Trim common prefix/suffix to keep the LCS table small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffOp[] = a.slice(0, start).map((line) => ({ type: 'equal', line }));
  const tail: DiffOp[] = a.slice(endA).map((line) => ({ type: 'equal', line }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  const mid: DiffOp[] = [];
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    // Too large for LCS: degrade to block replace (still correct, less minimal).
    midA.forEach((line) => mid.push({ type: 'remove', line }));
    midB.forEach((line) => mid.push({ type: 'add', line }));
  } else {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] =
          midA[i] === midB[j]
            ? dp[(i + 1) * w + j + 1] + 1
            : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        mid.push({ type: 'equal', line: midA[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        mid.push({ type: 'remove', line: midA[i++] });
      } else {
        mid.push({ type: 'add', line: midB[j++] });
      }
    }
    while (i < n) mid.push({ type: 'remove', line: midA[i++] });
    while (j < m) mid.push({ type: 'add', line: midB[j++] });
  }
  return [...head, ...mid, ...tail];
}

export function buildHunks(ops: DiffOp[], context = 3): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let current: DiffHunk | null = null;
  let trailingEqual = 0;

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.type === 'equal') {
      if (current) {
        if (trailingEqual < context) {
          current.lines.push(` ${op.line}`);
          current.oldLines++;
          current.newLines++;
          trailingEqual++;
        } else {
          // Look ahead: does another change start within `context` lines?
          let nextChange = -1;
          for (let q = k; q < Math.min(ops.length, k + context + 1); q++) {
            if (ops[q].type !== 'equal') {
              nextChange = q;
              break;
            }
          }
          if (nextChange === -1) {
            hunks.push(current);
            current = null;
          } else {
            current.lines.push(` ${op.line}`);
            current.oldLines++;
            current.newLines++;
          }
        }
      }
      oldLine++;
      newLine++;
      continue;
    }
    if (!current) {
      const lead: string[] = [];
      for (let q = Math.max(0, k - context); q < k; q++) {
        if (ops[q].type === 'equal') lead.push(` ${ops[q].line}`);
      }
      current = {
        oldStart: oldLine - lead.length,
        newStart: newLine - lead.length,
        oldLines: lead.length,
        newLines: lead.length,
        lines: lead,
      };
    }
    trailingEqual = 0;
    if (op.type === 'remove') {
      current.lines.push(`-${op.line}`);
      current.oldLines++;
      oldLine++;
    } else {
      current.lines.push(`+${op.line}`);
      current.newLines++;
      newLine++;
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

export function computeLineDiff(
  oldText: string,
  newText: string,
  labels: { from: string; to: string } = { from: 'a', to: 'b' },
): LineDiffResult {
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  const hunks = buildHunks(ops);
  const stats = { additions: 0, deletions: 0, unchanged: 0 };
  for (const op of ops) {
    if (op.type === 'add') stats.additions++;
    else if (op.type === 'remove') stats.deletions++;
    else stats.unchanged++;
  }
  const unified = [
    `--- ${labels.from}`,
    `+++ ${labels.to}`,
    ...hunks.flatMap((h) => [
      `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      ...h.lines,
    ]),
  ].join('\n');
  return { ops, hunks, unified, stats };
}
