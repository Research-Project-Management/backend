import {
  SPECIAL_CASE_WORDS,
  COMMON_ACADEMIC_ACRONYMS,
  MINOR_WORDS,
  TITLE_SIMILARITY_STOPWORDS,
  BOT_CHALLENGE_TITLE_RE,
  BOT_CHALLENGE_HTML_RE,
  MATH_BLOCK_REGEX,
} from './academic-text.lexicon';
import {
  decodeHtmlEntities,
  stripXmlAndHtmlTags,
  stripLatexBraces,
} from './academic-text.domain';

/**
 * Zotero-compatible title casing ("Fix ALL CAPS" only).
 *
 * Zotero stores titles verbatim. The only automatic recasing we apply is for
 * titles that are ENTIRELY uppercase (e.g. "A SURVEY OF DEEP LEARNING"), which
 * are converted to Title Case while preserving known acronyms (BERT, DNA, ...)
 * and mixed-case terms (arXiv, mRNA).
 *
 * Mixed-case, sentence-case and lowercase titles are returned unchanged
 * (only trimmed). Single-word all-caps titles are also left unchanged because
 * they are usually acronyms or proper names.
 */
export function normalizeAcademicTitleCase(title?: string | null): string {
  if (!title || typeof title !== 'string') return '';
  const trimmed = title.trim();
  if (trimmed.length < 3) return trimmed;

  // Ignore math segments when deciding whether the title is all caps
  const withoutMath = trimmed.replace(MATH_BLOCK_REGEX, ' ');
  const isAllUpper =
    /\p{Lu}/u.test(withoutMath) &&
    !/\p{Ll}/u.test(withoutMath) &&
    withoutMath === withoutMath.toUpperCase();

  if (!isAllUpper) {
    return collapseFragmentedSmallCapsTokens(trimmed);
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  const letterWords = words.filter((w) => /\p{L}{2,}/u.test(w));
  if (letterWords.length < 2) {
    return trimmed;
  }

  const formatWord = (
    word: string,
    isFirstOrLast: boolean,
    prevEndsWithColon: boolean,
  ): string => {
    const leadingPunct = word.match(/^[^\p{L}\p{N}]+/u)?.[0] || '';
    const trailingPunct = word.match(/[^\p{L}\p{N}]+$/u)?.[0] || '';
    const core = word.slice(
      leadingPunct.length,
      word.length - (trailingPunct.length || 0),
    );

    if (!core) return word;

    const lower = core.toLowerCase();
    const upper = core.toUpperCase();

    if (SPECIAL_CASE_WORDS[lower]) {
      return `${leadingPunct}${SPECIAL_CASE_WORDS[lower]}${trailingPunct}`;
    }

    if (COMMON_ACADEMIC_ACRONYMS.has(upper)) {
      return `${leadingPunct}${upper}${trailingPunct}`;
    }

    if (core.includes('-')) {
      const parts = core.split('-');
      const formattedParts = parts.map((part, idx) => {
        const pLower = part.toLowerCase();
        const pUpper = part.toUpperCase();
        if (SPECIAL_CASE_WORDS[pLower]) return SPECIAL_CASE_WORDS[pLower];
        if (COMMON_ACADEMIC_ACRONYMS.has(pUpper)) return pUpper;
        if (idx > 0 && MINOR_WORDS.has(pLower)) return pLower;
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      });
      return `${leadingPunct}${formattedParts.join('-')}${trailingPunct}`;
    }

    if (MINOR_WORDS.has(lower) && !isFirstOrLast && !prevEndsWithColon) {
      return `${leadingPunct}${lower}${trailingPunct}`;
    }

    return `${leadingPunct}${core.charAt(0).toUpperCase() + core.slice(1).toLowerCase()}${trailingPunct}`;
  };

  const formattedWords: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isFirstOrLast = i === 0 || i === words.length - 1;
    const prevWord = i > 0 ? words[i - 1] : '';
    const prevEndsWithColon = /[:—\-?!]$/.test(prevWord);

    // Never recase LaTeX/math tokens
    if (/[$\\]/.test(w)) {
      formattedWords.push(w);
      continue;
    }

    formattedWords.push(formatWord(w, isFirstOrLast, prevEndsWithColon));
  }

  return collapseFragmentedSmallCapsTokens(formattedWords.join(' '));
}

/**
 * Collapses words whose initial small-caps / drop-cap glyph was emitted as an
 * isolated capital token by PDF layout engines (e.g. ICLR/NIPS/CVPR LaTeX `\scshape`):
 *   "V Ery D Eep C Onvolutional N Etworks for L Arge -S Cale I Mage R Ecognition"
 *   -> "Very Deep Convolutional Networks for Large-Scale Image Recognition"
 *   "A Dam : A M Ethod for S Tochastic O Ptimization"
 *   -> "Adam: A Method for Stochastic Optimization"
 *
 * Only activates when the title contains at least 3 isolated single-capital + word pairs,
 * preventing any false positives on normal titles like "A Survey of X" or "X-Ray Analysis".
 */
export function collapseFragmentedSmallCapsTokens(title: string): string {
  if (!title || typeof title !== 'string') return '';
  const pairMatches = title.match(/(?:^|[\s\-–—:(])\p{Lu}\s+\p{Lu}\p{Ll}+/gu);
  if (!pairMatches || pairMatches.length < 3) {
    return title;
  }

  let out = title;
  // Join `<SingleUpper> <Upper><lower+>` into `<SingleUpper><lower><lower+>`
  // When two single uppercase letters appear in a row before a continuation ("A M Ethod"),
  // the negative lookahead `(?!\s+\p{Lu}\p{Ll})` ensures the first "A" is preserved as the article "A"
  // while "M Ethod" is joined into "Method"!
  out = out.replace(
    /(^|[\s\-–—:(])(\p{Lu})\s+(\p{Lu})(\p{Ll}+)\b/gu,
    (
      _full,
      prefix: string,
      firstCap: string,
      secondCap: string,
      restLower: string,
    ) => {
      return `${prefix}${firstCap}${secondCap.toLowerCase()}${restLower}`;
    },
  );
  out = out.replace(/\s+([:;,.!?])/g, '$1');
  out = out.replace(/(\b\p{L}{2,})\s*-\s*(\p{L}{2,}\b)/gu, '$1-$2');
  return out;
}

/**
 * Sanitizes an academic library item title:
 * 1. Strips <script> and <style> tags and their contents
 * 2. Strips remaining HTML/XML tags
 * 3. Decodes HTML entities
 * 4. Strips LaTeX curly braces
 * 5. Strips control characters
 * 6. Collapses multiple whitespace into a single space and trims
 * 7. Fixes screaming ALL CAPS titles only (Zotero "Fix ALL CAPS"); any other casing is stored verbatim
 * 8. Enforces maximum length of 1000 characters
 */
export function sanitizeItemTitle(title?: string | null): string {
  if (!title || typeof title !== 'string') return '';
  let cleaned = title.trim();
  cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  cleaned = stripXmlAndHtmlTags(cleaned);
  cleaned = decodeHtmlEntities(cleaned);
  cleaned = stripLatexBraces(cleaned);
  // eslint-disable-next-line no-control-regex
  cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, '');

  // Collapse small-caps / drop-cap fragmented words (e.g. "V Ery D Eep C Onvolutional" -> "Very Deep Convolutional")
  cleaned = collapseFragmentedSmallCapsTokens(cleaned);

  // Normalize OCR / publisher spaced hyphens (e.g. "Large - Scale" or "Large -Scale" -> "Large-Scale")
  // Requires at least 2 letters on both sides so legitimate subtitles like "Part A - Methods" are preserved.
  cleaned = cleaned.replace(/(\b\p{L}{2,})\s*-\s*(\p{L}{2,}\b)/gu, '$1-$2');

  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  // normalizeAcademicTitleCase is a no-op unless the title is entirely uppercase.
  cleaned = normalizeAcademicTitleCase(cleaned);
  if (cleaned.length > 1000) {
    cleaned = cleaned.substring(0, 1000).trim();
  }
  return cleaned;
}

export function normalizeAcademicTitle(title: string): string {
  return (decodeHtmlEntities(title) || title)
    .replace(/[đĐ]/g, 'd')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeAcademicTitle(title: string): string[] {
  return tokenizeTitleForSimilarity(title);
}

function tokenizeTitleForSimilarity(title: string): string[] {
  const normalized = (decodeHtmlEntities(title) || title)
    .replace(/[đĐ]/g, 'd')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');

  // Expand CJK ideograph runs into individual characters so CJK titles without spaces tokenize accurately
  const expanded = normalized.replace(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    ' $& ',
  );

  return expanded
    .split(/\s+/)
    .filter((t) => t.length > 0 && !TITLE_SIMILARITY_STOPWORDS.has(t));
}

/**
 * Dice coefficient over normalized title tokens (0..1).
 * Used to reject title-search hits that do not actually match the query
 * (e.g. query "Client Challenge" → "The client/server challenge").
 */
export function titleSimilarity(a?: string | null, b?: string | null): number {
  if (!a || !b) return 0;
  const ta = tokenizeTitleForSimilarity(a);
  const tb = tokenizeTitleForSimilarity(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  if (ta.join(' ') === tb.join(' ')) return 1;

  const counts = new Map<string, number>();
  for (const t of tb) counts.set(t, (counts.get(t) || 0) + 1);
  let overlap = 0;
  for (const t of ta) {
    const c = counts.get(t) || 0;
    if (c > 0) {
      overlap++;
      counts.set(t, c - 1);
    }
  }
  return (2 * overlap) / (ta.length + tb.length);
}

/**
 * Detects anti-bot interstitials (Cloudflare, Akamai "Client Challenge",
 * PerimeterX, DataDome...) that are served with HTTP 200 but contain no
 * bibliographic metadata.
 */
export function isBotChallengePage(
  html: string,
  title?: string | null,
): boolean {
  if (!html) return false;
  if (/<meta\s+[^>]*name=["']citation_title["']/i.test(html)) return false;
  const pageTitle =
    title ||
    decodeHtmlEntities(
      html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '',
    ).trim();
  if (pageTitle && BOT_CHALLENGE_TITLE_RE.test(pageTitle)) return true;
  return BOT_CHALLENGE_HTML_RE.test(html) && html.length < 50000;
}

/**
 * Repairs a title whose small-caps / drop-cap glyphs were split into separate
 * text runs ("A Dam : A M Ethod for S Tochastic O Ptimization" or
 * "V Ery D Eep C Onvolutional N Etworks for L Arge -S Cale I Mage R Ecognition").
 */
export function repairFragmentedTitle(
  title: string,
  pageText?: string,
): string | undefined {
  if (!title) return undefined;
  const fragments = title
    .split(/\s+/)
    .filter((t) => /^\p{Lu}$/u.test(t)).length;
  // "A" alone is a real word; require several isolated capitals to suspect damage.
  if (fragments < 3) {
    const collapsed = collapseFragmentedSmallCapsTokens(title);
    return collapsed !== title ? collapsed : undefined;
  }

  if (pageText) {
    const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const target = key(title);
    if (target.length >= 8) {
      const lines = pageText
        .slice(0, 4000)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 40);

      for (let i = 0; i < lines.length; i++) {
        for (const span of [1, 2]) {
          const candidate = lines.slice(i, i + span).join(' ');
          if (candidate !== title && key(candidate) === target) {
            return candidate;
          }
        }
      }
    }
  }

  const collapsed = collapseFragmentedSmallCapsTokens(title);
  return collapsed !== title ? collapsed : undefined;
}

/**
 * Checks whether an item title is empty or a generic system/PDF placeholder
 * (e.g. "Untitled Document", "Uploaded Document", "Untitled", raw filename "*.pdf", or raw DOI).
 */
export function isPlaceholderItemTitle(title?: unknown): boolean {
  if (typeof title !== 'string') return true;
  const trimmed = title.trim();
  if (!trimmed) return true;
  return (
    /^(untitled(\s+(document|record))?|uploaded\s+document|document)$/i.test(
      trimmed,
    ) ||
    /\.pdf$/i.test(trimmed) ||
    /^10\.\d{4,9}\//.test(trimmed)
  );
}

