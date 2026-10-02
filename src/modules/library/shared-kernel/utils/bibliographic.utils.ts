import {
  CreatorType,
  CreatorInput,
  IdentifierScheme,
  ParsedCreator,
} from '../types/bibliographic.types';

export { ParsedCreator };

export const INSTITUTION_KEYWORDS = [
  'organization',
  'organizations',
  'organisation',
  'organisations',
  'association',
  'associations',
  'institute',
  'institutes',
  'institution',
  'institutions',
  'university',
  'universities',
  'laboratory',
  'laboratories',
  'collab',
  'collaboration',
  'collaborations',
  'group',
  'team',
  'consortium',
  'network',
  'department',
  'departments',
  'agency',
  'agencies',
  'center',
  'centers',
  'centre',
  'centres',
  'foundation',
  'corporation',
  'inc',
  'llc',
  'ltd',
  'hospital',
  'hospitals',
  'openai',
  'google',
  'microsoft',
  'meta',
  'deepmind',
  'anthropic',
  'mit',
  'cern',
  'nasa',
  'who',
  'ieee',
  'acm',
];

const PREFIX_PARTICLES = new Set([
  'von',
  'van',
  'de',
  'del',
  'der',
  'da',
  'di',
  'du',
  'la',
  'le',
]);

const GENERATIONAL_SUFFIX_REGEX = /^(?:Jr\.?|Sr\.?|II|III|IV|V|Esq\.?)$/i;

export const NOISE_AUTHOR_WORDS = new Set([
  'abstract',
  'introduction',
  'indexterms',
  'keywords',
  'keyword',
  'references',
  'reference',
  'bibliography',
  'contents',
  'tableofcontents',
  'acknowledgments',
  'acknowledgements',
  'correspondence',
  'correspondingauthor',
  'allrightsreserved',
  'copyright',
  'unknown',
  'none',
  'na',
  'nil',
  'etal',
  'andothers',
  'visualgeometrygroup',
]);

/**
 * Validates if an extracted author name token is actually section noise, OCR artifact,
 * or academic affiliation header rather than a genuine author name.
 */
export function isNoiseAuthorName(raw?: string | null): boolean {
  if (!raw || typeof raw !== 'string') return true;
  const trimmed = raw.trim();
  if (!trimmed) return true;

  // Single non-word character or too short non-alphabetic
  if (trimmed.length <= 1 && !/[a-zA-Z]/.test(trimmed)) return true;

  // Collapse non-alpha characters to match against known noise blacklist
  // Handles letter-spaced headers: "A B S T R A C T", "A BSTRACT", "I N T R O D U C T I O N"
  const collapsed = trimmed.toLowerCase().replace(/[^a-z]/g, '');
  if (NOISE_AUTHOR_WORDS.has(collapsed)) return true;

  const lower = trimmed.toLowerCase();

  // Academic affiliations/departments mistakenly extracted as author names
  if (
    /^(?:department|faculty|school|division|college)\s+of\s+/i.test(lower) ||
    /^(?:lab|laboratory)\s+of\s+/i.test(lower) ||
    /^(?:centre|center)\s+for\s+/i.test(lower) ||
    /^(?:institute|university)\s+of\s+[a-z\s]+,\s*(?:department|faculty|school|division)/i.test(
      lower,
    )
  ) {
    return true;
  }

  // Reject emails or URLs mistakenly passed as author names
  if (/@/.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Strips OCR junk, footnote markers, email addresses, affiliations,
 * and academic titles from a single author string token.
 */
export function cleanAuthorName(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '';

  let cleaned = stripXmlAndHtmlTags(raw);
  cleaned = decodeHtmlEntities(cleaned);
  cleaned = stripLatexBraces(cleaned);
  cleaned = cleaned.trim();

  // Strip emails: e.g. <user@domain.com> or user@domain.com
  cleaned = cleaned.replace(/<[^>]+@[^>]+>/g, ' ');
  cleaned = cleaned.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    ' ',
  );

  // Strip leading list numbering, bullets, or prefix: e.g. "1. ", "[1] ", "- ", "By: "
  cleaned = cleaned.replace(
    /^(?:(?:\[?\d+\]?[\.\)]?|[-•*])\s+|(?:by|author|authors):\s*)/i,
    '',
  );

  // Strip parenthetical roles/annotations: e.g. "(corresponding author)", "(equal contribution)", "(author)"
  cleaned = cleaned.replace(
    /\s*\((?:corresponding(?:\s*author)?|equal\s*contribution|author|lead\s*author|co-author|presenter|speaker|advisor|mentor|first\s*author)[^)]*\)/gi,
    '',
  );

  // Strip leading honorifics / academic titles: e.g. "Prof. Dr.", "Prof.", "Dr.", "Mr.", "Mrs.", "Ms."
  cleaned = cleaned.replace(
    /^(?:(?:Prof(?:essor)?|Dr|Doctor|Mr|Mrs|Ms)\.?\s+)+/i,
    '',
  );

  // Strip trailing professional degrees / fellowships: e.g. ", PhD", " PhD", " M.D.", " FRS"
  cleaned = cleaned.replace(
    /[,\s]+(?:PhD|M\.?D\.?|M\.?S\.?|B\.?S\.?|OBE|FRS|FRSE|FIEEE|CBE)\b/gi,
    '',
  );

  // Strip trailing footnote markers, superscripts, and affiliation numbers:
  // e.g. "1,2*", "*", "1", "†", "‡", "§", "1*", "*1"
  cleaned = cleaned.replace(
    /(?:[\s,]*[*†‡§^#~]+[\s,]*\d*|[\s,]*\d+[*†‡§^#~]*)+$/,
    '',
  );

  // Normalize excessive internal whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Remove trailing comma or semicolon if leftover
  cleaned = cleaned.replace(/[,;]+$/, '').trim();

  if (isNoiseAuthorName(cleaned)) {
    return '';
  }

  return cleaned;
}

/**
 * Splits a composite string of authors separated by ';', ' and ', ' & ', or commas.
 * Handles both "LastName, FirstName" pairs and forward names without mangling.
 */
export function splitAuthorString(input: string): string[] {
  if (!input || !input.trim()) return [];
  const trimmed = input.trim();
  const lines = trimmed
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const result: string[] = [];

  for (const line of lines) {
    // 1. Semicolons are unequivocal delimiters in academic metadata
    if (line.includes(';')) {
      const parts = line
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of parts) {
        result.push(...splitAuthorString(p));
      }
      continue;
    }

    // 2. "and" / "&" conjunctions (e.g. "A, B, and C" or "A and B" or "A & B")
    if (/\s+and\s+/i.test(line) || /\s+&\s+/.test(line)) {
      const parts = line
        .split(/(?:,\s*(?:and|&)\s*|\s+(?:and|&)\s+)/i)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of parts) {
        result.push(...splitAuthorString(p));
      }
      continue;
    }

    // 3. Comma-separated lists
    if (line.includes(',')) {
      const rawTokens = line
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (rawTokens.length <= 1) {
        result.push(line.trim());
        continue;
      }

      if (rawTokens.length === 2) {
        // Disambiguate: Is it "LastName, FirstName" (1 author) OR "FirstName1 LastName1, FirstName2 LastName2" (2 authors)?
        const firstHasSpace = rawTokens[0].includes(' ');
        const secondHasSpace = rawTokens[1].includes(' ');
        const isSuffix = GENERATIONAL_SUFFIX_REGEX.test(rawTokens[1]);

        if (isSuffix) {
          // e.g. "Martin Luther King, Jr." -> single author
          result.push(line.trim());
        } else if (firstHasSpace && secondHasSpace) {
          // e.g. "Karen Simonyan, Andrew Zisserman" -> two authors!
          result.push(rawTokens[0], rawTokens[1]);
        } else {
          // e.g. "Simonyan, Karen" or "Knuth, Donald E." -> single inverted author
          result.push(line.trim());
        }
        continue;
      }

      // rawTokens.length >= 3:
      // Check if rawTokens are alternating [Surname, First/Initial, Surname, First/Initial, ...]
      const isEven = rawTokens.length % 2 === 0;
      let looksLikeInvertedPairs = isEven;

      if (isEven) {
        for (let i = 0; i < rawTokens.length; i += 2) {
          const surname = rawTokens[i];
          if (
            surname.includes(' ') &&
            !/^(?:van|von|de|del|der|da|di|du|la|le)\s+/i.test(surname)
          ) {
            looksLikeInvertedPairs = false;
            break;
          }
        }
      }

      if (looksLikeInvertedPairs) {
        for (let i = 0; i < rawTokens.length; i += 2) {
          result.push(`${rawTokens[i]}, ${rawTokens[i + 1]}`);
        }
      } else {
        // Forward author list: each token is an author
        for (const t of rawTokens) {
          result.push(t);
        }
      }
      continue;
    }

    result.push(line.trim());
  }

  return result.map(cleanAuthorName).filter(Boolean);
}

/**
 * Deterministically parses an author string into structured creator fields.
 * Handles:
 * - Institutional names (OpenAI, University of Cambridge, etc.)
 * - "LastName, FirstName MiddleName"
 * - "FirstName MiddleName LastName"
 * - Generational suffixes (Jr., Sr., III)
 * - Mononyms ("Aristotle", "Plato")
 */
export function parseCreatorString(
  rawName: string,
  orderIndex: number = 0,
  creatorType: CreatorType = 'author',
): ParsedCreator {
  const cleaned = cleanAuthorName(rawName);

  if (!cleaned) {
    return {
      orderIndex,
      creatorType,
      fieldMode: 0,
      firstName: '',
      lastName: '',
      fullName: '',
    };
  }

  const lower = cleaned.toLowerCase();
  const isInstitution = INSTITUTION_KEYWORDS.some((kw) =>
    new RegExp(`\\b${kw}\\b`, 'i').test(lower),
  );

  if (isInstitution) {
    return {
      orderIndex,
      creatorType,
      fieldMode: 1,
      firstName: '',
      lastName: cleaned,
      fullName: cleaned,
    };
  }

  let workingName = cleaned;

  // Comma separated: "LastName, FirstName MiddleName" OR "Name, Jr."
  if (workingName.includes(',')) {
    const parts = workingName.split(',').map((p) => p.trim());
    if (parts.length === 2 && GENERATIONAL_SUFFIX_REGEX.test(parts[1])) {
      workingName = `${parts[0]} ${parts[1]}`;
    } else {
      const lastName = parts[0] || '';
      const firstName = parts.slice(1).join(' ') || '';
      const fullName = firstName ? `${firstName} ${lastName}` : lastName;
      return {
        orderIndex,
        creatorType,
        fieldMode: 0,
        firstName,
        lastName,
        fullName,
      };
    }
  }

  // Space separated: "FirstName [MiddleName...] LastName [Suffix]"
  const tokens = workingName.split(' ');
  if (tokens.length === 1) {
    // Single word name / mononym (e.g. "Plato", "Aristotle")
    return {
      orderIndex,
      creatorType,
      fieldMode: 0,
      firstName: '',
      lastName: tokens[0],
      fullName: tokens[0],
    };
  }

  // Check if last token is generational suffix (e.g. "Martin Luther King Jr.")
  let splitIndex = tokens.length - 1;
  if (
    tokens.length >= 3 &&
    GENERATIONAL_SUFFIX_REGEX.test(tokens[tokens.length - 1])
  ) {
    splitIndex = tokens.length - 2;
  } else if (
    tokens.length >= 3 &&
    PREFIX_PARTICLES.has(tokens[tokens.length - 2].toLowerCase())
  ) {
    splitIndex = tokens.length - 2;
    if (
      tokens.length >= 4 &&
      PREFIX_PARTICLES.has(tokens[tokens.length - 3].toLowerCase())
    ) {
      splitIndex = tokens.length - 3;
    }
  }

  const lastName = tokens.slice(splitIndex).join(' ');
  const firstName = tokens.slice(0, splitIndex).join(' ');
  const fullName = firstName ? `${firstName} ${lastName}` : lastName;

  return {
    orderIndex,
    creatorType,
    fieldMode: 0,
    firstName,
    lastName,
    fullName,
  };
}

export function extractFamilyName(authorName?: string | null): string {
  if (!authorName) return '';
  const trimmed = authorName.trim();
  if (trimmed.includes(',')) {
    return trimmed.split(',')[0].trim();
  }
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1] || '';
}

export function normalizeCreators(
  creators?: CreatorInput[] | null,
  fallbackAuthors?: string[] | null,
): CreatorInput[] {
  if (Array.isArray(creators) && creators.length > 0) {
    return creators.map((c) => ({
      creatorType: c.creatorType || 'author',
      name:
        c.name ||
        [c.firstName, c.lastName].filter(Boolean).join(' ').trim() ||
        'Unknown',
      firstName: c.firstName,
      lastName: c.lastName,
    }));
  }
  if (Array.isArray(fallbackAuthors) && fallbackAuthors.length > 0) {
    return fallbackAuthors.map((name) => ({
      creatorType: 'author',
      name: name.trim(),
    }));
  }
  return [];
}

// ── Text Cleaner & Normalization ────────────────────────────────────────────

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

const HTML_ENTITY_REGEX = /&(?:([a-zA-Z]+)|#(\d+)|#x([0-9a-fA-F]+));/g;

/**
 * Decodes named, decimal, and hexadecimal HTML/XML entities into UTF-8 text.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text || typeof text !== 'string') return '';
  if (!text.includes('&')) return text;

  return text.replace(HTML_ENTITY_REGEX, (match, named, dec, hex) => {
    if (named) {
      return HTML_ENTITY_MAP[`&${named};`] ?? match;
    }
    if (dec) {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : '';
    }
    if (hex) {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : '';
    }
    return match;
  });
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

/**
 * Sanitizes and normalizes an author or repository comment (e.g. from arXiv, BibTeX, RIS).
 * Strips XML/HTML tags, decodes HTML entities, strips stray LaTeX braces,
 * collapses redundant whitespace, removes embedded 'Comment:' prefix,
 * and rejects noise, ellipsis, or placeholder strings.
 */
export function cleanCommentText(comment?: string | null): string | undefined {
  if (!comment || typeof comment !== 'string') return undefined;

  let cleaned = stripXmlAndHtmlTags(comment);
  cleaned = decodeHtmlEntities(cleaned);
  cleaned = stripLatexBraces(cleaned);
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (!cleaned) return undefined;

  // Strip leading redundant 'Comment:' if already embedded in text
  cleaned = cleaned.replace(/^comments?:\s*/i, '').trim();

  // Reject if string contains no alphanumeric characters (e.g. "...", "…", "--", "[]")
  if (!/[a-zA-Z0-9\u00C0-\u024F\u1EA0-\u1EF9]/.test(cleaned)) {
    return undefined;
  }

  const lower = cleaned.toLowerCase();
  if (
    BANNED_STRINGS.has(lower) ||
    lower === 'nil' ||
    lower === 'none.' ||
    lower === 'n/a.' ||
    lower === 'etc.' ||
    lower === 'etc' ||
    lower === 'no comment' ||
    lower === 'no comments' ||
    /^(\.{2,}|…|[-_—\s]+|null|undefined|none|n\/?a)$/i.test(cleaned)
  ) {
    return undefined;
  }

  // Reject truncated placeholder comments like "Submitted to ..." or "Accepted for publication in ..."
  if (
    /^(?:submitted to|to appear in|accepted in|accepted to)\s*(?:\.{2,}|…|\s*)$/i.test(
      cleaned,
    )
  ) {
    return undefined;
  }

  return cleaned;
}

const UNICODE_SUB_MAP: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  o: 'ₒ',
  x: 'ₓ',
  h: 'ₕ',
  k: 'ₖ',
  l: 'ₗ',
  m: 'ₘ',
  n: 'ₙ',
  p: 'ₚ',
  s: 'ₛ',
  t: 'ₜ',
  i: 'ᵢ',
  j: 'ⱼ',
  r: 'ᵣ',
  u: 'ᵤ',
  v: 'ᵥ',
};

const UNICODE_SUP_MAP: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  n: 'ⁿ',
  i: 'ⁱ',
  x: 'ˣ',
  y: 'ʸ',
  t: 'ᵗ',
  a: 'ᵃ',
  b: 'ᵇ',
  c: 'ᶜ',
  d: 'ᵈ',
  e: 'ᵉ',
};

export function convertSubscriptsToUnicode(str: string): string {
  return str
    .split('')
    .map((c) => UNICODE_SUB_MAP[c.toLowerCase()] || c)
    .join('');
}

export function convertSuperscriptsToUnicode(str: string): string {
  return str
    .split('')
    .map((c) => UNICODE_SUP_MAP[c.toLowerCase()] || c)
    .join('');
}

const MATH_BLOCK_REGEX =
  /(?:\$\$[\s\S]*?\$\$|\$(?!\s)(?:[^$\r\n\\]|\\.)+?(?<!\s)\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\\begin\{([a-zA-Z*]+)\}[\s\S]*?\\end\{\1\})/g;

/**
 * Sanitizes and normalizes an academic paper abstract.
 * 0. Protects mathematical formulas ($...$, $$...$$, \(...\), \[...\], \begin{...}...\end{...}) and pre-extracts JATS <tex-math>.
 * 1. Pre-processes JATS XML (<jats:...>), PubMed (<AbstractText>), and HTML tags before stripping.
 * 2. Converts chemical and numerical <sub>/<sup> to native Unicode (H₂O, 10⁻⁵).
 * 3. Normalizes structured section titles into formatted Markdown bold headings (**Background:**).
 * 4. Decodes HTML entities and strips remaining XML/HTML tags and non-math formatting braces.
 * 5. Strips leading "Abstract", "ABSTRACT", "Summary", "Graphical Abstract" prefixes.
 * 6. Removes repeated year extraction artifacts (e.g. "(2012)(2013)(2014)(2015)(2016)(2017).").
 * 7. Removes trailing author contribution, publisher copyright banners (Elsevier, Springer, Wiley, MDPI, IEEE, ACM), and index terms noise.
 * 8. Unwraps single hard line-breaks within paragraphs while preserving double-newline paragraph separation.
 * 9. Restores preserved mathematical formulas completely intact.
 */
export function cleanAbstractText(text?: string | null): string | undefined {
  if (!text || typeof text !== 'string') return undefined;

  let cleaned = text;

  // 0a. Pre-extract JATS XML tex-math tags into standard LaTeX math before masking
  cleaned = cleaned.replace(
    /<(?:jats:)?disp-formula[^>]*>[\s\S]*?<(?:jats:)?tex-math[^>]*>([\s\S]*?)<\/(?:jats:)?tex-math>[\s\S]*?<\/(?:jats:)?disp-formula>/gi,
    (_, math) => {
      const trimmed = math
        .trim()
        .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
        .trim();
      const content = trimmed.replace(/^\$\$?([\s\S]*?)\$\$?$/, '$1').trim();
      return `\n\n$$${content}$$\n\n`;
    },
  );
  cleaned = cleaned.replace(
    /<(?:jats:)?(?:inline-formula[^>]*>[\s\S]*?)?<(?:jats:)?tex-math[^>]*>([\s\S]*?)<\/(?:jats:)?tex-math>(?:[\s\S]*?<\/(?:jats:)?inline-formula>)?/gi,
    (_, math) => {
      const trimmed = math
        .trim()
        .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
        .trim();
      const content = trimmed.replace(/^\$([\s\S]*?)\$$/, '$1').trim();
      return `$${content}$`;
    },
  );

  // 0b. Protect mathematical formulas from accidental tag-stripping or LaTeX brace removal
  const mathPlaceholders: string[] = [];
  cleaned = cleaned.replace(MATH_BLOCK_REGEX, (match) => {
    const placeholder = `@@MATH_BLOCK_${mathPlaceholders.length}@@`;
    mathPlaceholders.push(match);
    return placeholder;
  });

  // 1. Fix hyphenated words broken across line wraps before tag/whitespace stripping
  cleaned = cleaned.replace(
    /([a-zA-Z]{2,})-\s*\r?\n\s*([a-zA-Z]{2,})/g,
    '$1$2',
  );

  // 2. Structured JATS / PubMed / HTML Pre-Processing
  // Convert <sub> and <sup> tags to scientific Unicode characters before stripping
  cleaned = cleaned.replace(
    /<(?:jats:)?sub[^>]*>([\s\S]*?)<\/(?:jats:)?sub>/gi,
    (_, content) => convertSubscriptsToUnicode(content.trim()),
  );
  cleaned = cleaned.replace(
    /<(?:jats:)?sup[^>]*>([\s\S]*?)<\/(?:jats:)?sup>/gi,
    (_, content) => convertSuperscriptsToUnicode(content.trim()),
  );

  // Remove generic abstract headings inside JATS/HTML tags
  cleaned = cleaned.replace(
    /<(?:jats:)?title[^>]*>\s*(?:Abstract|Summary|Résumé|Overview)\s*<\/(?:jats:)?title>/gi,
    '',
  );
  // Convert structured section titles into formatted Markdown bold headings (e.g. "**Background:** ", "**Methods:** ")
  cleaned = cleaned.replace(
    /<(?:jats:)?title[^>]*>([\s\S]*?)<\/(?:jats:)?title>/gi,
    (_, title) => {
      const cleanTitle = title.trim().replace(/[:.\s]+$/, '');
      return cleanTitle ? `\n\n**${cleanTitle}:** ` : '';
    },
  );
  // PubMed structured abstract tags: <AbstractText Label="BACKGROUND">...</AbstractText>
  cleaned = cleaned.replace(
    /<AbstractText\s+[^>]*Label=["']\s*([^"']+?)\s*["'][^>]*>([\s\S]*?)<\/AbstractText>/gi,
    (_, label, content) =>
      `\n\n**${label.trim().toUpperCase()}:** ${content.trim()}`,
  );
  // Unlabeled AbstractText tags become paragraph breaks
  cleaned = cleaned.replace(
    /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/gi,
    '\n\n$1',
  );
  // Convert paragraph break tags to newlines
  cleaned = cleaned.replace(/<\/(?:jats:)?p>/gi, '\n\n');
  cleaned = cleaned.replace(/<(?:jats:)?p[^>]*>/gi, '');
  cleaned = cleaned.replace(/<br\s*\/?>/gi, '\n');
  cleaned = cleaned.replace(/<\/(?:jats:)?sec>/gi, '\n\n');

  // Strip remaining XML/HTML tags without flattening paragraph newlines
  cleaned = cleaned
    .replace(/<\/?[a-zA-Z0-9_:-]+(?:\s+[^>]*?)?\/?>/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1');
  cleaned = decodeHtmlEntities(cleaned);
  cleaned = stripLatexBraces(cleaned);

  // 2. Remove leading "Abstract" or "ABSTRACT" headings and prefixes
  cleaned = cleaned.replace(
    /^(?:abstract|summary|résumé|synopsis|overview)\s*[:.—\-–\u2014\u2013]?\s*/i,
    '',
  );
  cleaned = cleaned.replace(
    /^(?:graphical\s+abstract|highlights?)\s*[:.—\-–\u2014\u2013]?\s*/i,
    '',
  );
  cleaned = cleaned.replace(
    /^(?:abstract|summary|résumé|synopsis|overview)\s*\r?\n+/i,
    '',
  );

  // 3. Remove repeated parenthesized / bracketed year-chain extraction artifacts
  cleaned = cleaned.replace(/(?:\((?:19|20)\d{2}\)\s*){2,}(\.)?/g, (_, dot) =>
    dot ? '.' : '',
  );
  cleaned = cleaned.replace(/(?:\[(?:19|20)\d{2}\]\s*){2,}(\.)?/g, (_, dot) =>
    dot ? '.' : '',
  );
  cleaned = cleaned.replace(
    /\((?:(?:19|20)\d{2}[,\s;]*){3,}\)(\.)?/g,
    (_, dot) => (dot ? '.' : ''),
  );

  // 4. Remove trailing author contribution / footnote / correspondence noise
  cleaned = cleaned.replace(
    /(?:(?:\n\s*|\.\s+|\s+)[*†‡§\d]*\s*(?:Equal contribution|Corresponding author|Correspondence to|Author ordering|Listing order|These authors contributed equally|Work performed while|Supported in part by|This work was supported by|Electronic address:[\s\S]*$|Email:[\s\S]*$)[\s\S]*$)/i,
    '.',
  );

  // 5. Remove trailing publication metadata, index terms, PACS numbers, keywords
  cleaned = cleaned.replace(
    /(?:\n\s*|\s+)(?:ACM Reference [Ff]ormat|Index Terms|Keywords|Key\s*words|Additional Key Words and Phrases|PACS numbers?|Subject classification|MSC classes?)[—:\-\s]+[\s\S]*$/i,
    '',
  );

  // 6. Remove publisher copyright notices and banners
  const COPYRIGHT_PATTERNS = [
    // Elsevier / Academic Press
    /(?:(?:Copyright\s*)?(?:\(c\)|©)\s*(?:19|20)\d{2}\s*(?:Elsevier|Academic Press)|Published by Elsevier|All rights reserved\b)[\s\S]*$/i,
    // Springer Nature / BioMed Central
    /(?:(?:Copyright\s*)?(?:\(c\)|©)\s*(?:The Author\(s\)|(?:19|20)\d{2}\s*(?:Springer|Nature|BioMed Central)))[\s\S]*$/i,
    // Wiley
    /(?:(?:Copyright\s*)?(?:\(c\)|©)\s*(?:19|20)\d{2}\s*John Wiley & Sons|Copyright\s*(?:\(c\)|©)\s*(?:19|20)\d{2}\s*Wiley)[\s\S]*$/i,
    // MDPI
    /(?:(?:Copyright\s*)?(?:\(c\)|©)\s*(?:19|20)\d{2}\s*by the authors?\. Licensee MDPI[\s\S]*$)/i,
    // Oxford / Cambridge / Taylor & Francis
    /(?:(?:Copyright\s*)?(?:\(c\)|©)\s*(?:19|20)\d{2}\s*(?:Oxford University Press|Cambridge University Press|Informa UK|Taylor & Francis))[\s\S]*$/i,
    // Creative Commons licenses
    /(?:This article is distributed under the terms of the Creative Commons|Licensed under a Creative Commons)[\s\S]*$/i,
    // IEEE / ACM
    /(?:Copyright\s*(?:\(c\)|©)?\s*(?:19|20)\d{2}|©\s*(?:19|20)\d{2}\s*(?:IEEE|ACM))[\s\S]*$/i,
    /\b\d{4}-\d{3}[\dX]\s*(?:\(c\)|©)?\s*\d{4}\s*IEEE[\s\S]*$/i,
  ];

  for (const pattern of COPYRIGHT_PATTERNS) {
    const dotRegex = new RegExp(`\\.\\s*${pattern.source}`, pattern.flags);
    cleaned = cleaned.replace(dotRegex, '.');
    const wsRegex = new RegExp(
      `(?:\\n\\s*|\\s+)${pattern.source}`,
      pattern.flags,
    );
    cleaned = cleaned.replace(wsRegex, '');
  }

  // 7. Normalize paragraphs & unwrap hard line-breaks within each paragraph
  const rawParagraphs = cleaned.split(/\r?\n\s*\r?\n/);
  const normalizedParagraphs = rawParagraphs
    .map((paragraph) => {
      // Fix hyphenation across breaks (e.g., "stochas- tic" -> "stochastic")
      let p = paragraph.replace(
        /([a-zA-Z]{2,})-\s*\r?\n\s*([a-zA-Z]{2,})/g,
        '$1$2',
      );
      // Collapse single newlines into a single space
      p = p.replace(/\r?\n/g, ' ');
      // Collapse multiple whitespace
      p = p.replace(/\s+/g, ' ').trim();
      // Clean spacing before punctuation: "word ." -> "word."
      p = p.replace(/\s+([.,;:!?%)\]}’'”])/g, '$1');
      // Clean spacing after opening punctuation: "( word" -> "(word"
      p = p.replace(/([([{‘'“])\s+/g, '$1');
      // Clean duplicate periods (excluding ellipsis)
      p = p.replace(/\.\s*\.(?!\.)/g, '.');
      return p;
    })
    .filter((p) => p.length > 0);

  cleaned = normalizedParagraphs.join('\n\n').trim();

  // 8. Restore preserved mathematical formulas completely intact
  if (mathPlaceholders.length > 0) {
    cleaned = cleaned.replace(/@@MATH_BLOCK_(\d+)@@/g, (_, index) => {
      const idx = parseInt(index, 10);
      return mathPlaceholders[idx] !== undefined ? mathPlaceholders[idx] : _;
    });
  }

  if (
    !cleaned ||
    cleaned.length < 15 ||
    BANNED_STRINGS.has(cleaned.toLowerCase())
  ) {
    return undefined;
  }

  return cleaned;
}

// ── Identifier Normalization ────────────────────────────────────────────────

export function normalizeDoi(doi?: string | null): string | undefined {
  if (!doi || typeof doi !== 'string') return undefined;
  let clean = doi.trim();

  // Nature article URL: nature.com/articles/<slug>
  const natureMatch = clean.match(
    /^https?:\/\/(?:www\.)?nature\.com\/articles\/([a-z0-9._-]+)(?:[?#].*)?$/i,
  );
  if (natureMatch && natureMatch[1]) return `10.1038/${natureMatch[1]}`;

  // Zenodo record URL: zenodo.org/records/<id>
  const zenodoMatch = clean.match(
    /^https?:\/\/zenodo\.org\/records?\/(\d+)(?:[?#].*)?$/i,
  );
  if (zenodoMatch && zenodoMatch[1]) return `10.5281/zenodo.${zenodoMatch[1]}`;

  // BioRxiv / MedRxiv preprint URL
  const biorxivMatch = clean.match(
    /^https?:\/\/(?:www\.)?(?:biorxiv|medrxiv)\.org\/content\/(10\.\d{4,9}\/[^?#\s]+?)(?:v\d+)?(?:\.full|\.abstract|\.pdf)?(?:[?#].*)?$/i,
  );
  if (biorxivMatch && biorxivMatch[1])
    return biorxivMatch[1].replace(/v\d+$/, '');

  // PLOS article URL
  const plosMatch = clean.match(
    /^https?:\/\/journals\.plos\.org\/[^/]+\/article\?(?:[^#]*&)?id=(10\.\d{4,9}\/[^&#\s]+)/i,
  );
  if (plosMatch && plosMatch[1]) return decodeURIComponent(plosMatch[1]);

  // Embedded /doi/ or /article/ in publisher URLs
  const embeddedMatch = clean.match(
    /^https?:\/\/[^/]+(?:\/[^/]+)*\/(?:doi\/|article\/)(?:abs\/|full\/|epdf\/|pdf\/)?(10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+)(?:[?#].*)?$/i,
  );
  if (embeddedMatch && embeddedMatch[1]) {
    clean = embeddedMatch[1];
  } else {
    clean = clean.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
  }

  clean = clean.replace(/[.,;]+$/, '');
  if (clean.endsWith(')') && !clean.includes('(')) {
    clean = clean.slice(0, -1);
  }
  if (clean.endsWith(']') && !clean.includes('[')) {
    clean = clean.slice(0, -1);
  }

  const match = clean.match(/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+$/);
  if (!match) {
    const embedded = clean.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+/);
    return embedded ? embedded[0].toLowerCase() : undefined;
  }

  return clean.startsWith('10.48550/arXiv.') ? clean : clean.toLowerCase();
}

export function normalizeArxivId(
  arxiv?: string | null,
  options?: { stripVersion?: boolean },
): string | undefined {
  if (!arxiv || typeof arxiv !== 'string') return undefined;
  let clean = arxiv.trim();

  // Strip accidental category brackets if present, e.g. "1512.03385v1 [cs.CV]" or "1512.03385v1[cs.CV]"
  clean = clean.replace(/\s*\[[^\]]+\]\s*$/, '').trim();

  clean = clean.replace(
    /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)/i,
    '',
  );
  clean = clean.replace(/\.pdf$/i, '');
  if (options?.stripVersion) {
    clean = clean.replace(/v\d+$/i, '');
  }

  const newFormat = clean.match(/^\d{4}\.\d{4,5}(?:v\d+)?$/i);
  if (newFormat) return newFormat[0];

  const oldFormat = clean.match(/^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}$/i);
  if (oldFormat) return oldFormat[0].toLowerCase();

  return undefined;
}

export function normalizePmid(
  pmid?: string | number | null,
): string | undefined {
  if (pmid === null || pmid === undefined) return undefined;
  const str = String(pmid)
    .trim()
    .replace(/^(?:pmid:\s*|https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/)/i, '')
    .replace(/\/$/, '');
  return /^\d{1,9}$/.test(str) ? str : undefined;
}

export function normalizePmcid(pmcid?: string | null): string | undefined {
  if (!pmcid || typeof pmcid !== 'string') return undefined;
  const clean = pmcid
    .trim()
    .toUpperCase()
    .replace(
      /^(?:PMCID:\s*|PMC:\s*|HTTPS?:\/\/WWW\.NCBI\.NLM\.NIH\.GOV\/PMC\/ARTICLES\/)/i,
      '',
    )
    .replace(/\/$/, '');
  const digits = clean.replace(/^PMC/, '');
  return /^\d{1,9}$/.test(digits) ? `PMC${digits}` : undefined;
}

export function normalizeIsbn(isbn?: string | null): string | undefined {
  if (!isbn || typeof isbn !== 'string') return undefined;
  const digits = isbn
    .replace(/^isbn:?\s*/i, '')
    .replace(/[-\s]/g, '')
    .toUpperCase();
  if (/^(?:978|979)\d{10}$/.test(digits) || /^\d{9}[\dX]$/.test(digits)) {
    return digits;
  }
  return undefined;
}

export function normalizeIssn(issn?: string | null): string | undefined {
  if (!issn || typeof issn !== 'string') return undefined;
  const clean = issn
    .replace(/^issn:?\s*/i, '')
    .replace(/[-\s]/g, '')
    .toUpperCase();
  if (/^\d{7}[\dX]$/.test(clean)) {
    return `${clean.slice(0, 4)}-${clean.slice(4)}`;
  }
  return undefined;
}

export function formatCanonicalId(
  scheme: IdentifierScheme,
  value?: string | number | null,
): string | undefined {
  if (!value) return undefined;
  const strVal = typeof value === 'number' ? String(value) : value;
  const normalizers: Record<IdentifierScheme, string | undefined> = {
    doi: normalizeDoi(strVal),
    arxiv: normalizeArxivId(strVal),
    pmid: normalizePmid(value),
    pmcid: normalizePmcid(strVal),
    isbn: normalizeIsbn(strVal),
    issn: normalizeIssn(strVal),
    url: strVal?.trim() || undefined,
    urn: strVal?.trim() || undefined,
    uri: strVal?.trim() || undefined,
    custom: strVal?.trim() || undefined,
  };

  const normalized = normalizers[scheme];
  return normalized ? `${scheme}:${normalized}` : undefined;
}

export function extractYearFromDate(
  dateStr?: string | null,
): number | undefined {
  if (!dateStr || typeof dateStr !== 'string') return undefined;
  const match = dateStr.match(/\b(19\d\d|20\d\d)\b/);
  return match ? parseInt(match[1], 10) : undefined;
}

// ── Bibliographic Item Types ────────────────────────────────────────────────
import { SCHEMA_V42_DATA } from '../types/schema.constants';

export const ITEM_TYPE_ALIASES: Record<string, string> = {
  preprint: 'preprint',
  'working-paper': 'preprint',
  'working paper': 'preprint',
  eprint: 'preprint',
  'posted-content': 'preprint',
  postedcontent: 'preprint',
  software: 'computerProgram',
  'software-code': 'computerProgram',
  code: 'computerProgram',
  program: 'computerProgram',
  computerprogram: 'computerProgram',
  algorithm: 'computerProgram',
  dataset: 'dataset',
  data: 'dataset',
  database: 'dataset',
  'data-set': 'dataset',
  standard: 'standard',
  norm: 'standard',
  specification: 'standard',
  rfc: 'standard',
  journalarticle: 'journalArticle',
  'journal-article': 'journalArticle',
  article: 'journalArticle',
  paper: 'journalArticle',
  peer_review: 'journalArticle',
  conferencepaper: 'conferencePaper',
  'proceedings-article': 'conferencePaper',
  proceedings: 'conferencePaper',
  conference: 'conferencePaper',
  inproceedings: 'conferencePaper',
  paper_conference: 'conferencePaper',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  booksection: 'bookSection',
  'book-section': 'bookSection',
  'book-chapter': 'bookSection',
  incollection: 'bookSection',
  inbook: 'bookSection',
  chapter: 'bookSection',
  thesis: 'thesis',
  dissertation: 'thesis',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  'doctoral-thesis': 'thesis',
  report: 'report',
  'tech-report': 'report',
  techreport: 'report',
  'research-report': 'report',
  whitepaper: 'report',
  patent: 'patent',
  'patent-application': 'patent',
  webpage: 'webpage',
  'web-page': 'webpage',
  website: 'webpage',
  online: 'webpage',
  blogpost: 'blogPost',
  'blog-post': 'blogPost',
  magazinearticle: 'magazineArticle',
  'magazine-article': 'magazineArticle',
  newspaperarticle: 'newspaperArticle',
  'newspaper-article': 'newspaperArticle',
  presentation: 'presentation',
  slides: 'presentation',
  talk: 'presentation',
  lecture: 'presentation',
  videorecording: 'videoRecording',
  video: 'videoRecording',
  audiorecording: 'audioRecording',
  audio: 'audioRecording',
  podcast: 'podcast',
  film: 'film',
  movie: 'film',
  artwork: 'artwork',
};

/**
 * Canonical CSL type → Zotero itemType mapping.
 * Based on zotero-schema.json v42 csl.types crosswalk.
 * Single source of truth — replaces duplicate local maps in ris.parser.ts and identify.stage.ts.
 */
export const CSL_TYPE_TO_ITEM_TYPE: Record<string, string> = {
  // Academic
  article: 'journalArticle',
  'article-journal': 'journalArticle',
  'paper-conference': 'conferencePaper',
  chapter: 'bookSection',
  thesis: 'thesis',
  report: 'report',
  dataset: 'dataset',
  software: 'computerProgram',
  standard: 'standard',
  // Books
  book: 'book',
  manuscript: 'manuscript',
  'entry-dictionary': 'dictionaryEntry',
  'entry-encyclopedia': 'encyclopediaArticle',
  // Articles
  'article-magazine': 'magazineArticle',
  'article-newspaper': 'newspaperArticle',
  // Legal
  bill: 'bill',
  legal_case: 'case',
  hearing: 'hearing',
  legislation: 'statute',
  patent: 'patent',
  // Media
  broadcast: 'tvBroadcast',
  graphic: 'artwork',
  interview: 'interview',
  map: 'map',
  motion_picture: 'film',
  song: 'audioRecording',
  speech: 'presentation',
  // Web/Documents
  document: 'document',
  personal_communication: 'letter',
  post: 'forumPost',
  'post-weblog': 'blogPost',
  webpage: 'webpage',
};

/**
 * Maps a raw CSL type string to the canonical Zotero itemType.
 * Falls back to ITEM_TYPE_ALIASES for BibTeX/RIS variants, then 'journalArticle'.
 */
export function mapCslTypeToZoteroItemType(cslType?: string | null): string {
  if (!cslType) return 'journalArticle';
  const trimmed = cslType.trim();
  const lower = trimmed.toLowerCase();
  if (CSL_TYPE_TO_ITEM_TYPE[trimmed]) return CSL_TYPE_TO_ITEM_TYPE[trimmed];
  if (CSL_TYPE_TO_ITEM_TYPE[lower]) return CSL_TYPE_TO_ITEM_TYPE[lower];
  if (ITEM_TYPE_ALIASES[lower]) return ITEM_TYPE_ALIASES[lower];
  const cleaned = lower.replace(/[\s_-]+/g, '');
  if (ITEM_TYPE_ALIASES[cleaned]) return ITEM_TYPE_ALIASES[cleaned];
  return 'journalArticle';
}

export interface PdfItemTypeSignals {
  title?: string;
  notes?: Array<string | { content: string }>;
  journal?: string;
  conferenceName?: string;
  bookTitle?: string;
  isbn?: string;
  publisher?: string;
  filename?: string;
  /** Plain text from first N pages for deeper heuristics */
  rawText?: string;
}

export interface InferredItemType {
  itemType: string;
  /** 0–1 confidence: how certain the heuristic is */
  confidence: number;
  /** Which signal triggered the decision */
  reason: string;
}

/**
 * Infers the probable Zotero itemType for a PDF that has no DOI, arXiv ID,
 * or other authoritative identifier, by applying deterministic text heuristics
 * on metadata signals extracted by GROBID (title, notes, conference name, etc.).
 *
 * Returns undefined when no signal is strong enough — the caller should fall
 * back to the pipeline default (`journalArticle`).
 *
 * Heuristic tiers (highest confidence first):
 *  1. ISBN present → book or bookSection
 *  2. conferenceName / bookTitle from GROBID TEI → conferencePaper / bookSection
 *  3. Title/notes keyword patterns for thesis, report, preprint, patent, dataset
 *  4. Filename-level patterns as a last resort
 */
export function inferItemTypeFromPdfSignals(
  signals: PdfItemTypeSignals,
): InferredItemType | undefined {
  const titleLower = (signals.title || '').toLowerCase();
  const filenameLower = (signals.filename || '').toLowerCase();

  // Collapse notes into a single searchable string
  const notesText = (signals.notes || [])
    .map((n) => (typeof n === 'string' ? n : n?.content || ''))
    .join(' ')
    .toLowerCase();

  const combined = `${titleLower} ${notesText}`;

  // ── Tier 1: ISBN present → book-class document ────────────────────────────
  if (signals.isbn) {
    if (signals.bookTitle) {
      return {
        itemType: 'bookSection',
        confidence: 0.88,
        reason: 'isbn+bookTitle',
      };
    }
    return { itemType: 'book', confidence: 0.85, reason: 'isbn' };
  }

  // ── Tier 2: GROBID TEI structural signals ─────────────────────────────────
  if (signals.conferenceName) {
    return {
      itemType: 'conferencePaper',
      confidence: 0.87,
      reason: 'grobid:conferenceName',
    };
  }

  if (signals.bookTitle) {
    return {
      itemType: 'bookSection',
      confidence: 0.85,
      reason: 'grobid:bookTitle',
    };
  }

  // ── Tier 3a: Thesis patterns ───────────────────────────────────────────────
  const THESIS_TITLE =
    /\b(ph\.?d\.?|doctoral|master'?s?|m\.?sc?\.?|m\.?eng?\.?|bachelor'?s?|undergraduate)\s+(thesis|dissertation)\b/i;
  // Only match structural thesis phrasing — NOT bare "submitted to <journal>"
  // (preprint detection below handles that case).
  const THESIS_NOTE =
    /\b(in\s+partial\s+(fulfil(?:l?ment)?|fulfil)|for\s+the\s+degree\s+of|for\s+the\s+award\s+of|for\s+graduation|thesis\s+advisor|thesis\s+supervisor|dissertation\s+committee)\b/i;
  const THESIS_TITLE2 = /\bthesis\b|\bdissertation\b/i;

  if (THESIS_TITLE.test(titleLower) || THESIS_NOTE.test(notesText)) {
    return {
      itemType: 'thesis',
      confidence: 0.92,
      reason: 'thesis:title+note',
    };
  }
  if (THESIS_TITLE2.test(titleLower) && notesText.length > 0) {
    return { itemType: 'thesis', confidence: 0.8, reason: 'thesis:title' };
  }

  // ── Tier 3b: Report patterns ──────────────────────────────────────────────
  const REPORT_TITLE =
    /\b(technical\s+report|research\s+report|white\s+paper|whitepaper|working\s+paper|discussion\s+paper|policy\s+brief|deliverable\s+d?\d|internal\s+report|annual\s+report|progress\s+report)\b/i;
  const REPORT_NOTE =
    /\b(report\s+no\.?|report\s+number|tech\.?\s+report|nist|nasa\s+tm|nasa\s+cr|afrl|dtic|rand\s+corporation)\b/i;

  if (REPORT_TITLE.test(titleLower) || REPORT_TITLE.test(notesText)) {
    return { itemType: 'report', confidence: 0.88, reason: 'report:title' };
  }
  if (REPORT_NOTE.test(notesText)) {
    return { itemType: 'report', confidence: 0.78, reason: 'report:note' };
  }

  // ── Tier 3c: Preprint — checked BEFORE conference venue names ─────────────
  // "submitted to <venue>" or "under review at <conference>" → preprint.
  // Must fire before CONF_TITLE so venue names in notes (ICML, JMLR) do not
  // incorrectly trigger conferencePaper.
  const PREPRINT_NOTE =
    /\b(preprint|under\s+review|submitted\s+to\b|to\s+appear\s+in|not\s+peer[\s-]reviewed|biorxiv|medrxiv|ssrn|chemrxiv)\b/i;
  // Use delimiter-aware pattern (no \b) so underscored filenames like
  // "arxiv_2310.06825v2.pdf" are matched correctly.
  const PREPRINT_FILENAME =
    /(?:^|[\s_\-./])(arxiv|preprint|biorxiv|medrxiv|ssrn)(?:$|[\s_\-./\d])/i;

  if (PREPRINT_NOTE.test(combined)) {
    return { itemType: 'preprint', confidence: 0.82, reason: 'preprint:note' };
  }
  if (PREPRINT_FILENAME.test(filenameLower)) {
    return {
      itemType: 'preprint',
      confidence: 0.75,
      reason: 'preprint:filename',
    };
  }

  // ── Tier 3d: Conference paper patterns (title/notes only) ─────────────────
  const CONF_TITLE =
    /\b(proceedings\s+of|in\s+proceedings|proc\.\s+of|workshop\s+on|symposium\s+on|conference\s+on|annual\s+conference|international\s+conference|ieee\s+[a-z]+\s+\d{4}|acm\s+[a-z]+\s+\d{4}|neurips|icml|iclr|cvpr|eccv|iccv|emnlp|acl\s+\d{4}|naacl|aaai\s+\d{4}|ijcai|sigchi|chi\s+\d{4})\b/i;

  if (CONF_TITLE.test(titleLower) || CONF_TITLE.test(notesText)) {
    return {
      itemType: 'conferencePaper',
      confidence: 0.83,
      reason: 'conference:pattern',
    };
  }

  const PATENT_TITLE =
    /\b(patent|us\s*\d{7,}|ep\s*\d{7,}|wo\s*\d{4}\/\d{6}|patent\s+application|utility\s+patent|international\s+publication)\b/i;

  if (PATENT_TITLE.test(titleLower) || PATENT_TITLE.test(notesText)) {
    return { itemType: 'patent', confidence: 0.85, reason: 'patent:pattern' };
  }

  // ── Tier 3f: Dataset patterns ──────────────────────────────────────────────
  const DATASET_TITLE =
    /\b(dataset|data\s+set|benchmark\s+dataset|corpus|annotated\s+(corpus|dataset)|knowledge\s+base|data\s+paper)\b/i;

  if (DATASET_TITLE.test(titleLower)) {
    return { itemType: 'dataset', confidence: 0.78, reason: 'dataset:title' };
  }

  // ── Tier 3g: Presentation patterns ────────────────────────────────────────
  const PRES_TITLE =
    /\b(tutorial|keynote(\s+talk)?|invited\s+talk|slide|presentation)\b/i;

  if (PRES_TITLE.test(titleLower)) {
    return {
      itemType: 'presentation',
      confidence: 0.72,
      reason: 'presentation:title',
    };
  }

  // ── Tier 4: Filename last-resort ─────────────────────────────────────────
  // Use delimiter-aware patterns (not \b) so underscored filenames like
  // "john_doe_phd_thesis_2023.pdf" are caught correctly.
  if (
    /(?:^|[\s_\-.])(thesis|dissertation)(?:$|[\s_\-.\d])/i.test(filenameLower)
  ) {
    return { itemType: 'thesis', confidence: 0.65, reason: 'thesis:filename' };
  }
  if (
    /(?:^|[\s_\-.])(report|techreport|whitepaper)(?:$|[\s_\-.\d])/i.test(
      filenameLower,
    )
  ) {
    return { itemType: 'report', confidence: 0.6, reason: 'report:filename' };
  }
  if (
    /(?:^|[\s_\-.])(proceedings|conference|workshop|symposium)(?:$|[\s_\-.\d])/i.test(
      filenameLower,
    )
  ) {
    return {
      itemType: 'conferencePaper',
      confidence: 0.6,
      reason: 'conference:filename',
    };
  }

  return undefined;
}

export function normalizeCanonicalItemType(
  rawType: string | undefined | null,
  canonicalTypes?: Record<string, unknown>,
): string {
  if (!rawType || typeof rawType !== 'string') {
    return 'journalArticle';
  }

  const trimmed = rawType.trim();
  const lower = trimmed.toLowerCase();

  if (canonicalTypes) {
    const matchedKey = Object.keys(canonicalTypes).find(
      (k) => k.toLowerCase() === lower,
    );
    if (matchedKey) return matchedKey;
  }

  if (ITEM_TYPE_ALIASES[lower]) {
    return ITEM_TYPE_ALIASES[lower];
  }

  const cleaned = lower.replace(/[\s_-]+/g, '');
  if (ITEM_TYPE_ALIASES[cleaned]) {
    return ITEM_TYPE_ALIASES[cleaned];
  }

  return 'journalArticle';
}

export const BIBLIOGRAPHIC_ITEM_TYPES = Object.values(SCHEMA_V42_DATA.itemTypes)
  .filter((t: any) => t.isBibliographic)
  .map((t: any) => t.itemType);

export const SPECIAL_ITEM_TYPES = Object.values(SCHEMA_V42_DATA.itemTypes)
  .filter((t: any) => t.isSpecial)
  .map((t: any) => t.itemType) as ['attachment', 'note', 'annotation'];

export const CANONICAL_ITEM_TYPES = new Set<string>(
  Object.keys(SCHEMA_V42_DATA.itemTypes),
);

export function normalizeItemType(type?: string | null): string {
  return normalizeCanonicalItemType(type, SCHEMA_V42_DATA.itemTypes);
}
export const normalizeLibraryItemType = normalizeItemType;

const SPECIAL_CASE_WORDS: Record<string, string> = {
  arxiv: 'arXiv',
  biorxiv: 'bioRxiv',
  medrxiv: 'medRxiv',
  latex: 'LaTeX',
  bibtex: 'BibTeX',
  fmri: 'fMRI',
  mrna: 'mRNA',
  't-sne': 't-SNE',
  pytorch: 'PyTorch',
  tensorflow: 'TensorFlow',
  openai: 'OpenAI',
  chatgpt: 'ChatGPT',
  ios: 'iOS',
  macos: 'macOS',
  phd: 'PhD',
  ieee: 'IEEE',
  acm: 'ACM',
  nature: 'Nature',
  science: 'Science',
};

const COMMON_ACADEMIC_ACRONYMS = new Set([
  'AI',
  'ML',
  'DL',
  'RL',
  'NLP',
  'CV',
  'NLU',
  'NLG',
  'LLM',
  'LLMS',
  'SLM',
  'SLMS',
  'VLM',
  'VLMS',
  'CNN',
  'CNNS',
  'RNN',
  'RNNS',
  'GNN',
  'GNNS',
  'GAN',
  'GANS',
  'VAE',
  'VAES',
  'BERT',
  'GPT',
  'CLIP',
  'LSTM',
  'SVM',
  'RAG',
  'COT',
  'TOT',
  'DQN',
  'PPO',
  'DDPG',
  'SAC',
  'DNA',
  'RNA',
  'CRISPR',
  'COVID',
  'COVID-19',
  'SARS',
  'MERS',
  'HIV',
  'PCR',
  'EEG',
  'ECG',
  'MRI',
  'CT',
  'PET',
  'API',
  'APIS',
  'REST',
  'HTTP',
  'HTTPS',
  'URL',
  'URI',
  'SQL',
  'NOSQL',
  'CPU',
  'CPUS',
  'GPU',
  'GPUS',
  'TPU',
  'TPUS',
  'RAM',
  'ROM',
  '2D',
  '3D',
  '4D',
  '5G',
  '6G',
  'DOI',
  'ISBN',
  'ISSN',
  'CSL',
  'PDF',
  'OCR',
  'XML',
  'HTML',
  'JSON',
  'USA',
  'UK',
  'EU',
  'UN',
  'WHO',
  'NIH',
  'NSF',
  'NASA',
  'DARPA',
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
  'IX',
  'X',
  'XI',
  'XII',
]);

const MINOR_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'but',
  'or',
  'nor',
  'for',
  'yet',
  'so',
  'as',
  'at',
  'by',
  'from',
  'in',
  'into',
  'of',
  'off',
  'on',
  'onto',
  'out',
  'over',
  'per',
  'to',
  'up',
  'via',
  'with',
]);

/**
 * Normalizes academic paper title casing:
 * - If title is ALL CAPS or all lowercase, converts to standard academic Title Case.
 * - If title has shouting uppercase non-acronym words (e.g. "SURVEY OF DEEP LEARNING"), normalizes them.
 * - Preserves standard academic acronyms (BERT, GPT, LLM, CNN, RNA, etc.) and mixed-case terms (arXiv, mRNA).
 * - Leaves correctly cased mixed-case titles untouched.
 */
export function normalizeAcademicTitleCase(title?: string | null): string {
  if (!title || typeof title !== 'string') return '';
  const trimmed = title.trim();
  if (trimmed.length < 3) return trimmed;

  const isAllUpper =
    trimmed.length > 3 &&
    trimmed === trimmed.toUpperCase() &&
    /[A-Z]/.test(trimmed);
  const isAllLower =
    trimmed.length > 3 &&
    trimmed === trimmed.toLowerCase() &&
    /[a-z]/.test(trimmed);

  const startsWithLower = /^[a-z]/.test(trimmed);

  const words = trimmed.split(/\s+/).filter(Boolean);
  const hasShoutingWords = words.some((w) => {
    const clean = w.replace(/^[^\w]+|[^\w]+$/g, '');
    return (
      clean.length >= 4 &&
      clean === clean.toUpperCase() &&
      !COMMON_ACADEMIC_ACRONYMS.has(clean) &&
      /[A-Z]/.test(clean)
    );
  });

  const significantWords = words
    .map((w) => w.replace(/^[^\w]+|[^\w]+$/g, ''))
    .filter(
      (w) => w.length >= 4 && !COMMON_ACADEMIC_ACRONYMS.has(w.toUpperCase()),
    );
  const isSentenceCase =
    significantWords.length >= 2 &&
    significantWords.filter((w) => w === w.toLowerCase()).length /
      significantWords.length >=
      0.5;

  if (
    !isAllUpper &&
    !isAllLower &&
    !startsWithLower &&
    !hasShoutingWords &&
    !isSentenceCase
  ) {
    return trimmed;
  }

  const formatWord = (
    word: string,
    isFirstOrLast: boolean,
    prevEndsWithColon: boolean,
  ): string => {
    const leadingPunct = word.match(/^[^\w]+/)?.[0] || '';
    const trailingPunct = word.match(/[^\w]+$/)?.[0] || '';
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

    if (!isAllUpper && !isAllLower) {
      const clean = w.replace(/^[^\w]+|[^\w]+$/g, '');
      const cleanUpper = clean.toUpperCase();
      if (
        clean.length <= 4 ||
        COMMON_ACADEMIC_ACRONYMS.has(cleanUpper) ||
        SPECIAL_CASE_WORDS[clean.toLowerCase()] ||
        clean !== cleanUpper
      ) {
        formattedWords.push(w);
        continue;
      }
    }

    formattedWords.push(formatWord(w, isFirstOrLast, prevEndsWithColon));
  }

  return formattedWords.join(' ');
}

/**
 * Sanitizes an academic library item title:
 * 1. Strips <script> and <style> tags and their contents
 * 2. Strips remaining HTML/XML tags
 * 3. Decodes HTML entities
 * 4. Strips LaTeX curly braces
 * 5. Strips control characters
 * 6. Collapses multiple whitespace into a single space and trims
 * 7. Normalizes screaming ALL CAPS or all lowercase into standard academic Title Case
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

  // Fix PDF small-caps drop-cap gaps (e.g. "V ERY" -> "VERY", "D EEP" -> "DEEP")
  cleaned = cleaned.replace(/\b([A-Z])\s+([A-Z]{2,})\b/g, '$1$2');

  // Fix spaced hyphens (e.g. "Auto - Encoding" -> "Auto-Encoding", "Large - Scale" -> "Large-Scale")
  cleaned = cleaned.replace(
    /\b([A-Za-z0-9]+)\s+[-–—]\s+([A-Za-z0-9]+)\b/g,
    '$1-$2',
  );

  // Fix single letter uppercase gaps: "B Y" -> "BY"
  cleaned = cleaned.replace(/\b([B-HJ-Z])\s+([A-Z])\b/g, '$1$2');

  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  cleaned = normalizeAcademicTitleCase(cleaned);
  if (cleaned.length > 1000) {
    cleaned = cleaned.substring(0, 1000).trim();
  }
  return cleaned;
}
