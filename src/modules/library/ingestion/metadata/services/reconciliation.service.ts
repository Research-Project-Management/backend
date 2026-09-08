import { Injectable, Logger } from '@nestjs/common';
import {
  MetadataCandidate,
  FieldAssertion,
  ConflictReport,
  MetadataConflict,
  ReconciledMetadataResult,
  ItemMetadata,
} from '../types/metadata.types';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  /**
   * Field authority weighting matrix — evidence-based per-provider, per-field confidence scores.
   *
   * Weights are derived from benchmark studies and official provider documentation (2022–2024):
   * - CrossRef abstract coverage: ~52.7% (many publishers don't deposit abstracts)
   * - arXiv year = submission year, NOT publication year — intentionally low weight
   * - PubMed/MEDLINE: near-complete abstracts for journal articles; gold standard in biomedicine
   * - OpenAlex citationCount: largest citation graph; more complete than CrossRef references
   * - Unpaywall: extremely conservative (legal OA only), very low false-positive rate
   * - GROBID/LocalPDFExtraction: >90% accuracy for well-formatted PDFs; journal field noisy
   *
   * Default weight for unlisted provider+field combinations: 0.75
   *
   * policyVersion: 1.1.0
   */
  private readonly FIELD_AUTHORITY_WEIGHTS: Record<
    string,
    Record<string, number>
  > = {
    // ── Identifiers ─────────────────────────────────────────────────────────
    doi: {
      UserOverride: 1.0,
      DirectIdentifier: 1.0,
      CrossRef: 0.999, // CrossRef IS the DOI registration authority
      PubMed: 0.95,
      ZoteroSync: 0.93,
      OpenAlex: 0.92,
      Unpaywall: 0.9,
      BibTeX: 0.9,
      RIS: 0.9,
      SemanticScholar: 0.9,
      LocalPDFExtraction: 0.82, // GROBID regex DOI extraction is reliable when found
      arXiv: 0.75, // Only present when author manually links to published version
    },
    arxivId: {
      UserOverride: 1.0,
      arXiv: 1.0, // arXiv IS the authority for its own IDs
      OpenAlex: 0.92,
      SemanticScholar: 0.9,
      BibTeX: 0.88,
      ZoteroSync: 0.92,
      LocalPDFExtraction: 0.8,
    },
    pmid: {
      UserOverride: 1.0,
      PubMed: 1.0, // PubMed IS the authority for PMIDs
      OpenAlex: 0.93,
      ZoteroSync: 0.92,
      BibTeX: 0.88,
    },
    pmcid: {
      UserOverride: 1.0,
      PubMed: 1.0, // PubMed IS the authority for PMCIDs
      OpenAlex: 0.92,
      ZoteroSync: 0.9,
    },
    isbn: {
      UserOverride: 1.0,
      OpenLibrary: 0.97, // OpenLibrary specialises in books
      CrossRef: 0.93, // CrossRef registers book DOIs + ISBNs
      BibTeX: 0.88,
      RIS: 0.87,
      ZoteroSync: 0.9,
    },
    issn: {
      UserOverride: 1.0,
      CrossRef: 0.98, // CrossRef ISSN data from publishers
      PubMed: 0.97, // NLM journal catalog
      OpenAlex: 0.9,
      BibTeX: 0.85,
      ZoteroSync: 0.9,
    },

    // ── Core Bibliographic Fields ────────────────────────────────────────────
    title: {
      UserOverride: 1.0,
      PubMed: 0.97, // MEDLINE editorial normalization
      CrossRef: 0.97, // Publisher-supplied; occasionally ALL CAPS
      arXiv: 0.94, // Author-submitted, stable
      ZoteroSync: 0.93,
      BibTeX: 0.91,
      RIS: 0.89,
      OpenAlex: 0.87, // Aggregated; known misclassification edge cases
      OpenLibrary: 0.87,
      SemanticScholar: 0.86,
      LocalPDFExtraction: 0.85, // GROBID: ~97% F1 on well-formatted PDFs
    },
    authors: {
      UserOverride: 1.0,
      PubMed: 0.97, // MEDLINE author normalization
      CrossRef: 0.95, // Publisher-supplied; no ORCID disambiguation
      arXiv: 0.93, // Author-submitted; limited editorial check
      ZoteroSync: 0.92,
      BibTeX: 0.9,
      RIS: 0.88,
      OpenAlex: 0.85, // MAG-based disambiguation; good but imperfect
      SemanticScholar: 0.83,
      OpenLibrary: 0.83,
      LocalPDFExtraction: 0.82,
    },
    creators: {
      UserOverride: 1.0,
      PubMed: 0.97,
      CrossRef: 0.95,
      arXiv: 0.93,
      ZoteroSync: 0.92,
      BibTeX: 0.9,
      RIS: 0.88,
      OpenAlex: 0.85,
      SemanticScholar: 0.83,
      OpenLibrary: 0.83,
      LocalPDFExtraction: 0.82,
    },
    abstract: {
      UserOverride: 1.0,
      PubMed: 0.97, // Near-complete for journal articles; editorially reviewed
      arXiv: 0.97, // Author-submitted, almost always present and complete
      ZoteroSync: 0.88,
      LocalPDFExtraction: 0.88, // GROBID decent but layout-dependent
      SemanticScholar: 0.86,
      BibTeX: 0.83,
      OpenAlex: 0.83, // Inverted-index reconstruction; occasional noise
      CrossRef: 0.7, // ⚠️ Only ~52.7% of records include abstract (2023–2024 data)
    },
    year: {
      UserOverride: 1.0,
      CrossRef: 0.98, // Publisher-supplied publication year — most reliable
      PubMed: 0.97, // PubDate curated by NLM
      BibTeX: 0.92,
      ZoteroSync: 0.92,
      RIS: 0.91,
      OpenAlex: 0.88,
      SemanticScholar: 0.87,
      OpenLibrary: 0.86,
      LocalPDFExtraction: 0.75,
      arXiv: 0.72, // ⚠️ Submission year ≠ publication year (preprint→journal gap)
    },

    // ── Publication Venue ────────────────────────────────────────────────────
    journal: {
      UserOverride: 1.0,
      CrossRef: 0.97,
      PubMed: 0.97, // NLM journal catalog; very curated
      ZoteroSync: 0.9,
      BibTeX: 0.88,
      RIS: 0.87,
      OpenAlex: 0.87,
      SemanticScholar: 0.82,
      LocalPDFExtraction: 0.68, // Frequently confused with conference/book names
      arXiv: 0.6, // Typically empty for preprints
    },
    publisher: {
      UserOverride: 1.0,
      CrossRef: 0.98,
      OpenLibrary: 0.9,
      ZoteroSync: 0.9,
      OpenAlex: 0.88,
      BibTeX: 0.85,
      RIS: 0.84,
    },
    volume: {
      UserOverride: 1.0,
      CrossRef: 0.95,
      PubMed: 0.94,
      BibTeX: 0.9,
      RIS: 0.89,
      ZoteroSync: 0.9,
      OpenAlex: 0.85,
      LocalPDFExtraction: 0.7,
      arXiv: 0.5, // Preprints rarely have volume
    },
    pages: {
      UserOverride: 1.0,
      CrossRef: 0.93,
      PubMed: 0.92,
      BibTeX: 0.9,
      RIS: 0.89,
      ZoteroSync: 0.9,
      OpenAlex: 0.82,
      LocalPDFExtraction: 0.6,
      arXiv: 0.4, // Almost never present for preprints
    },

    // ── Enrichment Fields ────────────────────────────────────────────────────
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
      arXiv: 0.96, // "preprint" is self-evident for arXiv records
      OpenLibrary: 0.94, // "book" is self-evident for OpenLibrary
      CrossRef: 0.92,
      PubMed: 0.91,
      BibTeX: 0.88,
      RIS: 0.86,
      ZoteroSync: 0.86,
      SemanticScholar: 0.82,
      LocalPDFExtraction: 0.7,
      OpenAlex: 0.78, // ⚠️ Known misclassification: articles vs editorials/reviews
    },
    openAccessPdfUrl: {
      UserOverride: 1.0,
      Unpaywall: 0.99, // Gold standard — legal OA only, very low false-positive rate
      arXiv: 0.98, // Canonical OA preprint source
      OpenAlex: 0.93, // Uses Unpaywall data internally
      ZoteroSync: 0.85,
    },
    citationCount: {
      UserOverride: 1.0,
      OpenAlex: 0.97, // Largest open citation graph (300M+ works)
      SemanticScholar: 0.93, // Especially strong for CS/ML papers
      CrossRef: 0.95, // References data; less complete than OpenAlex for OA
    },
    extraFields: {
      UserOverride: 1.0,
      PubMed: 0.95, // MeSH terms, clinical metadata — gold standard in biomedicine
      arXiv: 0.92, // ArXiv categories highly reliable
      CrossRef: 0.92,
      OpenLibrary: 0.9,
      ZoteroSync: 0.9,
      OpenAlex: 0.85,
      SemanticScholar: 0.82,
      BibTeX: 0.8,
    },
  };

  /**
   * Reconciles multiple metadata candidates from different providers into a single,
   * high-integrity ItemMetadata object with field-level assertions and conflict audit.
   * Completely immutable: does NOT mutate candidates or userOverrides.
   */
  reconcile(
    candidates: MetadataCandidate[],
    userOverrides: Partial<ItemMetadata> = {},
  ): ReconciledMetadataResult {
    if (!candidates || candidates.length === 0) {
      const fallbackMetadata: ItemMetadata = {
        title: userOverrides.title || 'Untitled Document',
        authors: userOverrides.authors ? [...userOverrides.authors] : [],
        creators: userOverrides.creators
          ? [...userOverrides.creators]
          : undefined,
        year: userOverrides.year ?? null,
        itemType: userOverrides.itemType || 'journalArticle',
        ...userOverrides,
      };

      return {
        metadata: fallbackMetadata,
        assertions: [],
        candidates: [],
        conflictReport: { hasConflicts: false, conflicts: [] },
        reconciledAt: new Date().toISOString(),
      };
    }

    const assertions: FieldAssertion[] = [];
    const conflicts: MetadataConflict[] = [];

    // Base resolved metadata - fresh object
    const resolved: Partial<ItemMetadata> = {};

    // List of scalar and array fields to reconcile
    const allFields: (keyof ItemMetadata)[] = [
      'doi',
      'arxivId',
      'pmid',
      'pmcid',
      'isbn',
      'issn',
      'url',
      'title',
      'shortTitle',
      'authors',
      'creators',
      'editors',
      'year',
      'publicationDate',
      'date',
      'accessedAt',
      'itemType',
      'type',
      'journal',
      'publicationTitle',
      'journalAbbr',
      'publisher',
      'place',
      'volume',
      'issue',
      'section',
      'partNumber',
      'partTitle',
      'pages',
      'series',
      'seriesTitle',
      'seriesText',
      'seriesNumber',
      'language',
      'abstract',
      'abstractNote',
      'keywords',
      'citationCount',
      'referenceCount',
      'openAccessPdfUrl',
      'pdfUrl',
      'fileUrl',
      'fileId',
      'filename',
      'storageId',
      'license',
      'rights',
      'archive',
      'archiveLocation',
      'callNumber',
      'libraryCatalog',
      'extra',
      'extraFields',
      'citationKey',
      'explicitCitationKey',
      'tags',
      'labels',
      'notes',
    ];

    for (const field of allFields) {
      // ── 1. Check User Override (Highest Precedence) ─────────────────────────
      if (
        userOverrides[field] !== undefined &&
        userOverrides[field] !== null &&
        userOverrides[field] !== ''
      ) {
        resolved[field] = this.cloneValue(userOverrides[field]) as any;
        assertions.push({
          field,
          value: this.cloneValue(userOverrides[field]),
          sourceProvider: 'UserOverride',
          confidenceScore: 1.0,
          isUserOverride: true,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      // ── 2. Collect field candidates from all providers ─────────────────────
      const fieldVariants: {
        candidate: MetadataCandidate;
        val: unknown;
        effectiveWeight: number;
      }[] = [];

      for (const cand of candidates) {
        const val = cand.metadata[field];
        if (val !== undefined && val !== null && val !== '') {
          if (Array.isArray(val) && val.length === 0) continue;

          const providerWeight =
            this.FIELD_AUTHORITY_WEIGHTS[field]?.[cand.sourceProvider] ?? 0.75;
          const effectiveWeight = cand.confidenceScore * providerWeight;

          fieldVariants.push({
            candidate: cand,
            val,
            effectiveWeight,
          });
        }
      }

      if (fieldVariants.length === 0) continue;

      // Sort by highest effective weight
      fieldVariants.sort((a, b) => b.effectiveWeight - a.effectiveWeight);

      if (field === 'extraFields') {
        const merged = fieldVariants
          .slice()
          .reverse()
          .reduce<Record<string, unknown>>(
            (accumulator, variant) => ({
              ...accumulator,
              ...(variant.val as Record<string, unknown>),
            }),
            {},
          );
        resolved.extraFields = merged;
        assertions.push({
          field,
          value: this.cloneValue(merged),
          sourceProvider: fieldVariants[0].candidate.sourceProvider,
          confidenceScore: Number(fieldVariants[0].effectiveWeight.toFixed(3)),
          isUserOverride: false,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      if (field === 'tags' || field === 'labels' || field === 'keywords') {
        const values = Array.from(
          new Set(
            fieldVariants.flatMap((variant) =>
              Array.isArray(variant.val) ? variant.val : [],
            ),
          ),
        );
        resolved[field] = values as any;
        assertions.push({
          field,
          value: [...values],
          sourceProvider: fieldVariants[0].candidate.sourceProvider,
          confidenceScore: Number(fieldVariants[0].effectiveWeight.toFixed(3)),
          isUserOverride: false,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      if (field === 'notes') {
        const values = fieldVariants.flatMap((variant) =>
          Array.isArray(variant.val) ? variant.val : [],
        );
        const unique = Array.from(
          new Map(
            values.map((value) => [JSON.stringify(value), value]),
          ).values(),
        );
        resolved.notes = unique as ItemMetadata['notes'];
        assertions.push({
          field,
          value: this.cloneValue(unique),
          sourceProvider: fieldVariants[0].candidate.sourceProvider,
          confidenceScore: Number(fieldVariants[0].effectiveWeight.toFixed(3)),
          isUserOverride: false,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      const winner = fieldVariants[0];

      resolved[field] = this.cloneValue(winner.val) as any;
      assertions.push({
        field,
        value: this.cloneValue(winner.val),
        sourceProvider: winner.candidate.sourceProvider,
        confidenceScore: Number(winner.effectiveWeight.toFixed(3)),
        isUserOverride: false,
        timestamp: new Date().toISOString(),
      });

      // ── 3. Conflict Detection ──────────────────────────────────────────────
      if (fieldVariants.length > 1) {
        const conflict = this.detectFieldConflict(field, fieldVariants);
        if (conflict) {
          conflicts.push(conflict);
        }
      }
    }

    const finalMetadata: ItemMetadata = {
      title: resolved.title || 'Untitled Document',
      authors: resolved.authors ? [...resolved.authors] : [],
      year: resolved.year ?? null,
      itemType: resolved.itemType || 'journalArticle',
      ...resolved,
    };

    return {
      metadata: finalMetadata,
      assertions,
      candidates: [...candidates],
      conflictReport: {
        hasConflicts: conflicts.length > 0,
        conflicts,
      },
      reconciledAt: new Date().toISOString(),
    };
  }

  private cloneValue(val: unknown): unknown {
    if (Array.isArray(val)) {
      return [...val];
    }
    if (val !== null && typeof val === 'object') {
      return { ...val };
    }
    return val;
  }

  private detectFieldConflict(
    field: string,
    variants: {
      candidate: MetadataCandidate;
      val: unknown;
      effectiveWeight: number;
    }[],
  ): MetadataConflict | null {
    if (field === 'year') {
      const years = variants
        .map((v) => Number(v.val))
        .filter((y) => !isNaN(y) && y > 0);
      if (years.length > 1) {
        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);
        if (maxYear - minYear > 1) {
          return {
            field: 'year',
            description: `Publication year differs across providers (${minYear} vs ${maxYear})`,
            severity: 'medium',
            variants: variants.map((v) => ({
              sourceProvider: v.candidate.sourceProvider,
              value: v.val,
              confidenceScore: v.effectiveWeight,
            })),
          };
        }
      }
    }

    if (field === 'title') {
      const topTwo = variants.slice(0, 2);
      const t1 = String(topTwo[0].val).trim().toLowerCase();
      const t2 = String(topTwo[1].val).trim().toLowerCase();
      if (t1 !== t2 && !t1.includes(t2) && !t2.includes(t1)) {
        return {
          field: 'title',
          description: `Discrepancy in title between ${topTwo[0].candidate.sourceProvider} and ${topTwo[1].candidate.sourceProvider}`,
          severity: 'low',
          variants: topTwo.map((v) => ({
            sourceProvider: v.candidate.sourceProvider,
            value: v.val,
            confidenceScore: v.effectiveWeight,
          })),
        };
      }
    }

    return null;
  }
}
