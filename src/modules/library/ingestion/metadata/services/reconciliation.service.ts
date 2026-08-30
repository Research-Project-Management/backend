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

  // Field authority weighting matrix per provider (0.0 - 1.0)
  private readonly FIELD_AUTHORITY_WEIGHTS: Record<
    string,
    Record<string, number>
  > = {
    doi: {
      UserOverride: 1.0,
      CrossRef: 0.99,
      PubMed: 0.95,
      OpenAlex: 0.9,
      SemanticScholar: 0.9,
      Unpaywall: 0.9,
      arXiv: 0.85,
      LocalPDFExtraction: 0.7,
    },
    title: {
      UserOverride: 1.0,
      CrossRef: 0.95,
      PubMed: 0.95,
      arXiv: 0.92,
      OpenAlex: 0.9,
      SemanticScholar: 0.9,
      OpenLibrary: 0.85,
      LocalPDFExtraction: 0.65,
    },
    authors: {
      UserOverride: 1.0,
      CrossRef: 0.95,
      PubMed: 0.95,
      arXiv: 0.92,
      OpenAlex: 0.9,
      SemanticScholar: 0.9,
      OpenLibrary: 0.85,
      LocalPDFExtraction: 0.6,
    },
    abstract: {
      UserOverride: 1.0,
      arXiv: 0.96,
      PubMed: 0.95,
      SemanticScholar: 0.92,
      OpenAlex: 0.9,
      CrossRef: 0.85,
      LocalPDFExtraction: 0.7,
    },
    journal: {
      UserOverride: 1.0,
      CrossRef: 0.96,
      PubMed: 0.95,
      OpenAlex: 0.9,
      SemanticScholar: 0.85,
      LocalPDFExtraction: 0.6,
    },
    publisher: {
      UserOverride: 1.0,
      CrossRef: 0.98,
      OpenLibrary: 0.95,
      OpenAlex: 0.9,
      SemanticScholar: 0.85,
    },
    year: {
      UserOverride: 1.0,
      CrossRef: 0.96,
      PubMed: 0.95,
      arXiv: 0.95,
      OpenAlex: 0.9,
      SemanticScholar: 0.9,
      OpenLibrary: 0.85,
      LocalPDFExtraction: 0.7,
    },
    openAccessPdfUrl: {
      UserOverride: 1.0,
      Unpaywall: 0.99,
      arXiv: 0.98,
      OpenAlex: 0.92,
      SemanticScholar: 0.88,
    },
    citationCount: {
      UserOverride: 1.0,
      OpenAlex: 0.95,
      SemanticScholar: 0.95,
      CrossRef: 0.8,
    },
    tldr: {
      UserOverride: 1.0,
      SemanticScholar: 0.98,
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
      'editors',
      'year',
      'publicationDate',
      'itemType',
      'journal',
      'publicationTitle',
      'journalAbbr',
      'publisher',
      'place',
      'volume',
      'issue',
      'section',
      'pages',
      'series',
      'seriesTitle',
      'language',
      'abstract',
      'tldr',
      'keywords',
      'citationCount',
      'referenceCount',
      'influentialCitationCount',
      'openAccessPdfUrl',
      'license',
      'rights',
      'archive',
      'archiveLocation',
      'callNumber',
      'extra',
      'citationKey',
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
