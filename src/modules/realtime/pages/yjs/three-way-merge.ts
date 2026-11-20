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
