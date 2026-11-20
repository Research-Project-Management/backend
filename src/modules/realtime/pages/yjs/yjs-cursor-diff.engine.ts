import * as Y from 'yjs';

export interface YjsCursorPreservingEdit {
  readonly index: number;
  readonly deleteLen: number;
  readonly insertText: string;
}

export class YjsCursorDiffEngine {
  private static isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff;
  }

  private static isLowSurrogate(code: number): boolean {
    return code >= 0xdc00 && code <= 0xdfff;
  }

  public static trimSpanToSingleEdit(
    baseOffset: number,
    oldSpan: string,
    newSpan: string,
  ): YjsCursorPreservingEdit | null {
    if (oldSpan === newSpan) return null;

    let prefix = 0;
    const maxPrefix = Math.min(oldSpan.length, newSpan.length);
    while (prefix < maxPrefix && oldSpan[prefix] === newSpan[prefix]) {
      prefix++;
    }
    if (
      prefix > 0 &&
      (this.isHighSurrogate(oldSpan.charCodeAt(prefix - 1)) ||
        this.isHighSurrogate(newSpan.charCodeAt(prefix - 1)))
    ) {
      prefix--;
    }

    let suffix = 0;
    const maxSuffix = Math.min(oldSpan.length, newSpan.length) - prefix;
    while (
      suffix < maxSuffix &&
      oldSpan[oldSpan.length - 1 - suffix] ===
        newSpan[newSpan.length - 1 - suffix]
    ) {
      suffix++;
    }
    if (
      suffix > 0 &&
      (this.isLowSurrogate(oldSpan.charCodeAt(oldSpan.length - suffix)) ||
        this.isLowSurrogate(newSpan.charCodeAt(newSpan.length - suffix)))
    ) {
      suffix--;
    }

    return {
      index: baseOffset + prefix,
      deleteLen: oldSpan.length - prefix - suffix,
      insertText: newSpan.slice(prefix, newSpan.length - suffix),
    };
  }

  public static computeCursorPreservingEdits(
    current: string,
    nextText: string,
  ): YjsCursorPreservingEdit[] {
    if (current === nextText) return [];

    const oldLines = current.match(/[^\n]*\n|[^\n]+/g) ?? [];
    const newLines = nextText.match(/[^\n]*\n|[^\n]+/g) ?? [];

    if (
      oldLines.length <= 1 ||
      newLines.length <= 1 ||
      oldLines.length * newLines.length > 400_000
    ) {
      const single = this.trimSpanToSingleEdit(0, current, nextText);
      return single ? [single] : [];
    }

    let startLine = 0;
    while (
      startLine < oldLines.length &&
      startLine < newLines.length &&
      oldLines[startLine] === newLines[startLine]
    ) {
      startLine++;
    }

    let endOld = oldLines.length;
    let endNew = newLines.length;
    while (
      endOld > startLine &&
      endNew > startLine &&
      oldLines[endOld - 1] === newLines[endNew - 1]
    ) {
      endOld--;
      endNew--;
    }

    const midOld = oldLines.slice(startLine, endOld);
    const midNew = newLines.slice(startLine, endNew);
    const m = midOld.length;
    const n = midNew.length;

    if (m * n > 250_000) {
      const single = this.trimSpanToSingleEdit(0, current, nextText);
      return single ? [single] : [];
    }

    const dp = new Int32Array((m + 1) * (n + 1));
    const width = n + 1;
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (midOld[i] === midNew[j]) {
          dp[i * width + j] = 1 + dp[(i + 1) * width + (j + 1)];
        } else {
          const down = dp[(i + 1) * width + j];
          const right = dp[i * width + (j + 1)];
          dp[i * width + j] = down >= right ? down : right;
        }
      }
    }

    let baseCharOffset = 0;
    for (let k = 0; k < startLine; k++) {
      baseCharOffset += oldLines[k].length;
    }

    const edits: YjsCursorPreservingEdit[] = [];
    let i = 0;
    let j = 0;
    let hunkOldStart = 0;
    let hunkNewStart = 0;
    let hunkCharOffset = baseCharOffset;

    const flushHunk = (oldEndIdx: number, newEndIdx: number) => {
      if (oldEndIdx === hunkOldStart && newEndIdx === hunkNewStart) return;
      const oldSpan = midOld.slice(hunkOldStart, oldEndIdx).join('');
      const newSpan = midNew.slice(hunkNewStart, newEndIdx).join('');
      const edit = this.trimSpanToSingleEdit(hunkCharOffset, oldSpan, newSpan);
      if (edit) edits.push(edit);
      hunkCharOffset += oldSpan.length;
    };

    while (i < m && j < n) {
      if (midOld[i] === midNew[j]) {
        flushHunk(i, j);
        hunkCharOffset += midOld[i].length;
        i++;
        j++;
        hunkOldStart = i;
        hunkNewStart = j;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
        i++;
      } else {
        j++;
      }
    }
    flushHunk(m, n);

    return edits;
  }

  public static applyEditsToYText(
    doc: Y.Doc,
    yText: Y.Text,
    current: string,
    nextText: string,
    origin: string,
  ): YjsCursorPreservingEdit[] {
    if (current === nextText) return [];
    const edits = this.computeCursorPreservingEdits(current, nextText);
    if (edits.length === 0) return [];

    doc.transact(() => {
      for (let i = edits.length - 1; i >= 0; i--) {
        const edit = edits[i];
        if (edit.deleteLen > 0) {
          yText.delete(edit.index, edit.deleteLen);
        }
        if (edit.insertText.length > 0) {
          yText.insert(edit.index, edit.insertText);
        }
      }
    }, origin);

    return edits;
  }
}
