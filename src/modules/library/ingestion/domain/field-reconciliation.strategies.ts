import {
  MetadataCandidate,
  FieldAssertion,
} from '@/modules/library/ingestion/types/metadata.types';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';
import {
  mergeZoteroExtraTextLines,
  resolveBidirectionalBaseFields,
} from '@/modules/library/core/domain/zotero-field-harmonizer.domain';
import { parseCreatorString } from '@/modules/library/core/domain/author.domain';
import { normalizeArxivId } from '@/modules/library/core/domain/identifier.domain';

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
  isUserOverride?: boolean;
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

function hasFullGivenNameToken(rawGiven: string): boolean {
  const tokens = rawGiven
    .trim()
    .split(/[\s-]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (token.endsWith('.')) continue;
    const cleaned = token.replace(/[^a-zA-Z\u00C0-\u024F\u1E00-\u1EFF]/g, '');
    if (cleaned.length >= 2 && !/^[A-Z]+$/.test(cleaned)) {
      return true;
    }
    if (cleaned.length > 2) {
      return true;
    }
  }
  return false;
}

/**
 * Counts how many entries in a creator/author array contain a full given name
 * (as opposed to single-letter initials like "J." or "J").
 */
export function countFullGivenNames(creatorsOrAuthors: unknown[]): number {
  if (!Array.isArray(creatorsOrAuthors)) return 0;
  let count = 0;
  for (const entry of creatorsOrAuthors) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      if (trimmed.includes(',')) {
        const afterComma = trimmed.split(',').slice(1).join(' ').trim();
        if (hasFullGivenNameToken(afterComma)) {
          count++;
        }
      } else {
        const parts = trimmed.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
          const givenPart = parts.slice(0, -1).join(' ');
          if (hasFullGivenNameToken(givenPart)) {
            count++;
          }
        }
      }
    } else if (entry && typeof entry === 'object') {
      const obj = entry as {
        firstName?: string;
        given?: string;
        givenName?: string;
        fullName?: string;
        name?: string;
        fieldMode?: number;
      };
      if (obj.fieldMode === 1) continue;
      const explicitGiven = obj.firstName ?? obj.given ?? obj.givenName;
      if (typeof explicitGiven === 'string' && explicitGiven.trim()) {
        if (hasFullGivenNameToken(explicitGiven)) {
          count++;
        }
        continue;
      }
      const fullStr = obj.fullName ?? obj.name;
      if (typeof fullStr === 'string' && fullStr.trim()) {
        if (countFullGivenNames([fullStr]) > 0) {
          count++;
        }
      }
    }
  }
  return count;
}

/**
 * Selects the best creator/author list variant, preferring complete lists from
 * authoritative publisher registries (CrossRef, PubMed, arXiv, EnrichedProvider)
 * over shorter/truncated lists or initial-only lists from local extraction.
 */
export function selectAuthoritativeCreatorVariant<
  T extends { sourceProvider?: string; val: unknown; isUserOverride?: boolean },
>(sortedVariants: T[]): T {
  const firstNonEmpty =
    sortedVariants.find((v) => Array.isArray(v.val) && v.val.length > 0) ||
    sortedVariants[0];
  const firstProviderLower = (firstNonEmpty?.sourceProvider || '').toLowerCase();
  if (
    firstNonEmpty?.isUserOverride ||
    firstProviderLower === 'useroverride' ||
    firstProviderLower === 'user' ||
    firstProviderLower === 'manual'
  ) {
    return firstNonEmpty;
  }

  let best = firstNonEmpty;
  for (const cand of sortedVariants) {
    if (
      !AUTHORITATIVE_CREATOR_PROVIDERS.has(
        (cand.sourceProvider || '').toLowerCase(),
      ) ||
      !Array.isArray(cand.val) ||
      cand.val.length === 0
    ) {
      continue;
    }
    if (!Array.isArray(best?.val) || cand.val.length > best.val.length) {
      best = cand;
    } else if (cand.val.length === best.val.length) {
      const candFullCount = countFullGivenNames(cand.val);
      const bestFullCount = countFullGivenNames(best.val);
      if (candFullCount > bestFullCount) {
        best = cand;
      }
    }
  }
  return best;
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
    const topProviderLower = (
      topVariant?.candidate?.sourceProvider || ''
    ).toLowerCase();
    const isTopUserOverride =
      Boolean(topVariant?.isUserOverride) ||
      Boolean(
        (topVariant?.candidate as { isUserOverride?: boolean } | undefined)
          ?.isUserOverride,
      ) ||
      topProviderLower === 'useroverride' ||
      topProviderLower === 'user' ||
      topProviderLower === 'manual';
    const variantsToMerge = isTopUserOverride ? [topVariant] : sortedVariants;

    if (field === 'notes') {
      const uniqueNotes = mergeReconciledNotesArrays(
        variantsToMerge.map((variant) => variant.val),
        false,
      );
      return {
        value: uniqueNotes,
        assertion: {
          field,
          value: cloneReconciledValue(uniqueNotes),
          sourceProvider: topVariant.candidate.sourceProvider,
          confidenceScore: Number(topVariant.effectiveWeight.toFixed(3)),
          isUserOverride: isTopUserOverride,
          timestamp: new Date().toISOString(),
        },
        detectConflicts: false,
      };
    }

    const uniqueTags = mergeReconciledTagArrays(
      variantsToMerge.map((variant) => variant.val),
    );
    return {
      value: uniqueTags,
      assertion: {
        field,
        value: [...uniqueTags],
        sourceProvider: topVariant.candidate.sourceProvider,
        confidenceScore: Number(topVariant.effectiveWeight.toFixed(3)),
        isUserOverride: isTopUserOverride,
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
        isUserOverride: Boolean(winner.isUserOverride),
        timestamp: new Date().toISOString(),
      },
      detectConflicts: true,
    };
  }
}

const ABSTRACT_BOILERPLATE_REGEX =
  /^(?:n\/?a|none|null|undefined|abstract\s+not\s+available\.?|no\s+abstract\s+available\.?|abstract\s+unavailable\.?|not\s+available\.?|-+|\.+)$/i;

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
    let winner = sortedVariants[0];

    if (
      (field === 'abstract' || field === 'abstractNote') &&
      sortedVariants.length > 1
    ) {
      const nonBoilerplate = sortedVariants.filter((v) => {
        if (typeof v.val !== 'string') return false;
        const trimmed = v.val.trim();
        return trimmed.length > 0 && !ABSTRACT_BOILERPLATE_REGEX.test(trimmed);
      });
      const pool = nonBoilerplate.length > 0 ? nonBoilerplate : sortedVariants;
      winner = pool[0];

      const winnerProvider = (
        winner?.candidate?.sourceProvider || ''
      ).toLowerCase();
      const isWinnerUserOverride =
        Boolean(winner?.isUserOverride) ||
        winnerProvider === 'useroverride' ||
        winnerProvider === 'user' ||
        winnerProvider === 'manual';

      if (!isWinnerUserOverride && typeof winner?.val === 'string') {
        const winnerLen = winner.val.trim().length;
        if (winnerLen < 60) {
          const fullerAbstract = pool.slice(1).find((v) => {
            if (typeof v.val !== 'string') return false;
            const len = v.val.trim().length;
            const prov = (v.candidate?.sourceProvider || '').toLowerCase();
            const isTrustedSource =
              AUTHORITATIVE_CREATOR_PROVIDERS.has(prov) ||
              v.effectiveWeight >= 0.5;
            return isTrustedSource && len >= 150 && len >= winnerLen * 3;
          });
          if (fullerAbstract) {
            winner = fullerAbstract;
          }
        }
      }
    }

    return {
      value: cloneReconciledValue(winner.val),
      assertion: {
        field,
        value: cloneReconciledValue(winner.val),
        sourceProvider: winner.candidate.sourceProvider,
        confidenceScore: Number(winner.effectiveWeight.toFixed(3)),
        isUserOverride: Boolean(winner.isUserOverride),
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
    const authorCreators = creatorsList.filter(
      (c) => c.creatorType === 'author' || !c.creatorType,
    );
    const effectiveList =
      authorCreators.length > 0 ? authorCreators : creatorsList;

    if (
      !authorsList ||
      authorsList.length === 0 ||
      effectiveList.length > authorsList.length ||
      (effectiveList.length === authorsList.length &&
        countFullGivenNames(effectiveList) >= countFullGivenNames(authorsList))
    ) {
      resolved.authors = effectiveList
        .map(
          (c) =>
            c.fullName ||
            c.name ||
            `${c.firstName || ''} ${c.lastName || ''}`.trim(),
        )
        .filter(Boolean);
    } else if (
      Array.isArray(authorsList) &&
      (authorsList.length > effectiveList.length ||
        countFullGivenNames(authorsList) > countFullGivenNames(effectiveList))
    ) {
      resolved.creators = (authorsList as string[])
        .map((authorName: string, idx: number) =>
          parseCreatorString(String(authorName), idx, 'author'),
        )
        .filter((c): c is NonNullable<typeof c> => c !== null);
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
