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

export interface ChangePatchStrategy {
  accept(
    sourceLines: readonly string[],
    change: TrackChange,
  ): LinePatchComputation;
  reject(
    sourceLines: readonly string[],
    change: TrackChange,
  ): LinePatchComputation;
}

export class LinePatcher {
  /**
   * Symmetric Dual Strategy Table for TrackChange accept/reject operations:
   * - accept('insert') === reject('delete') === insertIfAbsent
   * - reject('insert') === accept('delete') === removeIfNonEmptyRange / removeRange
   */
  public static readonly CHANGE_PATCH_STRATEGIES: Readonly<
    Record<'insert' | 'delete', ChangePatchStrategy>
  > = Object.freeze({
    insert: {
      accept: (sourceLines, change) =>
        LinePatcher.insertIfAbsent(sourceLines, change.range, change.text, true),
      reject: (sourceLines, change) =>
        LinePatcher.removeIfNonEmptyRange(
          sourceLines,
          change.range,
          change.text,
        ),
    },
    delete: {
      accept: (sourceLines, change) => ({
        lines: LinePatcher.removeRange(sourceLines, change.range),
        mutated: true,
      }),
      reject: (sourceLines, change) =>
        LinePatcher.insertIfAbsent(
          sourceLines,
          change.range,
          change.text,
          false,
        ),
    },
  });

  /**
   * Checks whether `text` is already present in `sourceLines` starting at `(lineIdx, startCol)`.
   * Correctly handles single-line and multi-line `text` (including text beginning with `\n`).
   */
  private static isTextPresentAt(
    sourceLines: readonly string[],
    lineIdx: number,
    startCol: number,
    text: string,
  ): boolean {
    if (!text || lineIdx < 0 || lineIdx >= sourceLines.length) return false;
    const currentLine = sourceLines[lineIdx] ?? '';
    const clampedCol = Math.max(0, Math.min(startCol, currentLine.length));

    if (!text.includes('\n')) {
      return currentLine.slice(clampedCol).startsWith(text);
    }

    const parts = text.split('\n');
    if (lineIdx + parts.length - 1 >= sourceLines.length) {
      return false;
    }

    // First line after clampedCol must equal parts[0] exactly
    if (currentLine.slice(clampedCol) !== parts[0]) {
      return false;
    }

    // Middle lines must match exactly
    for (let i = 1; i < parts.length - 1; i++) {
      if (sourceLines[lineIdx + i] !== parts[i]) {
        return false;
      }
    }

    // Last line must start with the final segment
    const lastPart = parts[parts.length - 1];
    const targetLastLine = sourceLines[lineIdx + parts.length - 1] ?? '';
    return targetLastLine.startsWith(lastPart);
  }

  private static insertIfAbsent(
    sourceLines: readonly string[],
    range: TextRangeVo | TextRangeProps,
    text: string,
    adjustOneBasedRange: boolean,
  ): LinePatchComputation {
    if (!text) {
      return { lines: [...sourceLines], mutated: false };
    }
    const useOneBased =
      range.startLine > 0 &&
      range.startLine === sourceLines.length &&
      (!adjustOneBasedRange || range.endLine >= range.startLine);
    const lineIdx = LinePatcher.clampLineIndex(
      range.startLine,
      sourceLines.length,
      useOneBased,
    );
    if (
      LinePatcher.isTextPresentAt(sourceLines, lineIdx, range.startCol, text)
    ) {
      return { lines: [...sourceLines], mutated: false };
    }
    const targetRange =
      adjustOneBasedRange && useOneBased
        ? {
            startLine: range.startLine - 1,
            startCol: range.startCol,
            endLine: Math.max(0, range.endLine - 1),
            endCol: range.endCol,
          }
        : range;
    return {
      lines: LinePatcher.insertRange(sourceLines, targetRange, text),
      mutated: true,
    };
  }

  private static removeIfNonEmptyRange(
    sourceLines: readonly string[],
    range: TextRangeVo | TextRangeProps,
    fallbackText?: string,
  ): LinePatchComputation {
    if (
      range.startLine === range.endLine &&
      range.startCol === range.endCol
    ) {
      if (!fallbackText) {
        return { lines: [...sourceLines], mutated: false };
      }
      const useOneBased =
        range.startLine > 0 && range.startLine === sourceLines.length;
      const lineIdx = LinePatcher.clampLineIndex(
        range.startLine,
        sourceLines.length,
        useOneBased,
      );
      if (
        !LinePatcher.isTextPresentAt(
          sourceLines,
          lineIdx,
          range.startCol,
          fallbackText,
        )
      ) {
        return { lines: [...sourceLines], mutated: false };
      }
      const parts = fallbackText.split('\n');
      const inferredRange: TextRangeProps =
        parts.length === 1
          ? {
              startLine: lineIdx,
              startCol: range.startCol,
              endLine: lineIdx,
              endCol: range.startCol + fallbackText.length,
            }
          : {
              startLine: lineIdx,
              startCol: range.startCol,
              endLine: lineIdx + parts.length - 1,
              endCol: parts[parts.length - 1].length,
            };
      return {
        lines: LinePatcher.removeRange(sourceLines, inferredRange),
        mutated: true,
      };
    }
    return {
      lines: LinePatcher.removeRange(sourceLines, range),
      mutated: true,
    };
  }
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
   * If an 'insert' is not yet present at its target range (e.g. out-of-band review suggestion),
   * inserts the text; if already present, keeps the lines as-is.
   * Accepting a 'delete' removes the range.
   */
  public static computeAcceptedPatch(
    sourceLines: readonly string[],
    change: TrackChange,
  ): LinePatchComputation {
    const strategy =
      LinePatcher.CHANGE_PATCH_STRATEGIES[change.type] ??
      LinePatcher.CHANGE_PATCH_STRATEGIES.delete;
    return strategy.accept(sourceLines, change);
  }

  /**
   * Pure computation of the resulting document lines when a change is rejected.
   * Rejecting an 'insert' removes the range (if the inserted text is present in the lines);
   * rejecting a 'delete' re-inserts the deleted text (if not already present at the range).
   */
  public static computeRejectedPatch(
    sourceLines: readonly string[],
    change: TrackChange,
  ): LinePatchComputation {
    const strategy =
      LinePatcher.CHANGE_PATCH_STRATEGIES[change.type] ??
      LinePatcher.CHANGE_PATCH_STRATEGIES.delete;
    return strategy.reject(sourceLines, change);
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

  public static applySuggestionToLines(
    lines: string[],
    record: TrackChangeSuggestionSpec,
  ): string[] {
    return applySuggestionToLines(lines, record);
  }

  public static applyBatchSuggestionsToLines(
    lines: string[],
    changes: readonly TrackChangeSuggestionSpec[],
  ): string[] {
    return applyBatchSuggestionsToLines(lines, changes);
  }
}

export interface TrackChangeSuggestionSpec {
  type: string;
  text: string;
  startLine?: number | null;
  endLine?: number | null;
  startCol?: number | null;
  endCol?: number | null;
}

/**
 * Pure computation that applies a single accepted track-change suggestion to a document's lines array.
 * Supports both 1-based and 0-based line coordinates and multi-line insertions/deletions.
 */
export function applySuggestionToLines(
  lines: string[],
  record: TrackChangeSuggestionSpec,
): string[] {
  const rawStartLine =
    record.startLine !== null && record.startLine !== undefined
      ? record.startLine
      : 1;
  const rawEndLine =
    record.endLine !== null && record.endLine !== undefined
      ? record.endLine
      : rawStartLine;
  const startCol = Math.max(
    0,
    record.startCol !== null && record.startCol !== undefined
      ? record.startCol
      : 0,
  );
  const endCol = Math.max(
    0,
    record.endCol !== null && record.endCol !== undefined ? record.endCol : 0,
  );
  const changeType = String(record.type);
  const isExplicitZero = rawStartLine === 0 && rawEndLine === 0;
  const sIdx = isExplicitZero
    ? 0
    : Math.max(0, rawStartLine > 0 ? rawStartLine - 1 : 0);
  const eIdx = isExplicitZero
    ? 0
    : Math.max(sIdx, rawEndLine > 0 ? rawEndLine - 1 : sIdx);

  if (changeType === 'insert') {
    if (sIdx < lines.length) {
      const currentLine = lines[sIdx] || '';
      const col = Math.min(startCol, currentLine.length);
      const prefix = currentLine.slice(0, col);
      const suffix = currentLine.slice(col);
      if (!record.text.includes('\n')) {
        lines[sIdx] = prefix + record.text + suffix;
      } else {
        const insertedLines = record.text.split('\n');
        const firstLine = prefix + insertedLines[0];
        const lastLine = insertedLines[insertedLines.length - 1] + suffix;
        const middle = insertedLines.slice(1, -1);
        lines.splice(sIdx, 1, firstLine, ...middle, lastLine);
      }
    } else {
      if (!record.text.includes('\n')) {
        lines.push(record.text);
      } else {
        lines.push(...record.text.split('\n'));
      }
    }
  } else if (changeType === 'delete' || changeType === 'replace') {
    const replacement = changeType === 'replace' ? record.text : '';
    if (sIdx < lines.length) {
      const line = lines[sIdx] || '';
      const sc = Math.min(startCol, line.length);
      const clampedEndIdx = Math.min(eIdx, lines.length - 1);
      if (sIdx === clampedEndIdx) {
        const ec =
          record.endCol !== null &&
          record.endCol !== undefined &&
          record.endCol > sc
            ? Math.min(endCol, line.length)
            : Math.min(sc + record.text.length, line.length);
        const newLine = line.slice(0, sc) + replacement + line.slice(ec);
        if (!replacement.includes('\n')) {
          lines[sIdx] = newLine;
        } else {
          lines.splice(sIdx, 1, ...newLine.split('\n'));
        }
      } else {
        const first = line.slice(0, sc);
        const lastLine = lines[clampedEndIdx] || '';
        const ec = Math.min(endCol, lastLine.length);
        const last = lastLine.slice(ec);
        const merged = first + replacement + last;
        if (!replacement.includes('\n')) {
          lines.splice(sIdx, clampedEndIdx - sIdx + 1, merged);
        } else {
          lines.splice(sIdx, clampedEndIdx - sIdx + 1, ...merged.split('\n'));
        }
      }
    }
  }

  return lines;
}

/**
 * Pure computation that applies a batch of pending track-change suggestions
 * sorted from bottom line/offset to top so earlier line mutations do not shift later offsets.
 */
export function applyBatchSuggestionsToLines(
  lines: string[],
  changes: readonly TrackChangeSuggestionSpec[],
): string[] {
  const sortedChanges = [...changes].sort((a, b) => {
    const aLine = a.startLine ?? 1;
    const bLine = b.startLine ?? 1;
    if (bLine !== aLine) return bLine - aLine;
    const aCol = a.startCol ?? 0;
    const bCol = b.startCol ?? 0;
    return bCol - aCol;
  });

  for (const record of sortedChanges) {
    applySuggestionToLines(lines, record);
  }

  return lines;
}

export const TextSuggestionMutator = {
  applySuggestionToLines,
  applyBatchSuggestionsToLines,
} as const;
