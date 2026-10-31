import { isIP } from 'node:net';
import { BaseDomainException } from '@/modules/library/core/errors/domain.exception';
import {
  ProviderName,
  QueryType,
  ItemMetadata,
  DuplicateMatchResult,
  CreatorInput,
} from '@/modules/library/ingestion/types/metadata.types';
import { SsrfGuardService } from '@/modules/library/core/services/ssrf-guard.service';
import {
  normalizeDoi,
  isInstitutionName,
  splitAuthorString,
  parseCreatorString,
  cleanBibliographicText,
} from '@/modules/library/core';
import {
  resolveCanonicalCreatorRole,
  getPrimaryCreatorRoleForType,
} from '@/modules/library/core/domain/zotero-field-harmonizer.domain';
import {
  calculateTitleSimilarity,
  firstAuthorMatches,
} from '@/modules/library/ingestion/domain/deduplication.domain';

export class SsrfBlockedDomainException extends BaseDomainException {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedDomainException';
  }
}

export const METADATA_POLICY_VERSION = 3;

export interface RoutingOptions {
  includeCitations?: boolean;
  includeReferences?: boolean;
  aggressive?: boolean;
}

export interface RoutingTiers {
  authoritative: ProviderName[];
  enrichment: ProviderName[];
  fallback: ProviderName[];
}

export class MetadataRoutingPolicy {
  static readonly PARALLEL_LIMIT = 2;
  private static readonly ssrfGuard = new SsrfGuardService();

  static getTiers(
    queryType: QueryType,
    options?: RoutingOptions,
  ): RoutingTiers {
    const wantsGraph = Boolean(
      options?.includeCitations ||
      options?.includeReferences ||
      options?.aggressive,
    );

    switch (queryType) {
      case 'DOI':
        return {
          authoritative: ['CrossRef'],
          enrichment: wantsGraph ? ['OpenAlex', 'SemanticScholar'] : [],
          fallback: ['OpenAlex', 'DBLP'],
        };

      case 'ARXIV':
        return {
          authoritative: ['arXiv'],
          enrichment: wantsGraph ? ['OpenAlex', 'SemanticScholar'] : [],
          fallback: ['CrossRef', 'OpenAlex'],
        };

      case 'PMID':
        return {
          authoritative: ['PubMed'],
          enrichment: wantsGraph ? ['OpenAlex', 'SemanticScholar'] : [],
          fallback: ['OpenAlex'],
        };

      case 'ISBN':
        return {
          authoritative: ['OpenLibrary'],
          enrichment: [],
          fallback: ['OpenAlex'],
        };

      case 'URL':
        return {
          authoritative: ['CrossRef'],
          enrichment: [],
          fallback: ['OpenAlex'],
        };

      case 'TITLE':
      default:
        return {
          authoritative: ['CrossRef'],
          enrichment: wantsGraph ? ['OpenAlex', 'SemanticScholar'] : [],
          fallback: ['OpenAlex', 'DBLP'],
        };
    }
  }

  static async assertSafeUrl(
    rawUrl: string,
    ssrfGuard?: SsrfGuardService,
  ): Promise<void> {
    const guard = ssrfGuard ?? this.ssrfGuard;
    try {
      await guard.assertSafeUrl(rawUrl);
    } catch (err: unknown) {
      throw new SsrfBlockedDomainException(
        err instanceof Error
          ? err.message
          : 'SSRF Protection: Destination blocked by security policy',
      );
    }
  }

  static validateUrl(rawUrl: string, ssrfGuard?: SsrfGuardService): void {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new SsrfBlockedDomainException(
        `SSRF Protection: Malformed or invalid URL "${rawUrl}"`,
      );
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SsrfBlockedDomainException(
        `SSRF Protection: Blocked unsupported protocol "${parsed.protocol}" in URL: ${rawUrl}`,
      );
    }

    if (parsed.username || parsed.password) {
      throw new SsrfBlockedDomainException(
        'SSRF Protection: URLs containing credentials are not permitted.',
      );
    }

    const hostname = parsed.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.+$/, '');
    if (
      !hostname ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.cluster.local') ||
      hostname === 'metadata.google.internal'
    ) {
      throw new SsrfBlockedDomainException(
        `SSRF Protection: Blocked request to restricted host "${hostname}"`,
      );
    }

    if (/^(0x[0-9a-f]+|\d+)$/i.test(hostname)) {
      throw new SsrfBlockedDomainException(
        `SSRF Protection: Blocked numeric/hexadecimal IP notation "${hostname}"`,
      );
    }

    const guard = ssrfGuard ?? this.ssrfGuard;
    if (isIP(hostname) && guard.isPrivateOrReservedIp(hostname)) {
      throw new SsrfBlockedDomainException(
        `SSRF Protection: Blocked request to restricted IP "${hostname}"`,
      );
    }
  }
}

// ============================================================================
// Duplicate Policy
// ============================================================================

export interface ExistingItemSummary {
  id: string;
  title: string;
  doi?: string | null;
  year?: number | null;
  authors?: string[];
  citationKey?: string | null;
}

export class DuplicatePolicy {
  evaluate(
    proposed: ItemMetadata,
    existingItems: ExistingItemSummary[],
  ): DuplicateMatchResult {
    const cleanProposedDoi =
      normalizeDoi(proposed.doi) || proposed.doi?.toLowerCase().trim();

    if (cleanProposedDoi) {
      const exactDoiMatch = existingItems.find((it) => {
        if (!it.doi) return false;
        const cleanExistingDoi =
          normalizeDoi(it.doi) || it.doi.toLowerCase().trim();
        return cleanExistingDoi === cleanProposedDoi;
      });
      if (exactDoiMatch) {
        return {
          matchType: 'EXACT',
          confidence: 1.0,
          targetItemId: exactDoiMatch.id,
          targetItemTitle: exactDoiMatch.title,
          matchReason: 'DOI_EXACT',
          evidence: { doi: cleanProposedDoi },
        };
      }
    }

    if (proposed.title && proposed.title.trim().length > 5) {
      for (const item of existingItems) {
        if (!item.title) continue;
        const similarity = calculateTitleSimilarity(proposed.title, item.title);
        if (similarity >= 0.88) {
          const hasBothYears =
            proposed.year !== undefined &&
            proposed.year !== null &&
            item.year !== undefined &&
            item.year !== null;
          const yearMatch =
            hasBothYears &&
            Math.abs(Number(proposed.year) - Number(item.year)) <= 1;
          const yearConflict =
            hasBothYears &&
            Math.abs(Number(proposed.year) - Number(item.year)) > 1;
          const authorMatch =
            proposed.authors &&
            proposed.authors.length > 0 &&
            item.authors &&
            item.authors.length > 0 &&
            firstAuthorMatches(proposed.authors[0], item.authors[0]);

          if (!yearConflict && (yearMatch || authorMatch)) {
            return {
              matchType: 'PROBABLE',
              confidence: 0.85,
              targetItemId: item.id,
              targetItemTitle: item.title,
              matchReason: 'TITLE_FUZZY',
              evidence: {
                proposedTitle: proposed.title,
                existingTitle: item.title,
                yearMatch: Boolean(yearMatch),
                authorMatch: Boolean(authorMatch),
              },
            };
          }
        }
      }
    }

    return {
      matchType: 'NO_MATCH',
      confidence: 0.0,
      matchReason: 'NONE',
    };
  }
}

// ============================================================================
// Creator Normalization Policy
// ============================================================================

function cleanCreatorString(val: unknown): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'string') return cleanBibliographicText(val);
  if (
    typeof val === 'number' ||
    typeof val === 'boolean' ||
    typeof val === 'bigint'
  ) {
    return String(val).trim();
  }
  return undefined;
}

export function normalizeCreators(
  creatorsInput?: CreatorInput[],
  authorsInput?: string[],
  editorsInput?: string[],
  itemType?: string,
): CreatorInput[] {
  const list: CreatorInput[] = [];

  const append = (creator: CreatorInput) => {
    const creatorType = resolveCanonicalCreatorRole(creator.creatorType, {
      itemType,
    });
    let firstName = (creator.firstName || '').trim();
    let lastName = (creator.lastName || '').trim();
    let fullName = (creator.fullName || creator.name || '').trim();
    let fieldMode: number | undefined = creator.fieldMode;
    const shortName = cleanCreatorString(creator.shortName);

    if (fieldMode === 1) {
      const single = cleanCreatorString(lastName || fullName || firstName);
      if (!single) return;
      list.push({
        creatorType,
        name: single,
        fullName: single,
        lastName: single,
        fieldMode: 1,
        ...(shortName ? { shortName } : {}),
      });
      return;
    }

    const looksLikeOrg =
      !firstName && !!fullName && isInstitutionName(fullName);

    if (
      fullName &&
      !looksLikeOrg &&
      !firstName &&
      !lastName &&
      (fullName.includes(';') || /\s+(?:and|&)\s+/i.test(fullName))
    ) {
      const parts = splitAuthorString(fullName);
      if (parts.length > 1) {
        for (const part of parts) {
          append({ creatorType, fullName: part });
        }
        return;
      }
    }

    if (fullName && (fullName.includes(',') || (!firstName && !lastName))) {
      const parsed = parseCreatorString(fullName, 0, creatorType);
      if (parsed.fieldMode === 1) {
        fieldMode = 1;
        firstName = '';
        lastName = parsed.lastName || fullName;
        fullName = parsed.fullName || fullName;
      } else {
        firstName = parsed.firstName || firstName;
        lastName = parsed.lastName || lastName;
        fullName = parsed.fullName || fullName;
      }
    } else if (!fullName && (firstName || lastName)) {
      fullName = `${firstName} ${lastName}`.trim();
    }

    const cleanFirst = cleanCreatorString(firstName) || '';
    const cleanLast = cleanCreatorString(lastName) || '';
    const cleanFull = cleanCreatorString(fullName) || '';

    if (!cleanFull && !cleanFirst && !cleanLast) return;

    const effectiveName = cleanFull || `${cleanFirst} ${cleanLast}`.trim();

    list.push({
      creatorType,
      name: effectiveName,
      fullName: effectiveName,
      firstName: fieldMode === 1 ? undefined : cleanFirst || undefined,
      lastName: cleanLast || (fieldMode === 1 ? effectiveName : undefined),
      fieldMode: fieldMode === 1 ? 1 : 0,
      ...(shortName ? { shortName } : {}),
    });
  };

  const hasStructuredCreators =
    Array.isArray(creatorsInput) && creatorsInput.length > 0;
  const primaryRole = getPrimaryCreatorRoleForType(itemType);

  if (hasStructuredCreators) {
    for (const c of creatorsInput) {
      if (!c || typeof c !== 'object') continue;
      append(c);
    }
  }

  if (Array.isArray(authorsInput) && authorsInput.length > 0) {
    const existingList = [...list];
    list.length = 0;
    for (const a of authorsInput as unknown[]) {
      if (a && typeof a === 'object') {
        const obj = a as CreatorInput;
        append({ ...obj, creatorType: obj.creatorType || primaryRole });
        continue;
      }
      if (typeof a !== 'string') continue;
      for (const author of splitAuthorString(a)) {
        const cleanA = cleanCreatorString(author);
        if (!cleanA) continue;
        const parsed = parseCreatorString(cleanA, 0, primaryRole);
        append({
          creatorType: primaryRole,
          name: parsed.fullName,
          fullName: parsed.fullName,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          fieldMode: parsed.fieldMode,
        });
      }
    }
    const parsedAuthors = [...list];
    list.length = 0;

    if (!hasStructuredCreators) {
      list.push(...parsedAuthors);
    } else if (parsedAuthors.length > 0) {
      const isPrimaryRole = (role?: string) => {
        const r = (role || 'author').toLowerCase();
        return r === 'author' || r === primaryRole.toLowerCase();
      };
      const existingPrimary = existingList.filter((c) =>
        isPrimaryRole(c.creatorType),
      );
      const existingNonPrimary = existingList.filter(
        (c) => !isPrimaryRole(c.creatorType),
      );
      const existingPrimaryNames = new Set(
        existingPrimary.map((c) => (c.fullName || c.name || '').toLowerCase()),
      );
      const parsedAuthorNames = new Set(
        parsedAuthors.map((c) => (c.fullName || c.name || '').toLowerCase()),
      );
      const allExistingInParsed =
        existingPrimary.length > 0 &&
        existingPrimary.every((c) =>
          parsedAuthorNames.has((c.fullName || c.name || '').toLowerCase()),
        );
      if (existingPrimary.length === 0) {
        list.push(...parsedAuthors, ...existingNonPrimary);
      } else if (allExistingInParsed) {
        list.push(...existingPrimary);
        for (const pa of parsedAuthors) {
          if (
            !existingPrimaryNames.has(
              (pa.fullName || pa.name || '').toLowerCase(),
            )
          ) {
            list.push(pa);
          }
        }
        list.push(...existingNonPrimary);
      } else {
        list.push(...parsedAuthors, ...existingNonPrimary);
      }
    } else {
      list.push(...existingList);
    }
  }

  const hasStructuredEditors =
    hasStructuredCreators &&
    creatorsInput.some((c) => c && c.creatorType === 'editor');

  if (!hasStructuredEditors && Array.isArray(editorsInput)) {
    for (const editor of editorsInput as unknown[]) {
      if (editor && typeof editor === 'object') {
        const obj = editor as CreatorInput;
        append({ ...obj, creatorType: 'editor' });
        continue;
      }
      if (typeof editor !== 'string') continue;
      for (const singleEditor of splitAuthorString(editor)) {
        const cleanEditor = cleanCreatorString(singleEditor);
        if (!cleanEditor) continue;
        const parsed = parseCreatorString(cleanEditor, 0, 'editor');
        append({
          creatorType: 'editor',
          name: parsed.fullName,
          fullName: parsed.fullName,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          fieldMode: parsed.fieldMode,
        });
      }
    }
  }

  const seen = new Set<string>();
  const deduped: CreatorInput[] = [];
  for (const c of list) {
    const key = `${(c.creatorType || 'author').toLowerCase()}::${(c.fullName || c.name || '').toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(c);
    }
  }
  return deduped;
}
