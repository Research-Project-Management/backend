/**
 * project-history/core/adapters/engine/myers-diff-engine.adapter.ts
 * Driven Adapter implementing IDiffEnginePort using the standard Myers Diff algorithm
 * and character/word-level highlight analysis.
 */

import { Injectable } from '@nestjs/common';
import { IDiffEnginePort, TextDiffResult } from '../../ports/diff-engine.port';
import { Snapshot } from '../../domain/entities/snapshot.entity';
import { FileDiffVo } from '../../domain/value-objects/file-diff.vo';
import {
  DiffHunkVo,
  DiffLine,
  WordDiffToken,
} from '../../domain/value-objects/diff-hunk.vo';

@Injectable()
export class MyersDiffEngineAdapter extends IDiffEnginePort {
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

    // Track processed paths
    const processedTargetPaths = new Set<string>();

    // 1. Process files present in baseSnapshot (check for DELETED, MODIFIED, or RENAMED)
    for (const [path, baseFile] of baseFiles.entries()) {
      const targetFile = targetFiles.get(path);

      if (!targetFile) {
        // Check for potential rename (different path, but identical hash)
        let renameTarget: string | null = null;
        for (const [tPath, tFile] of targetFiles.entries()) {
          if (!baseFiles.has(tPath) && tFile.hash === baseFile.hash) {
            renameTarget = tPath;
            break;
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
          // File DELETED
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

        // File exists in both snapshots
        if (baseFile.hash !== targetFile.hash) {
          // File MODIFIED
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
            // Binary file modified
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

    // Perform intra-line word diff on adjacent deleted/added pairs
    this.enhanceWithWordDiffs(diffLines);

    // Group into standard diff hunks (with 3 lines of unchanged context)
    const hunks = this.buildHunks(diffLines);

    return {
      hunks,
      additions,
      deletions,
    };
  }

  /**
   * High-performance Myers diff algorithm for Longest Common Subsequence of lines
   * featuring O(N) common prefix/suffix trimming and bounded memory guard.
   */
  private computeMyersLCS(
    a: string[],
    b: string[],
  ): Array<{ type: 'added' | 'deleted' | 'unchanged'; text: string }> {
    const n = a.length;
    const m = b.length;
    if (n === 0 && m === 0) return [];

    // 1. Fast path: Common prefix trimming (O(N) before entering O(ND) matrix)
    let start = 0;
    while (start < n && start < m && a[start] === b[start]) {
      start++;
    }

    // 2. Fast path: Common suffix trimming
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

    // If middle slices are empty, the entire document was identical
    if (middleA.length === 0 && middleB.length === 0) {
      return [...prefix, ...suffix];
    }

    // Safety threshold: If middle slice exceeds 3,000 lines (pathological diff),
    // fallback gracefully to block replacement to prevent event loop blocking.
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
          return this.backtrackMyers(a, b, trace, max);
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
    max: number,
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

  /**
   * Computes fine-grained word-level diff tokens for adjacent deleted & added lines.
   */
  private enhanceWithWordDiffs(diffLines: DiffLine[]): void {
    for (let i = 0; i < diffLines.length - 1; i++) {
      const current = diffLines[i];
      const next = diffLines[i + 1];

      if (current.type === 'deleted' && next.type === 'added') {
        const oldTokens = this.tokenizeText(current.text);
        const newTokens = this.tokenizeText(next.text);
        const { aTokens, bTokens } = this.computeTokenLCS(oldTokens, newTokens);
        current.words = aTokens;
        next.words = bTokens;
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

    // Safety guard on pathological lines with > 500 tokens
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

  /**
   * Groups linear diff lines into standard discrete unified diff hunks with context windows.
   */
  private buildHunks(lines: DiffLine[], contextSize = 3): DiffHunkVo[] {
    if (lines.length === 0) return [];

    const changeIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].type !== 'unchanged') {
        changeIndices.push(i);
      }
    }

    if (changeIndices.length === 0) return [];

    // Group change indices into clusters where distance <= 2 * contextSize
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
