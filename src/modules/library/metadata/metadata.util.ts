export * from './circuit-breaker.util';
export * from './query-classifier.util';

export function normalizeMetadataDoi(doi?: string | null): string {
  return (
    doi
      ?.trim()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
      .replace(/^doi:\s*/i, '') ?? ''
  );
}

export function normalizeMetadataTitle(title?: string | null): string {
  return title?.trim().replace(/\s+/g, ' ') || '';
}

export function normalizeMetadataAuthors(
  authors?: Array<string | null | undefined> | null,
): string[] {
  return (authors ?? [])
    .map((author) => author?.trim())
    .filter((author): author is string => Boolean(author));
}
