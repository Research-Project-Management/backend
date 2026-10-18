import { SCHEMA_V42_DATA } from '@/modules/library/core/types/schema.constants';

// Text Cleaner & Normalization

export const BANNED_STRINGS = new Set([
  'undefined',
  'null',
  'n/a',
  'na',
  'none',
  'unknown',
  '',
]);

const HTML_ENTITY_CODEPOINTS: Record<string, number> = (() => {
  const map: Record<string, number> = {
    amp: 0x26,
    lt: 0x3c,
    gt: 0x3e,
    quot: 0x22,
    apos: 0x27,
    nbsp: 0x20, // decoded as a plain space on purpose (whitespace collapsing)
    ensp: 0x20,
    emsp: 0x20,
    thinsp: 0x20,
    shy: 0, // soft hyphen → removed
    zwnj: 0,
    zwj: 0,
    ndash: 0x2013,
    mdash: 0x2014,
    minus: 0x2212,
    hyphen: 0x2010,
    lsquo: 0x2018,
    rsquo: 0x2019,
    sbquo: 0x201a,
    ldquo: 0x201c,
    rdquo: 0x201d,
    bdquo: 0x201e,
    laquo: 0xab,
    raquo: 0xbb,
    lsaquo: 0x2039,
    rsaquo: 0x203a,
    hellip: 0x2026,
    bull: 0x2022,
    middot: 0xb7,
    prime: 0x2032,
    Prime: 0x2033,
    dagger: 0x2020,
    Dagger: 0x2021,
    permil: 0x2030,
    copy: 0xa9,
    reg: 0xae,
    trade: 0x2122,
    sect: 0xa7,
    para: 0xb6,
    cent: 0xa2,
    pound: 0xa3,
    yen: 0xa5,
    euro: 0x20ac,
    iexcl: 0xa1,
    iquest: 0xbf,
    ordf: 0xaa,
    ordm: 0xba,
    plusmn: 0xb1,
    times: 0xd7,
    divide: 0xf7,
    micro: 0xb5,
    deg: 0xb0,
    sup1: 0xb9,
    sup2: 0xb2,
    sup3: 0xb3,
    frac14: 0xbc,
    frac12: 0xbd,
    frac34: 0xbe,
    acute: 0xb4,
    uml: 0xa8,
    cedil: 0xb8,
    macr: 0xaf,
    le: 0x2264,
    ge: 0x2265,
    ne: 0x2260,
    asymp: 0x2248,
    equiv: 0x2261,
    infin: 0x221e,
    sum: 0x2211,
    prod: 0x220f,
    radic: 0x221a,
    part: 0x2202,
    nabla: 0x2207,
    isin: 0x2208,
    larr: 0x2190,
    uarr: 0x2191,
    rarr: 0x2192,
    darr: 0x2193,
    harr: 0x2194,
    szlig: 0xdf,
    yuml: 0xff,
    Yuml: 0x178,
    AElig: 0xc6,
    aelig: 0xe6,
    OElig: 0x152,
    oelig: 0x153,
    Scaron: 0x160,
    scaron: 0x161,
    Zcaron: 0x17d,
    zcaron: 0x17e,
    ETH: 0xd0,
    eth: 0xf0,
    THORN: 0xde,
    thorn: 0xfe,
    sigmaf: 0x3c2,
    thetasym: 0x3d1,
    upsih: 0x3d2,
    piv: 0x3d6,
  };
  // Latin-1 accented letters: lowercase at U+00E0.., uppercase = lowercase - 0x20
  const latin1: Array<[string, number]> = [
    ['agrave', 0xe0],
    ['aacute', 0xe1],
    ['acirc', 0xe2],
    ['atilde', 0xe3],
    ['auml', 0xe4],
    ['aring', 0xe5],
    ['ccedil', 0xe7],
    ['egrave', 0xe8],
    ['eacute', 0xe9],
    ['ecirc', 0xea],
    ['euml', 0xeb],
    ['igrave', 0xec],
    ['iacute', 0xed],
    ['icirc', 0xee],
    ['iuml', 0xef],
    ['ntilde', 0xf1],
    ['ograve', 0xf2],
    ['oacute', 0xf3],
    ['ocirc', 0xf4],
    ['otilde', 0xf5],
    ['ouml', 0xf6],
    ['oslash', 0xf8],
    ['ugrave', 0xf9],
    ['uacute', 0xfa],
    ['ucirc', 0xfb],
    ['uuml', 0xfc],
    ['yacute', 0xfd],
  ];
  for (const [name, cp] of latin1) {
    map[name] = cp;
    map[name.charAt(0).toUpperCase() + name.slice(1)] = cp - 0x20;
  }
  // Greek letters: lowercase U+03B1.., uppercase = lowercase - 0x20
  const greek = [
    'alpha',
    'beta',
    'gamma',
    'delta',
    'epsilon',
    'zeta',
    'eta',
    'theta',
    'iota',
    'kappa',
    'lambda',
    'mu',
    'nu',
    'xi',
    'omicron',
    'pi',
    'rho',
    '', // final sigma slot (handled as sigmaf)
    'sigma',
    'tau',
    'upsilon',
    'phi',
    'chi',
    'psi',
    'omega',
  ];
  greek.forEach((name, idx) => {
    if (!name) return;
    const cp = 0x3b1 + idx;
    map[name] = cp;
    map[name.charAt(0).toUpperCase() + name.slice(1)] = cp - 0x20;
  });
  return map;
})();

const HTML_ENTITY_REGEX =
  /&(?:([a-zA-Z][a-zA-Z0-9]*)|#(\d+)|#[xX]([0-9a-fA-F]+));/g;

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  if (code >= 0xd800 && code <= 0xdfff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Decodes named, decimal, and hexadecimal HTML/XML entities into UTF-8 text.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text || typeof text !== 'string') return '';
  if (!text.includes('&')) return text;

  return text.replace(HTML_ENTITY_REGEX, (match, named, dec, hex) => {
    if (named) {
      const key = Object.prototype.hasOwnProperty.call(
        HTML_ENTITY_CODEPOINTS,
        named,
      )
        ? named
        : String(named).toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(HTML_ENTITY_CODEPOINTS, key)) {
        return match;
      }
      const cp = HTML_ENTITY_CODEPOINTS[key];
      return cp === 0 ? '' : String.fromCodePoint(cp);
    }
    if (dec) {
      return safeFromCodePoint(parseInt(dec, 10));
    }
    if (hex) {
      return safeFromCodePoint(parseInt(hex, 16));
    }
    return match;
  });
}

/** Double-encoded tags such as "&lt;i&gt;" or "&amp;lt;sub&amp;gt;". */
const DOUBLE_ENCODED_TAG_REGEX =
  /&(?:amp;)?lt;(\/?[a-zA-Z][\w:-]*(?:\s[^&<>]*?)?\/?)&(?:amp;)?gt;/g;

/** Inline formatting tags that must be removed WITHOUT inserting whitespace. */
const INLINE_FORMAT_TAG_REGEX =
  /<\/?(?:jats:|mml:|html:)?(?:i|b|u|em|strong|sub|sup|sc|scp|span|small|tt|italic|bold|underline|font|smallcaps)\b[^>]*>/gi;

/**
 * Converts <sub>/<sup> (incl. JATS-prefixed) to Unicode sub/superscripts when
 * every character of the content is mappable; otherwise keeps the raw content
 * (the tag is dropped without inserting spaces, e.g. "CO<sub>2max</sub>" →
 * "CO2max").
 */
export function convertSubSupTagsToUnicode(text: string): string {
  if (!text || typeof text !== 'string') return '';
  if (!/<(?:jats:|mml:)?su[bp]\b/i.test(text)) return text;
  const mapAll = (content: string, map: Record<string, string>) => {
    const inner = content.trim();
    if (!inner) return content;
    let out = '';
    for (const ch of inner) {
      const mapped = map[ch];
      if (!mapped) return content;
      out += mapped;
    }
    return out;
  };
  return text
    .replace(
      /<(?:jats:|mml:)?sub\b[^>]*>([\s\S]*?)<\/(?:jats:|mml:)?sub>/gi,
      (_, content: string) => mapAll(content, UNICODE_SUB_MAP),
    )
    .replace(
      /<(?:jats:|mml:)?sup\b[^>]*>([\s\S]*?)<\/(?:jats:|mml:)?sup>/gi,
      (_, content: string) => mapAll(content, UNICODE_SUP_MAP),
    );
}

/**
 * Strips XML and HTML tags including JATS XML (<jats:...>), math tags, etc.
 * - Double-encoded tags (&lt;i&gt;) are decoded first so they get stripped.
 * - <sub>/<sup> become Unicode sub/superscripts where fully mappable.
 * - Inline formatting tags (i, b, em, strong, sub, sup, sc, span, ...) are
 *   removed without inserting spaces; block-level tags become a space.
 */
export function stripXmlAndHtmlTags(text: string): string {
  if (!text || typeof text !== 'string') return '';
  let out = text;
  if (out.includes('&')) {
    out = out.replace(DOUBLE_ENCODED_TAG_REGEX, '<$1>');
  }
  out = convertSubSupTagsToUnicode(out);
  out = out.replace(INLINE_FORMAT_TAG_REGEX, '');
  return out
    .replace(/<\/?[a-zA-Z0-9_:-]+(?:\s+[^>]*?)?\/?>/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Converts rich academic/Zotero HTML note content into clean Markdown.
 */
export function convertAcademicHtmlToMarkdown(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  if (
    !/<\/?[a-z][\s\S]*>/i.test(raw) &&
    !raw.includes('&') &&
    !raw.includes('\r')
  ) {
    return raw
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => `# ${c.trim()}\n\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => `## ${c.trim()}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => `### ${c.trim()}\n\n`)
    .replace(
      /<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi,
      (_, c) => `#### ${c.trim()}\n\n`,
    )
    .replace(
      /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
      (_, c) => `> ${c.trim()}\n\n`,
    )
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `- ${c.trim()}\n`)
    .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, c) => `${c.trim()}\n\n`)
    .replace(/<\/div>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(
      /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      '[$2]($1)',
    )
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const LATEX_SPECIAL_MACROS: Array<[RegExp, string]> = [
  [/\{\\ss\}|\\ss\b/g, 'ß'],
  [/\{\\SS\}|\\SS\b/g, 'ẞ'],
  [/\{\\ae\}|\\ae\b/g, 'æ'],
  [/\{\\AE\}|\\AE\b/g, 'Æ'],
  [/\{\\oe\}|\\oe\b/g, 'œ'],
  [/\{\\OE\}|\\OE\b/g, 'Œ'],
  [/\{\\aa\}|\\aa\b/g, 'å'],
  [/\{\\AA\}|\\AA\b/g, 'Å'],
  [/\{\\o\}|\\o\b/g, 'ø'],
  [/\{\\O\}|\\O\b/g, 'Ø'],
  [/\{\\l\}|\\l\b/g, 'ł'],
  [/\{\\L\}|\\L\b/g, 'Ł'],
  [/\{\\dj\}|\\dj\b/g, 'đ'],
  [/\{\\DJ\}|\\DJ\b/g, 'Đ'],
  [/\{\\ng\}|\\ng\b/g, 'ŋ'],
  [/\{\\NG\}|\\NG\b/g, 'Ŋ'],
  [/\{\\th\}|\\th\b/g, 'þ'],
  [/\{\\TH\}|\\TH\b/g, 'Þ'],
  [/\{\\dh\}|\\dh\b/g, 'ð'],
  [/\{\\DH\}|\\DH\b/g, 'Ð'],
  [/\\([uvHckr])\\([ij])\b/g, '\\$1{$2}'],
  [/\{\\i\}|\\i\b/g, 'i'],
  [/\{\\j\}|\\j\b/g, 'j'],
  [/\\&/g, '&'],
  [/\\%/g, '%'],
];

const LATEX_COMBINING_MAP: Record<string, string> = {
  '"': '\u0308', // umlaut / diaeresis
  "'": '\u0301', // acute
  '`': '\u0300', // grave
  '^': '\u0302', // circumflex
  '~': '\u0303', // tilde
  '=': '\u0304', // macron
  '.': '\u0307', // dot above
  u: '\u0306', // breve
  v: '\u030C', // caron / hacek
  H: '\u030B', // double acute
  c: '\u0327', // cedilla
  k: '\u0328', // ogonek
  r: '\u030A', // ring above
  d: '\u0323', // dot below
  b: '\u0331', // macron below
};

function decodeLatexOutsideMath(segment: string): string {
  let s = segment;
  for (const [pattern, replacement] of LATEX_SPECIAL_MACROS) {
    s = s.replace(pattern, replacement);
  }
  // Braced or unbraced letter commands: \v{s}, {\v{s}}, \c{c}, \u{g}, \H{o}, \k{a}, \r{a}, \d{o}, \b{o}
  s = s.replace(
    /\{?\\([uvHckrdb])\{\\?([a-zA-Z])\}\}?|\{\\([uvHckrdb])\s+\\?([a-zA-Z])\}|\\([uvHckrdb])\s+\\?([a-zA-Z])/g,
    (_, cmd1, ch1, cmd2, ch2, cmd3, ch3) => {
      const cmd = (cmd1 || cmd2 || cmd3) as string;
      const ch = (ch1 || ch2 || ch3) as string;
      const comb = LATEX_COMBINING_MAP[cmd];
      return comb ? (ch + comb).normalize('NFC') : ch;
    },
  );
  // Symbol accent commands: {\"o}, {\"{o}}, \"o, \"{o}, \'e, \`a, \^o, \~n, \=a, \.z
  s = s.replace(
    /\{?\\(["'`^~=.])\{?\\?([a-zA-Z])\}?\}?/g,
    (_, cmd: string, ch: string) => {
      const comb = LATEX_COMBINING_MAP[cmd];
      return comb ? (ch + comb).normalize('NFC') : ch;
    },
  );
  return s.replace(/[{}]/g, '');
}

/**
 * Strips LaTeX curly braces (e.g. "{Deep Learning}" -> "Deep Learning")
 * and decodes LaTeX diacritic sequences (e.g. "{\"o}" -> "ö", "{\v{s}}" -> "š").
 * Braces inside math segments ($...$, $$...$$, \(...\), \[...\], \begin..\end)
 * are preserved so formulas such as "$\mathcal{O}(n^{2})$" stay intact.
 */
export function stripLatexBraces(text: string): string {
  if (!text || typeof text !== 'string') return '';
  if (!/[{}\\]/.test(text)) return text.trim();
  if (!/[$\\]/.test(text)) return text.replace(/[{}]/g, '').trim();

  let result = '';
  let lastIndex = 0;
  text.replace(MATH_BLOCK_REGEX, (match: string, ...args: unknown[]) => {
    const offset = args[args.length - 2] as number;
    result += decodeLatexOutsideMath(text.slice(lastIndex, offset));
    result += match;
    lastIndex = offset + match.length;
    return match;
  });
  result += decodeLatexOutsideMath(text.slice(lastIndex));
  return result.trim();
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
  cleaned = convertSubSupTagsToUnicode(cleaned);

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
  // (inline formatting tags are dropped without inserting whitespace)
  cleaned = cleaned.replace(INLINE_FORMAT_TAG_REGEX, '');
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

export function extractYearFromDate(
  dateStr?: string | null,
): number | undefined {
  if (!dateStr || typeof dateStr !== 'string') return undefined;
  const match = dateStr.match(/\b(1\d{3}|20\d{2})\b/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Normalizes a page range:
 * - "--", en dash, em dash, minus and other dash variants → "-"
 * - Expands Medline-style abbreviated ranges ("857-63" → "857-863")
 *   only when the abbreviated end would otherwise be smaller than the start.
 */
export function normalizePageRange(pages?: string | null): string | undefined {
  if (!pages || typeof pages !== 'string') return undefined;
  let cleaned = pages
    .trim()
    .replace(/\s*(?:--+|[\u2010-\u2015\u2212])\s*/g, '-')
    .replace(/\s*-\s*/g, '-');
  cleaned = cleaned.replace(
    /\b(\d+)-(\d+)\b/g,
    (m, start: string, end: string) => {
      if (end.length >= start.length) return m;
      const expanded = start.slice(0, start.length - end.length) + end;
      return parseInt(expanded, 10) > parseInt(start, 10)
        ? `${start}-${expanded}`
        : m;
    },
  );
  return cleaned || undefined;
}

// Bibliographic Item Types

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
  notes?: Array<string | { content?: string }>;
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
 * Infers the probable itemType for a PDF that has no DOI, arXiv ID,
 * or other authoritative identifier, by applying deterministic text heuristics
 * on metadata signals extracted from PDF (title, notes, conference name, etc.).
 *
 * Returns undefined when no signal is strong enough — the caller should fall
 * back to the pipeline default (`journalArticle`).
 *
 * Heuristic tiers (highest confidence first):
 *  1. ISBN present → book or bookSection
 *  2. conferenceName / bookTitle from structural signals → conferencePaper / bookSection
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

  // Tier 1: ISBN present → book-class document
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

  // Tier 2: Structural venue signals
  if (signals.conferenceName) {
    return {
      itemType: 'conferencePaper',
      confidence: 0.87,
      reason: 'structural:conferenceName',
    };
  }

  if (signals.bookTitle) {
    return {
      itemType: 'bookSection',
      confidence: 0.85,
      reason: 'structural:bookTitle',
    };
  }

  // Tier 3a: Thesis patterns
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

  // Tier 3b: Report patterns
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

  // Tier 3c: Preprint — checked BEFORE conference venue names
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

  // Tier 3d: Conference paper patterns (title/notes only)
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

  // Tier 3f: Dataset patterns
  const DATASET_TITLE =
    /\b(dataset|data\s+set|benchmark\s+dataset|corpus|annotated\s+(corpus|dataset)|knowledge\s+base|data\s+paper)\b/i;

  if (DATASET_TITLE.test(titleLower)) {
    return { itemType: 'dataset', confidence: 0.78, reason: 'dataset:title' };
  }

  // Tier 3g: Presentation patterns
  const PRES_TITLE =
    /\b(tutorial|keynote(\s+talk)?|invited\s+talk|slide|presentation)\b/i;

  if (PRES_TITLE.test(titleLower)) {
    return {
      itemType: 'presentation',
      confidence: 0.72,
      reason: 'presentation:title',
    };
  }

  // Tier 4: Filename last-resort
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
  .filter((t) => t.isBibliographic)
  .map((t) => t.itemType);

export const SPECIAL_ITEM_TYPES = Object.values(SCHEMA_V42_DATA.itemTypes)
  .filter((t) => t.isSpecial)
  .map((t) => t.itemType) as ['attachment', 'note', 'annotation'];

export const CANONICAL_ITEM_TYPES = new Set<string>(
  Object.keys(SCHEMA_V42_DATA.itemTypes),
);

export function normalizeItemType(type?: string | null): string {
  return normalizeCanonicalItemType(type, SCHEMA_V42_DATA.itemTypes);
}

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

// Metadata trust guards

const TITLE_SIMILARITY_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'and',
  'or',
  'in',
  'on',
  'for',
  'to',
  'with',
  'by',
  'at',
  'from',
  'via',
]);

function tokenizeTitleForSimilarity(title: string): string[] {
  return (decodeHtmlEntities(title) || title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
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

/** Minimum similarity for accepting a title-search hit from an external provider. */
export const TITLE_MATCH_THRESHOLD = 0.85;

const BOT_CHALLENGE_TITLE_RE =
  /client challenge|just a moment|attention required|access denied|are you a robot|verify you are human|captcha|security check|ddos-guard|please wait|cloudflare|bot verification|request blocked|unusual traffic/i;
const BOT_CHALLENGE_HTML_RE =
  /cf-challenge|_cf_chl|challenge-platform|perimeterx|px-captcha|datadome|captcha-delivery|cf-browser-verification/i;

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
