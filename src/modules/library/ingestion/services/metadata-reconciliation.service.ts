import { Injectable } from '@nestjs/common';
import {
  MetadataCandidate,
  FieldAssertion,
  MetadataConflict,
  ReconciledMetadataResult,
  ItemMetadata,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  ALL_RECONCILABLE_METADATA_FIELDS,
  resolveBidirectionalBaseFields,
} from '@/modules/library/core/domain/zotero-field-harmonizer.domain';
import { parseCreatorString } from '@/modules/library/core/domain/author.domain';

@Injectable()
export class MetadataReconciliationService {
  /**
   * Field authority weighting matrix — evidence-based per-provider, per-field confidence scores.
   */
  private readonly FIELD_AUTHORITY_WEIGHTS: Record<
    string,
    Record<string, number>
  > = {
    // Identifiers
    doi: {
      UserOverride: 1.0,
      DirectIdentifier: 1.0,
      CrossRef: 0.999,
      PubMed: 0.95,
      ZoteroSync: 0.93,
      OpenAlex: 0.92,
      SemanticScholar: 0.92,
      Unpaywall: 0.9,
      BibTeX: 0.9,
      RIS: 0.9,
      LocalPDFExtraction: 0.82,
      arXiv: 0.75,
    },
    arxivId: {
      UserOverride: 1.0,
      arXiv: 1.0,
      OpenAlex: 0.92,
      SemanticScholar: 0.92,
      BibTeX: 0.88,
      ZoteroSync: 0.92,
      LocalPDFExtraction: 0.8,
    },
    pmid: {
      UserOverride: 1.0,
      PubMed: 1.0,
      OpenAlex: 0.93,
      SemanticScholar: 0.93,
      ZoteroSync: 0.92,
      BibTeX: 0.88,
    },
    pmcid: {
      UserOverride: 1.0,
      PubMed: 1.0,
      OpenAlex: 0.92,
      SemanticScholar: 0.92,
      ZoteroSync: 0.9,
    },
    isbn: {
      UserOverride: 1.0,
      OpenLibrary: 0.97,
      CrossRef: 0.93,
      BibTeX: 0.88,
      RIS: 0.87,
      ZoteroSync: 0.9,
    },
    issn: {
      UserOverride: 1.0,
      CrossRef: 0.98,
      PubMed: 0.97,
      OpenAlex: 0.9,
      BibTeX: 0.85,
      ZoteroSync: 0.9,
    },

    // Core Bibliographic Fields
    title: {
      UserOverride: 1.0,
      PubMed: 0.97,
      CrossRef: 0.97,
      arXiv: 0.94,
      ZoteroSync: 0.93,
      SemanticScholar: 0.92,
      BibTeX: 0.91,
      RIS: 0.89,
      OpenAlex: 0.87,
      OpenLibrary: 0.87,
      LocalPDFExtraction: 0.85,
    },
    authors: {
      UserOverride: 1.0,
      PubMed: 0.97,
      CrossRef: 0.95,
      arXiv: 0.93,
      ZoteroSync: 0.92,
      SemanticScholar: 0.91,
      BibTeX: 0.9,
      RIS: 0.88,
      OpenAlex: 0.85,
      OpenLibrary: 0.83,
      LocalPDFExtraction: 0.82,
    },
    creators: {
      UserOverride: 1.0,
      PubMed: 0.97,
      CrossRef: 0.95,
      arXiv: 0.93,
      ZoteroSync: 0.92,
      SemanticScholar: 0.91,
      BibTeX: 0.9,
      RIS: 0.88,
      OpenAlex: 0.85,
      OpenLibrary: 0.83,
      LocalPDFExtraction: 0.82,
    },
    abstract: {
      UserOverride: 1.0,
      PubMed: 0.97,
      arXiv: 0.97,
      SemanticScholar: 0.92,
      ZoteroSync: 0.88,
      LocalPDFExtraction: 0.88,
      BibTeX: 0.83,
      OpenAlex: 0.83,
      CrossRef: 0.7,
    },
    year: {
      UserOverride: 1.0,
      CrossRef: 0.98,
      PubMed: 0.97,
      SemanticScholar: 0.93,
      BibTeX: 0.92,
      ZoteroSync: 0.92,
      RIS: 0.91,
      OpenAlex: 0.88,
      OpenLibrary: 0.86,
      LocalPDFExtraction: 0.75,
      arXiv: 0.72,
    },

    // Publication Venue
    journal: {
      UserOverride: 1.0,
      CrossRef: 0.97,
      PubMed: 0.97,
      ZoteroSync: 0.9,
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
      RIS: 0.89,
      ZoteroSync: 0.9,
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
      LocalPDFExtraction: 0.7,
      OpenAlex: 0.78,
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

    const resolved: Partial<ItemMetadata> = {};

    const dynamicCandidateKeys = new Set<string>([
      'title',
      'authors',
      'creators',
      'editors',
      'itemType',
      'type',
      'extra',
      'extraFields',
      'notes',
      'tags',
      'keywords',
      'pdfUrl',
      'fileUrl',
      'fileId',
      'filename',
      ...ALL_RECONCILABLE_METADATA_FIELDS,
      ...Object.keys(userOverrides || {}),
    ]);
    for (const cand of candidates) {
      if (cand?.metadata && typeof cand.metadata === 'object') {
        for (const k of Object.keys(cand.metadata)) {
          dynamicCandidateKeys.add(k);
        }
      }
    }
    const allFields = Array.from(dynamicCandidateKeys);

    for (const field of allFields) {
      if (
        userOverrides[field] !== undefined &&
        userOverrides[field] !== null &&
        userOverrides[field] !== ''
      ) {
        resolved[field] = this.cloneValue(userOverrides[field]);
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
              Array.isArray(variant.val) ? (variant.val as string[]) : [],
            ),
          ),
        );
        (resolved as Record<string, unknown>)[field] = values;
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
          Array.isArray(variant.val) ? (variant.val as unknown[]) : [],
        );
        const seen = new Set<string>();
        const unique: unknown[] = [];
        for (const value of values) {
          const noteRec =
            value && typeof value === 'object'
              ? (value as Record<string, unknown>)
              : null;
          const rawNoteText =
            noteRec?.content ?? noteRec?.contentMd ?? noteRec?.note;
          const text =
            typeof value === 'string'
              ? value.trim()
              : typeof rawNoteText === 'string'
                ? rawNoteText.trim()
                : '';
          const key = text ? text.toLowerCase() : JSON.stringify(value);
          if (key && !seen.has(key)) {
            seen.add(key);
            unique.push(value);
          }
        }
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

      resolved[field] = this.cloneValue(winner.val);
      assertions.push({
        field,
        value: this.cloneValue(winner.val),
        sourceProvider: winner.candidate.sourceProvider,
        confidenceScore: Number(winner.effectiveWeight.toFixed(3)),
        isUserOverride: false,
        timestamp: new Date().toISOString(),
      });

      if (fieldVariants.length > 1) {
        const conflict = this.detectFieldConflict(field, fieldVariants);
        if (conflict) {
          conflicts.push(conflict);
        }
      }
    }

    const itemType = String(resolved.itemType || 'journalArticle');
    resolveBidirectionalBaseFields(resolved, itemType, undefined, false);

    const finalMetadata: ItemMetadata = {
      title: resolved.title || 'Untitled Document',
      authors: resolved.authors ? [...resolved.authors] : [],
      year: resolved.year ?? null,
      itemType,
      ...resolved,
    };

    const finalRecord = finalMetadata as Record<string, unknown>;
    resolveBidirectionalBaseFields(finalRecord, itemType, undefined, false);

    if (itemType === 'journalArticle') {
      if (finalMetadata.publicationTitle && !finalMetadata.journal) {
        finalMetadata.journal = finalMetadata.publicationTitle;
      } else if (finalMetadata.journal && !finalMetadata.publicationTitle) {
        finalMetadata.publicationTitle = finalMetadata.journal;
      }
    }

    if (
      Array.isArray(finalMetadata.creators) &&
      finalMetadata.creators.length > 0 &&
      (!finalMetadata.authors || finalMetadata.authors.length === 0)
    ) {
      const authorCreators = finalMetadata.creators.filter(
        (c) => c.creatorType === 'author' || !c.creatorType,
      );
      const effectiveList =
        authorCreators.length > 0 ? authorCreators : finalMetadata.creators;
      finalMetadata.authors = effectiveList
        .map(
          (c) =>
            c.fullName ||
            c.name ||
            `${c.firstName || ''} ${c.lastName || ''}`.trim(),
        )
        .filter(Boolean);
    } else if (
      Array.isArray(finalMetadata.authors) &&
      finalMetadata.authors.length > 0 &&
      (!Array.isArray(finalMetadata.creators) ||
        finalMetadata.creators.length === 0)
    ) {
      finalMetadata.creators = finalMetadata.authors
        .map((authorName, idx) => parseCreatorString(authorName, idx, 'author'))
        .filter((c): c is NonNullable<typeof c> => c !== null);
    }

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
      return [...(val as unknown[])];
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
