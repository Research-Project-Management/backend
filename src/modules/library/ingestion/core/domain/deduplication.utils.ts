/**
 * Pure domain utility functions for curation, deduplication, and similarity matching.
 *
 * Clean Architecture & DDD:
 * Resides in Domain Policy layer. 100% pure deterministic functions, zero dependencies on NestJS or ORM.
 */

/**
 * Normalizes title string for duplicate matching by removing punctuation and lowercasing.
 */
export function normalizeTitleForDedupe(title?: string | null): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Extracts first author's family/last name from an author string array.
 */
export function extractFirstAuthorFamily(authors?: string[] | null): string {
  if (!authors || authors.length === 0) return '';
  const first = (authors[0] || '').trim().toLowerCase();
  if (first.includes(',')) {
    return first.split(',')[0].trim();
  }
  const parts = first.split(/\s+/);
  return parts[parts.length - 1] || '';
}

/**
 * Extracts normalized author display strings from item contributors.
 */
export function extractContributorAuthors(item: {
  contributors?: Array<{
    firstName?: string;
    lastName?: string;
    fullName?: string;
  }>;
}): string[] {
  if (!item.contributors || item.contributors.length === 0) return [];
  return item.contributors
    .map((c) => c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim())
    .filter(Boolean);
}

/**
 * Generates deduplication bucket key from normalized title prefix and first author surname.
 */
export function generateDedupeBucketKey(
  title: string,
  authors: string[],
  titlePrefixLength = 32,
): string {
  const authorFamily = extractFirstAuthorFamily(authors);
  const tokens = tokenizeTitleWords(title);
  if (tokens.length >= 2) {
    // Resilient to leading stop words (e.g. "A Study of...", "Towards a...", "The...")
    const topTokens = tokens.slice(0, 3).sort().join('_');
    return `${topTokens}::${authorFamily}`;
  }
  const normTitle = normalizeTitleForDedupe(title);
  return `${normTitle.substring(0, titlePrefixLength)}::${authorFamily}`;
}

/**
 * Generates tokens from title for similarity calculation without stripping spaces.
 */
export function tokenizeTitleWords(str?: string | null): string[] {
  if (!str) return [];
  const STOPWORDS = new Set([
    'a',
    'an',
    'the',
    'and',
    'or',
    'of',
    'in',
    'on',
    'at',
    'to',
    'for',
    'with',
    'by',
    'from',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'as',
    'into',
    'through',
    'during',
  ]);
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ') // Replace punctuation & LaTeX symbols with space
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Calculates Token Sort Ratio similarity between two titles.
 * Sorts unique normalized word tokens alphabetically to eliminate word-order sensitivity.
 */
export function calculateTokenSortRatio(
  a?: string | null,
  b?: string | null,
): number {
  if (!a || !b) return 0.0;
  const tokensA = tokenizeTitleWords(a).sort().join(' ');
  const tokensB = tokenizeTitleWords(b).sort().join(' ');
  if (!tokensA || !tokensB) return 0.0;
  if (tokensA === tokensB) return 1.0;

  const maxLen = Math.max(tokensA.length, tokensB.length);
  if (maxLen === 0) return 1.0;

  // Levenshtein distance on sorted tokens
  const m = tokensA.length;
  const n = tokensB.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = tokensA[i - 1] === tokensB[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  const dist = dp[m][n];
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * Calculates Jaccard similarity score between two title strings.
 */
export function calculateTitleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0.0;
  if (a === b) return 1.0;

  // Fast path: Token sort ratio gives high fidelity on academic papers
  const tokenSortScore = calculateTokenSortRatio(a, b);
  if (tokenSortScore >= 0.88) return tokenSortScore;

  // Fallback / complement: Jaccard word set overlap
  const wordsA = new Set(tokenizeTitleWords(a));
  const wordsB = new Set(tokenizeTitleWords(b));
  if (wordsA.size === 0 || wordsB.size === 0) {
    const rawA = a.toLowerCase().trim();
    const rawB = b.toLowerCase().trim();
    return rawA === rawB
      ? 1.0
      : rawA.includes(rawB) || rawB.includes(rawA)
        ? 0.85
        : 0.0;
  }

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  const jaccard = union > 0 ? intersection / union : 0.0;

  return Math.max(jaccard, tokenSortScore);
}

/**
 * Jaro-Winkler string similarity for author surnames.
 */
export function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  const a = s1.toLowerCase().trim();
  const b = s2.toLowerCase().trim();
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;

  const matchDistance = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);
    for (let j = start; j < end; j++) {
      if (!bMatches[j] && a[i] === b[j]) {
        aMatches[i] = true;
        bMatches[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return 0.0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (aMatches[i]) {
      while (!bMatches[k]) k++;
      if (a[i] !== b[k]) transpositions++;
      k++;
    }
  }

  const jaro =
    (matches / a.length +
      matches / b.length +
      (matches - transpositions / 2) / matches) /
    3;

  // Winkler prefix boost (up to 4 chars)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(a.length, b.length)); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Compares two author family strings fuzzily using Jaro-Winkler metric.
 */
export function firstAuthorMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  const normA = a.toLowerCase().replace(/[^a-z]/g, '');
  const normB = b.toLowerCase().replace(/[^a-z]/g, '');
  if (!normA || !normB) return false;
  if (normA === normB || normA.includes(normB) || normB.includes(normA)) {
    return true;
  }
  return jaroWinkler(normA, normB) >= 0.85;
}
