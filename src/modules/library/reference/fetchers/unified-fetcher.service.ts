import { Injectable, Logger, Optional } from '@nestjs/common';
import { QueryClassifierUtil, AcademicQueryType } from '../utils/query-classifier.util';
import { SemanticScholarFetcher } from './semantic-scholar.fetcher';
import { ArxivFetcher } from './arxiv.fetcher';
import { PubmedFetcher } from './pubmed.fetcher';
import { OpenlibraryFetcher } from './openlibrary.fetcher';
import { OpenAlexFetcher } from './openalex.fetcher';
import { UnpaywallFetcher } from './unpaywall.fetcher';
import { DoiResolver } from '../resolvers/doi.resolver';
import { BibtexFormatter } from '../formatters/bibtex.formatter';
import { UnifiedAcademicMetadata, ProvenanceMetadata } from './types/fetcher.types';
import { RedisCacheService } from '../../../../core/cache/redis-cache.service';
import { createHash } from 'crypto';

export interface ResolveResult {
  query: string;
  queryType: AcademicQueryType;
  provider:
    | 'SemanticScholar'
    | 'CrossRef'
    | 'arXiv'
    | 'PubMed'
    | 'OpenLibrary'
    | 'Unpaywall'
    | 'Fallback';
  metadata: UnifiedAcademicMetadata;
  cached?: boolean;
}

@Injectable()
export class UnifiedFetcherService {
  private readonly logger = new Logger(UnifiedFetcherService.name);

  constructor(
    private readonly s2Fetcher: SemanticScholarFetcher,
    private readonly arxivFetcher: ArxivFetcher,
    private readonly pubmedFetcher: PubmedFetcher,
    private readonly openlibraryFetcher: OpenlibraryFetcher,
    private readonly openAlexFetcher: OpenAlexFetcher,
    private readonly unpaywallFetcher: UnpaywallFetcher,
    private readonly doiResolver: DoiResolver,
    private readonly bibtexFormatter: BibtexFormatter,
    @Optional() private readonly redisCache?: RedisCacheService,
  ) {}

  /**
   * Unified entry point: Resolves academic metadata with 7-day Redis caching & provenance stamping
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

    // 2. Resolve via multi-provider cascading
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
        // 1. Try Semantic Scholar first for rich TLDR + Citations
        meta = await this.s2Fetcher.fetchById(classified.clean);
        if (meta) {
          provider = 'SemanticScholar';
        } else {
          // 2. Fallback to direct arXiv official API
          meta = await this.arxivFetcher.fetchById(classified.clean);
          if (meta) {
            provider = 'arXiv';
          } else {
            // 3. Fallback to CrossRef search
            const crMeta = await this.doiResolver.searchByTitle(classified.clean);
            if (crMeta) {
              provider = 'CrossRef';
              meta = this.convertCrMeta(crMeta);
            }
          }
        }
        break;
      }

      case 'DOI': {
        // 1. Try Semantic Scholar first
        meta = await this.s2Fetcher.fetchById(classified.clean);
        if (meta) {
          provider = 'SemanticScholar';
        } else {
          // 2. Fallback to CrossRef official DOI registry
          const crMeta = await this.doiResolver.resolve(classified.clean);
          if (crMeta) {
            provider = 'CrossRef';
            meta = this.convertCrMeta(crMeta);
          } else {
            // 3. Fallback to OpenAlex
            meta = await this.openAlexFetcher.fetchByDoi(classified.clean);
            if (meta) provider = 'CrossRef';
          }
        }

        // Check Open Access PDF via Unpaywall if not yet present
        if (meta && !meta.openAccessPdfUrl && meta.doi) {
          const oaResult = await this.unpaywallFetcher.resolveOaPdf(meta.doi);
          if (oaResult?.pdfUrl) {
            meta.openAccessPdfUrl = oaResult.pdfUrl;
            if (meta.provenance) {
              meta.provenance.isOpenAccess = true;
              meta.provenance.openAccessPdfUrl = oaResult.pdfUrl;
            }
          }
        }
        break;
      }

      case 'PMID': {
        // 1. Try NCBI PubMed E-Utilities
        meta = await this.pubmedFetcher.fetchByPmid(classified.clean);
        if (meta) {
          provider = 'PubMed';
        } else {
          // 2. Fallback to Semantic Scholar direct PMID
          meta = await this.s2Fetcher.fetchById(`PMID:${classified.clean}`);
          if (meta) provider = 'SemanticScholar';
        }
        break;
      }

      case 'ISBN': {
        // 1. Try OpenLibrary Books API
        meta = await this.openlibraryFetcher.fetchByIsbn(classified.clean);
        if (meta) {
          provider = 'OpenLibrary';
        } else {
          // 2. Fallback to title search if ISBN fails
          meta = await this.s2Fetcher.searchByTitle(`ISBN ${classified.clean}`);
          if (meta) provider = 'SemanticScholar';
        }
        break;
      }

      case 'URL': {
        // Test if URL contains arXiv, DOI, PMID, or ISBN
        const subClassified = QueryClassifierUtil.classify(classified.clean);
        if (
          subClassified.type === 'ARXIV' ||
          subClassified.type === 'DOI' ||
          subClassified.type === 'PMID' ||
          subClassified.type === 'ISBN'
        ) {
          return this.resolve(subClassified.clean);
        }
        meta = await this.s2Fetcher.fetchById(classified.clean);
        if (meta) provider = 'SemanticScholar';
        break;
      }

      case 'TITLE':
      default: {
        // 1. Try Semantic Scholar
        meta = await this.s2Fetcher.searchByTitle(classified.clean);
        if (meta) {
          provider = 'SemanticScholar';
        } else {
          // 2. Fallback to CrossRef bibliographic search (IEEE, ACM, Springer, Elsevier, NeurIPS, CVPR)
          const crMeta = await this.doiResolver.searchByTitle(classified.clean);
          if (crMeta) {
            provider = 'CrossRef';
            meta = this.convertCrMeta(crMeta);
          } else {
            // 3. Fallback to OpenAlex open academic database
            meta = await this.openAlexFetcher.searchByTitle(classified.clean);
            if (meta) {
              provider = 'SemanticScholar';
            } else if (/^\d{4}\.\d{4,5}/i.test(classified.clean)) {
              // 4. Fallback to direct arXiv
              meta = await this.arxivFetcher.fetchById(classified.clean);
              if (meta) provider = 'arXiv';
            }
          }
        }
        break;
      }
    }

    if (!meta) {
      return null;
    }

    // Ensure Provenance block exists
    if (!meta.provenance) {
      meta.provenance = {
        originProvider: provider as any,
        resolvedAt: new Date().toISOString(),
        canonicalId: meta.doi ? `doi:${meta.doi}` : meta.arxivId ? `arxiv:${meta.arxivId}` : cleanQuery,
        canonicalUrl: meta.url,
        confidenceScore: 0.9,
        isOpenAccess: Boolean(meta.openAccessPdfUrl),
        openAccessPdfUrl: meta.openAccessPdfUrl,
      };
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

  private convertCrMeta(crMeta: any): UnifiedAcademicMetadata {
    return {
      title: crMeta.title,
      authors: crMeta.authors || [],
      year: crMeta.year || null,
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
      itemType: crMeta.itemType || 'journalArticle',
      provenance: crMeta.provenance,
    };
  }
}
