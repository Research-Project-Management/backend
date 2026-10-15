/**
 * track-changes/domain/line-patcher.ts
 * Pure, side-effect-free domain functions for splicing, inserting, and ordering
 * inline text changes across document lines.
 */

import { TrackChange } from './track-change.entity';
import { TextRangeVo, TextRangeProps } from './text-range.vo';

export interface LinePatchComputation {
  lines: string[];
  mutated: boolean;
}

export class LinePatcher {
  /**
   * Resolves a raw line coordinate (supporting both 0-based and 1-based conventions)
   * and clamps it safely to `[0, linesLength - 1]`.
   */
  public static clampLineIndex(
    rawLine: number,
    linesLength: number,
    preferOneBased = false,
  ): number {
    if (linesLength <= 0) return 0;
    const candidate = preferOneBased ? rawLine - 1 : rawLine;
    return Math.max(0, Math.min(candidate, linesLength - 1));
  }

  /**
   * Pure function removing a character/line range from an array of document lines.
   */
  public static removeRange(
    sourceLines: readonly string[],
    rangeInput: TextRangeVo | TextRangeProps,
  ): string[] {
    const lines = [...sourceLines];
    if (lines.length === 0) return lines;

    const range =
      rangeInput instanceof TextRangeVo
        ? rangeInput
        : TextRangeVo.create(rangeInput);

    const rawStartLine = range.startLine;
    const rawEndLine = range.endLine;
    const startCol = Math.max(0, range.startCol);
    const endCol = Math.max(0, range.endCol);

    if (rawStartLine > lines.length) return lines;
    if (rawStartLine === lines.length && rawEndLine > lines.length) {
      return lines;
    }

    const useOneBased = rawStartLine === lines.length && rawStartLine > 0;
    const startLine = LinePatcher.clampLineIndex(
      rawStartLine,
      lines.length,
      useOneBased,
    );
    const endLine = Math.max(
      startLine,
      LinePatcher.clampLineIndex(rawEndLine, lines.length, useOneBased),
    );

    if (startLine === endLine) {
      const line = lines[startLine] || '';
      const sc = Math.min(startCol, line.length);
      const ec = Math.max(sc, Math.min(endCol, line.length));
      lines[startLine] = line.slice(0, sc) + line.slice(ec);
    } else {
      const firstLine = lines[startLine] || '';
      const lastLine = lines[endLine] || '';
      const first = firstLine.slice(0, Math.min(startCol, firstLine.length));
      const last = lastLine.slice(Math.min(endCol, lastLine.length));
      const merged = first + last;
      lines.splice(startLine, endLine - startLine + 1, merged);
    }

    return lines;
  }

  /**
   * Pure function inserting single-line or multi-line text at the start of a range.
   */
  public static insertRange(
    sourceLines: readonly string[],
    rangeInput: TextRangeVo | TextRangeProps,
    textToInsert: string,
  ): string[] {
    const lines = [...sourceLines];
    const range =
      rangeInput instanceof TextRangeVo
        ? rangeInput
        : TextRangeVo.create(rangeInput);

    const rawStartLine = Math.max(0, range.startLine);
    const startCol = Math.max(0, range.startCol);

    while (rawStartLine >= lines.length) {
      lines.push('');
    }

    const startLine = Math.max(0, Math.min(rawStartLine, lines.length - 1));
    const currentLine = lines[startLine] || '';
    const clampedCol = Math.min(startCol, currentLine.length);
    const prefix = currentLine.slice(0, clampedCol);
    const suffix = currentLine.slice(clampedCol);

    if (!textToInsert.includes('\n')) {
      lines[startLine] = prefix + textToInsert + suffix;
    } else {
      const insertedLines = textToInsert.split('\n');
      const newFirstLine = prefix + insertedLines[0];
      const newLastLine = insertedLines[insertedLines.length - 1] + suffix;
      const middleLines = insertedLines.slice(1, -1);
      lines.splice(startLine, 1, newFirstLine, ...middleLines, newLastLine);
    }

    return lines;
  }

  /**
   * Pure computation of the resulting document lines when a change is accepted.
   * Accepting an 'insert' keeps the lines as-is; accepting a 'delete' removes the range.
   */
  public static computeAcceptedPatch(
    sourceLines: readonly string[],
    change: TrackChange,
  ): LinePatchComputation {
    if (change.type === 'insert') {
      return { lines: [...sourceLines], mutated: false };
    }
    return {
      lines: LinePatcher.removeRange(sourceLines, change.range),
      mutated: true,
    };
  }

  /**
   * Pure computation of the resulting document lines when a change is rejected.
   * Rejecting an 'insert' removes the range; rejecting a 'delete' re-inserts the deleted text.
   */
  public static computeRejectedPatch(
    sourceLines: readonly string[],
    change: TrackChange,
  ): LinePatchComputation {
    if (change.type === 'insert') {
      return {
        lines: LinePatcher.removeRange(sourceLines, change.range),
        mutated: true,
      };
    }
    return {
      lines: LinePatcher.insertRange(sourceLines, change.range, change.text),
      mutated: true,
    };
  }

  /**
   * Sorts changes in descending document coordinate order (bottom-to-top, right-to-left)
   * so sequential line/column mutations do not shift earlier coordinates.
   */
  public static sortChangesBottomUp(
    changes: readonly TrackChange[],
  ): TrackChange[] {
    return [...changes].sort((a, b) => {
      if (b.range.startLine !== a.range.startLine) {
        return b.range.startLine - a.range.startLine;
      }
      return b.range.startCol - a.range.startCol;
    });
  }
}
