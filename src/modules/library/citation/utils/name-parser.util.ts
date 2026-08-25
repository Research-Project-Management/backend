/**
 * Academic Stop Words - Filtered out when generating deterministic BibTeX Citation Keys
 */
export const BIBTEX_STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'on',
  'in',
  'for',
  'with',
  'of',
  'and',
  'to',
  'from',
  'at',
  'by',
  'towards',
  'toward',
  'using',
  'through',
  'via',
  'novel',
  'new',
  'study',
  'analysis',
  'design',
  'based',
  'approach',
  'system',
  'method',
  'review',
  'survey',
  'evaluation',
  'framework',
  'modeling',
  'overview',
  'introduction',
  'perspective',
  'investigation',
]);

/**
 * Strips diacritics / accents (including Vietnamese and European characters)
 */
export function stripDiacritics(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/**
 * Extracts the family name (last name) of the first author in standard academic formats:
 * - "Vaswani, Ashish" -> "vaswani"
 * - "Ashish Vaswani" -> "vaswani"
 * - "Geoffrey E. Hinton" -> "hinton"
 * - "Y. LeCun" -> "lecun"
 * - "Johannes Diderik van der Waals" -> "vanderwaals"
 * - "Nguyễn Văn A" -> "nguyen" (if Asian format) or "a" (if English token order)
 */
export function extractFamilyName(authorStr?: string | null): string {
  if (!authorStr || typeof authorStr !== 'string') return 'author';

  const clean = stripDiacritics(authorStr.trim());
  if (!clean) return 'author';

  // Format 1: "FamilyName, GivenNames"
  if (clean.includes(',')) {
    const parts = clean.split(',');
    const family = parts[0]
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    return family || 'author';
  }

  // Format 2: "GivenNames FamilyName"
  const tokens = clean.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    return tokens[0].toLowerCase().replace(/[^a-z0-9]/g, '') || 'author';
  }

  // Last token is family name
  const lastToken = tokens[tokens.length - 1];
  const family = lastToken.toLowerCase().replace(/[^a-z0-9]/g, '');
  return family || 'author';
}

/**
 * Extracts the first non-stop-word title keyword for Citation Key generation
 */
export function extractMeaningfulTitleWord(title?: string | null): string {
  if (!title || typeof title !== 'string') return 'doc';

  const clean = stripDiacritics(title.trim());
  if (!clean) return 'doc';

  const words = clean
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !BIBTEX_STOP_WORDS.has(w));

  return words[0] || 'doc';
}
