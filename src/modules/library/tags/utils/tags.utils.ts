import { TagInput } from '../types/tag.types';

/**
 * Normalizes an array of raw tag strings or tag objects into a unique, trimmed, non-empty list of tag strings.
 * Case-insensitive deduplication preserves the original case of the first seen occurrence.
 */
export function normalizeTags(
  tags?: (TagInput | null | undefined)[] | null,
): string[] {
  if (!Array.isArray(tags)) return [];
  const seenLower = new Set<string>();
  const result: string[] = [];

  for (const item of tags) {
    if (!item) continue;
    const raw = typeof item === 'string' ? item : item.tag || item.name;
    if (raw && typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        const lower = trimmed.toLowerCase();
        if (!seenLower.has(lower)) {
          seenLower.add(lower);
          result.push(trimmed);
        }
      }
    }
  }

  return result;
}
