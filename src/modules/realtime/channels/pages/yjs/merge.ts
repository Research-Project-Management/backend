import type * as Y from 'yjs';

/**
 * Pure line-based three-way merge algorithm for resolving OCC conflicts between
 * Docstore revisions and live Yjs CRDT buffers.
 */
export function mergeThreeWayText(
  baseText: string,
  remoteText: string,
  localText: string,
): string {
  if (localText === baseText || localText === remoteText) return remoteText;
  if (remoteText === baseText) return localText;

  const baseLines = baseText.split('\n');
  const remoteLines = remoteText.split('\n');
  const localLines = localText.split('\n');

  let prefix = 0;
  const maxPrefix = Math.min(
    baseLines.length,
    remoteLines.length,
    localLines.length,
  );
  while (
    prefix < maxPrefix &&
    baseLines[prefix] === remoteLines[prefix] &&
    baseLines[prefix] === localLines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  const maxSuffix =
    Math.min(baseLines.length, remoteLines.length, localLines.length) - prefix;
  while (
    suffix < maxSuffix &&
    baseLines[baseLines.length - 1 - suffix] ===
      remoteLines[remoteLines.length - 1 - suffix] &&
    baseLines[baseLines.length - 1 - suffix] ===
      localLines[localLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const head = baseLines.slice(0, prefix);
  const tail = suffix > 0 ? baseLines.slice(baseLines.length - suffix) : [];
  const bMid = baseLines.slice(prefix, baseLines.length - suffix);
  const rMid = remoteLines.slice(prefix, remoteLines.length - suffix);
  const lMid = localLines.slice(prefix, localLines.length - suffix);

  if (rMid.length === bMid.length && rMid.every((l, i) => l === bMid[i])) {
    return [...head, ...lMid, ...tail].join('\n');
  }
  if (lMid.length === bMid.length && lMid.every((l, i) => l === bMid[i])) {
    return [...head, ...rMid, ...tail].join('\n');
  }

  let rLeadSame = 0;
  while (
    rLeadSame < bMid.length &&
    rLeadSame < rMid.length &&
    bMid[rLeadSame] === rMid[rLeadSame]
  ) {
    rLeadSame++;
  }
  let lTrailSame = 0;
  while (
    lTrailSame < bMid.length &&
    lTrailSame < lMid.length &&
    bMid[bMid.length - 1 - lTrailSame] === lMid[lMid.length - 1 - lTrailSame]
  ) {
    lTrailSame++;
  }
  if (lLeadCheck(bMid, rMid, lMid, rLeadSame, lTrailSame)) {
    const lChanged = lMid.slice(0, lMid.length - lTrailSame);
    const bUnchangedBetween = bMid.slice(bMid.length - lTrailSame, rLeadSame);
    const rChanged = rMid.slice(rLeadSame);
    return [
      ...head,
      ...lChanged,
      ...bUnchangedBetween,
      ...rChanged,
      ...tail,
    ].join('\n');
  }

  let lLeadSame = 0;
  while (
    lLeadSame < bMid.length &&
    lLeadSame < lMid.length &&
    bMid[lLeadSame] === lMid[lLeadSame]
  ) {
    lLeadSame++;
  }
  let rTrailSame = 0;
  while (
    rTrailSame < bMid.length &&
    rTrailSame < rMid.length &&
    bMid[bMid.length - 1 - rTrailSame] === rMid[rMid.length - 1 - rTrailSame]
  ) {
    rTrailSame++;
  }
  if (lLeadCheck(bMid, lMid, rMid, lLeadSame, rTrailSame)) {
    const rChanged = rMid.slice(0, rMid.length - rTrailSame);
    const bUnchangedBetween = bMid.slice(bMid.length - rTrailSame, lLeadSame);
    const lChanged = lMid.slice(lLeadSame);
    return [
      ...head,
      ...rChanged,
      ...bUnchangedBetween,
      ...lChanged,
      ...tail,
    ].join('\n');
  }

  return [...head, ...rMid, ...lMid, ...tail].join('\n');
}

function lLeadCheck(
  bMid: string[],
  tailEditedMid: string[],
  headEditedMid: string[],
  tailSideUnchangedPrefix: number,
  headSideUnchangedSuffix: number,
): boolean {
  return (
    tailSideUnchangedPrefix + headSideUnchangedSuffix >= bMid.length &&
    tailEditedMid.length >= tailSideUnchangedPrefix &&
    headEditedMid.length >= headSideUnchangedSuffix
  );
}

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
