/**
 * modules/manuscripts/docstore/domain/text-suggestion-mutator.ts
 * Pure in-process domain functions for applying single and batch track-change
 * suggestion mutations to document lines arrays.
 */

export interface TrackChangeSuggestionSpec {
  type: string;
  text: string;
  startLine?: number | null;
  endLine?: number | null;
  startCol?: number | null;
  endCol?: number | null;
}

/**
 * Pure computation that applies a single accepted track-change suggestion to a copy
 * (or in-place when requested by legacy callers) of a document's lines array.
 */
export function applySuggestionToLines(
  lines: string[],
  record: TrackChangeSuggestionSpec,
): string[] {
  const startLine =
    record.startLine !== null && record.startLine !== undefined
      ? record.startLine
      : 1;
  const endLine =
    record.endLine !== null && record.endLine !== undefined
      ? record.endLine
      : startLine;
  const startCol =
    record.startCol !== null && record.startCol !== undefined
      ? record.startCol
      : 0;
  const endCol =
    record.endCol !== null && record.endCol !== undefined ? record.endCol : 0;
  const changeType = String(record.type);

  if (changeType === 'insert') {
    const lineIdx = Math.max(0, startLine - 1);
    if (lineIdx < lines.length) {
      const currentLine = lines[lineIdx] || '';
      const col = Math.min(startCol, currentLine.length);
      lines[lineIdx] =
        currentLine.slice(0, col) + record.text + currentLine.slice(col);
    } else {
      lines.push(record.text);
    }
  } else if (changeType === 'delete' || changeType === 'replace') {
    const sIdx = Math.max(0, startLine - 1);
    const eIdx = Math.max(0, endLine - 1);
    const replacement = changeType === 'replace' ? record.text : '';
    if (sIdx < lines.length) {
      const line = lines[sIdx] || '';
      const sc = Math.min(startCol, line.length);
      if (sIdx === eIdx) {
        const ec =
          record.endCol !== null && record.endCol !== undefined
            ? Math.min(endCol, line.length)
            : sc + record.text.length;
        lines[sIdx] = line.slice(0, sc) + replacement + line.slice(ec);
      } else {
        const first = line.slice(0, sc);
        const lastLine = lines[eIdx] || '';
        const ec = Math.min(endCol, lastLine.length);
        const last = lastLine.slice(ec);
        lines.splice(sIdx, eIdx - sIdx + 1, first + replacement + last);
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
