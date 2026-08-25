export function normalizeQualityDoi(doi?: string | null): string {
  return (
    doi
      ?.trim()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
      .replace(/^doi:\s*/i, '')
      .toLowerCase() ?? ''
  );
}

export function normalizeQualityTitle(title?: string | null): string {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

export function hasMeaningfulDoi(doi?: string | null): boolean {
  return normalizeQualityDoi(doi).length > 3;
}
