import {
  CreatorType,
  CreatorInput,
  IdentifierScheme,
} from '../types/items.types';

// ── Creator & Author Parsing ────────────────────────────────────────────────

export interface ParsedCreator {
  orderIndex: number;
  creatorType: CreatorType;
  firstName: string;
  lastName: string;
  fullName: string;
}

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

/**
 * Splits a composite string of authors separated by ';', ' and ', ' & ', or newlines.
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
    if (line.includes(';')) {
      result.push(
        ...line
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (/\s+and\s+/i.test(line)) {
      result.push(
        ...line
          .split(/\s+and\s+/i)
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (/\s+&\s+/.test(line)) {
      result.push(
        ...line
          .split(/\s+&\s+/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if ((line.match(/,/g) || []).length >= 2) {
      result.push(
        ...line
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else {
      result.push(line);
    }
  }

  return result;
}

/**
 * Deterministically parses an author string into structured creator fields.
 * Handles:
 * - Institutional names (OpenAI, University of Cambridge, etc.)
 * - "LastName, FirstName MiddleName"
 * - "FirstName MiddleName LastName"
 * - Mononyms ("Aristotle", "Plato")
 */
export function parseCreatorString(
  rawName: string,
  orderIndex: number = 0,
  creatorType: CreatorType = 'author',
): ParsedCreator {
  const trimmed = (rawName || '').trim().replace(/\s+/g, ' ');

  if (!trimmed) {
    return {
      orderIndex,
      creatorType,
      firstName: '',
      lastName: '',
      fullName: '',
    };
  }

  const lower = trimmed.toLowerCase();
  const isInstitution = INSTITUTION_KEYWORDS.some((kw) =>
    new RegExp(`\\b${kw}\\b`, 'i').test(lower),
  );

  if (isInstitution) {
    return {
      orderIndex,
      creatorType,
      firstName: '',
      lastName: trimmed,
      fullName: trimmed,
    };
  }

  // Comma separated: "LastName, FirstName MiddleName"
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map((p) => p.trim());
    const lastName = parts[0] || '';
    const firstName = parts.slice(1).join(' ') || '';
    const fullName = firstName ? `${firstName} ${lastName}` : lastName;
    return {
      orderIndex,
      creatorType,
      firstName,
      lastName,
      fullName,
    };
  }

  // Space separated: "FirstName [MiddleName...] LastName"
  const tokens = trimmed.split(' ');
  if (tokens.length === 1) {
    // Single word name / mononym (e.g. "Plato", "Aristotle")
    return {
      orderIndex,
      creatorType,
      firstName: '',
      lastName: tokens[0],
      fullName: tokens[0],
    };
  }

  // Handle prefix particles like "von Neumann", "van Beethoven", "de Fermat"
  let splitIndex = tokens.length - 1;
  if (
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

  return {
    orderIndex,
    creatorType,
    firstName,
    lastName,
    fullName: trimmed,
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

/**
 * Sanitizes and normalizes an academic paper abstract.
 * 1. Pre-processes JATS XML (<jats:...>), PubMed (<AbstractText>), and HTML tags before stripping.
 * 2. Decodes HTML entities and strips remaining XML/HTML tags and LaTeX braces.
 * 3. Strips leading "Abstract", "ABSTRACT", "Summary", "Graphical Abstract" prefixes.
 * 4. Removes repeated year extraction artifacts (e.g. "(2012)(2013)(2014)(2015)(2016)(2017).").
 * 5. Removes trailing author contribution, publisher copyright banners (Elsevier, Springer, Wiley, MDPI, IEEE, ACM), and index terms noise.
 * 6. Unwraps single hard line-breaks within paragraphs while preserving double-newline paragraph separation.
 * 7. Normalizes punctuation spacing and fixes hyphenated words broken across line wraps ("stochas- tic" -> "stochastic").
 */
export function cleanAbstractText(text?: string | null): string | undefined {
  if (!text || typeof text !== 'string') return undefined;

  // 0. Fix hyphenated words broken across line wraps before tag/whitespace stripping
  let cleaned = text.replace(
    /([a-zA-Z]{2,})-\s*\r?\n\s*([a-zA-Z]{2,})/g,
    '$1$2',
  );

  // 1. Structured JATS / PubMed / HTML Pre-Processing
  // Remove abstract headings inside JATS/HTML tags
  cleaned = cleaned.replace(
    /<(?:jats:)?title[^>]*>\s*(?:Abstract|Summary|Résumé|Overview)\s*<\/(?:jats:)?title>/gi,
    '',
  );
  // Convert structured section titles into formatted headings (e.g. "Background:", "Methods:")
  cleaned = cleaned.replace(
    /<(?:jats:)?title[^>]*>(.*?)<\/(?:jats:)?title>/gi,
    '\n\n$1: ',
  );
  // PubMed structured abstract tags: <AbstractText Label="BACKGROUND">...</AbstractText>
  cleaned = cleaned.replace(
    /<AbstractText\s+[^>]*Label=["']([^"']+)["'][^>]*>([\s\S]*?)<\/AbstractText>/gi,
    '\n\n$1: $2',
  );
  // Convert paragraph break tags to newlines
  cleaned = cleaned.replace(/<\/(?:jats:)?p>/gi, '\n\n');
  cleaned = cleaned.replace(/<(?:jats:)?p[^>]*>/gi, '');
  cleaned = cleaned.replace(/<br\s*\/?>/gi, '\n');
  cleaned = cleaned.replace(/<\/(?:jats:)?sec>/gi, '\n\n');

  // Strip remaining XML/HTML tags, decode entities, and strip LaTeX braces
  cleaned = stripXmlAndHtmlTags(cleaned);
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
  cleaned = cleaned.replace(/(?:\((?:19|20)\d{2}\)\s*){2,}\.?/g, '');
  cleaned = cleaned.replace(/(?:\[(?:19|20)\d{2}\]\s*){2,}\.?/g, '');
  cleaned = cleaned.replace(/\((?:(?:19|20)\d{2}[,\s;]*){3,}\)\.?/g, '');

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

export const BIBLIOGRAPHIC_ITEM_TYPES = [
  'artwork',
  'audioRecording',
  'bill',
  'blogPost',
  'book',
  'bookSection',
  'case',
  'computerProgram',
  'conferencePaper',
  'dataset',
  'dictionaryEntry',
  'document',
  'email',
  'encyclopediaArticle',
  'film',
  'forumPost',
  'hearing',
  'instantMessage',
  'interview',
  'journalArticle',
  'letter',
  'magazineArticle',
  'manuscript',
  'map',
  'newspaperArticle',
  'patent',
  'podcast',
  'preprint',
  'presentation',
  'radioBroadcast',
  'report',
  'standard',
  'statute',
  'thesis',
  'tvBroadcast',
  'videoRecording',
  'webpage',
] as const;

export const SPECIAL_ITEM_TYPES = ['attachment', 'note', 'annotation'] as const;

export const CANONICAL_ITEM_TYPES = new Set<string>([
  ...BIBLIOGRAPHIC_ITEM_TYPES,
  ...SPECIAL_ITEM_TYPES,
]);

const ITEM_TYPE_ALIASES: Record<string, string> = {
  paper: 'journalArticle',
  article: 'journalArticle',
  journal_article: 'journalArticle',
  'journal-article': 'journalArticle',
  conference_paper: 'conferencePaper',
  'conference-paper': 'conferencePaper',
  proceeding: 'conferencePaper',
  proceedings: 'conferencePaper',
  inproceedings: 'conferencePaper',
  book_section: 'bookSection',
  'book-section': 'bookSection',
  chapter: 'bookSection',
  incollection: 'bookSection',
  inbook: 'bookSection',
  dissertation: 'thesis',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  techreport: 'report',
  software: 'computerProgram',
  code: 'computerProgram',
  program: 'computerProgram',
  data: 'dataset',
  spec: 'standard',
  specification: 'standard',
  rfc: 'standard',
  web: 'webpage',
  website: 'webpage',
  online: 'webpage',
  audio: 'audioRecording',
  sound: 'audioRecording',
  video: 'videoRecording',
  movie: 'film',
  tv: 'tvBroadcast',
  radio: 'radioBroadcast',
  blog: 'blogPost',
  forum: 'forumPost',
  mail: 'email',
  message: 'instantMessage',
  talk: 'presentation',
  slide: 'presentation',
  slides: 'presentation',
};

export function normalizeItemType(type?: string | null): string {
  if (!type) return 'journalArticle';
  const trimmed = type.trim();
  if (CANONICAL_ITEM_TYPES.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (ITEM_TYPE_ALIASES[lower]) return ITEM_TYPE_ALIASES[lower];
  for (const canonical of CANONICAL_ITEM_TYPES) {
    if (canonical.toLowerCase() === lower) return canonical;
  }
  return 'journalArticle';
}
export const normalizeLibraryItemType = normalizeItemType;
