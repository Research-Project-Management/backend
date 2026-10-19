/**
 * project-history/domain/myers-diff.engine.ts
 * Pure, side-effect-free Myers LCS line-diff and intra-line word-diff engine
 * for comparing Manuscript Snapshots.
 */

import { Snapshot } from './snapshot.entity';
import {
  DiffHunkVo,
  DiffLine,
  FileDiffVo,
  TextDiffResult,
  WordDiffToken,
} from './project-history.ports';

export class MyersDiffEngine {
  /**
   * Compares two snapshots and identifies all added, deleted, modified, and renamed files.
   */
  public compareSnapshots(
    baseSnapshot: Snapshot,
    targetSnapshot: Snapshot,
  ): FileDiffVo[] {
    const baseFiles = baseSnapshot.files;
    const targetFiles = targetSnapshot.files;
    const diffs: FileDiffVo[] = [];

    const processedTargetPaths = new Set<string>();

    // 1. Process files present in baseSnapshot (check for DELETED, MODIFIED, or RENAMED)
    for (const [path, baseFile] of baseFiles.entries()) {
      const targetFile = targetFiles.get(path);

      if (!targetFile) {
        let renameTarget: string | null = null;
        if (baseFile.hash) {
          for (const [tPath, tFile] of targetFiles.entries()) {
            if (
              !baseFiles.has(tPath) &&
              !processedTargetPaths.has(tPath) &&
              tFile.type === baseFile.type &&
              tFile.hash === baseFile.hash
            ) {
              renameTarget = tPath;
              break;
            }
          }
        }

        if (renameTarget) {
          processedTargetPaths.add(renameTarget);
          diffs.push(
            new FileDiffVo({
              path: renameTarget,
              oldPath: path,
              status: 'renamed',
              type: baseFile.type,
              oldHash: baseFile.hash,
              newHash: targetFiles.get(renameTarget)?.hash,
              additions: 0,
              deletions: 0,
              hunks: [],
            }),
          );
        } else {
          const lineCount = baseFile.lines ? baseFile.lines.length : 0;
          const hunks: DiffHunkVo[] = [];

          if (baseFile.lines && baseFile.lines.length > 0) {
            hunks.push(
              new DiffHunkVo({
                oldStartLine: 1,
                oldLineCount: lineCount,
                newStartLine: 0,
                newLineCount: 0,
                lines: baseFile.lines.map((text, idx) => ({
                  type: 'deleted',
                  text,
                  oldLineNumber: idx + 1,
                })),
              }),
            );
          }

          diffs.push(
            new FileDiffVo({
              path,
              status: 'deleted',
              type: baseFile.type,
              oldHash: baseFile.hash,
              additions: 0,
              deletions: lineCount,
              hunks,
            }),
          );
        }
      } else {
        processedTargetPaths.add(path);

        if (baseFile.hash !== targetFile.hash) {
          if (baseFile.type === 'doc' && targetFile.type === 'doc') {
            const diffResult = this.diffText(
              baseFile.lines || [],
              targetFile.lines || [],
            );
            diffs.push(
              new FileDiffVo({
                path,
                status: 'modified',
                type: 'doc',
                oldHash: baseFile.hash,
                newHash: targetFile.hash,
                additions: diffResult.additions,
                deletions: diffResult.deletions,
                hunks: diffResult.hunks,
              }),
            );
          } else {
            diffs.push(
              new FileDiffVo({
                path,
                status: 'modified',
                type: 'file',
                oldHash: baseFile.hash,
                newHash: targetFile.hash,
                additions: 0,
                deletions: 0,
                hunks: [],
              }),
            );
          }
        }
      }
    }

    // 2. Process remaining files in targetSnapshot (ADDED)
    for (const [path, targetFile] of targetFiles.entries()) {
      if (!processedTargetPaths.has(path) && !baseFiles.has(path)) {
        const lineCount = targetFile.lines ? targetFile.lines.length : 0;
        const hunks: DiffHunkVo[] = [];

        if (targetFile.lines && targetFile.lines.length > 0) {
          hunks.push(
            new DiffHunkVo({
              oldStartLine: 0,
              oldLineCount: 0,
              newStartLine: 1,
              newLineCount: lineCount,
              lines: targetFile.lines.map((text, idx) => ({
                type: 'added',
                text,
                newLineNumber: idx + 1,
              })),
            }),
          );
        }

        diffs.push(
          new FileDiffVo({
            path,
            status: 'added',
            type: targetFile.type,
            newHash: targetFile.hash,
            additions: lineCount,
            deletions: 0,
            hunks,
          }),
        );
      }
    }

    return diffs;
  }

  /**
   * Myers Diff implementation on lines array + word highlight resolution.
   */
  public diffText(oldLines: string[], newLines: string[]): TextDiffResult {
    const rawOps = this.computeMyersLCS(oldLines, newLines);

    let additions = 0;
    let deletions = 0;
    const diffLines: DiffLine[] = [];

    let oldLineNum = 1;
    let newLineNum = 1;

    for (const op of rawOps) {
      if (op.type === 'added') {
        additions++;
        diffLines.push({
          type: 'added',
          text: op.text,
          newLineNumber: newLineNum++,
        });
      } else if (op.type === 'deleted') {
        deletions++;
        diffLines.push({
          type: 'deleted',
          text: op.text,
          oldLineNumber: oldLineNum++,
        });
      } else {
        diffLines.push({
          type: 'unchanged',
          text: op.text,
          oldLineNumber: oldLineNum++,
          newLineNumber: newLineNum++,
        });
      }
    }

    this.enhanceWithWordDiffs(diffLines);
    const hunks = this.buildHunks(diffLines);

    return {
      hunks,
      additions,
      deletions,
    };
  }

  public computeMyersLCS(
    a: string[],
    b: string[],
  ): Array<{ type: 'added' | 'deleted' | 'unchanged'; text: string }> {
    const n = a.length;
    const m = b.length;
    if (n === 0 && m === 0) return [];

    let start = 0;
    while (start < n && start < m && a[start] === b[start]) {
      start++;
    }

    let aEnd = n - 1;
    let bEnd = m - 1;
    while (aEnd >= start && bEnd >= start && a[aEnd] === b[bEnd]) {
      aEnd--;
      bEnd--;
    }

    const prefix = a.slice(0, start).map((text) => ({
      type: 'unchanged' as const,
      text,
    }));
    const suffix = a.slice(aEnd + 1).map((text) => ({
      type: 'unchanged' as const,
      text,
    }));

    const middleA = a.slice(start, aEnd + 1);
    const middleB = b.slice(start, bEnd + 1);

    if (middleA.length === 0 && middleB.length === 0) {
      return [...prefix, ...suffix];
    }

    if (middleA.length + middleB.length > 3000) {
      const fallbackOps: Array<{
        type: 'added' | 'deleted' | 'unchanged';
        text: string;
      }> = [
        ...middleA.map((text) => ({ type: 'deleted' as const, text })),
        ...middleB.map((text) => ({ type: 'added' as const, text })),
      ];
      return [...prefix, ...fallbackOps, ...suffix];
    }

    const middleOps = this.rawMyers(middleA, middleB);
    return [...prefix, ...middleOps, ...suffix];
  }

  private rawMyers(
    a: string[],
    b: string[],
  ): Array<{ type: 'added' | 'deleted' | 'unchanged'; text: string }> {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    if (max === 0) return [];

    const v: number[] = new Array(2 * max + 1);
    v[1 + max] = 0;
    const trace: Array<{ [k: number]: number }> = [];

    for (let d = 0; d <= max; d++) {
      const snap: { [k: number]: number } = {};
      for (let k = -d; k <= d; k += 2) {
        let x: number;
        if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
          x = v[k + 1 + max];
        } else {
          x = v[k - 1 + max] + 1;
        }

        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) {
          x++;
          y++;
        }

        v[k + max] = x;
        snap[k] = x;

        if (x >= n && y >= m) {
          trace.push(snap);
          return this.backtrackMyers(a, b, trace);
        }
      }
      trace.push(snap);
    }

    return [];
  }

  private backtrackMyers(
    a: string[],
    b: string[],
    trace: Array<{ [k: number]: number }>,
  ): Array<{ type: 'added' | 'deleted' | 'unchanged'; text: string }> {
    let x = a.length;
    let y = b.length;
    const result: Array<{
      type: 'added' | 'deleted' | 'unchanged';
      text: string;
    }> = [];

    for (let d = trace.length - 1; d > 0; d--) {
      const k = x - y;
      let prevK: number;
      if (
        k === -d ||
        (k !== d && (trace[d - 1][k - 1] ?? -1) < (trace[d - 1][k + 1] ?? -1))
      ) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }

      const prevX = trace[d - 1][prevK] ?? 0;
      const prevY = prevX - prevK;

      while (x > prevX && y > prevY) {
        result.unshift({ type: 'unchanged', text: a[x - 1] });
        x--;
        y--;
      }

      if (d > 0) {
        if (x === prevX) {
          result.unshift({ type: 'added', text: b[prevY] });
        } else if (y === prevY) {
          result.unshift({ type: 'deleted', text: a[prevX] });
        }
      }

      x = prevX;
      y = prevY;
    }

    while (x > 0 && y > 0) {
      result.unshift({ type: 'unchanged', text: a[x - 1] });
      x--;
      y--;
    }

    return result;
  }

  private enhanceWithWordDiffs(diffLines: DiffLine[]): void {
    let i = 0;
    while (i < diffLines.length) {
      if (diffLines[i].type !== 'deleted') {
        i++;
        continue;
      }

      const delStart = i;
      while (i < diffLines.length && diffLines[i].type === 'deleted') {
        i++;
      }
      const delEnd = i;

      const addStart = i;
      while (i < diffLines.length && diffLines[i].type === 'added') {
        i++;
      }
      const addEnd = i;

      const pairCount = Math.min(delEnd - delStart, addEnd - addStart);
      for (let k = 0; k < pairCount; k++) {
        const delLine = diffLines[delStart + k];
        const addLine = diffLines[addStart + k];
        const oldTokens = this.tokenizeText(delLine.text);
        const newTokens = this.tokenizeText(addLine.text);
        const { aTokens, bTokens } = this.computeTokenLCS(oldTokens, newTokens);
        delLine.words = aTokens;
        addLine.words = bTokens;
      }
    }
  }

  private tokenizeText(text: string): string[] {
    return text.split(/([^\w\s]+|\s+)/).filter(Boolean);
  }

  private computeTokenLCS(
    a: string[],
    b: string[],
  ): { aTokens: WordDiffToken[]; bTokens: WordDiffToken[] } {
    const n = a.length;
    const m = b.length;
    if (n === 0 && m === 0) return { aTokens: [], bTokens: [] };
    if (n === 0) {
      return {
        aTokens: [],
        bTokens: [{ type: 'added', text: b.join('') }],
      };
    }
    if (m === 0) {
      return {
        aTokens: [{ type: 'deleted', text: a.join('') }],
        bTokens: [],
      };
    }

    if (n + m > 500) {
      return {
        aTokens: [{ type: 'deleted', text: a.join('') }],
        bTokens: [{ type: 'added', text: b.join('') }],
      };
    }

    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        if (a[i] === b[j]) {
          dp[i + 1][j + 1] = dp[i][j] + 1;
        } else {
          dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    let i = n;
    let j = m;
    const aResult: WordDiffToken[] = [];
    const bResult: WordDiffToken[] = [];

    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        aResult.unshift({ type: 'unchanged', text: a[i - 1] });
        bResult.unshift({ type: 'unchanged', text: b[j - 1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        bResult.unshift({ type: 'added', text: b[j - 1] });
        j--;
      } else if (i > 0) {
        aResult.unshift({ type: 'deleted', text: a[i - 1] });
        i--;
      }
    }

    return {
      aTokens: this.mergeAdjacentTokens(aResult),
      bTokens: this.mergeAdjacentTokens(bResult),
    };
  }

  private mergeAdjacentTokens(tokens: WordDiffToken[]): WordDiffToken[] {
    const merged: WordDiffToken[] = [];
    for (const t of tokens) {
      if (merged.length > 0 && merged[merged.length - 1].type === t.type) {
        merged[merged.length - 1].text += t.text;
      } else {
        merged.push({ type: t.type, text: t.text });
      }
    }
    return merged;
  }

  private buildHunks(lines: DiffLine[], contextSize = 3): DiffHunkVo[] {
    if (lines.length === 0) return [];

    const changeIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].type !== 'unchanged') {
        changeIndices.push(i);
      }
    }

    if (changeIndices.length === 0) return [];

    const clusters: Array<{ start: number; end: number }> = [];
    let currentCluster = { start: changeIndices[0], end: changeIndices[0] };

    for (let i = 1; i < changeIndices.length; i++) {
      const idx = changeIndices[i];
      if (idx - currentCluster.end <= 2 * contextSize) {
        currentCluster.end = idx;
      } else {
        clusters.push(currentCluster);
        currentCluster = { start: idx, end: idx };
      }
    }
    clusters.push(currentCluster);

    const hunks: DiffHunkVo[] = [];
    for (const cluster of clusters) {
      const hunkStart = Math.max(0, cluster.start - contextSize);
      const hunkEnd = Math.min(lines.length - 1, cluster.end + contextSize);
      const hunkLines = lines.slice(hunkStart, hunkEnd + 1);

      let oldStartLine = 0;
      let oldLineCount = 0;
      let newStartLine = 0;
      let newLineCount = 0;

      for (const line of hunkLines) {
        if (line.type === 'deleted' || line.type === 'unchanged') {
          if (oldStartLine === 0 && line.oldLineNumber !== undefined) {
            oldStartLine = line.oldLineNumber;
          }
          oldLineCount++;
        }
        if (line.type === 'added' || line.type === 'unchanged') {
          if (newStartLine === 0 && line.newLineNumber !== undefined) {
            newStartLine = line.newLineNumber;
          }
          newLineCount++;
        }
      }

      if (oldStartLine === 0) oldStartLine = 1;
      if (newStartLine === 0) newStartLine = 1;

      hunks.push(
        new DiffHunkVo({
          oldStartLine,
          oldLineCount,
          newStartLine,
          newLineCount,
          lines: hunkLines,
        }),
      );
    }

    return hunks;
  }
}

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

const sharedMyersEngine = new MyersDiffEngine();

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split('\n');
}

export function diffLines(a: string[], b: string[]): DiffOp[] {
  return sharedMyersEngine.computeMyersLCS(a, b).map((op) => ({
    type:
      op.type === 'added' ? 'add' : op.type === 'deleted' ? 'remove' : 'equal',
    line: op.text,
  }));
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
