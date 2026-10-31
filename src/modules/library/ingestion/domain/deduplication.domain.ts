/**
 * Pure domain utility functions for curation, deduplication, and similarity matching.
 */
import { isVietnameseName } from '@/modules/library/core';

const GREEK_UNICODE_TO_LATIN: Record<string, string> = {
  α: ' alpha ',
  β: ' beta ',
  γ: ' gamma ',
  δ: ' delta ',
  ε: ' epsilon ',
  ζ: ' zeta ',
  η: ' eta ',
  θ: ' theta ',
  ι: ' iota ',
  κ: ' kappa ',
  λ: ' lambda ',
  μ: ' mu ',
  ν: ' nu ',
  ξ: ' xi ',
  π: ' pi ',
  ρ: ' rho ',
  σ: ' sigma ',
  ς: ' sigma ',
  τ: ' tau ',
  υ: ' upsilon ',
  φ: ' phi ',
  χ: ' chi ',
  ψ: ' psi ',
  ω: ' omega ',
  Δ: ' delta ',
  Γ: ' gamma ',
  Λ: ' lambda ',
  Ω: ' omega ',
  Φ: ' phi ',
  Π: ' pi ',
  Ψ: ' psi ',
  Σ: ' sigma ',
  Θ: ' theta ',
};

function stripDiacriticsAndLigatures(input: string): string {
  return input
    .replace(/ß/g, 'ss')
    .replace(/[łŁ]/g, 'l')
    .replace(/[øØ]/g, 'o')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[œŒ]/g, 'oe')
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function cleanAcademicTitleForDedupe(raw?: string | null): string {
  if (!raw) return '';
  let s = raw
    // Strip HTML/XML tags such as <i>, <b>, <sub>, <sup>
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    // Strip trailing bibliographic bracket tags: [Article], (Preprint), [Review], etc.
    .replace(
      /\s*[[(](?:article|review|preprint|online ahead of print|author manuscript|in press|translated|abstract|english|german|french|spanish|chinese|japanese)[\])]\s*$/gi,
      '',
    )
    // Strip LaTeX formatting macros while keeping inner text
    .replace(
      /\\(?:textbf|textit|emph|mathrm|mathbf|mathit|text|mathcal)\b/gi,
      ' ',
    );

  // Convert LaTeX Greek macros (\alpha, \beta, \gamma, etc.) to spaced Latin names
  s = s.replace(
    /\\(alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|varphi|chi|psi|omega)\b/gi,
    ' $1 ',
  );

  // Convert Unicode Greek characters to Latin names
  s = s.replace(
    /[αβγδεζηθικλμνξπρσςτυφχψωΔΓΛΩΦΠΨΣΘ]/g,
    (ch) => GREEK_UNICODE_TO_LATIN[ch] ?? ch,
  );

  // Strip curly braces and LaTeX punctuation accent escapes like {\"u}, \'e, \^o
  s = s
    .replace(/\\(?:u|v|H|c|k|b|d)\{([a-zA-Z])\}/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/\\[`'^"~=.]([a-zA-Z])/g, '$1');

  return stripDiacriticsAndLigatures(s).toLowerCase();
}

/**
 * Normalizes title string for duplicate matching by removing punctuation and lowercasing.
 */
export function normalizeTitleForDedupe(title?: string | null): string {
  if (!title) return '';
  return cleanAcademicTitleForDedupe(title)
    .replace(/[^\p{L}\p{N}]/gu, '')
    .trim();
}

/**
 * Extracts first author's family/last name from an author string array,
 * normalizing diacritics and German umlaut transliterations (Müller / Mueller / Muller -> muller).
 */
export function extractFirstAuthorFamily(authors?: string[] | null): string {
  if (!authors || authors.length === 0) return '';
  const firstRaw = (authors[0] || '')
    .replace(/\\(?:u|v|H|c|k|b|d)\{([a-zA-Z])\}/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/\\[`'^"~=.]([a-zA-Z])/g, '$1')
    .trim();
  if (!firstRaw) return '';

  let familyRaw = '';
  if (firstRaw.includes(',')) {
    familyRaw = firstRaw.split(',')[0].trim();
  } else if (isVietnameseName(firstRaw)) {
    const parts = firstRaw.split(/\s+/);
    familyRaw = parts[0] || '';
  } else {
    const parts = firstRaw.split(/\s+/);
    familyRaw = parts[parts.length - 1] || '';
  }

  return stripDiacriticsAndLigatures(familyRaw.toLowerCase())
    .replace(/ae/g, 'a')
    .replace(/oe/g, 'o')
    .replace(/ue/g, 'u')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .trim();
}

/**
 * Extracts normalized author display strings from item contributors.
 */
export function extractContributorAuthors(item: {
  contributors?: Array<{
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
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
  return cleanAcademicTitleForDedupe(str)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
      ' $& ',
    )
    .trim()
    .split(/\s+/)
    .filter(
      (w) =>
        (w.length > 1 ||
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
            w,
          )) &&
        !STOPWORDS.has(w),
    );
}

/**
 * 1D Rolling-Row Levenshtein Distance ($O(N)$ space, zero 2D matrix heap allocations).
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = new Uint16Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prevDiag = dp[0];
    dp[0] = i;
    const charA = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      const cost = charA === b.charCodeAt(j - 1) ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prevDiag + cost);
      prevDiag = temp;
    }
  }

  return dp[n];
}

function computeTokenSortRatioFromTokens(
  rawTokensA: readonly string[],
  rawTokensB: readonly string[],
): number {
  if (rawTokensA.length === 0 || rawTokensB.length === 0) return 0.0;
  const sortedA = [...rawTokensA].sort().join(' ');
  const sortedB = [...rawTokensB].sort().join(' ');
  if (!sortedA || !sortedB) return 0.0;
  if (sortedA === sortedB) return 1.0;

  const maxLen = Math.max(sortedA.length, sortedB.length);
  if (maxLen === 0) return 1.0;

  const dist = levenshteinDistance(sortedA, sortedB);
  return Math.max(0, 1 - dist / maxLen);
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
  return computeTokenSortRatioFromTokens(
    tokenizeTitleWords(a),
    tokenizeTitleWords(b),
  );
}

const ROMAN_NUMERAL_TO_ARABIC: Readonly<Record<string, string>> = {
  i: '1',
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
  xi: '11',
  xii: '12',
};

function normalizePartDesignatorToken(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (ROMAN_NUMERAL_TO_ARABIC[lower]) {
    return ROMAN_NUMERAL_TO_ARABIC[lower];
  }
  if (/^\d+$/.test(lower)) {
    return String(parseInt(lower, 10));
  }
  return lower;
}

export function extractPartAndVolumeMarkers(title: string): string[] {
  if (!title) return [];
  const collected: Array<{ index: number; token: string }> = [];

  const structRegex =
    /\b(?:part|vol(?:ume)?\.?|section|chapter)\s*(?:#|no\.?\s*)?(\d+|i{1,3}|iv|vi{0,3}|ix|x|xi{1,2})\b/gi;
  for (const m of title.matchAll(structRegex)) {
    if (m[1] && m.index !== undefined) {
      collected.push({
        index: m.index,
        token: normalizePartDesignatorToken(m[1]),
      });
    }
  }

  const paperStudyRegex =
    /\b(?:[Pp]aper|PAPER|[Ss]tudy|STUDY)\s*(?:#|no\.?\s*)?(\d+|I{1,3}|IV|VI{0,3}|IX|X|XI{1,2})\b/g;
  for (const m of title.matchAll(paperStudyRegex)) {
    if (m[1] && m.index !== undefined) {
      collected.push({
        index: m.index,
        token: normalizePartDesignatorToken(m[1]),
      });
    }
  }

  const upperLetterRegex =
    /\b(?:[Pp]art|PART|[Ss]ection|SECTION|[Vv]ol(?:ume)?\.?|VOL(?:UME)?\.?)\s+([A-HJ-UW-Z])\b/g;
  for (const m of title.matchAll(upperLetterRegex)) {
    if (m[1] && m.index !== undefined) {
      collected.push({
        index: m.index,
        token: m[1].toLowerCase(),
      });
    }
  }

  return collected
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.token);
}

type DocumentRelationCategory =
  'main' | 'reply' | 'comment' | 'erratum' | 'retraction' | 'supplement';

function classifyDocumentRelationCategory(
  title: string,
): DocumentRelationCategory {
  if (
    /\b(?:reply\s+to(?:\s+comment\s+on)?|response\s+to|authors?'?\s+reply|author\s+response)\b/i.test(
      title,
    )
  ) {
    return 'reply';
  }
  if (/\b(?:comment(?:ary)?\s+on)\b/i.test(title)) {
    return 'comment';
  }
  if (
    /\b(?:errat(?:um|a)|corrigend(?:um|a)|addendum|correction\s+to|published\s+erratum)\b/i.test(
      title,
    )
  ) {
    return 'erratum';
  }
  if (/\b(?:retraction(?:\s+of|\s+notice)?|retracted\s*:)\b/i.test(title)) {
    return 'retraction';
  }
  if (
    /\b(?:supplementary\s+(?:material|information|data|appendix|notes?)|supporting\s+information)\b/i.test(
      title,
    )
  ) {
    return 'supplement';
  }
  return 'main';
}

const GENERIC_BOILERPLATE_TITLES = new Set([
  'editorial',
  'guest editorial',
  'preface',
  'introduction',
  'foreword',
  'afterword',
  'book review',
  'book reviews',
  'front matter',
  'back matter',
  'table of contents',
  'contents',
  'erratum',
  'corrigendum',
  'addendum',
  'retraction',
  'acknowledgements',
  'acknowledgments',
  'author response',
  'authors reply',
  'letter to the editor',
  'letters to the editor',
  'issue information',
  'masthead',
  'cover image',
  'in this issue',
  'highlights',
  'news and views',
]);

/**
 * Detects generic boilerplate section titles ("Editorial", "Preface", "Introduction", etc.)
 * that frequently recur across issues by the same editor/author in the same year.
 */
export function isGenericBoilerplateTitle(title?: string | null): boolean {
  if (!title) return true;
  const cleaned = cleanAcademicTitleForDedupe(title)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return true;
  if (GENERIC_BOILERPLATE_TITLES.has(cleaned)) {
    return true;
  }
  const tokens = tokenizeTitleWords(title);
  if (tokens.length <= 1 && GENERIC_BOILERPLATE_TITLES.has(tokens[0] || '')) {
    return true;
  }
  return false;
}

export function hasConflictingPartOrSupplementMarkers(
  titleA: string,
  titleB: string,
): boolean {
  // 1. Check if the two titles belong to different document relation categories
  // (e.g. main paper vs Erratum vs Comment on vs Reply to Comment on vs Supplement)
  const catA = classifyDocumentRelationCategory(titleA);
  const catB = classifyDocumentRelationCategory(titleB);
  if (catA !== catB) {
    return true;
  }

  // 2. Check if both titles have explicit Part / Volume / Section / Study designators that differ
  const partsA = extractPartAndVolumeMarkers(titleA);
  const partsB = extractPartAndVolumeMarkers(titleB);
  if (partsA.length > 0 && partsB.length > 0) {
    if (partsA.join('|') !== partsB.join('|')) {
      return true;
    }
  } else if (partsA.length !== partsB.length) {
    // One has "Part I" / "Part 2" and the other has no part marker at all
    return true;
  }

  // 3. Trailing Roman numeral or integer after colon/dash: e.g. "Title: I" vs "Title: II"
  const trailingPartRegex =
    /[:—–-]\s*(i{1,3}|iv|vi{0,3}|ix|x|xi{1,2}|\d+)\s*$/i;
  const trailRawA = titleA.trim().match(trailingPartRegex)?.[1];
  const trailRawB = titleB.trim().match(trailingPartRegex)?.[1];
  if (trailRawA && trailRawB) {
    const trailA = normalizePartDesignatorToken(trailRawA);
    const trailB = normalizePartDesignatorToken(trailRawB);
    if (trailA !== trailB) {
      return true;
    }
  }

  return false;
}

/**
 * Calculates Jaccard + Token Sort similarity score between two title strings,
 * guarding against distinct multi-part papers ("Part I" vs "Part II") and supplements.
 */
export function calculateTitleSimilarity(
  titleA: string,
  titleB: string,
): number {
  if (!titleA || !titleB) return 0.0;
  if (titleA === titleB) return 1.0;

  if (hasConflictingPartOrSupplementMarkers(titleA, titleB)) {
    return 0.0;
  }

  // Tokenize once and share across Token Sort Ratio & Jaccard Word Set Overlap
  const rawTokensA = tokenizeTitleWords(titleA);
  const rawTokensB = tokenizeTitleWords(titleB);

  const tokenSortScore = computeTokenSortRatioFromTokens(
    rawTokensA,
    rawTokensB,
  );
  if (tokenSortScore >= 0.88) return tokenSortScore;

  const wordsA = new Set(rawTokensA);
  const wordsB = new Set(rawTokensB);
  if (wordsA.size === 0 || wordsB.size === 0) {
    const rawA = titleA.toLowerCase().trim();
    const rawB = titleB.toLowerCase().trim();
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
  // Inclusion–Exclusion Principle: |A ∪ B| = |A| + |B| - |A ∩ B|
  const union = wordsA.size + wordsB.size - intersection;
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
 * Compares two author strings fuzzily by family name and full string using Jaro-Winkler metric.
 * Handles inverted ("Vaswani, Ashish") vs forward ("Ashish Vaswani") vs abbreviated ("A. Vaswani") forms.
 */
export function firstAuthorMatches(authorA: string, authorB: string): boolean {
  if (!authorA || !authorB) return false;
  const famA = extractFirstAuthorFamily([authorA])
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
  const famB = extractFirstAuthorFamily([authorB])
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
  if (famA && famB && famA.length >= 2 && famB.length >= 2) {
    if (famA === famB || jaroWinkler(famA, famB) >= 0.88) {
      return true;
    }
  }
  const normA = authorA
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
  const normB = authorB
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
  if (!normA || !normB) return false;
  if (normA === normB || normA.includes(normB) || normB.includes(normA)) {
    return true;
  }
  return jaroWinkler(normA, normB) >= 0.85;
}
