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
import {
  selectAuthoritativeCreatorVariant,
  countFullGivenNames,
  mergeReconciledTagArrays,
  mergeReconciledNotesArrays,
  mergeReconciledExtraText,
  resolveFieldReconciliationStrategy,
  WeightedFieldVariant,
  finalizeReconciledBibliographicMetadata,
  SOURCE_WEIGHTS,
  FIELD_AUTHORITY_WEIGHTS,
  FIELD_AUTHORITY,
  resolveProviderFieldWeight,
} from '@/modules/library/ingestion/policies/reconciliation.policy';

export {
  selectAuthoritativeCreatorVariant,
  countFullGivenNames,
  mergeReconciledTagArrays,
  mergeReconciledNotesArrays,
  mergeReconciledExtraText,
  resolveFieldReconciliationStrategy,
  finalizeReconciledBibliographicMetadata,
  SOURCE_WEIGHTS,
  FIELD_AUTHORITY_WEIGHTS,
  FIELD_AUTHORITY,
  resolveProviderFieldWeight,
};
export type { WeightedFieldVariant };

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
        metadata: clonedMeta,
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

          const isCandUserOverride =
            Boolean((cand as { isUserOverride?: boolean }).isUserOverride) ||
            cand.sourceProvider === 'UserOverride' ||
            cand.sourceProvider === 'user' ||
            cand.sourceProvider === 'manual';

          fieldVariants.push({
            candidate: cand,
            val,
            effectiveWeight: isCandUserOverride ? 10.0 : effectiveWeight,
            isUserOverride: isCandUserOverride,
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

    finalizeReconciledBibliographicMetadata(finalMetadata, candidates);

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
