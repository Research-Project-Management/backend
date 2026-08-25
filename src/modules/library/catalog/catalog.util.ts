export function normalizeCatalogDoi(doi?: string | null): string | null {
  const value = doi
    ?.trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');

  return value ? value.toLowerCase() : null;
}

export function normalizeCatalogTitle(title?: string | null): string {
  return title?.trim().replace(/\s+/g, ' ') || 'Untitled';
}

export function parseCatalogYear(
  value?: string | number | null,
): number | null {
  if (value === null || value === undefined || value === '') return null;

  const match = String(value).match(/\b(18|19|20|21)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

export function normalizeCatalogStringList(
  values?: Array<string | null | undefined> | null,
): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}
