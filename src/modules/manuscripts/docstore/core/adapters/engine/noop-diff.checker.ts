/**
 * modules/manuscripts/docstore/core/adapters/engine/noop-diff.checker.ts
 * Filters out redundant no-op database writes by comparing incoming lines, version, and ranges.
 * Matches Overleaf DocManager.js diff checking optimization.
 */

import { TextDoc } from '../../domain/text-doc.entity';
import { DocRanges, DocRangeVo } from '../../domain/doc-range.vo';

export interface DiffCheckResult {
  shouldUpdate: boolean;
  updateLines: boolean;
  updateVersion: boolean;
  updateRanges: boolean;
}

export class NoopDiffChecker {
  /**
   * Fast equality check between existing doc lines and incoming lines.
   */
  public static areLinesEqual(currentLines: string[], newLines: string[]): boolean {
    if (currentLines.length !== newLines.length) return false;
    for (let i = 0; i < currentLines.length; i++) {
      if (currentLines[i] !== newLines[i]) return false;
    }
    return true;
  }

  /**
   * Evaluates if any part of the document has meaningfully changed.
   */
  public static checkDiff(
    currentDoc: TextDoc,
    newLines: string[],
    newVersion: number,
    newRanges?: DocRanges
  ): DiffCheckResult {
    const updateLines = !this.areLinesEqual(currentDoc.lines, newLines);
    const updateVersion = currentDoc.version !== newVersion;
    const updateRanges = newRanges !== undefined && !DocRangeVo.areEqual(currentDoc.ranges, newRanges);

    const shouldUpdate = updateLines || updateVersion || updateRanges;

    return {
      shouldUpdate,
      updateLines,
      updateVersion,
      updateRanges,
    };
  }
}
