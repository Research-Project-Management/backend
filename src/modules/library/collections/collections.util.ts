export function normalizeCollectionName(name?: string | null): string {
  return name?.trim().replace(/\s+/g, ' ') || 'Untitled Collection';
}

export function normalizeOptionalCollectionId(
  collectionId?: string | null,
): string | null {
  const value = collectionId?.trim();
  return value ? value : null;
}

export function isSameCollectionId(
  left?: string | null,
  right?: string | null,
): boolean {
  return (
    normalizeOptionalCollectionId(left) === normalizeOptionalCollectionId(right)
  );
}
