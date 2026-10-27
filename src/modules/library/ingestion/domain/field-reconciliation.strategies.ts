import {
  MetadataCandidate,
  FieldAssertion,
} from '@/modules/library/ingestion/types/metadata.types';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';
import { mergeZoteroExtraTextLines } from '@/modules/library/core/domain/zotero-field-harmonizer.domain';

const AUTHORITATIVE_CREATOR_PROVIDERS = new Set([
  'crossref',
  'pubmed',
  'arxiv',
  'enrichedprovider',
  'openalex',
  'semanticscholar',
  'dblp',
  'zoterosync',
  'zotero',
  'bibtex',
  'ris',
]);

export interface WeightedFieldVariant {
  candidate: MetadataCandidate;
  val: unknown;
  effectiveWeight: number;
}

export interface ReconciledFieldOutcome {
  value: unknown;
  assertion: FieldAssertion;
  detectConflicts: boolean;
}

export interface IFieldReconciliationStrategy {
  readonly strategyName: string;
  supports(field: string): boolean;
  reconcileField(
    field: string,
    sortedVariants: WeightedFieldVariant[],
  ): ReconciledFieldOutcome;
}

function cloneReconciledValue<T>(val: T): T {
  if (Array.isArray(val)) {
    return [...(val as unknown[])] as unknown as T;
  }
  if (val !== null && typeof val === 'object') {
    return { ...(val as Record<string, unknown>) } as unknown as T;
  }
  return val;
}

/**
 * Selects the best creator/author list variant, preferring complete lists from
 * authoritative publisher registries (CrossRef, PubMed, arXiv, EnrichedProvider)
 * over shorter/truncated lists from local extraction.
 */
export function selectAuthoritativeCreatorVariant<
  T extends { sourceProvider?: string; val: unknown },
>(sortedVariants: T[]): T {
  const firstNonEmpty =
    sortedVariants.find((v) => Array.isArray(v.val) && v.val.length > 0) ||
    sortedVariants[0];
  const firstProviderLower = (firstNonEmpty?.sourceProvider || '').toLowerCase();
  if (
    firstProviderLower === 'useroverride' ||
    firstProviderLower === 'user' ||
    firstProviderLower === 'manual'
  ) {
    return firstNonEmpty;
  }
  const authoritative = sortedVariants.find(
    (v) =>
      AUTHORITATIVE_CREATOR_PROVIDERS.has(
        (v.sourceProvider || '').toLowerCase(),
      ) &&
      Array.isArray(v.val) &&
      v.val.length > 0,
  );
  if (
    authoritative &&
    Array.isArray(authoritative.val) &&
    Array.isArray(firstNonEmpty?.val) &&
    authoritative.val.length > firstNonEmpty.val.length
  ) {
    return authoritative;
  }
  for (const cand of sortedVariants) {
    if (
      AUTHORITATIVE_CREATOR_PROVIDERS.has(
        (cand.sourceProvider || '').toLowerCase(),
      ) &&
      Array.isArray(cand.val) &&
      Array.isArray(firstNonEmpty?.val) &&
      cand.val.length > firstNonEmpty.val.length
    ) {
      return cand;
    }
  }
  return firstNonEmpty;
}

/**
 * Unions and normalizes academic tags/keywords/labels across multiple candidate arrays.
 */
export function mergeReconciledTagArrays(arrays: unknown[]): string[] {
  const candidateTags: string[] = [];
  for (const arr of arrays) {
    if (Array.isArray(arr)) {
      for (const t of arr) {
        if (typeof t === 'string' && t.trim()) {
          candidateTags.push(t.trim());
        }
      }
    }
  }
  return normalizeAcademicTags(candidateTags);
}

/**
 * Deduplicates notes across multiple candidate arrays by case-insensitive content text.
 */
export function mergeReconciledNotesArrays(
  arrays: unknown[],
  normalizeToObject = false,
): unknown[] {
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const noteObj =
        item && typeof item === 'object'
          ? (item as Record<string, unknown>)
          : null;
      const rawNoteContent =
        noteObj?.content ?? noteObj?.contentMd ?? noteObj?.note;
      const text =
        typeof item === 'string'
          ? item.trim()
          : typeof rawNoteContent === 'string'
            ? rawNoteContent.trim()
            : '';
      const dedupeKey = text
        ? text.toLowerCase()
        : normalizeToObject
          ? ''
          : JSON.stringify(item);
      if (dedupeKey && !seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        if (normalizeToObject) {
          merged.push(
            typeof item === 'string'
              ? { content: text }
              : {
                  content: text,
                  ...(typeof noteObj?.title === 'string' && noteObj.title.trim()
                    ? { title: noteObj.title.trim() }
                    : {}),
                  ...(typeof noteObj?.source === 'string' &&
                  noteObj.source.trim()
                    ? { source: noteObj.source.trim() }
                    : {}),
                  ...(Array.isArray(noteObj?.tags) && noteObj.tags.length > 0
                    ? { tags: noteObj.tags as string[] }
                    : {}),
                },
          );
        } else {
          merged.push(item);
        }
      }
    }
  }
  return merged;
}

/**
 * Merges plain-text Zotero `Extra` blocks in priority order, preserving unique `Key: Value`
 * entries and free-form lines without duplicating keys already provided by a higher-trust source.
 */
export function mergeReconciledExtraText(variants: unknown[]): string {
  return mergeZoteroExtraTextLines(variants);
}

/**
 * Strategy 1: `ExtraFieldsMergeReconciliationStrategy`
 * Deep-merges `extraFields` dictionaries and additively merges plain-text `extra` lines
 * so higher-trust provider keys override lower-trust ones while preserving unique supplemental keys.
 */
export class ExtraFieldsMergeReconciliationStrategy
  implements IFieldReconciliationStrategy
{
  readonly strategyName = 'EXTRA_FIELDS_MERGE';

  supports(field: string): boolean {
    return field === 'extraFields' || field === 'extra';
  }

  reconcileField(
    field: string,
    sortedVariants: WeightedFieldVariant[],
  ): ReconciledFieldOutcome {
    const topVariant = sortedVariants[0];
    if (
      field === 'extra' &&
      sortedVariants.some((variant) => typeof variant.val === 'string')
    ) {
      const mergedText = mergeReconciledExtraText(
        sortedVariants.map((variant) => variant.val),
      );
      return {
        value: mergedText,
        assertion: {
          field,
          value: mergedText,
          sourceProvider: topVariant.candidate.sourceProvider,
          confidenceScore: Number(topVariant.effectiveWeight.toFixed(3)),
          isUserOverride: false,
          timestamp: new Date().toISOString(),
        },
        detectConflicts: false,
      };
    }

    const merged = sortedVariants
      .slice()
      .reverse()
      .reduce<Record<string, unknown>>(
        (accumulator, variant) => ({
          ...accumulator,
          ...(variant.val && typeof variant.val === 'object'
            ? (variant.val as Record<string, unknown>)
            : {}),
        }),
        {},
      );
    return {
      value: merged,
      assertion: {
        field,
        value: cloneReconciledValue(merged),
        sourceProvider: topVariant.candidate.sourceProvider,
        confidenceScore: Number(topVariant.effectiveWeight.toFixed(3)),
        isUserOverride: false,
        timestamp: new Date().toISOString(),
      },
      detectConflicts: false,
    };
  }
}

/**
 * Strategy 2: `AppendOnlyUniqueArrayReconciliationStrategy`
 * Reconciles `tags`, `labels`, `keywords`, and `notes` by unioning and deduplicating
 * across all candidate arrays without discarding non-conflicting entries.
 */
export class AppendOnlyUniqueArrayReconciliationStrategy
  implements IFieldReconciliationStrategy
{
  readonly strategyName = 'APPEND_ONLY_UNIQUE_ARRAY';

  supports(field: string): boolean {
    return (
      field === 'tags' ||
      field === 'labels' ||
      field === 'keywords' ||
      field === 'notes'
    );
  }

  reconcileField(
    field: string,
    sortedVariants: WeightedFieldVariant[],
  ): ReconciledFieldOutcome {
    const topVariant = sortedVariants[0];
    if (field === 'notes') {
      const uniqueNotes = mergeReconciledNotesArrays(
        sortedVariants.map((variant) => variant.val),
        false,
      );
      return {
        value: uniqueNotes,
        assertion: {
          field,
          value: cloneReconciledValue(uniqueNotes),
          sourceProvider: topVariant.candidate.sourceProvider,
          confidenceScore: Number(topVariant.effectiveWeight.toFixed(3)),
          isUserOverride: false,
          timestamp: new Date().toISOString(),
        },
        detectConflicts: false,
      };
    }

    const uniqueTags = mergeReconciledTagArrays(
      sortedVariants.map((variant) => variant.val),
    );
    return {
      value: uniqueTags,
      assertion: {
        field,
        value: [...uniqueTags],
        sourceProvider: topVariant.candidate.sourceProvider,
        confidenceScore: Number(topVariant.effectiveWeight.toFixed(3)),
        isUserOverride: false,
        timestamp: new Date().toISOString(),
      },
      detectConflicts: false,
    };
  }
}

/**
 * Strategy 3: `CreatorCompletenessReconciliationStrategy`
 * Reconciles `creators` and `authors` by preferring complete lists from authoritative
 * registries over truncated lists.
 */
export class CreatorCompletenessReconciliationStrategy
  implements IFieldReconciliationStrategy
{
  readonly strategyName = 'CREATOR_COMPLETENESS';

  supports(field: string): boolean {
    return field === 'creators' || field === 'authors';
  }

  reconcileField(
    field: string,
    sortedVariants: WeightedFieldVariant[],
  ): ReconciledFieldOutcome {
    const winner = selectAuthoritativeCreatorVariant(
      sortedVariants.map((v) => ({
        ...v,
        sourceProvider: v.candidate.sourceProvider,
      })),
    );

    return {
      value: cloneReconciledValue(winner.val),
      assertion: {
        field,
        value: cloneReconciledValue(winner.val),
        sourceProvider: winner.candidate.sourceProvider,
        confidenceScore: Number(winner.effectiveWeight.toFixed(3)),
        isUserOverride: false,
        timestamp: new Date().toISOString(),
      },
      detectConflicts: true,
    };
  }
}

/**
 * Strategy 4: `ScalarTrustHierarchyReconciliationStrategy`
 * Default weighted trust + completeness scoring for scalar bibliographic fields.
 */
export class ScalarTrustHierarchyReconciliationStrategy
  implements IFieldReconciliationStrategy
{
  readonly strategyName = 'SCALAR_TRUST_HIERARCHY';

  supports(_field: string): boolean {
    return true;
  }

  reconcileField(
    field: string,
    sortedVariants: WeightedFieldVariant[],
  ): ReconciledFieldOutcome {
    const winner = sortedVariants[0];
    return {
      value: cloneReconciledValue(winner.val),
      assertion: {
        field,
        value: cloneReconciledValue(winner.val),
        sourceProvider: winner.candidate.sourceProvider,
        confidenceScore: Number(winner.effectiveWeight.toFixed(3)),
        isUserOverride: false,
        timestamp: new Date().toISOString(),
      },
      detectConflicts: true,
    };
  }
}

export const FIELD_RECONCILIATION_STRATEGIES: readonly IFieldReconciliationStrategy[] =
  [
    new ExtraFieldsMergeReconciliationStrategy(),
    new AppendOnlyUniqueArrayReconciliationStrategy(),
    new CreatorCompletenessReconciliationStrategy(),
    new ScalarTrustHierarchyReconciliationStrategy(),
  ];

const DEFAULT_SCALAR_STRATEGY =
  new ScalarTrustHierarchyReconciliationStrategy();

export function resolveFieldReconciliationStrategy(
  field: string,
  strategies: readonly IFieldReconciliationStrategy[] = FIELD_RECONCILIATION_STRATEGIES,
): IFieldReconciliationStrategy {
  return (
    strategies.find((strategy) => strategy.supports(field)) ??
    DEFAULT_SCALAR_STRATEGY
  );
}
