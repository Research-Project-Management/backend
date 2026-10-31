import { IdentifierScheme } from '@/modules/library/core/types/bibliographic.types';
import { parseCreatorString } from './author.domain';

// Identifier Normalization

function hasBalancedOuterPair(
  str: string,
  openChar: string,
  closeChar: string,
): boolean {
  if (!str.startsWith(openChar) || !str.endsWith(closeChar) || str.length < 2) {
    return false;
  }
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === openChar) depth++;
    else if (str[i] === closeChar) depth--;
    if (depth === 0 && i < str.length - 1) {
      return false;
    }
    if (depth < 0) {
      return false;
    }
  }
  return depth === 0;
}

export function stripSurroundingPunctuation(raw: string): string {
  let clean = raw.trim();
  let prev = '';
  while (clean !== prev) {
    prev = clean;
    // Strip trailing sentence punctuation (period, comma, semicolon, colon)
    clean = clean.replace(/[.,;:]+$/, '').trim();
    // Strip matching outer parentheses, brackets, angle brackets, or quotes
    if (
      hasBalancedOuterPair(clean, '(', ')') ||
      hasBalancedOuterPair(clean, '[', ']') ||
      (clean.startsWith('<') && clean.endsWith('>')) ||
      (clean.startsWith('"') && clean.endsWith('"')) ||
      (clean.startsWith("'") && clean.endsWith("'"))
    ) {
      clean = clean.slice(1, -1).trim();
    }
    const openParens = (clean.match(/\(/g) || []).length;
    const closeParens = (clean.match(/\)/g) || []).length;
    const openBrackets = (clean.match(/\[/g) || []).length;
    const closeBrackets = (clean.match(/\]/g) || []).length;

    // Strip unbalanced trailing closing parens/brackets
    if (clean.endsWith(')') && closeParens > openParens) {
      clean = clean.slice(0, -1).trim();
    }
    if (clean.endsWith(']') && closeBrackets > openBrackets) {
      clean = clean.slice(0, -1).trim();
    }
    // Strip unbalanced leading opening parens/brackets
    if (clean.startsWith('(') && openParens > closeParens) {
      clean = clean.slice(1).trim();
    }
    if (clean.startsWith('[') && openBrackets > closeBrackets) {
      clean = clean.slice(1).trim();
    }
  }
  return clean;
}

export function normalizeDoi(doi?: string | null): string | undefined {
  if (!doi || typeof doi !== 'string') return undefined;
  let clean = stripSurroundingPunctuation(doi);

  // Nature article URL: nature.com/articles/<slug>
  const natureMatch = clean.match(
    /^https?:\/\/(?:www\.)?nature\.com\/articles\/([a-z0-9._-]+)(?:[?#].*)?$/i,
  );
  if (natureMatch && natureMatch[1]) {
    return `10.1038/${natureMatch[1].replace(/[.,;:]+$/, '')}`;
  }

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
    return biorxivMatch[1].replace(/v\d+$/, '').replace(/[.,;:]+$/, '');

  // PLOS article URL
  const plosMatch = clean.match(
    /^https?:\/\/journals\.plos\.org\/[^/]+\/article\?(?:[^#]*&)?id=(10\.\d{4,9}\/[^&#\s]+)/i,
  );
  if (plosMatch && plosMatch[1])
    return decodeURIComponent(plosMatch[1]).replace(/[.,;:]+$/, '');

  // ACL Anthology URL: aclanthology.org/<id> -> 10.18653/v1/<id>
  const aclMatch = clean.match(
    /^https?:\/\/(?:www\.)?aclanthology\.org\/([a-zA-Z0-9.-]+?)(?:\.pdf)?\/?(?:[?#].*)?$/i,
  );
  if (
    aclMatch &&
    aclMatch[1] &&
    !['anthology', 'events', 'venues', 'sigs', 'people', 'info'].includes(
      aclMatch[1].toLowerCase(),
    )
  ) {
    return `10.18653/v1/${aclMatch[1].replace(/[.,;:]+$/, '')}`;
  }

  // Embedded /doi/, /article/, /chapter/, or /book/ in publisher URLs (linear-time, ReDoS-safe)
  let extractedFromEmbeddedUrl = false;
  if (/^https?:\/\/[^/?#]+\//i.test(clean)) {
    const withoutQueryHash = clean.replace(/[?#].*$/, '');
    const embeddedMatch = withoutQueryHash.match(
      /\/(?:doi|article|chapter|book)\/(?:abs\/|full\/|epdf\/|pdf\/)?(10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+)/i,
    );
    if (embeddedMatch && embeddedMatch[1]) {
      clean = embeddedMatch[1]
        .replace(/\/+$/, '')
        .replace(/\.(?:pdf|html)$/i, '')
        .replace(/\/(?:full|abstract|pdf|epdf|html|fulltext|meta)\/?$/i, '');
      extractedFromEmbeddedUrl = true;
    }
  }
  if (!extractedFromEmbeddedUrl) {
    clean = clean.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
  }

  clean = stripSurroundingPunctuation(clean);

  const match = clean.match(/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+$/);
  if (!match) {
    const embedded = clean.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+/);
    if (!embedded) return undefined;
    const extracted = stripSurroundingPunctuation(embedded[0])
      .replace(/\/(?:full|abstract|pdf|epdf|html|fulltext|meta)\/?$/i, '')
      .replace(/\.pdf$/i, '');
    if (/^10\.48550\/arXiv\./.test(extracted)) {
      return `10.48550/arXiv.${extracted.slice('10.48550/arXiv.'.length)}`;
    }
    return extracted.toLowerCase();
  }

  if (/^10\.48550\/arXiv\./.test(clean)) {
    return `10.48550/arXiv.${clean.slice('10.48550/arXiv.'.length)}`;
  }

  return clean.toLowerCase();
}

export function normalizeArxivId(
  arxiv?: string | null,
  options?: { stripVersion?: boolean },
): string | undefined {
  if (!arxiv || typeof arxiv !== 'string') return undefined;
  let clean = stripSurroundingPunctuation(arxiv);

  // Strip accidental category brackets if present, e.g. "1512.03385v1 [cs.CV]" or "1512.03385v1[cs.CV]"
  clean = clean.replace(/\s*\[[^\]]+\]\s*$/, '').trim();

  // Also support arXiv DOI format `10.48550/arXiv.2305.18290v2`
  clean = clean.replace(
    /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\.48550\/arxiv\./i,
    '',
  );

  clean = clean.replace(
    /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf|html)\/|arxiv:\s*)/i,
    '',
  );
  clean = clean.replace(/\.(?:pdf|html)$/i, '');
  clean = stripSurroundingPunctuation(clean);
  if (options?.stripVersion) {
    clean = clean.replace(/v\d+$/i, '');
  }

  const newFormat = clean.match(/^\d{4}\.\d{4,5}(?:v\d+)?$/i);
  if (newFormat) return newFormat[0];

  const oldFormat = clean.match(/^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/i);
  if (oldFormat) {
    const val = oldFormat[0].toLowerCase();
    return options?.stripVersion ? val.replace(/v\d+$/i, '') : val;
  }

  return undefined;
}

export function normalizePmid(
  pmid?: string | number | null,
): string | undefined {
  if (pmid === null || pmid === undefined) return undefined;
  const str = stripSurroundingPunctuation(String(pmid))
    .replace(/^(?:pmid:\s*|https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/)/i, '')
    .replace(/\/$/, '');
  const cleaned = stripSurroundingPunctuation(str);
  return /^\d{1,9}$/.test(cleaned) ? cleaned : undefined;
}

export function normalizePmcid(pmcid?: string | null): string | undefined {
  if (!pmcid || typeof pmcid !== 'string') return undefined;
  const clean = stripSurroundingPunctuation(pmcid)
    .toUpperCase()
    .replace(
      /^(?:PMCID:\s*|PMC:\s*|HTTPS?:\/\/(?:WWW\.)?NCBI\.NLM\.NIH\.GOV\/PMC\/ARTICLES\/)/i,
      '',
    )
    .replace(/\/$/, '');
  const digits = stripSurroundingPunctuation(clean).replace(/^PMC/, '');
  return /^\d{1,9}$/.test(digits) ? `PMC${digits}` : undefined;
}

/**
 * Validates ISBN-10 (mod 11) or ISBN-13 (mod 10) check digit.
 */
export function isValidIsbnChecksum(digits: string): boolean {
  const clean = digits.replace(/[-\s]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(clean)) {
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += (10 - i) * parseInt(clean[i], 10);
    }
    const check = clean[9] === 'X' ? 10 : parseInt(clean[9], 10);
    sum += check;
    return sum % 11 === 0;
  }
  if (/^(?:978|979)\d{10}$/.test(clean)) {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += parseInt(clean[i], 10) * (i % 2 === 0 ? 1 : 3);
    }
    const check = (10 - (sum % 10)) % 10;
    return check === parseInt(clean[12], 10);
  }
  return false;
}

/**
 * Converts a 10-digit ISBN into its canonical 13-digit `978...` representation.
 */
export function convertIsbn10To13(isbn10: string): string | undefined {
  const clean = isbn10.replace(/[-\s]/g, '').toUpperCase();
  if (!/^\d{9}[\dX]$/.test(clean)) return undefined;
  const stem = `978${clean.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(stem[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return `${stem}${check}`;
}

export function normalizeIsbn(
  isbn?: string | null,
  options?: { strictChecksum?: boolean; toIsbn13?: boolean },
): string | undefined {
  if (!isbn || typeof isbn !== 'string') return undefined;
  const stripped = stripSurroundingPunctuation(isbn);
  const validateCandidate = (rawDigits: string): string | undefined => {
    const digits = rawDigits.replace(/[-\s]/g, '').toUpperCase();
    if (/^(?:978|979)\d{10}$/.test(digits) || /^\d{9}[\dX]$/.test(digits)) {
      if (options?.strictChecksum && !isValidIsbnChecksum(digits)) {
        return undefined;
      }
      if (options?.toIsbn13 && digits.length === 10) {
        return convertIsbn10To13(digits);
      }
      return digits;
    }
    return undefined;
  };

  const direct = validateCandidate(
    stripped.replace(/^(?:urn:isbn:|isbn(?:-1[03])?:?\s*)/i, ''),
  );
  if (direct) return direct;

  if (
    /^(?:https?:\/\/|doi:|10\.\d{4,9}\/|arxiv:|pmid:|pmcid?:|urn:issn:|e?-?issn\b)/i.test(
      stripped,
    )
  ) {
    return undefined;
  }

  const segments = stripped
    .split(/[\r\n;,|/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const seg of segments) {
    const withoutQualifiers = stripSurroundingPunctuation(
      seg
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(
          /\b(?:urn:isbn:|isbn(?:-1[03])?:?|hardcover|paperback|pbk|hbk|ebk|ebook|e-book|print|electronic|online|cloth|alk\.?\s*paper)\b/gi,
          ' ',
        ),
    );
    const cleanedSeg = validateCandidate(withoutQualifiers);
    if (cleanedSeg) return cleanedSeg;

    const tokenMatch = withoutQualifiers.match(
      /(?:^|[^\d])(97[89][-\s]?(?:\d[-\s]?){9}\d|(?:\d[-\s]?){9}[\dXx])(?:$|[^\d])/i,
    );
    if (tokenMatch) {
      const matched = validateCandidate(tokenMatch[1]);
      if (matched) return matched;
    }
  }
  return undefined;
}

/**
 * Validates ISSN (ISO 3297 modulo-11) check digit.
 */
export function isValidIssnChecksum(clean: string): boolean {
  if (!clean || typeof clean !== 'string') return false;
  const digits = clean.replace(/[-\s]/g, '').toUpperCase();
  if (!/^\d{7}[\dX]$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    sum += (8 - i) * parseInt(digits[i], 10);
  }
  const check = digits[7] === 'X' ? 10 : parseInt(digits[7], 10);
  sum += check;
  return sum % 11 === 0;
}

export function normalizeIssn(issn?: string | null): string | undefined {
  if (!issn || typeof issn !== 'string') return undefined;
  const stripped = stripSurroundingPunctuation(issn);
  const direct = stripped
    .replace(/^(?:urn:issn:|e?-?issn:?\s*)/i, '')
    .replace(/[-\s]/g, '')
    .toUpperCase();
  if (/^\d{7}[\dX]$/.test(direct)) {
    return `${direct.slice(0, 4)}-${direct.slice(4)}`;
  }

  if (
    /^(?:https?:\/\/|doi:|10\.\d{4,9}\/|arxiv:|pmid:|pmcid?:|urn:isbn:|isbn\b)/i.test(
      stripped,
    )
  ) {
    return undefined;
  }

  const segments = stripped
    .split(/[\r\n;,|/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const seg of segments) {
    const withoutQualifiers = stripSurroundingPunctuation(
      seg
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(
          /\b(?:urn:issn:|e?-?issn:?|p-issn:?|print|electronic|online|linking)\b/gi,
          ' ',
        ),
    );
    const cand = withoutQualifiers.replace(/[-\s]/g, '').toUpperCase();
    if (/^\d{7}[\dX]$/.test(cand)) {
      return `${cand.slice(0, 4)}-${cand.slice(4)}`;
    }
    if (!/\d{9,}/.test(cand)) {
      const m = withoutQualifiers.match(
        /(?:^|[^\d-])(\d{4})[-\s](\d{3}[\dXx])(?:$|[^\d-])/i,
      );
      if (m) {
        return `${m[1]}-${m[2].toUpperCase()}`;
      }
    }
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

  // ACL Anthology: aclanthology.org/<id> -> DOI 10.18653/v1/<id>
  if (host === 'aclanthology.org') {
    const aclMatch = path.match(/\/([a-zA-Z0-9.-]+?)(?:\.pdf)?\/?$/i);
    if (
      aclMatch &&
      !['anthology', 'events', 'venues', 'sigs', 'people', 'info'].includes(
        aclMatch[1].toLowerCase(),
      )
    ) {
      return normalizeDoi(`10.18653/v1/${aclMatch[1]}`) || '';
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

/**
 * Derives the first-submission year from an arXiv identifier.
 * New style `YYMM.NNNNN` => 20YY. Old style `cat/YYMMNNN` => 19YY if YY >= 91.
 * Returns undefined for impossible months or future years.
 */
export function yearFromArxivId(id?: string | null): number | undefined {
  if (!id) return undefined;
  const now = new Date().getFullYear();

  let m = id.match(/^(\d{2})(\d{2})\.\d{4,5}/);
  if (m) {
    const month = parseInt(m[2], 10);
    const year = 2000 + parseInt(m[1], 10);
    return month >= 1 && month <= 12 && year <= now ? year : undefined;
  }

  m = id.match(/\/(\d{2})(\d{2})\d{3}/);
  if (m) {
    const month = parseInt(m[2], 10);
    const yy = parseInt(m[1], 10);
    const year = yy >= 91 ? 1900 + yy : 2000 + yy;
    return month >= 1 && month <= 12 && year <= now ? year : undefined;
  }
  return undefined;
}

/**
 * Resolves known academic and open repository URLs directly to their PDF stream URL using regex.
 * Zero API calls, 0ms latency.
 */
export function deriveDirectPdfUrl(rawUrl: string): string | undefined {
  if (!rawUrl || typeof rawUrl !== 'string') return undefined;
  const url = rawUrl.trim();

  // 1. Direct PDF URL
  if (/\.pdf(?:\?.*)?$/i.test(url)) {
    return url;
  }

  // 2. arXiv: https://arxiv.org/abs/1706.03762, https://arxiv.org/abs/hep-th/9901001, or https://arxiv.org/html/1706.03762
  const arxivMatch = url.match(
    /(?:arxiv\.org\/(?:abs|html)\/|arxiv:)((?:[a-z-]+(?:\.[a-z]{2})?\/\d{7}|\d{4}\.\d{4,5})v?\d*)/i,
  );
  if (arxivMatch) {
    const cleanArxivId = normalizeArxivId(arxivMatch[1]);
    if (!cleanArxivId) return undefined;
    return `https://arxiv.org/pdf/${cleanArxivId}.pdf`;
  }

  // 3. BioRxiv / MedRxiv: https://www.biorxiv.org/content/10.1101/2023.01.01.522432v1
  const bioRxivMatch = url.match(
    /(?:biorxiv|medrxiv)\.org\/content\/(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+?)(?:\.full|\.abstract)?$/i,
  );
  if (bioRxivMatch) {
    const isMedrxiv = url.includes('medrxiv');
    const domain = isMedrxiv ? 'www.medrxiv.org' : 'www.biorxiv.org';
    return `https://${domain}/content/${bioRxivMatch[1]}.full.pdf`;
  }

  // 4. OpenReview: https://openreview.net/forum?id=XXXX -> https://openreview.net/pdf?id=XXXX
  const openReviewMatch = url.match(
    /openreview\.net\/(?:forum|document)\?id=([a-zA-Z0-9_-]+)/i,
  );
  if (openReviewMatch) {
    return `https://openreview.net/pdf?id=${openReviewMatch[1]}`;
  }

  // 5. ACL Anthology: https://aclanthology.org/2020.acl-main.1/ -> https://aclanthology.org/2020.acl-main.1.pdf
  const aclMatch = url.match(/aclanthology\.org\/([a-zA-Z0-9.-]+)\/?$/i);
  if (aclMatch && !aclMatch[1].endsWith('.pdf')) {
    return `https://aclanthology.org/${aclMatch[1].replace(/\/+$/, '')}.pdf`;
  }

  // 6. PLOS: https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0248823
  const plosMatch = url.match(
    /^https?:\/\/journals\.plos\.org\/([^/]+)\/article\?(?:[^#]*&)?id=(10\.\d{4,9}\/[^&#\s]+)/i,
  );
  if (plosMatch && plosMatch[1] && plosMatch[2]) {
    const journalSlug = plosMatch[1];
    const plosDoi = decodeURIComponent(plosMatch[2]);
    return `https://journals.plos.org/${journalSlug}/article/file?id=${plosDoi}&type=printable`;
  }

  return undefined;
}

/**
 * Normalizes DOI, returning empty string if invalid or absent.
 */
export function cleanDoi(doi?: string | null): string {
  return normalizeDoi(doi) ?? '';
}

/**
 * Checks whether a given string is a valid DOI format.
 */
export function isValidDoi(doi?: string | null): boolean {
  return !!normalizeDoi(doi);
}

/**
 * Centralized extractor for resolving storage fileId from an attachment URL or path.
 * Supports `/api/v1/storage/files/...`, project-scoped `/api/v1/projects/:id/storage/files/...`,
 * and `/api/v1/library/files/...`.
 */
export function extractFileIdFromUrl(url?: string | null): string | null {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(
    /\/api\/v1\/(?:projects\/[^/]+\/)?(?:library\/|storage\/)(?:attachments\/)?files\/([a-zA-Z0-9_-]+)/,
  );
  return match ? match[1] : null;
}

const CITATION_KEY_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'on',
  'in',
  'of',
  'for',
  'and',
  'to',
  'with',
  'by',
  'from',
  'at',
  'as',
  'into',
  'towards',
  'toward',
  'via',
  'using',
]);

/**
 * Generates a canonical BibTeX / BetterBibTeX-style citation key (`lastnameYYYYkeyword`)
 * from item bibliographic metadata.
 */
export function generateCitationKey(metadata: {
  citationKey?: string | null;
  creators?: Array<{
    lastName?: string | null;
    family?: string | null;
    fullName?: string | null;
    name?: string | null;
    fieldMode?: number | null;
  }> | null;
  authors?: Array<
    | string
    | {
        lastName?: string | null;
        family?: string | null;
        fullName?: string | null;
        name?: string | null;
      }
  > | null;
  year?: number | string | null;
  publicationDate?: string | null;
  date?: string | null;
  title?: string | null;
}): string {
  if (metadata.citationKey && metadata.citationKey.trim()) {
    return metadata.citationKey.trim();
  }

  const extractFirstNonStopwordToken = (str: string): string => {
    const normalized = str
      .replace(/[đĐ]/g, 'd')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const tokens = normalized.match(/[a-z0-9]+/g) || [];
    return (
      tokens.find((t) => !CITATION_KEY_STOPWORDS.has(t)) || tokens[0] || 'anon'
    );
  };

  const resolveFamilyFromRawString = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) return 'anon';
    const parsed = parseCreatorString(trimmed);
    if (parsed.fieldMode === 1) {
      return extractFirstNonStopwordToken(
        parsed.lastName || parsed.fullName || trimmed,
      );
    }
    return parsed.lastName || 'anon';
  };

  let family = 'anon';
  const firstCreator = metadata.creators?.[0];
  const firstAuthor = metadata.authors?.[0];

  if (firstCreator?.fieldMode === 1) {
    const rawSingle = (
      firstCreator.lastName ||
      firstCreator.family ||
      firstCreator.fullName ||
      firstCreator.name ||
      ''
    ).trim();
    family = extractFirstNonStopwordToken(rawSingle);
  } else if (firstCreator?.lastName || firstCreator?.family) {
    family = (firstCreator.lastName || firstCreator.family || '').trim();
  } else if (firstCreator?.fullName || firstCreator?.name) {
    const raw = (firstCreator.fullName || firstCreator.name || '').trim();
    family = resolveFamilyFromRawString(raw);
  } else if (
    firstAuthor &&
    typeof firstAuthor === 'object' &&
    (firstAuthor.lastName ||
      firstAuthor.family ||
      firstAuthor.fullName ||
      firstAuthor.name)
  ) {
    if ((firstAuthor as { fieldMode?: number | null }).fieldMode === 1) {
      const rawSingle = (
        firstAuthor.lastName ||
        firstAuthor.family ||
        firstAuthor.fullName ||
        firstAuthor.name ||
        ''
      ).trim();
      family = extractFirstNonStopwordToken(rawSingle);
    } else if (firstAuthor.lastName || firstAuthor.family) {
      family = (firstAuthor.lastName || firstAuthor.family || '').trim();
    } else {
      const raw = (firstAuthor.fullName || firstAuthor.name || '').trim();
      family = resolveFamilyFromRawString(raw);
    }
  } else if (typeof firstAuthor === 'string' && firstAuthor.trim()) {
    family = resolveFamilyFromRawString(firstAuthor);
  }

  const cleanFamily =
    family
      .replace(/[đĐ]/g, 'd')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '') || 'anon';

  const yearStr = metadata.year
    ? String(metadata.year)
    : (metadata.publicationDate || metadata.date)?.match(/\b(\d{4})\b/)?.[1] ||
      'nd';

  const rawTitle = (metadata.title || '')
    .replace(/[đĐ]/g, 'd')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const words = rawTitle.match(/[a-z0-9]{3,}/g) || [];
  const titleWord =
    words.find((w) => !CITATION_KEY_STOPWORDS.has(w)) || words[0] || 'work';

  return `${cleanFamily}${yearStr}${titleWord}`;
}

/**
 * Normalizes a 19-character NASA ADS Bibcode (e.g. `1974AJ.....79..819H` or `2020ApJ...891L..41S`).
 */
export function normalizeBibcode(bibcode?: string | null): string | undefined {
  if (!bibcode || typeof bibcode !== 'string') return undefined;
  const clean = stripSurroundingPunctuation(bibcode)
    .replace(/^(?:bibcode:\s*|https?:\/\/ui\.adsabs\.harvard\.edu\/abs\/)/i, '')
    .replace(/\/(?:abstract|citations|references|metrics)?\/?$/i, '')
    .trim();
  return /^\d{4}[A-Za-z0-9.&]{5}[A-Za-z0-9.]{4}[A-Za-z0-9.][A-Za-z0-9.]{4}[A-Za-z]$/.test(
    clean,
  )
    ? clean
    : undefined;
}
