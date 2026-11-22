/**
 * Pure, side-effect-free functions for splicing, inserting, and ordering
 * inline text changes across document lines.
 */

import { TrackChange } from './change.domain';
import { TextRange, TextRangeProps } from './text-range.domain';
import { StaleAnchorError } from './review.errors';

export interface PatchResult {
  lines: string[];
  mutated: boolean;
}

export interface ChangePatchStrategy {
  accept(sourceLines: readonly string[], change: TrackChange): PatchResult;
  reject(sourceLines: readonly string[], change: TrackChange): PatchResult;
}

export class LinePatcher {
  /**
   * Symmetric Dual Strategy Table:
   * - accept('insert') === reject('delete') === insertIfAbsent
   * - reject('insert') === accept('delete') === removeIfNonEmptyRange / acceptDeleteAnchored
   */
  public static readonly CHANGE_PATCH_STRATEGIES: Readonly<
    Record<'insert' | 'delete', ChangePatchStrategy>
  > = Object.freeze({
    insert: {
      accept: (sourceLines, change) =>
        LinePatcher.insertIfAbsent(sourceLines, change.range, change.text),
      reject: (sourceLines, change) =>
        LinePatcher.removeIfNonEmptyRange(
          sourceLines,
          change.range,
          change.text,
        ),
    },
    delete: {
      accept: (sourceLines, change) =>
        LinePatcher.acceptDeleteAnchored(
          sourceLines,
          change.range,
          change.text,
          change.id,
        ),
      reject: (sourceLines, change) =>
        LinePatcher.insertIfAbsent(sourceLines, change.range, change.text),
    },
  });

  private static extractRangeText(
    sourceLines: readonly string[],
    startLine: number,
    startCol: number,
    endLine: number,
    endCol: number,
  ): string {
    if (
      sourceLines.length === 0 ||
      startLine < 0 ||
      startLine >= sourceLines.length
    ) {
      return '';
    }
    const clampedEndLine = Math.max(
      startLine,
      Math.min(endLine, sourceLines.length - 1),
    );
    if (startLine === clampedEndLine) {
      const line = sourceLines[startLine] ?? '';
      const sc = Math.max(0, Math.min(startCol, line.length));
      const ec = Math.max(sc, Math.min(endCol, line.length));
      return line.slice(sc, ec);
    }
    const parts: string[] = [];
    const first = sourceLines[startLine] ?? '';
    parts.push(first.slice(Math.max(0, Math.min(startCol, first.length))));
    for (let i = startLine + 1; i < clampedEndLine; i++) {
      parts.push(sourceLines[i] ?? '');
    }
    const last = sourceLines[clampedEndLine] ?? '';
    parts.push(last.slice(0, Math.max(0, Math.min(endCol, last.length))));
    return parts.join('\n');
  }

  private static findUniqueAnchoredRange(
    sourceLines: readonly string[],
    range: TextRange | TextRangeProps,
    expectedText: string,
  ): TextRangeProps | null {
    const startLine = Math.max(
      0,
      Math.min(range.startLine, sourceLines.length - 1),
    );
    const lineDelta = Math.max(0, range.endLine - range.startLine);
    const startCol = Math.max(0, range.startCol);

    if (
      LinePatcher.extractRangeText(
        sourceLines,
        startLine,
        startCol,
        startLine + lineDelta,
        range.endCol,
      ) === expectedText
    ) {
      return {
        startLine,
        startCol,
        endLine: Math.min(sourceLines.length - 1, startLine + lineDelta),
        endCol: range.endCol,
      };
    }

    const parts = expectedText.split('\n');
    const inferredLineDelta = Math.max(0, parts.length - 1);
    if (
      LinePatcher.isTextPresentAt(
        sourceLines,
        startLine,
        startCol,
        expectedText,
      )
    ) {
      return parts.length === 1
        ? {
            startLine,
            startCol,
            endLine: startLine,
            endCol: startCol + expectedText.length,
          }
        : {
            startLine,
            startCol,
            endLine: startLine + inferredLineDelta,
            endCol: parts[parts.length - 1].length,
          };
    }

    const matches: TextRangeProps[] = [];
    for (let delta = -5; delta <= 5; delta++) {
      if (delta === 0) continue;
      const candLine = startLine + delta;
      if (candLine < 0 || candLine + inferredLineDelta >= sourceLines.length) {
        continue;
      }
      if (
        LinePatcher.isTextPresentAt(
          sourceLines,
          candLine,
          startCol,
          expectedText,
        )
      ) {
        matches.push(
          parts.length === 1
            ? {
                startLine: candLine,
                startCol,
                endLine: candLine,
                endCol: startCol + expectedText.length,
              }
            : {
                startLine: candLine,
                startCol,
                endLine: candLine + inferredLineDelta,
                endCol: parts[parts.length - 1].length,
              },
        );
      } else if (parts.length === 1) {
        const idx = (sourceLines[candLine] ?? '').indexOf(expectedText);
        if (idx >= 0) {
          const secondIdx = (sourceLines[candLine] ?? '').indexOf(
            expectedText,
            idx + 1,
          );
          if (secondIdx >= 0) {
            return null;
          }
          matches.push({
            startLine: candLine,
            startCol: idx,
            endLine: candLine,
            endCol: idx + expectedText.length,
          });
        }
      }
    }

    return matches.length === 1 ? matches[0] : null;
  }

  private static acceptDeleteAnchored(
    sourceLines: readonly string[],
    range: TextRange | TextRangeProps,
    expectedText: string,
    changeId: string,
  ): PatchResult {
    if (!expectedText) {
      return {
        lines: LinePatcher.removeRange(sourceLines, range),
        mutated: true,
      };
    }
    const matched = LinePatcher.findUniqueAnchoredRange(
      sourceLines,
      range,
      expectedText,
    );
    if (!matched) {
      throw new StaleAnchorError(changeId);
    }
    return {
      lines: LinePatcher.removeRange(sourceLines, matched),
      mutated: true,
    };
  }

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
    if (currentLine.slice(clampedCol) !== parts[0]) {
      return false;
    }
    for (let i = 1; i < parts.length - 1; i++) {
      if (sourceLines[lineIdx + i] !== parts[i]) {
        return false;
      }
    }
    const lastPart = parts[parts.length - 1];
    const targetLastLine = sourceLines[lineIdx + parts.length - 1] ?? '';
    return targetLastLine.startsWith(lastPart);
  }

  private static insertIfAbsent(
    sourceLines: readonly string[],
    range: TextRange | TextRangeProps,
    text: string,
  ): PatchResult {
    if (!text) {
      return { lines: [...sourceLines], mutated: false };
    }
    const lineIdx = LinePatcher.clampLineIndex(
      range.startLine,
      sourceLines.length,
    );
    if (
      LinePatcher.isTextPresentAt(sourceLines, lineIdx, range.startCol, text)
    ) {
      return { lines: [...sourceLines], mutated: false };
    }
    return {
      lines: LinePatcher.insertRange(sourceLines, range, text),
      mutated: true,
    };
  }

  private static removeIfNonEmptyRange(
    sourceLines: readonly string[],
    range: TextRange | TextRangeProps,
    fallbackText?: string,
  ): PatchResult {
    if (fallbackText) {
      const matched = LinePatcher.findUniqueAnchoredRange(
        sourceLines,
        range,
        fallbackText,
      );
      if (!matched) {
        return { lines: [...sourceLines], mutated: false };
      }
      return {
        lines: LinePatcher.removeRange(sourceLines, matched),
        mutated: true,
      };
    }
    if (range.startLine === range.endLine && range.startCol === range.endCol) {
      return { lines: [...sourceLines], mutated: false };
    }
    return {
      lines: LinePatcher.removeRange(sourceLines, range),
      mutated: true,
    };
  }

  public static clampLineIndex(
    rawLine: number,
    linesLength: number,
    preferOneBased = false,
  ): number {
    if (linesLength <= 0) return 0;
    const candidate = preferOneBased ? rawLine - 1 : rawLine;
    return Math.max(0, Math.min(candidate, linesLength - 1));
  }

  public static removeRange(
    sourceLines: readonly string[],
    rangeInput: TextRange | TextRangeProps,
  ): string[] {
    const lines = [...sourceLines];
    if (lines.length === 0) return lines;

    const range =
      rangeInput instanceof TextRange
        ? rangeInput
        : TextRange.create(rangeInput);

    const rawStartLine = range.startLine;
    const rawEndLine = range.endLine;
    const startCol = Math.max(0, range.startCol);
    const endCol = Math.max(0, range.endCol);

    if (rawStartLine >= lines.length || rawStartLine < 0) return lines;

    const startLine = LinePatcher.clampLineIndex(rawStartLine, lines.length);
    const endLine = Math.max(
      startLine,
      LinePatcher.clampLineIndex(rawEndLine, lines.length),
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
      lines.splice(startLine, endLine - startLine + 1, first + last);
    }

    return lines;
  }

  public static insertRange(
    sourceLines: readonly string[],
    rangeInput: TextRange | TextRangeProps,
    textToInsert: string,
  ): string[] {
    const lines = [...sourceLines];
    const range =
      rangeInput instanceof TextRange
        ? rangeInput
        : TextRange.create(rangeInput);

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

  public static computeAcceptedPatch(
    sourceLines: readonly string[],
    change: TrackChange,
  ): PatchResult {
    const strategy =
      LinePatcher.CHANGE_PATCH_STRATEGIES[change.type] ??
      LinePatcher.CHANGE_PATCH_STRATEGIES.delete;
    return strategy.accept(sourceLines, change);
  }

  public static computeRejectedPatch(
    sourceLines: readonly string[],
    change: TrackChange,
  ): PatchResult {
    const strategy =
      LinePatcher.CHANGE_PATCH_STRATEGIES[change.type] ??
      LinePatcher.CHANGE_PATCH_STRATEGIES.delete;
    return strategy.reject(sourceLines, change);
  }

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
