import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CANONICAL_METADATA_PROVIDERS,
  CanonicalMetadataResolver,
  FieldProvenance,
  ItemMetadata,
  MetadataCandidate,
  MetadataProvider,
  MetadataRequest,
  ProviderExecutionResult,
  ProviderName,
  ProviderResult,
  ResolvedMetadata,
} from './metadata.contracts';
import { QueryClassifier } from './metadata.classifier';
import {
  formatCanonicalId,
  normalizeArxivId,
  normalizeDoi,
  normalizePmid,
} from './metadata.identifiers';
import {
  MetadataRoutingPolicy,
  METADATA_POLICY_VERSION,
} from './metadata.policy';
import { MetadataCache } from './metadata.cache';
import { MetadataReconciliationService } from './metadata.reconciler';
import { ProviderExecutor } from './metadata.executor';
import { validateMetadata } from './metadata.validator';

@Injectable()
export class MetadataService implements CanonicalMetadataResolver {
  private readonly logger = new Logger(MetadataService.name);
  private readonly providerMap = new Map<ProviderName, MetadataProvider>();

  constructor(
    @Inject(CANONICAL_METADATA_PROVIDERS)
    private readonly providers: MetadataProvider[],
    private readonly cache: MetadataCache,
    private readonly reconciler: MetadataReconciliationService,
    private readonly executor: ProviderExecutor,
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
    let classified = QueryClassifier.classify(cleanQuery);

    // 2. SSRF check for URL queries
    if (classified.type === 'URL') {
      MetadataRoutingPolicy.validateUrl(classified.clean);

      // Re-classify if URL embeds a recognized identifier
      const embeddedDoi = normalizeDoi(classified.clean);
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
        }
      }
    }

    // 3. Canonical ID and cache key
    const canonicalId = this.buildCanonicalId(
      classified.type,
      classified.clean,
    );
    const cacheKey = this.cache.buildKey(classified.type, canonicalId);
    const cacheOutcome = request.forceRefresh
      ? 'refresh'
      : this.cache.available
        ? 'miss'
        : 'disabled';

    // 4. Cache read (unless forceRefresh)
    if (!request.forceRefresh) {
      const cached = await this.cache.get(cacheKey);
      if (cached === false) {
        // Negative cache hit (not found)
        this.logResolution({
          queryType: classified.type,
          outcome: 'not_found',
          cacheOutcome: 'negative_hit',
          durationMs: Date.now() - startedAt,
        });
        return null;
      }
      if (cached && typeof cached === 'object') {
        this.logResolution({
          queryType: classified.type,
          outcome: 'found',
          cacheOutcome: 'hit',
          durationMs: Date.now() - startedAt,
        });
        return { ...cached, cached: true };
      }
    }

    // 5. Routing tiers
    const tiers = MetadataRoutingPolicy.getTiers(classified.type);
    const candidateResults: ProviderResult[] = [];
    const allExecutions: ProviderExecutionResult[] = [];

    // 6. Authoritative resolution
    for (const providerId of tiers.authoritative) {
      const provider = this.providerMap.get(providerId);
      if (!provider || !provider.supports(classified.type)) continue;

      const execResult = await this.executor.execute(
        provider,
        { ...request, query: classified.clean },
        request.signal,
      );
      allExecutions.push(execResult);

      if (execResult.status === 'found' && execResult.result) {
        candidateResults.push(execResult.result);
      }
    }

    // 7. Enrichment (if authoritative found results)
    if (candidateResults.length > 0 && tiers.enrichment.length > 0) {
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
            { ...request, query: classified.clean },
            request.signal,
          ),
        ),
      );

      for (const execResult of enrichmentExecs) {
        allExecutions.push(execResult);
        if (execResult.status === 'found' && execResult.result) {
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
          { ...request, query: classified.clean },
          request.signal,
        );
        allExecutions.push(execResult);

        if (execResult.status === 'found' && execResult.result) {
          candidateResults.push(execResult.result);
          break; // Stop at first successful fallback
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

    // 11. Validate and convert candidates
    const validCandidates: MetadataCandidate[] = [];
    for (const res of candidateResults) {
      const valid = validateMetadata(res.metadata);
      if (valid) {
        validCandidates.push({
          id: `${res.provider.toLowerCase()}:${res.identifier}`,
          sourceProvider: res.provider,
          metadata: valid,
          confidenceScore: res.confidence,
          fetchedAt: res.fetchedAt,
        });
      }
    }

    if (validCandidates.length === 0) {
      this.logResolution({
        queryType: classified.type,
        outcome: 'invalid_candidates',
        cacheOutcome,
        providerCount: candidateResults.length,
        durationMs: Date.now() - startedAt,
      });
      return null;
    }

    // 12. Immutable reconciliation
    const reconciled = this.reconciler.reconcile(validCandidates, {});

    // 13. Field-level provenance map
    const fieldProvenance: Record<string, FieldProvenance> = {};
    for (const assertion of reconciled.assertions) {
      const candidate = validCandidates.find(
        (c) => c.sourceProvider === assertion.sourceProvider,
      );
      fieldProvenance[assertion.field] = {
        provider: assertion.sourceProvider as ProviderName,
        fetchedAt: candidate?.fetchedAt || assertion.timestamp,
        identifier: candidate?.id || assertion.sourceProvider,
        confidence: assertion.confidenceScore,
      };
    }

    // Attach high-level provenance
    const primaryCandidate = validCandidates[0];
    const finalMetadata: ItemMetadata = {
      ...reconciled.metadata,
      provenance: {
        originProvider: primaryCandidate.sourceProvider,
        resolvedAt: new Date().toISOString(),
        canonicalId,
        confidenceScore: primaryCandidate.confidenceScore,
        isOpenAccess: Boolean(
          reconciled.metadata.openAccessPdfUrl ||
          reconciled.metadata.provenance?.isOpenAccess,
        ),
        openAccessPdfUrl: reconciled.metadata.openAccessPdfUrl,
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

    // 14. Cache positive result
    await this.cache.set(cacheKey, resolved, classified.type);

    this.logResolution({
      queryType: classified.type,
      outcome: 'found',
      cacheOutcome,
      primaryProvider: primaryCandidate.sourceProvider,
      providerCount: validCandidates.length,
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
    const qTokens = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 2);
    const cTokens = candidateTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 2);

    if (qTokens.length === 0 || cTokens.length === 0) return true;

    let matches = 0;
    for (const qt of qTokens) {
      if (cTokens.includes(qt)) {
        matches++;
      }
    }

    const similarity = matches / qTokens.length;
    return similarity >= 0.5;
  }
}
