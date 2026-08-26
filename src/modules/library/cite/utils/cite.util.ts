export const STOP_WORDS = new Set([
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
export const BIBTEX_STOP_WORDS = STOP_WORDS;

export function stripDiacritics(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

export function extractFamilyName(rawAuthor: string): string {
  if (!rawAuthor || typeof rawAuthor !== 'string') return 'author';
  const clean = stripDiacritics(rawAuthor).trim();

  if (clean.includes(',')) {
    const last = clean.split(',')[0].trim();
    return sanitizeKeyWord(last) || 'author';
  }

  const tokens = clean.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 'author';

  const last = tokens[tokens.length - 1];
  return sanitizeKeyWord(last) || 'author';
}

export function extractMeaningfulTitleWord(title: string): string {
  if (!title || typeof title !== 'string') return 'item';
  const clean = stripDiacritics(title).toLowerCase();

  const words = clean.split(/[^a-z0-9]+/).filter(Boolean);

  for (const word of words) {
    if (!STOP_WORDS.has(word) && word.length >= 2) {
      return word;
    }
  }

  return words[0] || 'item';
}

function sanitizeKeyWord(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function generateCitationKey(
  author?: string,
  year?: number | null,
  title?: string,
): string {
  const authorPart = extractFamilyName(author || 'item');
  const yearPart = year ? String(year) : '';
  const titlePart = extractMeaningfulTitleWord(title || '');

  return `${authorPart}${yearPart}${titlePart}`;
}
