export function normalizeSearchTerm(term?: string | null): string {
  return term?.trim().replace(/\s+/g, ' ') || '';
}

export function hasSearchTerm(term?: string | null): boolean {
  return normalizeSearchTerm(term).length > 0;
}

export function clampSearchLimit(limit?: number | string | null): number {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(Math.max(parsed, 1), 100);
}
