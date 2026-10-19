import { TagInput } from '@/modules/library/core/types/bibliographic.types';
import { stripLatexBraces } from './academic-text.domain';
import {
  MAX_TAG_LENGTH,
  ARXIV_CATEGORY_MAP,
  CANONICAL_ARXIV_CATEGORIES,
  NOISE_TAG_WORDS,
} from './tag-taxonomy.lexicon';

/**
 * Resolves an archive classification code (e.g., `cs.CV`, `stat.ML`, `astro-ph.CO`, `cs-cv`)
 * into its full human-readable academic subject descriptor (`"<Archive> - <Sub-Discipline>"`).
 */
export function resolveArxivTaxonomyTag(rawCode: string): string | null {
  const normalizedCode = rawCode.trim().toLowerCase();
  if (ARXIV_CATEGORY_MAP[normalizedCode]) {
    return ARXIV_CATEGORY_MAP[normalizedCode];
  }
  const prefixMatch = normalizedCode.match(
    /^(cs|econ|eess|math|nlin|physics|q-fin|q-bio|stat|astro-ph|cond-mat)[-_]([a-z-]+)$/,
  );
  if (prefixMatch) {
    const dotted = `${prefixMatch[1]}.${prefixMatch[2]}`;
    if (ARXIV_CATEGORY_MAP[dotted]) {
      return ARXIV_CATEGORY_MAP[dotted];
    }
  }
  return null;
}

// 3. Text Sanitization & Canonical Normalization

/** Fixes UTF-8 encoding corruption (Mojibake) common in academic PDF extraction */
export function fixMojibake(str: string): string {
  return str
    .replace(/â€“|â€”/g, '-')
    .replace(/â€™|â€˜/g, "'")
    .replace(/â€œ|â€ /g, '"')
    .replace(/\uFFFD/g, '')
    .replace(/[\xA0\r\n\s]+/g, ' ');
}

/** Strips LaTeX macros, decodes LaTeX diacritics, and unescapes symbols common in BibTeX keywords */
export function stripLatexMarkup(str: string): string {
  if (!str || typeof str !== 'string') return '';
  if (!str.includes('\\') && !str.includes('{') && !str.includes('}')) {
    return str.trim();
  }
  const out = str
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(
      /\\(?:textbf|textit|textsf|texttt|textsc|emph|text|mathrm|mathbf|mathit)\s*\{([^}]+)\}/gi,
      '$1',
    )
    .replace(/\\(?:bf|it|em|rm|sf|tt|large|Large|small|tiny)\b\s*/gi, '');
  return stripLatexBraces(out).replace(/[{}]/g, '').trim();
}

/** Strips Wikipedia/Wikidata disambiguation suffixes like "(psychology)", "(genetics)" */
export function stripDisambiguationSuffix(str: string): string {
  return str.replace(/(?<=[\w\d])\s+\([^)]*\)$/g, '').trim();
}

/** Strips common field prefixes and leading/trailing quotes, unbalanced brackets, dots, ellipses (...) */
export function stripTagPrefixes(str: string): string {
  let out = str
    .replace(/<[^>]+>/g, '')
    .replace(
      /^(?:tags?|keywords?|index terms?|categor(?:y|ies)|subject(?: areas?)?|topics?|terms?|classification|descriptors?|field(?: of study)?)[:—\-\s]+/i,
      '',
    )
    .replace(/^[#"''`[{<•·*—\-\s]+/, '')
    .replace(/^(?:\.{2,}|…)+/, '')
    .replace(/["''`\]}>]+$/, '')
    .replace(/(?:\.{2,}|…|[.,;:—\-\s•·*])+$/, '')
    .trim();

  // Strip outer wrapping parentheses `(foo)` or unmatched leading/trailing parenthesis without breaking `SE(3)` or `O(n)`
  if (out.startsWith('(') && out.endsWith(')')) {
    out = out.slice(1, -1).trim();
  } else if (out.startsWith('(') && !out.includes(')')) {
    out = out.slice(1).trim();
  } else if (out.endsWith(')') && !out.includes('(')) {
    out = out.slice(0, -1).trim();
  }

  return out;
}

const CANONICAL_TAXONOMY_DESCRIPTORS = new Set(
  Object.values(ARXIV_CATEGORY_MAP).map((v) => v.toLowerCase()),
);

const COMMA_BEARING_TAXONOMY_DESCRIPTORS = Object.values(
  ARXIV_CATEGORY_MAP,
).filter((v) => v.includes(','));

function splitPreservingTaxonomyDescriptors(rawStr: string): string[] {
  const trimmed = rawStr.trim();
  if (!trimmed) return [];
  if (CANONICAL_TAXONOMY_DESCRIPTORS.has(trimmed.toLowerCase())) {
    return [trimmed];
  }

  let protectedStr = rawStr;
  const placeholders: Array<[string, string]> = [];
  for (let i = 0; i < COMMA_BEARING_TAXONOMY_DESCRIPTORS.length; i++) {
    const desc = COMMA_BEARING_TAXONOMY_DESCRIPTORS[i];
    if (protectedStr.toLowerCase().includes(desc.toLowerCase())) {
      const token = `__TAXONOMY_DESC_${i}__`;
      const regex = new RegExp(
        desc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'gi',
      );
      protectedStr = protectedStr.replace(regex, token);
      placeholders.push([token, desc]);
    }
  }

  return protectedStr
    .split(/[,;\n\r|•·]|\s+[/]\s+/)
    .map((p) => {
      let restored = p.trim();
      for (const [token, desc] of placeholders) {
        if (restored.includes(token)) {
          restored = restored.replaceAll(token, desc);
        }
      }
      return restored.trim();
    })
    .filter(Boolean);
}

/**
 * Generates a canonical, case- and diacritic-insensitive identity key for tag indexing
 * and deduplication (Unicode NFKD decomposition + combining mark removal + lowercase).
 */
export function toCanonicalTagKey(tag: string): string {
  return tag
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[\xA0\r\n\s]+/g, ' ')
    .trim();
}

/**
 * Sanitizes and validates a single academic tag:
 * - Cleans HTML/XML markup, LaTeX commands, and encoding mojibake
 * - Collapses internal whitespace and normalizes to Unicode NFC
 * - Preserves exact source/researcher casing (Case-Preserving)
 * - Expands raw arXiv taxonomy codes into full academic descriptors
 * - Rejects non-keyword structural noise (DOIs, URLs, PMIDs, pagination, dates, placeholders)
 */
export function cleanSingleTag(rawTag: string): string | null {
  if (!rawTag || typeof rawTag !== 'string') return null;

  // 1. Mojibake, LaTeX, and HTML cleanup
  let tag = fixMojibake(rawTag);
  tag = stripLatexMarkup(tag);
  tag = tag
    .replace(/<br\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/[\xA0\r\n\s]+/g, ' ')
    .trim();
  if (!tag) return null;

  // 2. Strip disambiguation suffixes & field header prefixes
  tag = stripDisambiguationSuffix(tag);
  tag = stripTagPrefixes(tag);
  if (!tag) return null;

  // 3. Collapse internal whitespace + Unicode NFC normalization (Case-Preserving)
  tag = tag
    .replace(/[\xA0\r\n\s]+/g, ' ')
    .trim()
    .normalize('NFC');
  if (!tag) return null;

  // 4. Subject taxonomy resolution for arXiv classification codes
  const taxonomyDescriptor = resolveArxivTaxonomyTag(tag);
  if (taxonomyDescriptor) {
    return taxonomyDescriptor;
  }

  // 5. Reject bibliographic identifiers & web links (DOI, PMID, PMC, ISBN, ISSN, arXiv ID, URLs)
  if (
    /^(?:doi[:\s/]|https?:\/\/(?:dx\.)?doi\.org\/)/i.test(tag) ||
    /^10\.\d{4,9}\//i.test(tag) ||
    /(?:^|\s)10\.\d{4,9}\/[^\s]+/i.test(tag) ||
    /^(?:pmid|pmcid|isbn|issn|arxiv|corpusid|hdl|urn|bibcode)[:\s/]/i.test(
      tag,
    ) ||
    /^https?:\/\//i.test(tag) ||
    /^ftp:\/\//i.test(tag) ||
    /^www\./i.test(tag) ||
    /^downloaded\s+(?:from|on|by)\b/i.test(tag) ||
    /@/.test(tag) ||
    /\.(?:com|org|net|edu|gov|io|ai|dev|de|uk|fr|cn)\b/i.test(tag)
  ) {
    return null;
  }

  const lower = tag.toLowerCase();

  // 6. Reject structural document noise
  if (NOISE_TAG_WORDS.has(lower)) {
    return null;
  }

  // 7. Length & character sanity checks
  if (tag.length < 2 || tag.length > MAX_TAG_LENGTH) return null;
  if (!/[\p{L}\p{N}]/u.test(tag)) return null;
  if (/^[\p{P}\p{S}\s]+$/u.test(tag)) return null;

  // 8. Reject standalone numbers, year ranges, calendar dates, and pagination/volume markers
  if (/^\d+$/.test(tag)) return null;
  if (/^\d{1,4}[-–—/]\d{1,4}$/.test(tag)) return null;
  if (/^\d{4}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])$/.test(tag))
    return null;
  if (/^(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.]\d{4}$/.test(tag))
    return null;
  if (
    /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{2,4}$/i.test(
      tag,
    )
  ) {
    return null;
  }
  if (
    /^(?:(?:p|pp|v)\.\s*|(?:p|pp|v)\s+|(?:page|pages|vol|volume|no|number|issue)\.?\s*)\d+(?:\s*[-–—]\s*\d+)?$/i.test(
      tag,
    )
  ) {
    return null;
  }
  if (/^vol(?:ume)?\.?\s*\d+[\s,]+(?:no|issue|number)\.?\s*\d+$/i.test(tag)) {
    return null;
  }
  // Reject lowercase standalone Roman numerals used as section/volume numbers (e.g. "iv", "ix", "xii")
  if (
    /^(?:i{1,3}|iv|vi{0,3}|ix|x{1,3}|xi{1,3}|xiv|xvi{0,3}|xix|xx{0,2})$/.test(
      tag,
    )
  ) {
    return null;
  }

  return tag;
}

/**
 * Normalizes a collection of raw tags or keyword strings:
 * - Splits compound keyword strings on `,`, `;`, newlines, bullets, pipes, or ` / `
 * - Sanitizes each token via `cleanSingleTag` (Case-Preserving + Unicode NFC)
 * - Deduplicates via `toCanonicalTagKey` while preferring explicit mixed/uppercase orthography
 *   (e.g., `ICLR` over `iclr`, `DeepONet` over `deeponet`) when both appear in the same batch.
 */
export function normalizeAcademicTags(
  rawTags?: (TagInput | null | undefined)[] | null,
): string[] {
  if (!Array.isArray(rawTags) || rawTags.length === 0) return [];

  const indexByKey = new Map<string, number>();
  const result: string[] = [];

  for (const item of rawTags) {
    if (!item) continue;
    const rawStr = typeof item === 'string' ? item : item.tag || item.name;
    if (!rawStr || typeof rawStr !== 'string') continue;

    const parts = splitPreservingTaxonomyDescriptors(rawStr);

    for (const part of parts) {
      const cleaned = cleanSingleTag(part);
      if (!cleaned) continue;

      const key = toCanonicalTagKey(cleaned);
      const existingIdx = indexByKey.get(key);
      if (existingIdx === undefined) {
        indexByKey.set(key, result.length);
        result.push(cleaned);
      } else {
        const existing = result[existingIdx];
        if (
          existing === existing.toLowerCase() &&
          cleaned !== cleaned.toLowerCase()
        ) {
          result[existingIdx] = cleaned;
        }
      }
    }
  }

  return result;
}

/**
 * Resolves the canonical arXiv primary category code (e.g. `cs.LG`, `stat.ML`, `math.PR`)
 * for structured Extra field formatting: `arXiv:<id> [<primaryCategory>]`.
 */
export function resolveCanonicalArxivCategory(
  arxivId?: string | null,
  tags?: unknown[],
  extraFields?: Record<string, unknown> | null,
  item?: Record<string, unknown> | null,
): string | undefined {
  if (
    typeof extraFields?.primaryCategory === 'string' &&
    extraFields.primaryCategory.trim()
  ) {
    const raw = extraFields.primaryCategory.trim();
    return CANONICAL_ARXIV_CATEGORIES[raw.toLowerCase()] || raw;
  }
  if (
    typeof extraFields?.category === 'string' &&
    extraFields.category.trim()
  ) {
    const raw = extraFields.category.trim();
    return CANONICAL_ARXIV_CATEGORIES[raw.toLowerCase()] || raw;
  }
  if (
    typeof item?.primaryCategory === 'string' &&
    item.primaryCategory.trim()
  ) {
    const raw = item.primaryCategory.trim();
    return CANONICAL_ARXIV_CATEGORIES[raw.toLowerCase()] || raw;
  }

  const extractStringCandidate = (entry: unknown): string | null => {
    if (typeof entry === 'string') return entry;
    if (typeof entry === 'object' && entry !== null) {
      const rec = entry as Record<string, unknown>;
      if (typeof rec.name === 'string') return rec.name;
      if (typeof rec.tag === 'string') return rec.tag;
    }
    return null;
  };

  const candidates: string[] = [];
  if (Array.isArray(tags)) {
    for (const t of tags) {
      const val = extractStringCandidate(t);
      if (val) candidates.push(val);
    }
  }
  if (Array.isArray(item?.keywords)) {
    for (const k of item.keywords) {
      const val = extractStringCandidate(k);
      if (val) candidates.push(val);
    }
  }

  // 1. Direct code match
  for (const c of candidates) {
    const lower = c.trim().toLowerCase();
    if (CANONICAL_ARXIV_CATEGORIES[lower]) {
      return CANONICAL_ARXIV_CATEGORIES[lower];
    }
  }

  // 2. Reverse lookup in ARXIV_CATEGORY_MAP
  for (const c of candidates) {
    const lower = c.trim().toLowerCase();
    for (const [code, desc] of Object.entries(ARXIV_CATEGORY_MAP)) {
      if (desc.toLowerCase() === lower) {
        return CANONICAL_ARXIV_CATEGORIES[code] || code;
      }
    }
  }

  // 3. Keyword heuristics from tags/keywords
  for (const c of candidates) {
    const lower = c.trim().toLowerCase();
    if (/machine\s*learning|reinforcement\s*learning/i.test(lower))
      return 'cs.LG';
    if (/computer\s*vision/i.test(lower)) return 'cs.CV';
    if (/natural\s*language|computation\s*and\s*language/i.test(lower))
      return 'cs.CL';
    if (/artificial\s*intelligence/i.test(lower)) return 'cs.AI';
    if (/robotics/i.test(lower)) return 'cs.RO';
    if (/neural\s*and\s*evolutionary/i.test(lower)) return 'cs.NE';
  }

  // 4. Explicit bracketed category in arxivId string if present (e.g. "arXiv:1706.03762 [cs.CL]")
  if (arxivId) {
    const bracketMatch = String(arxivId).match(/\[([a-z-]+\.[a-z-]+)\]/i);
    if (bracketMatch) {
      const lowerCode = bracketMatch[1].toLowerCase();
      return CANONICAL_ARXIV_CATEGORIES[lowerCode] || bracketMatch[1];
    }
  }

  // 5. Title / abstract fallback for arXiv preprints
  const title = typeof item?.title === 'string' ? item.title.toLowerCase() : '';
  const abs =
    typeof item?.abstract === 'string' ? item.abstract.toLowerCase() : '';
  if (arxivId || item?.repository === 'arXiv') {
    if (
      /reinforcement\s*learning|deep\s*q-network|atari/i.test(title) ||
      /deep\s*q-network|atari/i.test(abs)
    ) {
      return 'cs.LG';
    }
    if (/machine\s*learning/i.test(title)) return 'cs.LG';
    if (/generative\s*adversarial\s*network/i.test(title)) return 'stat.ML';
    if (/computer\s*vision|object\s*detection|segmentation/i.test(title))
      return 'cs.CV';
    if (/language\s*model|transformer|bert|gpt/i.test(title)) return 'cs.CL';
  }

  return undefined;
}
