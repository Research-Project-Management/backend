import {
  CreatorType,
  CreatorInput,
  IdentifierScheme,
  ParsedCreator,
} from '../types/bibliographic.types';

export { ParsedCreator };

/**
 * Whole-word keywords that mark a creator string as an organization
 * (Zotero single-field creator, fieldMode = 1). Deliberately excludes short
 * tokens that collide with person names (e.g. "who", "mit", "meta").
 */
export const INSTITUTION_KEYWORDS = [
  'university',
  'universities',
  'universität',
  'université',
  'universidad',
  'universidade',
  'università',
  'institute',
  'institutes',
  'institution',
  'institutions',
  'consortium',
  'consortia',
  'collaboration',
  'collaborations',
  'committee',
  'committees',
  'organization',
  'organizations',
  'organisation',
  'organisations',
  'association',
  'associations',
  'society',
  'societies',
  'foundation',
  'group',
  'groups',
  'team',
  'council',
  'agency',
  'agencies',
  'department',
  'departments',
  'ministry',
  'laboratory',
  'laboratories',
  'center',
  'centers',
  'centre',
  'centres',
  'network',
  'initiative',
  'working party',
  'investigators',
  'commission',
  'corporation',
  'hospital',
  'hospitals',
  'inc',
  'llc',
  'ltd',
  'openai',
  'deepmind',
  'anthropic',
  'google',
  'microsoft',
  'cern',
  'nasa',
  'ieee',
];

const INSTITUTION_REGEX = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:${INSTITUTION_KEYWORDS.map((kw) =>
    kw.replace(/\s+/g, '\\s+'),
  ).join('|')})(?=$|[^\\p{L}\\p{N}])`,
  'iu',
);

/**
 * Returns true when the (already cleaned) creator string looks like an
 * organization rather than a person (whole-word keyword match).
 */
export function isInstitutionName(name?: string | null): boolean {
  if (!name || typeof name !== 'string') return false;
  return INSTITUTION_REGEX.test(name);
}

/** Lowercase name particles (only matched when written in lowercase). */
const PREFIX_PARTICLES = new Set([
  'von',
  'van',
  'de',
  'del',
  'della',
  'der',
  'den',
  'des',
  'da',
  'das',
  'do',
  'dos',
  'di',
  'du',
  'la',
  'le',
  'ter',
  'ten',
  'zu',
  'al',
  'el',
  'bin',
  'ibn',
]);

const GENERATIONAL_SUFFIX_REGEX = /^(?:Jr\.?|Sr\.?|II|III|IV|V|Esq\.?)$/i;

/** Surname beginning with a name particle, e.g. "van der Berg", "De Silva". */
const PARTICLE_SURNAME_REGEX =
  /^(?:(?:von|van|de|del|della|der|den|des|da|das|do|dos|di|du|la|le|ter|ten|zu|al|el|bin|ibn|Von|Van|De|Del|Della|Der|Den|Des|Da|Das|Dos|Di|Du|Ter|Ten)\s+)+\S/;

/**
 * Detects Vancouver / Medline style names: "Smith JA", "van der Berg AB",
 * "O'Neil P". The trailing token must be 1-3 uppercase initials without dots
 * and every surname token must be a lowercase particle or a capitalized word
 * containing at least one lowercase letter.
 */
export function isVancouverName(raw?: string | null): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const tokens = raw.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  const initials = tokens[tokens.length - 1];
  if (!/^[A-Z]{1,3}$/.test(initials)) return false;
  if (/^(?:II|III|IV)$/.test(initials)) return false;
  const surname = tokens.slice(0, -1);
  let hasCore = false;
  for (const t of surname) {
    if (PREFIX_PARTICLES.has(t)) continue;
    if (!/^\p{Lu}[\p{L}'’-]*$/u.test(t) || !/\p{Ll}/u.test(t)) return false;
    hasCore = true;
  }
  return hasCore;
}

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

  // Strip trailing comma-delimited professional degrees / fellowships:
  // e.g. "John Smith, PhD", "Smith, J. A., MD". Only stripped when the text
  // before the comma already contains a full name (space or comma), so that
  // inverted initials like "Wong, M.D." are NOT mistaken for a degree.
  // Generational suffixes (Jr., Sr., III) are kept.
  const TRAILING_DEGREE_REGEX =
    /,\s*(?:Ph\.?\s?D\.?|PHD|M\.?D\.?|M\.?Sc\.?|MSc|M\.?S\.?|B\.?Sc\.?|BSc|B\.?S\.?|MBA|MPH|D\.?Phil\.?|DPhil|FRS|FRSE|FIEEE|OBE|CBE)\s*$/;
  for (let guard = 0; guard < 4; guard++) {
    const m = cleaned.match(TRAILING_DEGREE_REGEX);
    if (!m || m.index === undefined) break;
    const prefix = cleaned.slice(0, m.index).trim();
    if (!/[\s,]/.test(prefix)) break;
    cleaned = prefix;
  }

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
    //    Organizations ("Bill & Melinda Gates Foundation") are never split.
    if (
      (/\s+and\s+/i.test(line) || /\s+&\s+/.test(line)) &&
      !(isInstitutionName(line) && !line.includes(','))
    ) {
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

      // Vancouver / Medline lists: "Smith JA, Jones B, van der Berg AB"
      if (rawTokens.every((t) => isVancouverName(t))) {
        result.push(...rawTokens);
        continue;
      }

      if (rawTokens.length === 2) {
        // Disambiguate: Is it "LastName, FirstName" (1 author) OR "FirstName1 LastName1, FirstName2 LastName2" (2 authors)?
        const firstHasSpace =
          rawTokens[0].includes(' ') &&
          !PARTICLE_SURNAME_REGEX.test(rawTokens[0]);
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
          if (surname.includes(' ') && !PARTICLE_SURNAME_REGEX.test(surname)) {
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

  if (isInstitutionName(cleaned)) {
    return {
      orderIndex,
      creatorType,
      fieldMode: 1,
      firstName: '',
      lastName: cleaned,
      fullName: cleaned,
    };
  }

  // Vancouver / Medline: "Smith JA" → lastName "Smith", firstName "J. A."
  if (!cleaned.includes(',') && isVancouverName(cleaned)) {
    const vTokens = cleaned.split(/\s+/);
    const initials = vTokens[vTokens.length - 1];
    const lastName = vTokens.slice(0, -1).join(' ');
    const firstName = initials
      .split('')
      .map((c) => `${c}.`)
      .join(' ');
    return {
      orderIndex,
      creatorType,
      fieldMode: 0,
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
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
    PREFIX_PARTICLES.has(tokens[tokens.length - 2])
  ) {
    // Lowercase particles attach to the surname: "Vincent van Gogh",
    // "Juan de la Cruz", "Ludwig van der Rohe". Capitalized forms ("Le", "Van")
    // are left alone since they are frequently given/middle names.
    splitIndex = tokens.length - 2;
    while (splitIndex > 1 && PREFIX_PARTICLES.has(tokens[splitIndex - 1])) {
      splitIndex--;
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
      ...(c.fieldMode !== undefined ? { fieldMode: c.fieldMode } : {}),
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
 * Strips LaTeX curly braces (e.g. "{Deep Learning}" -> "Deep Learning").
 * Braces inside math segments ($...$, $$...$$, \(...\), \[...\], \begin..\end)
 * are preserved so formulas such as "$\mathcal{O}(n^{2})$" stay intact.
 */
export function stripLatexBraces(text: string): string {
  if (!text || typeof text !== 'string') return '';
  if (!/[{}]/.test(text)) return text.trim();
  if (!/[$\\]/.test(text)) return text.replace(/[{}]/g, '').trim();

  let result = '';
  let lastIndex = 0;
  text.replace(MATH_BLOCK_REGEX, (match: string, ...args: unknown[]) => {
    const offset = args[args.length - 2] as number;
    result += text.slice(lastIndex, offset).replace(/[{}]/g, '');
    result += match;
    lastIndex = offset + match.length;
    return match;
  });
  result += text.slice(lastIndex).replace(/[{}]/g, '');
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

  // ── Tier 2: Structural venue signals ──────────────────────────────────────
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
    return trimmed;
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

  // Normalize OCR / publisher spaced hyphens (e.g. "Large - Scale" -> "Large-Scale")
  // Requires at least 2 letters on both sides so legitimate subtitles like "Part A - Methods" are preserved.
  cleaned = cleaned.replace(/(\b\p{L}{2,})\s+-\s+(\p{L}{2,}\b)/gu, '$1-$2');

  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  // normalizeAcademicTitleCase is a no-op unless the title is entirely uppercase.
  cleaned = normalizeAcademicTitleCase(cleaned);
  if (cleaned.length > 1000) {
    cleaned = cleaned.substring(0, 1000).trim();
  }
  return cleaned;
}

// ─── Metadata trust guards ──────────────────────────────────────────────────

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
 * Derives a DOI deterministically from well-known publisher URL patterns,
 * so that metadata can be resolved even when the landing page is blocked.
 */
export function deriveDoiFromPublisherUrl(rawUrl?: string | null): string {
  if (!rawUrl) return '';
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return '';
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = decodeURIComponent(parsed.pathname);

  // doi.org / dx.doi.org
  if (host === 'doi.org' || host === 'dx.doi.org') {
    return normalizeDoi(path.replace(/^\//, '')) || '';
  }

  // Nature portfolio: nature.com/articles/<id>
  if (host === 'nature.com' || host.endsWith('.nature.com')) {
    const m = path.match(/\/articles\/([a-z0-9.-]+?)(?:\.pdf)?\/?$/i);
    if (m && /^[a-z]+\d|^\d/i.test(m[1])) {
      return normalizeDoi(`10.1038/${m[1]}`) || '';
    }
  }

  // Generic: DOI embedded in the URL path (Springer, Wiley, ACM, T&F, SAGE,
  // Frontiers, PLOS, IEEE /doi/, ...). Strip common trailing view suffixes.
  const embedded = path.match(/(10\.\d{4,9}\/[^\s?#]+)/);
  if (embedded) {
    const cleaned = embedded[1]
      .replace(/\/(full|abstract|pdf|epdf|html|fulltext|meta)\/?$/i, '')
      .replace(/\.pdf$/i, '')
      .replace(/\/$/, '');
    return normalizeDoi(cleaned) || '';
  }

  // PLOS / query-string ?id=10.xxxx
  const qid = parsed.searchParams.get('id') || parsed.searchParams.get('doi');
  if (qid && /^10\.\d{4,9}\//.test(qid)) return normalizeDoi(qid) || '';

  return '';
}
