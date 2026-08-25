export function normalizeIngestionFilename(filename?: string | null): string {
  return filename?.trim().replace(/\s+/g, ' ') || 'document.pdf';
}

export function inferTitleFromFilename(filename?: string | null): string {
  const clean = normalizeIngestionFilename(filename);
  return (
    clean
      .replace(/\.[^/.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .trim() || 'Untitled'
  );
}

export function hasIngestionIdentifier(input?: string | null): boolean {
  return Boolean(input?.trim());
}
