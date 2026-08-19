import { Injectable, Logger, Optional } from '@nestjs/common';
import { QueryClassifierUtil, AcademicQueryType } from '../utils/query-classifier.util';
import { SemanticScholarFetcher } from './semantic-scholar.fetcher';
import { ArxivFetcher } from './arxiv.fetcher';
import { DoiResolver } from '../resolvers/doi.resolver';
import { BibtexFormatter } from '../formatters/bibtex.formatter';
import { UnifiedAcademicMetadata } from './types/fetcher.types';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { createHash } from 'crypto';

export interface ResolveResult {
  query: string;
  queryType: AcademicQueryType;
  provider: 'SemanticScholar' | 'CrossRef' | 'Arxiv' | 'Fallback';
  metadata: UnifiedAcademicMetadata;
  cached?: boolean;
}

@Injectable()
export class UnifiedFetcherService {
  private readonly logger = new Logger(UnifiedFetcherService.name);

  constructor(
    private readonly s2Fetcher: SemanticScholarFetcher,
    private readonly arxivFetcher: ArxivFetcher,
    private readonly doiResolver: DoiResolver,
    private readonly bibtexFormatter: BibtexFormatter,
    @Optional() private readonly redisCache?: RedisCacheService,
  ) {}

  /**
   * Unified entry point: Resolves academic metadata from any query string with 7-day Redis caching
   */
  async resolve(rawQuery: string): Promise<ResolveResult | null> {
    if (!rawQuery || typeof rawQuery !== 'string') {
      return null;
    }

    const cleanQuery = rawQuery.trim();
    const queryHash = createHash('md5')
      .update(cleanQuery.toLowerCase())
      .digest('hex');
    const cacheKey = `academic:resolve:${queryHash}`;

    // 1. Check Redis Cache
    if (this.redisCache && this.redisCache.isReady()) {
      const cached = await this.redisCache.get<ResolveResult>(cacheKey);
      if (cached) {
        this.logger.log(`Cache HIT (Redis) for academic query: ${cleanQuery}`);
        return { ...cached, cached: true };
      }
    }

    // 2. Resolve via provider cascading
    const result = await this.doResolve(cleanQuery);

    // 3. Populate Redis Cache with 7-day TTL (604,800s)
    if (result && this.redisCache && this.redisCache.isReady()) {
      await this.redisCache.set(cacheKey, result, 604800);
      this.logger.log(`Cached academic query result for 7 days: ${cleanQuery}`);
    }

    return result;
  }

  private async doResolve(cleanQuery: string): Promise<ResolveResult | null> {
    const classified = QueryClassifierUtil.classify(cleanQuery);
    let meta: UnifiedAcademicMetadata | null = null;
    let provider: ResolveResult['provider'] = 'Fallback';

    switch (classified.type) {
      case 'ARXIV': {
        // 1. Try Semantic Scholar first for rich TLDR + OpenAccess
        meta = await this.s2Fetcher.fetchById(classified.clean);
        if (meta) {
          provider = 'SemanticScholar';
        } else {
          // 2. Fallback to direct arXiv API
          meta = await this.arxivFetcher.fetchById(classified.clean);
          if (meta) provider = 'Arxiv';
        }
        break;
      }

      case 'DOI': {
        // 1. Try Semantic Scholar first
        meta = await this.s2Fetcher.fetchById(classified.clean);
        if (meta) {
          provider = 'SemanticScholar';
        } else {
          // 2. Fallback to CrossRef
          const crMeta = await this.doiResolver.resolve(classified.clean);
          if (crMeta) {
            provider = 'CrossRef';
            meta = {
              title: crMeta.title,
              authors: crMeta.authors,
              year: crMeta.year,
              journal: crMeta.journal,
              publisher: crMeta.publisher,
              volume: crMeta.volume,
              issue: crMeta.issue,
              pages: crMeta.pages,
              issn: crMeta.issn,
              isbn: crMeta.isbn,
              doi: crMeta.doi,
              url: crMeta.url,
              abstract: crMeta.abstract,
              itemType: crMeta.itemType,
            };
          }
        }
        break;
      }

      case 'PMID': {
        // 1. Semantic Scholar supports direct PMID: lookup
        meta = await this.s2Fetcher.fetchById(`PMID:${classified.clean}`);
        if (meta) provider = 'SemanticScholar';
        break;
      }

      case 'URL': {
        // Test if URL contains arXiv, DOI, or PMID
        const subClassified = QueryClassifierUtil.classify(classified.clean);
        if (
          subClassified.type === 'ARXIV' ||
          subClassified.type === 'DOI' ||
          subClassified.type === 'PMID'
        ) {
          return this.resolve(subClassified.clean);
        }
        // Else try S2 with full URL
        meta = await this.s2Fetcher.fetchById(classified.clean);
        if (meta) provider = 'SemanticScholar';
        break;
      }

      case 'TITLE':
      default: {
        // Search Semantic Scholar by title
        meta = await this.s2Fetcher.searchByTitle(classified.clean);
        if (meta) provider = 'SemanticScholar';
        break;
      }
    }

    if (!meta) {
      return null;
    }

    // Auto-generate Better BibTeX citationKey if not present
    if (!meta.citationKey && meta.title) {
      meta.citationKey = this.bibtexFormatter.generateCitationKey(
        meta.title,
        meta.authors,
        meta.year,
      );
    }

    return {
      query: cleanQuery,
      queryType: classified.type,
      provider,
      metadata: meta,
    };
  }
}
