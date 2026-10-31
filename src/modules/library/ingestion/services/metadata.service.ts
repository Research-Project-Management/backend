import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  METADATA_PROVIDERS,
  MetadataPort,
  FieldProvenance,
  ItemMetadata,
  MetadataProvider,
  MetadataRequest,
  ProviderExecutionResult,
  ProviderName,
  ProviderResult,
  ResolvedMetadata,
  Provenance,
} from '@/modules/library/ingestion/types/metadata.types';
import { QueryClassifier } from '@/modules/library/ingestion/parsers/bibtex.parser';
import {
  deriveDoiFromPublisherUrl,
  formatCanonicalId,
  normalizeArxivId,
  normalizeDoi,
  normalizePmcid,
  normalizePmid,
  resolveBidirectionalBaseFields,
  resolveFieldAliases,
  titleSimilarity,
  finalizeReconciledBibliographicMetadata,
} from '@/modules/library/core';
import {
  MetadataRoutingPolicy,
  METADATA_POLICY_VERSION,
} from '@/modules/library/ingestion/policies/metadata.policy';
import { MetadataCache } from '@/modules/library/ingestion/repositories/metadata.cache';
import { MetadataExecutorService } from './metadata-executor.service';
import { validateMetadata } from '@/modules/library/ingestion/domain/metadata.validator';
import { SsrfGuardService } from '@/modules/library/core/services/ssrf-guard.service';

@Injectable()
export class MetadataService implements MetadataPort {
  private readonly logger = new Logger(MetadataService.name);
  private readonly providerMap = new Map<ProviderName, MetadataProvider>();

  constructor(
    @Inject(METADATA_PROVIDERS)
    providers: MetadataProvider[],
    private readonly cache: MetadataCache,
    private readonly executor: MetadataExecutorService,
    @Optional() private readonly ssrfGuard?: SsrfGuardService,
  ) {
    for (const provider of providers) {
      this.providerMap.set(provider.id, provider);
    }
  }

  /**
   * Canonical resolution entry point.
   */
  async resolve(request: MetadataRequest): Promise<ResolvedMetadata | null> {
    const rawQuery = request?.query;
    if (!rawQuery || typeof rawQuery !== 'string' || !rawQuery.trim()) {
      return null;
    }

    const cleanQuery = rawQuery.trim();
    const startedAt = Date.now();

    // 1. Classification
    let classified = request.queryType
      ? { raw: cleanQuery, clean: cleanQuery, type: request.queryType }
      : QueryClassifier.classify(cleanQuery);

    // 2. SSRF check for URL queries
    if (classified.type === 'URL') {
      await MetadataRoutingPolicy.assertSafeUrl(
        classified.clean,
        this.ssrfGuard,
      );

      const embeddedDoi =
        normalizeDoi(classified.clean) ||
        deriveDoiFromPublisherUrl(classified.clean);
      if (embeddedDoi) {
        classified = {
          raw: cleanQuery,
          clean: embeddedDoi,
          type: 'DOI',
        };
      } else {
        const embeddedArxiv = normalizeArxivId(classified.clean);
        if (embeddedArxiv) {
          classified = {
            raw: cleanQuery,
            clean: embeddedArxiv,
            type: 'ARXIV',
          };
        } else {
          const embeddedPmid =
            normalizePmid(classified.clean) || normalizePmcid(classified.clean);
          if (embeddedPmid) {
            classified = {
              raw: cleanQuery,
              clean: embeddedPmid,
              type: 'PMID',
            };
          }
        }
      }
    }

    // 3. Canonical ID and cache key
    const canonicalId = this.buildCanonicalId(
      classified.type,
      classified.clean,
    );
    const cacheHintParts: string[] = [];
    if (classified.type === 'TITLE') {
      if (request.authorHint && String(request.authorHint).trim()) {
        cacheHintParts.push(
          `a:${String(request.authorHint).trim().toLowerCase()}`,
        );
      }
      if (
        request.yearHint !== undefined &&
        request.yearHint !== null &&
        String(request.yearHint).trim()
      ) {
        cacheHintParts.push(`y:${String(request.yearHint).trim()}`);
      }
    }
    const cacheCanonicalId =
      cacheHintParts.length > 0
        ? `${canonicalId}|${cacheHintParts.join('|')}`
        : canonicalId;
    const cacheKey = this.cache.buildKey(classified.type, cacheCanonicalId);
    const cacheOutcome = request.forceRefresh
      ? 'refresh'
      : this.cache.available
        ? 'miss'
        : 'disabled';

    // 4. Cache read (unless forceRefresh)
    const reqAny = request as {
      includeCitations?: boolean;
      includeReferences?: boolean;
      policy?: { includeCitations?: boolean; includeReferences?: boolean };
    };
    const wantsCitations = Boolean(
      reqAny.includeCitations ?? reqAny.policy?.includeCitations,
    );
    const wantsReferences = Boolean(
      reqAny.includeReferences ?? reqAny.policy?.includeReferences,
    );

    if (!request.forceRefresh) {
      const cached = await this.cache.get(cacheKey);
      if (cached === false) {
        this.logResolution({
          queryType: classified.type,
          outcome: 'not_found',
          cacheOutcome: 'negative_hit',
          durationMs: Date.now() - startedAt,
        });
        return null;
      }
      if (cached && typeof cached === 'object') {
        const cachedMeta = (cached.metadata || {}) as Record<string, unknown>;
        const cachedRecord = cached as unknown as Record<string, unknown>;
        const missingRequestedCitations =
          wantsCitations &&
          cachedMeta.citations === undefined &&
          cachedRecord.citations === undefined;
        const missingRequestedReferences =
          wantsReferences &&
          cachedMeta.references === undefined &&
          cachedRecord.references === undefined;

        if (!missingRequestedCitations && !missingRequestedReferences) {
          this.logResolution({
            queryType: classified.type,
            outcome: 'found',
            cacheOutcome: 'hit',
            durationMs: Date.now() - startedAt,
          });
          return { ...cached, cached: true };
        }
      }
    }

    // 5. Routing tiers (Zotero-style: single-hit authoritative unless citations/graph explicitly requested)
    const tiers = MetadataRoutingPolicy.getTiers(classified.type, {
      includeCitations: wantsCitations,
      includeReferences: wantsReferences,
      aggressive: Boolean(request.aggressive),
    });
    const candidateResults: ProviderResult[] = [];
    const allExecutions: ProviderExecutionResult[] = [];

    // 6. Authoritative resolution
    for (const providerId of tiers.authoritative) {
      const provider = this.providerMap.get(providerId);
      if (!provider || !provider.supports(classified.type)) continue;

      const execResult = await this.executor.execute(
        provider,
        { ...request, query: classified.clean, queryType: classified.type },
        request.signal,
      );
      allExecutions.push(execResult);

      if (execResult.status === 'found' && execResult.result) {
        candidateResults.push(execResult.result);
      }
    }

    // 7. Enrichment (if authoritative found results)
    if (candidateResults.length > 0 && tiers.enrichment.length > 0) {
      const primaryMeta = candidateResults[0]?.metadata;
      const primaryAuthoritativeTitle = primaryMeta?.title;
      const primaryDoi = primaryMeta?.doi
        ? normalizeDoi(primaryMeta.doi)
        : undefined;
      const isPreprintDoi = (d?: string) =>
        Boolean(
          d &&
          /^10\.(?:48550\/arxiv\.|1101\/|21203\/|26434\/|20944\/)/i.test(d),
        );
      const enrichmentProviders = tiers.enrichment
        .map((id) => this.providerMap.get(id))
        .filter(
          (p): p is MetadataProvider =>
            p !== undefined && p.supports(classified.type),
        )
        .slice(0, MetadataRoutingPolicy.PARALLEL_LIMIT);

      const enrichmentExecs = await Promise.all(
        enrichmentProviders.map((provider) =>
          this.executor.execute(
            provider,
            { ...request, query: classified.clean, queryType: classified.type },
            request.signal,
          ),
        ),
      );

      for (const execResult of enrichmentExecs) {
        allExecutions.push(execResult);
        if (execResult.status === 'found' && execResult.result) {
          const enrichedMeta = execResult.result.metadata;
          // Guard against enrichment provider returning a different work (e.g. a paper citing the arXiv preprint)
          const enrichedTitle = enrichedMeta?.title;
          if (
            primaryAuthoritativeTitle &&
            enrichedTitle &&
            !this.isTitleSimilar(primaryAuthoritativeTitle, enrichedTitle) &&
            !this.isTitleSimilar(enrichedTitle, primaryAuthoritativeTitle)
          ) {
            continue;
          }
          const enrichedDoi = enrichedMeta?.doi
            ? normalizeDoi(enrichedMeta.doi)
            : undefined;
          if (
            primaryDoi &&
            enrichedDoi &&
            primaryDoi !== enrichedDoi &&
            !isPreprintDoi(primaryDoi) &&
            !isPreprintDoi(enrichedDoi)
          ) {
            continue;
          }
          if (
            primaryMeta?.year &&
            enrichedMeta?.year &&
            Math.abs(Number(primaryMeta.year) - Number(enrichedMeta.year)) > 3
          ) {
            continue;
          }
          candidateResults.push(execResult.result);
        }
      }
    }

    // 8. Fallback (if authoritative produced no results)
    if (candidateResults.length === 0 && tiers.fallback.length > 0) {
      for (const providerId of tiers.fallback) {
        const provider = this.providerMap.get(providerId);
        if (!provider || !provider.supports(classified.type)) continue;

        const execResult = await this.executor.execute(
          provider,
          { ...request, query: classified.clean, queryType: classified.type },
          request.signal,
        );
        allExecutions.push(execResult);

        if (execResult.status === 'found' && execResult.result) {
          candidateResults.push(execResult.result);
          break;
        }
      }
    }

    // 9. If no candidates found: negative cache ONLY if all executed providers returned 'not_found'
    const shouldNegativeCache =
      allExecutions.length > 0 &&
      allExecutions.every((exec) => exec.status === 'not_found');

    if (candidateResults.length === 0) {
      if (shouldNegativeCache) {
        await this.cache.setNegative(cacheKey, classified.type);
      }
      this.logResolution({
        queryType: classified.type,
        outcome: shouldNegativeCache ? 'not_found' : 'provider_error',
        cacheOutcome,
        providerStatuses: allExecutions.map(({ provider, status }) => ({
          provider,
          status,
        })),
        durationMs: Date.now() - startedAt,
      });
      return null;
    }

    // 10. Title similarity check for TITLE queries to avoid irrelevant results
    if (classified.type === 'TITLE') {
      const top = candidateResults[0];
      if (
        top.metadata.title &&
        !this.isTitleSimilar(classified.clean, top.metadata.title)
      ) {
        this.logResolution({
          queryType: classified.type,
          outcome: 'title_mismatch',
          cacheOutcome,
          durationMs: Date.now() - startedAt,
        });
        return null;
      }
    }

    // 11. Validate and coalesce primary + supplemental graph provider results
    const validResults: Array<ProviderResult & { metadata: ItemMetadata }> = [];
    for (const res of candidateResults) {
      const valid = validateMetadata(res.metadata);
      if (valid) {
        validResults.push({ ...res, metadata: valid });
      }
    }

    if (validResults.length === 0) {
      this.logResolution({
        queryType: classified.type,
        outcome: 'invalid_candidates',
        cacheOutcome,
        providerCount: candidateResults.length,
        durationMs: Date.now() - startedAt,
      });
      return null;
    }

    // 12. Single-pass priority coalesce (primary[k] ?? secondary[k])
    const primaryResult = validResults[0];
    const coalescedRecord: Record<string, unknown> = {};
    const fieldProvenance: Record<string, FieldProvenance> = {};

    for (const res of validResults) {
      const clonedMeta: Record<string, unknown> = { ...res.metadata };
      const candType = String(clonedMeta.itemType || 'journalArticle');
      resolveFieldAliases(clonedMeta);
      resolveBidirectionalBaseFields(clonedMeta, candType, undefined, false);

      for (const [field, val] of Object.entries(clonedMeta)) {
        if (val === undefined || val === null || val === '') continue;
        if (Array.isArray(val) && val.length === 0) continue;

        const existingVal = coalescedRecord[field];
        const isExistingEmpty =
          existingVal === undefined ||
          existingVal === null ||
          existingVal === '' ||
          (Array.isArray(existingVal) && existingVal.length === 0);

        if (isExistingEmpty) {
          coalescedRecord[field] = Array.isArray(val)
            ? [...val]
            : typeof val === 'object'
              ? { ...(val as Record<string, unknown>) }
              : val;
          fieldProvenance[field] = {
            provider: res.provider,
            fetchedAt: res.fetchedAt,
            identifier: `${res.provider.toLowerCase()}:${res.identifier}`,
            confidence: res.confidence,
          };
        }
      }
    }

    const resolvedItemType = String(
      coalescedRecord.itemType || 'journalArticle',
    );
    resolveBidirectionalBaseFields(
      coalescedRecord,
      resolvedItemType,
      undefined,
      false,
    );
    finalizeReconciledBibliographicMetadata(coalescedRecord);

    const finalMetadata: ItemMetadata = {
      title: (coalescedRecord.title as string) || 'Untitled Document',
      authors: Array.isArray(coalescedRecord.authors)
        ? [...(coalescedRecord.authors as string[])]
        : [],
      year: (coalescedRecord.year as number | null) ?? null,
      itemType: String(coalescedRecord.itemType || resolvedItemType),
      ...coalescedRecord,
      provenance: {
        originProvider: primaryResult.provider,
        resolvedAt: new Date().toISOString(),
        canonicalId,
        confidenceScore: primaryResult.confidence,
        isOpenAccess: Boolean(
          coalescedRecord.openAccessPdfUrl ||
          (coalescedRecord.provenance as Provenance | undefined)?.isOpenAccess,
        ),
        openAccessPdfUrl: coalescedRecord.openAccessPdfUrl as
          | string
          | undefined,
      },
    };

    const resolved: ResolvedMetadata = {
      query: cleanQuery,
      queryType: classified.type,
      canonicalId,
      metadata: finalMetadata,
      provenance: fieldProvenance,
      cached: false,
      resolvedAt: new Date().toISOString(),
      policyVersion: METADATA_POLICY_VERSION,
    };

    await this.cache.set(cacheKey, resolved, classified.type);

    this.logResolution({
      queryType: classified.type,
      outcome: 'found',
      cacheOutcome,
      primaryProvider: primaryResult.provider,
      providerCount: validResults.length,
      durationMs: Date.now() - startedAt,
    });

    return resolved;
  }

  private logResolution(details: Record<string, unknown>): void {
    this.logger.debug(
      JSON.stringify({ event: 'library.metadata.resolution', ...details }),
    );
  }

  private buildCanonicalId(type: string, clean: string): string {
    switch (type) {
      case 'DOI':
        return formatCanonicalId('doi', clean) || `doi:${clean}`;
      case 'ARXIV':
        return formatCanonicalId('arxiv', clean) || `arxiv:${clean}`;
      case 'PMID':
        return formatCanonicalId('pmid', clean) || `pmid:${clean}`;
      case 'ISBN':
        return formatCanonicalId('isbn', clean) || `isbn:${clean}`;
      default:
        return `${type.toLowerCase()}:${clean.toLowerCase()}`;
    }
  }

  private isTitleSimilar(query: string, candidateTitle: string): boolean {
    if (titleSimilarity(query, candidateTitle) < 0.5) return false;

    // Bag-of-words alone accepts re-ordered titles ("Is Attention All You Need?" vs
    // "Attention Is All You Need"), which are different works. Require the ordered
    // word-pair overlap to agree as well.
    const bigrams = (title: string): Set<string> => {
      const words = title
        .replace(/[đĐ]/g, 'd')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
          ' $& ',
        )
        .split(/\s+/)
        .filter(Boolean);
      const pairs = new Set<string>();
      for (let i = 0; i < words.length - 1; i++) {
        pairs.add(`${words[i]} ${words[i + 1]}`);
      }
      return pairs;
    };
    const qPairs = bigrams(query);
    const cPairs = bigrams(candidateTitle);
    if (qPairs.size < 2 || cPairs.size < 2) return true;
    let shared = 0;
    for (const pair of qPairs) {
      if (cPairs.has(pair)) shared++;
    }
    return shared / (qPairs.size + cPairs.size - shared) >= 0.5;
  }
}
