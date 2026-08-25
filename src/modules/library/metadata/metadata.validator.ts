import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  formatCanonicalId,
} from './canonical-identifiers.util';
import { UnifiedAcademicMetadata, ProvenanceMetadata } from './metadata.types';

/**
 * Validates, sanitizes, and normalizes metadata objects returned from
 * third-party academic providers before ingestion or merge.
 */
export function validateAcademicMetadata(
  input: unknown,
): UnifiedAcademicMetadata | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const raw = input as Record<string, any>;

  // Title is mandatory; fallback to trimmed string or 'Untitled'
  const rawTitle = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!rawTitle && !raw.doi && !raw.arxivId && !raw.pmid && !raw.isbn) {
    return null;
  }
  const title = rawTitle || 'Untitled Academic Item';

  // Normalize Authors & Editors
  const authors: string[] = Array.isArray(raw.authors)
    ? raw.authors
        .map((a: unknown) => (typeof a === 'string' ? a.trim() : ''))
        .filter((a: string) => a.length > 0)
    : [];

  const editors: string[] | undefined = Array.isArray(raw.editors)
    ? raw.editors
        .map((e: unknown) => (typeof e === 'string' ? e.trim() : ''))
        .filter((e: string) => e.length > 0)
    : undefined;

  // Normalize Publication Year
  let year: number | null = null;
  if (typeof raw.year === 'number' && !isNaN(raw.year) && raw.year > 1000 && raw.year < 2200) {
    year = raw.year;
  } else if (typeof raw.year === 'string') {
    const parsed = parseInt(raw.year.replace(/\D/g, ''), 10);
    if (!isNaN(parsed) && parsed > 1000 && parsed < 2200) {
      year = parsed;
    }
  }

  // Canonical Identifiers
  const doi = normalizeDoi(raw.doi);
  const arxivId = normalizeArxivId(raw.arxivId);
  const pmid = normalizePmid(raw.pmid);
  const pmcid = normalizePmcid(raw.pmcid);
  const isbn = normalizeIsbn(raw.isbn);
  const issn = normalizeIssn(raw.issn);

  // Validate itemType against Zotero types, default to 'journalArticle'
  const itemType =
    typeof raw.itemType === 'string' && raw.itemType.trim().length > 0
      ? raw.itemType.trim()
      : 'journalArticle';

  // Sanitize strings
  const sanitizeStr = (val: unknown): string | undefined => {
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
    return undefined;
  };

  const journal = sanitizeStr(raw.journal || raw.publicationTitle);
  const publisher = sanitizeStr(raw.publisher);
  const volume = sanitizeStr(raw.volume);
  const issue = sanitizeStr(raw.issue);
  const pages = sanitizeStr(raw.pages);
  const abstract = sanitizeStr(raw.abstract);
  const tldr = sanitizeStr(raw.tldr);
  const url = sanitizeStr(raw.url) || (doi ? `https://doi.org/${doi}` : undefined);
  const openAccessPdfUrl = sanitizeStr(raw.openAccessPdfUrl);

  const keywords: string[] = Array.isArray(raw.keywords)
    ? Array.from(
        new Set(
          raw.keywords
            .map((k: unknown) => (typeof k === 'string' ? k.trim() : ''))
            .filter((k: string) => k.length > 0),
        ),
      )
    : [];

  // Normalize Provenance
  let provenance: ProvenanceMetadata | undefined = undefined;
  if (raw.provenance && typeof raw.provenance === 'object') {
    const p = raw.provenance as Record<string, any>;
    const originProvider = p.originProvider || 'Fallback';
    const canonicalId =
      p.canonicalId ||
      (doi
        ? formatCanonicalId('doi', doi)
        : arxivId
          ? formatCanonicalId('arxiv', arxivId)
          : pmid
            ? formatCanonicalId('pmid', pmid)
            : isbn
              ? formatCanonicalId('isbn', isbn)
              : `flux:${title}`);

    provenance = {
      originProvider,
      resolvedAt: typeof p.resolvedAt === 'string' ? p.resolvedAt : new Date().toISOString(),
      canonicalId,
      canonicalUrl: sanitizeStr(p.canonicalUrl) || url,
      confidenceScore: typeof p.confidenceScore === 'number' ? p.confidenceScore : 0.9,
      rawSnapshotHash: sanitizeStr(p.rawSnapshotHash),
      isOpenAccess: Boolean(p.isOpenAccess || openAccessPdfUrl),
      openAccessPdfUrl,
    };
  }

  return {
    title,
    shortTitle: sanitizeStr(raw.shortTitle),
    authors,
    editors: editors && editors.length > 0 ? editors : undefined,
    year,
    publicationDate: sanitizeStr(raw.publicationDate),
    doi,
    arxivId,
    pmid,
    pmcid,
    isbn,
    issn,
    url,
    itemType,
    journal,
    publicationTitle: journal,
    publisher,
    volume,
    issue,
    pages,
    abstract,
    tldr,
    keywords: keywords.length > 0 ? keywords : undefined,
    openAccessPdfUrl,
    citationCount: typeof raw.citationCount === 'number' ? raw.citationCount : undefined,
    provenance,
  };
}
