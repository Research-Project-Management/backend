/**
 * Text Cleaner & Normalization Utility for Bibliographic Data.
 * Decodes HTML & XML entities, strips tags, collapses excessive whitespace,
 * and filters out placeholder/banned strings.
 */

export const BANNED_STRINGS = new Set([
  'undefined',
  'null',
  'n/a',
  'na',
  'none',
  'unknown',
  '',
]);

const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ndash;': '–',
  '&mdash;': '—',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&hellip;': '…',
  '&copy;': '©',
  '&reg;': '®',
  '&trade;': '™',
  '&plusmn;': '±',
  '&times;': '×',
  '&divide;': '÷',
  '&micro;': 'µ',
  '&deg;': '°',
};

/**
 * Decodes named, decimal, and hexadecimal HTML/XML entities into UTF-8 text.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text || typeof text !== 'string') return '';

  let decoded = text;

  // Replace named entities
  for (const [entity, char] of Object.entries(HTML_ENTITY_MAP)) {
    if (decoded.includes(entity)) {
      decoded = decoded.replaceAll(entity, char);
    }
  }

  // Replace decimal entities: &#123;
  decoded = decoded.replace(/&#(\d+);/g, (_, dec) => {
    try {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : '';
    } catch {
      return '';
    }
  });

  // Replace hex entities: &#x1f; or &#X1F;
  decoded = decoded.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
    try {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : '';
    } catch {
      return '';
    }
  });

  return decoded;
}

/**
 * Strips XML and HTML tags including JATS XML (<jats:...>), math tags, etc.
 */
export function stripXmlAndHtmlTags(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<\/?[a-zA-Z0-9_:-]+(?:\s+[^>]*?)?\/?>/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strips enclosing LaTeX curly braces (e.g. "{Deep Learning}" -> "Deep Learning").
 */
export function stripLatexBraces(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/[{}]/g, '').trim();
}

/**
 * Completely cleans bibliographic text:
 * 1. Strips XML/HTML tags
 * 2. Decodes all HTML entities
 * 3. Strips stray LaTeX braces
 * 4. Collapses multi-line / excessive whitespace into a single space
 */
export function cleanBibliographicText(
  text?: string | null,
): string | undefined {
  if (!text || typeof text !== 'string') return undefined;

  let cleaned = stripXmlAndHtmlTags(text);
  cleaned = decodeHtmlEntities(cleaned);
  cleaned = stripLatexBraces(cleaned);
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (!cleaned || BANNED_STRINGS.has(cleaned.toLowerCase())) {
    return undefined;
  }

  return cleaned;
}

/**
 * Filters out placeholder strings ('undefined', 'null', 'n/a', 'none', etc.).
 */
export function cleanBannedString(val?: string | null): string | undefined {
  if (val === undefined || val === null) return undefined;
  const str = String(val).trim();
  if (BANNED_STRINGS.has(str.toLowerCase())) {
    return undefined;
  }
  return str;
}
