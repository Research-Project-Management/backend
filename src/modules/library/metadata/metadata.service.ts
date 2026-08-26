import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  AcademicQueryType,
  ProviderCircuitBreaker,
  QueryClassifierUtil,
} from './utils/metadata.util';
import { SemanticScholarProvider } from './providers/semantic.provider';

import { ArxivProvider } from './providers/arxiv.provider';
import { PubmedProvider } from './providers/pubmed.provider';
import { OpenlibraryProvider } from './providers/openlibrary.provider';
import { OpenAlexProvider } from './providers/openalex.provider';
import { UnpaywallProvider } from './providers/unpaywall.provider';
import { DoiResolver } from '../cite/resolvers/doi.resolver';
import { BibtexFormatter } from '../cite/formatters/bibtex.formatter';

import {
  ItemMetadata,
  UnifiedAcademicMetadata,
  ProvenanceMetadata,
  CREATOR_TYPE_LABELS,
  FIELD_LABELS,
  ITEM_TYPE_CREATOR_KEYS,
  ITEM_TYPE_FIELD_KEYS,
  ITEM_TYPE_LABELS,
  SELECTABLE_LIBRARY_ITEM_TYPES,
  SUPPORTED_LIBRARY_ITEM_TYPES,
  SYSTEM_LIBRARY_ITEM_TYPES,
  SupportedLibraryItemType,
  REFERENCE_MANAGER_SCHEMA_VERSION,
  extractYearFromDate,
  normalizeCreators,
  normalizeLibraryItemType,
  normalizeTags,
} from './types/metadata.types';

import { NormalizeMetadataDto } from './dto/metadata.dto';

import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { createHash } from 'crypto';

export interface ResolveResult {
  query: string;
  queryType: AcademicQueryType;
  /**
   * The primary provider that returned the authoritative metadata record.
   * 'OpenAlex' is used when CrossRef returns nothing but OpenAlex re-serves the same CrossRef data.
   */
  provider:
    | 'SemanticScholar'
    | 'CrossRef'
    | 'OpenAlex'
    | 'arXiv'
    | 'PubMed'
    | 'OpenLibrary'
    | 'Unpaywall'
    | 'Fallback';
  metadata: UnifiedAcademicMetadata;
  cached?: boolean;
}

@Injectable()
export class MetadataService {
  private readonly logger = new Logger(MetadataService.name);
  private readonly circuitBreaker = new ProviderCircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 30_000,
  });

  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  private readonly REDIS_KEY_PREFIX = 'metadata:resolved:';

  constructor(
    private readonly s2Provider: SemanticScholarProvider,
    private readonly arxivProvider: ArxivProvider,
    private readonly pubmedProvider: PubmedProvider,
    private readonly openlibraryProvider: OpenlibraryProvider,
    private readonly openAlexProvider: OpenAlexProvider,
    private readonly unpaywallProvider: UnpaywallProvider,
    private readonly doiResolver: DoiResolver,
    private readonly bibtexFormatter: BibtexFormatter,
    @Optional() private readonly redisCache?: RedisCacheService,
  ) {}

  getItemTypes() {
    return {
      version: REFERENCE_MANAGER_SCHEMA_VERSION,
      selectable: SELECTABLE_LIBRARY_ITEM_TYPES.map((itemType: string) =>
        this.getItemType(itemType),
      ),
      system: SYSTEM_LIBRARY_ITEM_TYPES.map((itemType: string) =>
        this.getItemType(itemType),
      ),
      supported: SUPPORTED_LIBRARY_ITEM_TYPES.map((itemType: string) =>
        this.getItemType(itemType),
      ),
    };
  }

  getItemType(itemType: string) {
    const normalized = normalizeLibraryItemType(itemType);
    return {
      version: REFERENCE_MANAGER_SCHEMA_VERSION,
      itemType: normalized,
      localized: ITEM_TYPE_LABELS[normalized],
      selectable: SELECTABLE_LIBRARY_ITEM_TYPES.includes(normalized as any),
      fields: this.getItemTypeFields(normalized),
      creators: this.getItemTypeCreators(normalized),
    };
  }

  getItemTypeFields(itemType: string) {
    const normalized = normalizeLibraryItemType(itemType);
    const fieldKeys = ITEM_TYPE_FIELD_KEYS[normalized] ??
      ITEM_TYPE_FIELD_KEYS.document ?? ['title', 'abstractNote'];

    return fieldKeys.map((key: string) => ({
      key,
      label: FIELD_LABELS[key] ?? key,
      required: key === 'title',
    }));
  }

  getItemTypeCreators(itemType: string) {
    const normalized = normalizeLibraryItemType(itemType);
    const creators = ITEM_TYPE_CREATOR_KEYS[normalized] ?? [
      { creatorType: 'author', primary: true },
      { creatorType: 'contributor' },
    ];

    return creators.map((creator: any) => ({
      creatorType: creator.creatorType,
      localized:
        CREATOR_TYPE_LABELS[creator.creatorType] ?? creator.creatorType,
      primary: Boolean(creator.primary),
    }));
  }

  normalize(dto: NormalizeMetadataDto) {
    const itemType = normalizeLibraryItemType(dto.itemType);
    return {
      itemType,
      itemTypeLabel: ITEM_TYPE_LABELS[itemType],
      creators: normalizeCreators(dto.creators),
      tags: normalizeTags(dto.tags as any),
      year: extractYearFromDate(dto.date),
    };
  }

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
    let confidenceScore = 0.5;

    switch (classified.type) {
      case 'ARXIV': {
        // 1. arXiv API is authoritative for arXiv IDs
        meta = await this.circuitBreaker.execute('arXiv', () =>
          this.arxivProvider.fetchById(classified.clean),
        );
        if (meta) {
          provider = 'arXiv';
          confidenceScore = 0.95;
        }
        // 2. Enrich with S2 for tldr, citationCount — non-blocking merge
        if (meta) {
          const s2Meta = await this.circuitBreaker
            .execute<ItemMetadata | null>('SemanticScholar', () =>
              this.s2Provider.fetchById(classified.clean),
            )
            .catch(() => null);
          if (s2Meta) {
            meta.tldr = meta.tldr ?? s2Meta.tldr;
            meta.citationCount = meta.citationCount ?? s2Meta.citationCount;
            meta.keywords = meta.keywords?.length
              ? meta.keywords
              : s2Meta.keywords;
            meta.openAccessPdfUrl =
              meta.openAccessPdfUrl ?? s2Meta.openAccessPdfUrl;
          }
        } else {
          // 3. Fallback to Semantic Scholar
          meta = await this.circuitBreaker.execute<ItemMetadata | null>(
            'SemanticScholar',
            () => this.s2Provider.fetchById(classified.clean),
          );
          if (meta) {
            provider = 'SemanticScholar';
            confidenceScore = 0.92;
          } else {
            // 4. Fallback to CrossRef search
            const crMeta = await this.circuitBreaker.execute<any>(
              'CrossRef',
              () => this.doiResolver.searchByTitle(classified.clean),
            );
            if (crMeta) {
              provider = 'CrossRef';
              confidenceScore = 0.7;
              meta = this.convertCrMeta(crMeta);
            }
          }
        }
        break;
      }

      case 'DOI': {
        // 1. CrossRef is the canonical DOI registry — always query first.
        const crMeta = await this.circuitBreaker.execute<any>('CrossRef', () =>
          this.doiResolver.resolve(classified.clean),
        );
        if (crMeta) {
          provider = 'CrossRef';
          confidenceScore = 0.98;
          meta = this.convertCrMeta(crMeta);
        } else {
          // 2. OpenAlex re-serves CrossRef data — use as fallback
          meta = await this.circuitBreaker.execute<ItemMetadata | null>(
            'OpenAlex',
            () => this.openAlexProvider.fetchByDoi(classified.clean),
          );
          if (meta) {
            provider = 'OpenAlex';
            confidenceScore = 0.9;
          }
        }

        // 3. Enrich with S2 for tldr, citationCount — non-blocking, merge if available
        if (meta) {
          const s2Meta = await this.circuitBreaker
            .execute<ItemMetadata | null>('SemanticScholar', () =>
              this.s2Provider.fetchById(classified.clean),
            )
            .catch(() => null);
          if (s2Meta) {
            meta.tldr = meta.tldr ?? s2Meta.tldr;
            meta.citationCount = meta.citationCount ?? s2Meta.citationCount;
            meta.openAccessPdfUrl =
              meta.openAccessPdfUrl ?? s2Meta.openAccessPdfUrl;
          }
        }

        // 4. Check Open Access PDF via Unpaywall if not yet present
        if (meta && !meta.openAccessPdfUrl && meta.doi) {
          const oaResult = await this.circuitBreaker.execute<any>(
            'Unpaywall',
            () => this.unpaywallProvider.resolveOaPdf(meta!.doi!),
          );
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
        // 1. NCBI PubMed E-Utilities is authoritative for PMIDs
        meta = await this.circuitBreaker.execute('PubMed', () =>
          this.pubmedProvider.fetchByPmid(classified.clean),
        );
        if (meta) {
          provider = 'PubMed';
          confidenceScore = 0.97;
        } else {
          // 2. Fallback to Semantic Scholar with PMID prefix
          meta = await this.circuitBreaker.execute('SemanticScholar', () =>
            this.s2Provider.fetchById(`PMID:${classified.clean}`),
          );
          if (meta) {
            provider = 'SemanticScholar';
            confidenceScore = 0.88;
          }
        }
        break;
      }

      case 'ISBN': {
        // 1. OpenLibrary is authoritative for books/ISBNs
        meta = await this.circuitBreaker.execute('OpenLibrary', () =>
          this.openlibraryProvider.fetchByIsbn(classified.clean),
        );
        if (meta) {
          provider = 'OpenLibrary';
          confidenceScore = 0.95;
        } else {
          // 2. Fallback to Semantic Scholar search
          meta = await this.circuitBreaker.execute('SemanticScholar', () =>
            this.s2Provider.searchByTitle(`ISBN ${classified.clean}`),
          );
          if (meta) {
            provider = 'SemanticScholar';
            confidenceScore = 0.6;
          }
        }
        break;
      }

      case 'URL': {
        // Extract identifier from URL and re-resolve at the correct case
        const subClassified = QueryClassifierUtil.classify(classified.clean);
        if (
          subClassified.type === 'ARXIV' ||
          subClassified.type === 'DOI' ||
          subClassified.type === 'PMID' ||
          subClassified.type === 'ISBN'
        ) {
          return this.resolve(subClassified.clean);
        }
        meta = await this.circuitBreaker.execute('SemanticScholar', () =>
          this.s2Provider.fetchById(classified.clean),
        );
        if (meta) {
          provider = 'SemanticScholar';
          confidenceScore = 0.7;
        }
        break;
      }

      case 'TITLE':
      default: {
        // 1. Semantic Scholar — best fuzzy title search
        const s2Meta = await this.circuitBreaker.execute<ItemMetadata | null>(
          'SemanticScholar',
          () => this.s2Provider.searchByTitle(classified.clean),
        );
        if (s2Meta) {
          const sim = this.titleSimilarity(
            classified.clean,
            s2Meta.title ?? '',
          );
          if (sim >= 0.6) {
            meta = s2Meta;
            provider = 'SemanticScholar';
            confidenceScore = sim * 0.9;
          } else {
            this.logger.debug(
              `S2 title match rejected (sim=${sim.toFixed(2)}): "${s2Meta.title}" vs "${classified.clean}"`,
            );
          }
        }

        if (!meta) {
          // 2. CrossRef bibliographic search
          const crMeta = await this.circuitBreaker.execute<any>(
            'CrossRef',
            () => this.doiResolver.searchByTitle(classified.clean),
          );
          if (crMeta) {
            const sim = this.titleSimilarity(classified.clean, crMeta.title);
            if (sim >= 0.6) {
              provider = 'CrossRef';
              confidenceScore = sim * 0.85;
              meta = this.convertCrMeta(crMeta);
            } else {
              this.logger.debug(
                `CrossRef title match rejected (sim=${sim.toFixed(2)}): "${crMeta.title}" vs "${classified.clean}"`,
              );
            }
          }
        }

        if (!meta) {
          // 3. OpenAlex as additional fallback
          const oaMeta = await this.circuitBreaker.execute<ItemMetadata | null>(
            'OpenAlex',
            () => this.openAlexProvider.searchByTitle(classified.clean),
          );
          if (oaMeta) {
            const sim = this.titleSimilarity(
              classified.clean,
              oaMeta.title ?? '',
            );
            if (sim >= 0.6) {
              meta = oaMeta;
              provider = 'CrossRef';
              confidenceScore = sim * 0.8;
            }
          }
        }

        if (!meta && /^\d{4}\.\d{4,5}/i.test(classified.clean)) {
          // 4. arXiv direct fallback for arXiv-like strings misclassified as TITLE
          meta = await this.circuitBreaker.execute<ItemMetadata | null>(
            'arXiv',
            () => this.arxivProvider.fetchById(classified.clean),
          );

          if (meta) {
            provider = 'arXiv';
            confidenceScore = 0.9;
          }
        }
        break;
      }
    }

    if (!meta) {
      return null;
    }

    // Stamp provenance with dynamically computed confidence score
    if (!meta.provenance) {
      meta.provenance = {
        originProvider: provider,
        resolvedAt: new Date().toISOString(),
        canonicalId: meta.doi
          ? `doi:${meta.doi}`
          : meta.arxivId
            ? `arxiv:${meta.arxivId}`
            : cleanQuery,
        canonicalUrl: meta.url,
        confidenceScore,
        isOpenAccess: Boolean(meta.openAccessPdfUrl),
        openAccessPdfUrl: meta.openAccessPdfUrl,
      };
    } else {
      // Upstream provider already stamped provenance — only override score if we computed higher
      meta.provenance.confidenceScore = Math.max(
        meta.provenance.confidenceScore ?? 0,
        confidenceScore,
      );
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

  private toItemType(itemType: SupportedLibraryItemType) {
    const system = SYSTEM_LIBRARY_ITEM_TYPES.includes(itemType);
    return {
      itemType,
      localized: ITEM_TYPE_LABELS[itemType],
      selectable: !system,
      system,
    };
  }

  /**
   * Dice coefficient on word-level tokens — no external dependencies.
   *
   * Formula: 2 * |intersection| / (|A| + |B|)
   * Returns 0.0–1.0.
   *
   * Used to reject title-search results that are textually unrelated to the query,
   * preventing false positives when CrossRef or S2 returns a top-1 result with low relevance.
   */
  private titleSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;

    const tokenize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 1);

    const setA = new Set(tokenize(a));
    const setB = new Set(tokenize(b));

    if (setA.size === 0 || setB.size === 0) return 0;

    let intersection = 0;
    for (const token of setA) {
      if (setB.has(token)) intersection++;
    }

    return (2 * intersection) / (setA.size + setB.size);
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
