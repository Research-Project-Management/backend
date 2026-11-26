import { Injectable } from '@nestjs/common';
import { diffArrays, diffWordsWithSpace } from 'diff';
import { FileSnapshotType, Snapshot } from './snapshot';

export type LineDiffType = 'added' | 'deleted' | 'unchanged';
export type WordDiffType = 'added' | 'deleted' | 'unchanged';

export interface WordDiffToken {
  type: WordDiffType;
  text: string;
}

export interface DiffLine {
  type: LineDiffType;
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  words?: WordDiffToken[];
}

export interface DiffHunkProps {
  oldStartLine: number;
  oldLineCount: number;
  newStartLine: number;
  newLineCount: number;
  lines: DiffLine[];
}

export class DiffHunkVo {
  public readonly oldStartLine: number;
  public readonly oldLineCount: number;
  public readonly newStartLine: number;
  public readonly newLineCount: number;
  public readonly lines: DiffLine[];

  constructor(props: DiffHunkProps) {
    this.oldStartLine = props.oldStartLine;
    this.oldLineCount = props.oldLineCount;
    this.newStartLine = props.newStartLine;
    this.newLineCount = props.newLineCount;
    this.lines = props.lines;
  }

  public get header(): string {
    return `@@ -${this.oldStartLine},${this.oldLineCount} +${this.newStartLine},${this.newLineCount} @@`;
  }
}

export type FileDiffStatus =
  'added' | 'deleted' | 'modified' | 'renamed' | 'unchanged';

export interface FileDiffProps {
  path: string;
  status: FileDiffStatus;
  type: FileSnapshotType;
  oldPath?: string;
  oldHash?: string;
  newHash?: string;
  additions: number;
  deletions: number;
  hunks: DiffHunkVo[];
}

export class FileDiffVo {
  public readonly path: string;
  public readonly status: FileDiffStatus;
  public readonly type: FileSnapshotType;
  public readonly oldPath?: string;
  public readonly oldHash?: string;
  public readonly newHash?: string;
  public readonly additions: number;
  public readonly deletions: number;
  public readonly hunks: DiffHunkVo[];

  constructor(props: FileDiffProps) {
    this.path = props.path;
    this.status = props.status;
    this.type = props.type;
    this.oldPath = props.oldPath;
    this.oldHash = props.oldHash;
    this.newHash = props.newHash;
    this.additions = props.additions;
    this.deletions = props.deletions;
    this.hunks = props.hunks;
  }
}

export interface TextDiffResult {
  hunks: DiffHunkVo[];
  additions: number;
  deletions: number;
}

@Injectable()
export class DiffEngine {
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
    if (a.length === 0 && b.length === 0) return [];

    // Guard against pathological huge line diffs
    if (a.length + b.length > 10_000) {
      return [
        ...a.map((text) => ({ type: 'deleted' as const, text })),
        ...b.map((text) => ({ type: 'added' as const, text })),
      ];
    }

    const changes = diffArrays(a, b);
    const ops: Array<{ type: 'added' | 'deleted' | 'unchanged'; text: string }> = [];
    for (const part of changes) {
      const type = part.added ? 'added' : part.removed ? 'deleted' : 'unchanged';
      for (const line of part.value) {
        ops.push({ type, text: line });
      }
    }
    return ops;
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
        const parts = diffWordsWithSpace(delLine.text, addLine.text);
        const aTokens: WordDiffToken[] = [];
        const bTokens: WordDiffToken[] = [];
        for (const part of parts) {
          if (!part.value) continue;
          if (part.removed) {
            aTokens.push({ type: 'deleted', text: part.value });
          } else if (part.added) {
            bTokens.push({ type: 'added', text: part.value });
          } else {
            aTokens.push({ type: 'unchanged', text: part.value });
            bTokens.push({ type: 'unchanged', text: part.value });
          }
        }
        delLine.words = aTokens;
        addLine.words = bTokens;
      }
    }
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

export { DiffEngine as MyersDiffEngine };

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

const sharedDiffEngine = new DiffEngine();

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split('\n');
}

export function diffLines(a: string[], b: string[]): DiffOp[] {
  return sharedDiffEngine.computeMyersLCS(a, b).map((op) => ({
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
