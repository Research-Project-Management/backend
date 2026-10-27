/**
 * Unified global fallback provider authority weights (0.0 - 1.0 scale).
 * Shared across MetadataReconciliationService, ReconciliationPolicy, and ItemProvenancePolicy.
 */
export const SOURCE_WEIGHTS: Record<string, number> = {
  UserOverride: 1.0,
  Manual: 1.0,
  manual: 1.0,
  UserIdentifier: 1.0,
  DirectIdentifier: 0.99,
  CrossRef: 0.97,
  Crossref: 0.97,
  crossref: 0.97,
  DataCite: 0.95,
  datacite: 0.95,
  PubMed: 0.96,
  pubmed: 0.96,
  arXiv: 0.95,
  arxiv: 0.95,
  EnrichedProvider: 0.95,
  enrichedprovider: 0.95,
  ZoteroSync: 0.88,
  zotero: 0.88,
  SemanticScholar: 0.86,
  semanticscholar: 0.86,
  OpenAlex: 0.85,
  openalex: 0.85,
  DBLP: 0.85,
  dblp: 0.85,
  OpenLibrary: 0.84,
  openlibrary: 0.84,
  TrustedPaper: 0.82,
  trustedpaper: 0.82,
  MetadataResolution: 0.8,
  CSL_JSON: 0.78,
  AIMetadata: 0.7,
  aimetadata: 0.7,
  Grobid: 0.68,
  grobid: 0.68,
  BibTeX: 0.65,
  bibtex: 0.65,
  RIS: 0.65,
  ris: 0.65,
  Unpaywall: 0.55,
  unpaywall: 0.55,
  UrlCapture: 0.5,
  urlcapture: 0.5,
  StagedPdf: 0.4,
  stagedpdf: 0.4,
  LocalPDFExtraction: 0.4,
  localpdfextraction: 0.4,
  Unknown: 0.4,
  unknown: 0.4,
};

export const FIELD_AUTHORITY_WEIGHTS: Record<string, Record<string, number>> = {
  // Identifiers
  doi: {
    UserOverride: 1.0,
    UserIdentifier: 1.0,
    DirectIdentifier: 1.0,
    CrossRef: 0.999,
    PubMed: 0.97,
    arXiv: 0.95,
    EnrichedProvider: 0.95,
    ZoteroSync: 0.93,
    OpenAlex: 0.92,
    SemanticScholar: 0.92,
    Unpaywall: 0.9,
    BibTeX: 0.9,
    RIS: 0.9,
    TrustedPaper: 0.85,
    LocalPDFExtraction: 0.82,
  },
  arxivId: {
    UserOverride: 1.0,
    UserIdentifier: 1.0,
    DirectIdentifier: 1.0,
    arXiv: 1.0,
    EnrichedProvider: 0.97,
    TrustedPaper: 0.94,
    OpenAlex: 0.92,
    SemanticScholar: 0.92,
    ZoteroSync: 0.92,
    BibTeX: 0.88,
    LocalPDFExtraction: 0.8,
  },
  pmid: {
    UserOverride: 1.0,
    UserIdentifier: 1.0,
    DirectIdentifier: 1.0,
    PubMed: 1.0,
    EnrichedProvider: 0.97,
    TrustedPaper: 0.94,
    OpenAlex: 0.93,
    SemanticScholar: 0.93,
    ZoteroSync: 0.92,
    BibTeX: 0.88,
  },
  pmcid: {
    UserOverride: 1.0,
    UserIdentifier: 1.0,
    DirectIdentifier: 1.0,
    PubMed: 1.0,
    EnrichedProvider: 0.97,
    TrustedPaper: 0.94,
    OpenAlex: 0.92,
    SemanticScholar: 0.92,
    ZoteroSync: 0.9,
  },
  isbn: {
    UserOverride: 1.0,
    UserIdentifier: 1.0,
    DirectIdentifier: 1.0,
    OpenLibrary: 0.97,
    CrossRef: 0.93,
    ZoteroSync: 0.9,
    BibTeX: 0.88,
    RIS: 0.87,
  },
  issn: {
    UserOverride: 1.0,
    CrossRef: 0.98,
    PubMed: 0.97,
    OpenAlex: 0.9,
    ZoteroSync: 0.9,
    BibTeX: 0.85,
  },

  // Core Bibliographic Fields
  title: {
    UserOverride: 1.0,
    PubMed: 0.98,
    CrossRef: 0.98,
    arXiv: 0.97,
    EnrichedProvider: 0.96,
    ZoteroSync: 0.93,
    SemanticScholar: 0.92,
    DBLP: 0.91,
    BibTeX: 0.91,
    RIS: 0.89,
    OpenAlex: 0.87,
    OpenLibrary: 0.87,
    TrustedPaper: 0.86,
    LocalPDFExtraction: 0.82,
  },
  authors: {
    UserOverride: 1.0,
    PubMed: 0.98,
    CrossRef: 0.97,
    arXiv: 0.96,
    EnrichedProvider: 0.95,
    ZoteroSync: 0.92,
    SemanticScholar: 0.91,
    DBLP: 0.91,
    BibTeX: 0.9,
    RIS: 0.88,
    OpenAlex: 0.85,
    TrustedPaper: 0.84,
    OpenLibrary: 0.83,
    LocalPDFExtraction: 0.8,
  },
  creators: {
    UserOverride: 1.0,
    PubMed: 0.98,
    CrossRef: 0.97,
    arXiv: 0.96,
    EnrichedProvider: 0.95,
    ZoteroSync: 0.92,
    SemanticScholar: 0.91,
    DBLP: 0.91,
    BibTeX: 0.9,
    RIS: 0.88,
    OpenAlex: 0.85,
    TrustedPaper: 0.84,
    OpenLibrary: 0.83,
    LocalPDFExtraction: 0.8,
  },
  abstract: {
    UserOverride: 1.0,
    PubMed: 0.98,
    arXiv: 0.98,
    EnrichedProvider: 0.96,
    TrustedPaper: 0.93,
    SemanticScholar: 0.92,
    ZoteroSync: 0.88,
    LocalPDFExtraction: 0.85,
    BibTeX: 0.83,
    OpenAlex: 0.83,
    CrossRef: 0.7,
  },
  year: {
    UserOverride: 1.0,
    CrossRef: 0.98,
    PubMed: 0.97,
    arXiv: 0.96,
    EnrichedProvider: 0.95,
    SemanticScholar: 0.93,
    DBLP: 0.93,
    BibTeX: 0.92,
    ZoteroSync: 0.92,
    RIS: 0.91,
    OpenAlex: 0.88,
    OpenLibrary: 0.86,
    TrustedPaper: 0.84,
    LocalPDFExtraction: 0.75,
  },

  // Publication Venue
  journal: {
    UserOverride: 1.0,
    CrossRef: 0.97,
    PubMed: 0.97,
    ZoteroSync: 0.9,
    EnrichedProvider: 0.9,
    SemanticScholar: 0.89,
    BibTeX: 0.88,
    RIS: 0.87,
    OpenAlex: 0.87,
    LocalPDFExtraction: 0.68,
    arXiv: 0.6,
  },
  publicationTitle: {
    UserOverride: 1.0,
    CrossRef: 0.97,
    PubMed: 0.97,
    ZoteroSync: 0.9,
    EnrichedProvider: 0.9,
    SemanticScholar: 0.89,
    BibTeX: 0.88,
    RIS: 0.87,
    OpenAlex: 0.87,
    LocalPDFExtraction: 0.68,
    arXiv: 0.6,
  },
  publisher: {
    UserOverride: 1.0,
    CrossRef: 0.98,
    OpenLibrary: 0.9,
    ZoteroSync: 0.9,
    EnrichedProvider: 0.89,
    OpenAlex: 0.88,
    BibTeX: 0.85,
    RIS: 0.84,
  },
  volume: {
    UserOverride: 1.0,
    CrossRef: 0.95,
    PubMed: 0.94,
    BibTeX: 0.9,
    ZoteroSync: 0.9,
    RIS: 0.89,
    SemanticScholar: 0.86,
    OpenAlex: 0.85,
    LocalPDFExtraction: 0.7,
    arXiv: 0.5,
  },
  pages: {
    UserOverride: 1.0,
    CrossRef: 0.93,
    PubMed: 0.92,
    BibTeX: 0.9,
    ZoteroSync: 0.9,
    RIS: 0.89,
    SemanticScholar: 0.84,
    OpenAlex: 0.82,
    LocalPDFExtraction: 0.6,
    arXiv: 0.4,
  },

  // Enrichment Fields
  language: {
    UserOverride: 1.0,
    PubMed: 0.95,
    OpenAlex: 0.87,
    arXiv: 0.83,
    CrossRef: 0.82,
    LocalPDFExtraction: 0.8,
    BibTeX: 0.78,
  },
  itemType: {
    UserOverride: 1.0,
    arXiv: 0.96,
    OpenLibrary: 0.94,
    CrossRef: 0.92,
    PubMed: 0.91,
    BibTeX: 0.88,
    RIS: 0.86,
    ZoteroSync: 0.86,
    SemanticScholar: 0.85,
    OpenAlex: 0.78,
    LocalPDFExtraction: 0.7,
  },
  openAccessPdfUrl: {
    UserOverride: 1.0,
    Unpaywall: 0.99,
    arXiv: 0.98,
    SemanticScholar: 0.95,
    OpenAlex: 0.93,
    ZoteroSync: 0.85,
  },
  citationCount: {
    UserOverride: 1.0,
    OpenAlex: 0.97,
    SemanticScholar: 0.96,
    CrossRef: 0.95,
  },
  referenceCount: {
    UserOverride: 1.0,
    OpenAlex: 0.97,
    SemanticScholar: 0.96,
    CrossRef: 0.95,
    LocalPDFExtraction: 0.88,
    PubMed: 0.85,
    arXiv: 0.7,
  },
  extraFields: {
    UserOverride: 1.0,
    PubMed: 0.95,
    arXiv: 0.92,
    CrossRef: 0.92,
    OpenLibrary: 0.9,
    ZoteroSync: 0.9,
    SemanticScholar: 0.88,
    OpenAlex: 0.85,
    BibTeX: 0.8,
  },
};

export const FIELD_AUTHORITY = FIELD_AUTHORITY_WEIGHTS;

/**
 * Resolves the canonical authority weight (0.0 - 1.0 scale) for a given provider and optional field.
 * Checks field-specific authority first, then global SOURCE_WEIGHTS (case-insensitive).
 */
export function resolveProviderFieldWeight(
  provider: string | undefined,
  field?: string,
): number {
  if (!provider) return 0.5;
  const lower = provider.toLowerCase();

  if (field && FIELD_AUTHORITY_WEIGHTS[field]) {
    const fieldWeights = FIELD_AUTHORITY_WEIGHTS[field];
    if (fieldWeights[provider] !== undefined) {
      return fieldWeights[provider];
    }
    for (const [key, val] of Object.entries(fieldWeights)) {
      if (key.toLowerCase() === lower) {
        return val;
      }
    }
  }

  if (SOURCE_WEIGHTS[provider] !== undefined) {
    return SOURCE_WEIGHTS[provider];
  }
  for (const [key, val] of Object.entries(SOURCE_WEIGHTS)) {
    if (key.toLowerCase() === lower) {
      return val;
    }
  }

  return 0.75;
}
