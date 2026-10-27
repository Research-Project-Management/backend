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
  resolveFieldAliases,
} from '@/modules/library/core/domain/zotero-field-harmonizer.domain';
import { parseCreatorString } from '@/modules/library/core/domain/author.domain';
import { normalizeArxivId } from '@/modules/library/core/domain/identifier.domain';
import {
  selectAuthoritativeCreatorVariant,
  mergeReconciledTagArrays,
  mergeReconciledNotesArrays,
  mergeReconciledExtraText,
  resolveFieldReconciliationStrategy,
  WeightedFieldVariant,
} from '@/modules/library/ingestion/domain/field-reconciliation.strategies';

export {
  selectAuthoritativeCreatorVariant,
  mergeReconciledTagArrays,
  mergeReconciledNotesArrays,
  mergeReconciledExtraText,
  resolveFieldReconciliationStrategy,
};
export type { WeightedFieldVariant };

export {
  SOURCE_WEIGHTS,
  FIELD_AUTHORITY_WEIGHTS,
  FIELD_AUTHORITY,
  resolveProviderFieldWeight,
} from '@/modules/library/core';
import { resolveProviderFieldWeight } from '@/modules/library/core';

/**
 * Shared post-reconciliation cleanup for resolved bibliographic metadata:
 * - Default `title` and `itemType`
 * - Bidirectional Zotero base-field harmonization (`publicationTitle` <-> `journal`, etc.)
 * - Canonical `preprint` vs. non-arXiv publisher DOI cleanup (`arXiv` repository/DOI vs. stripping stale journal fields)
 * - Bidirectional `creators` <-> `authors` synchronization
 */
export function finalizeReconciledBibliographicMetadata(
  resolved: Record<string, unknown>,
  _candidates?: Array<{
    sourceProvider?: string;
    metadata?: Record<string, unknown>;
  }>,
): void {
  if (!resolved.title) {
    resolved.title = 'Untitled Document';
  }
  if (!resolved.itemType || typeof resolved.itemType !== 'string') {
    resolved.itemType = 'journalArticle';
  }

  const itemType = String(resolved.itemType);
  const resolvedYearNum =
    typeof resolved.year === 'number'
      ? resolved.year
      : typeof resolved.year === 'string' && /^\d{4}$/.test(resolved.year.trim())
        ? Number(resolved.year.trim())
        : undefined;
  if (resolvedYearNum && resolvedYearNum >= 1000 && resolvedYearNum <= 2999) {
    const yearStr = String(resolvedYearNum);
    for (const dateKey of ['publicationDate', 'date'] as const) {
      const rawDate = resolved[dateKey];
      if (typeof rawDate === 'string' && rawDate.trim()) {
        const matchYear = rawDate.match(/\b(19\d{2}|20\d{2})\b/);
        if (matchYear && matchYear[1] !== yearStr) {
          const matchingCandDate = _candidates
            ?.map((c) => {
              const meta = c.metadata ?? (c as Record<string, unknown>);
              const candVal = meta?.[dateKey];
              if (typeof candVal === 'string') return candVal;
              if (
                candVal &&
                typeof candVal === 'object' &&
                typeof (candVal as { normalizedValue?: unknown }).normalizedValue === 'string'
              ) {
                return (candVal as { normalizedValue: string }).normalizedValue;
              }
              return undefined;
            })
            .find(
              (d) =>
                typeof d === 'string' &&
                d.match(/\b(19\d{2}|20\d{2})\b/)?.[1] === yearStr,
            );
          resolved[dateKey] = matchingCandDate ?? yearStr;
        }
      }
    }
  }
  resolveBidirectionalBaseFields(resolved, itemType, undefined, false);

  if (itemType === 'journalArticle') {
    if (resolved.publicationTitle && !resolved.journal) {
      resolved.journal = resolved.publicationTitle;
    } else if (resolved.journal && !resolved.publicationTitle) {
      resolved.publicationTitle = resolved.journal;
    }
  } else if (itemType === 'preprint') {
    const rawArxivCandidate =
      normalizeArxivId(
        String(
          resolved.arxivId ||
            (/^arxiv:/i.test(String(resolved.archiveId || ''))
              ? resolved.archiveId
              : '') ||
            (typeof resolved.doi === 'string' &&
            /^10\.48550\/arxiv\./i.test(resolved.doi)
              ? resolved.doi.replace(/^10\.48550\/arxiv\./i, '')
              : ''),
        ),
        { stripVersion: true },
      ) || '';
    const isValidArxivId =
      /^\d{4}\.\d{4,5}$/.test(rawArxivCandidate) ||
      /^[a-z-]+(?:\.[a-z]{2})?\/\d{7}$/i.test(rawArxivCandidate);
    const isNonArxivDoi = Boolean(
      typeof resolved.doi === 'string' &&
        resolved.doi.trim() &&
        !/^10\.48550\/arxiv\./i.test(resolved.doi.trim()),
    );
    if (isValidArxivId && !isNonArxivDoi) {
      resolved.repository = resolved.repository || 'arXiv';
      resolved.archive = resolved.archive || 'arXiv';
      resolved.arxivId = rawArxivCandidate;
      resolved.archiveId = `arXiv:${rawArxivCandidate}`;
      resolved.doi = `10.48550/arXiv.${rawArxivCandidate}`;
    } else {
      resolved.repository =
        resolved.repository ||
        resolved.institution ||
        resolved.publicationTitle ||
        resolved.journal ||
        resolved.publisher;
    }
    delete resolved.publicationTitle;
    delete resolved.journal;
    delete resolved.proceedingsTitle;
    delete resolved.conferenceName;
    delete resolved.bookTitle;
    delete resolved.series;
    delete resolved.volume;
    delete resolved.issue;
    delete resolved.pages;
    delete resolved.journalAbbr;
    delete resolved.journalAbbreviation;
    delete resolved.issn;
    delete resolved.isbn;
    if (resolved.extraFields && typeof resolved.extraFields === 'object') {
      const ef = resolved.extraFields as Record<string, unknown>;
      delete ef.publicationTitle;
      delete ef.journal;
      delete ef.proceedingsTitle;
      delete ef.conferenceName;
      delete ef.bookTitle;
      delete ef.series;
      delete ef.volume;
      delete ef.issue;
      delete ef.pages;
      delete ef.journalAbbr;
      delete ef.journalAbbreviation;
      delete ef.issn;
      delete ef.isbn;
    }
  }

  if (Array.isArray(resolved.creators) && resolved.creators.length > 0) {
    const creatorsList = resolved.creators as Array<{
      creatorType?: string;
      fullName?: string;
      name?: string;
      firstName?: string;
      lastName?: string;
    }>;
    const authorsList = resolved.authors as unknown[] | undefined;
    if (
      !authorsList ||
      authorsList.length === 0 ||
      authorsList.length !== creatorsList.length
    ) {
      const authorCreators = creatorsList.filter(
        (c) => c.creatorType === 'author' || !c.creatorType,
      );
      const effectiveList =
        authorCreators.length > 0 ? authorCreators : creatorsList;
      resolved.authors = effectiveList
        .map(
          (c) =>
            c.fullName ||
            c.name ||
            `${c.firstName || ''} ${c.lastName || ''}`.trim(),
        )
        .filter(Boolean);
    }
  } else if (Array.isArray(resolved.authors) && resolved.authors.length > 0) {
    if (!Array.isArray(resolved.creators) || resolved.creators.length === 0) {
      resolved.creators = (resolved.authors as string[])
        .map((authorName: string, idx: number) =>
          parseCreatorString(authorName, idx, 'author'),
        )
        .filter((c): c is NonNullable<typeof c> => c !== null);
    }
  }
}

@Injectable()
export class MetadataReconciliationService {
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

    const normalizedCandidates: MetadataCandidate[] = candidates.map((cand) => {
      if (!cand?.metadata || typeof cand.metadata !== 'object') return cand;
      const clonedMeta: Record<string, unknown> = { ...cand.metadata };
      const candType = String(clonedMeta.itemType || 'journalArticle');
      resolveFieldAliases(clonedMeta);
      resolveBidirectionalBaseFields(clonedMeta, candType, undefined, false);
      return {
        ...cand,
        metadata: clonedMeta as ItemMetadata,
      };
    });

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
    for (const cand of normalizedCandidates) {
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

      const fieldVariants: WeightedFieldVariant[] = [];

      for (const cand of normalizedCandidates) {
        const val = cand.metadata[field];
        if (val !== undefined && val !== null && val !== '') {
          if (Array.isArray(val) && val.length === 0) continue;

          const providerWeight = resolveProviderFieldWeight(
            cand.sourceProvider,
            field,
          );
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

      const strategy = resolveFieldReconciliationStrategy(field);
      const outcome = strategy.reconcileField(field, fieldVariants);
      (resolved as Record<string, unknown>)[field] = outcome.value;
      assertions.push(outcome.assertion);

      if (outcome.detectConflicts && fieldVariants.length > 1) {
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

    finalizeReconciledBibliographicMetadata(
      finalMetadata as Record<string, unknown>,
      candidates,
    );

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
