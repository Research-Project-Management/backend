export function normalizeRelationLabel(label?: string | null): string {
  return label?.trim().replace(/\s+/g, ' ') || 'related';
}

export function isSelfRelation(
  sourceItemId: string,
  targetItemId: string,
): boolean {
  return sourceItemId === targetItemId;
}

export function toRelationPairKey(
  sourceItemId: string,
  targetItemId: string,
): string {
  return [sourceItemId, targetItemId].sort().join('___');
}
