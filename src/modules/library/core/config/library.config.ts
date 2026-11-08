import { registerAs, ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';

interface LibraryConfig {
  app: {
    nodeEnv: string;
    isTest: boolean;
    isProduction: boolean;
  };
  academic: {
    contactEmail: string;
    userAgent: string;
  };
  providers: {
    openAlexApiKey?: string;
    openAlexEmail?: string;
    crossrefEmail?: string;
    ncbiApiKey?: string;
    ncbiEmail?: string;
    ncbiBaseUrl: string;
    semanticScholarApiKey?: string;
    semanticScholarBaseUrl: string;
    unpaywallEmail?: string;
    unpaywallBaseUrl: string;
    dblpBaseUrl: string;
    arxivBaseUrl: string;
    openLibraryBaseUrl: string;
  };
  outbox: {
    queue: string;
    pollIntervalMs: number;
    batchSize: number;
    maxRetries: number;
    leaseMs: number;
    workerEnabled?: string;
  };
  ingestion: {
    priorityQueue: string;
    standardQueue: string;
    captureQueue: string;
    concurrency: number;
  };
  extraction: {
    pdfMaxPages: number;
    webFetchTimeoutMs: number;
    pdfMaxIndexPages: number;
  };
  capture: {
    secret?: string;
  };
  retraction: {
    syncIntervalHours: number;
    enableGitlabDump: boolean;
  };
  http: {
    defaultTimeoutMs: number;
    maxRedirects: number;
  };
}

export const libraryConfig = registerAs('library', (): LibraryConfig => {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isTest = nodeEnv === 'test';
  const isProduction = nodeEnv === 'production';

  const contactEmail =
    process.env.ACADEMIC_POLITE_EMAIL ||
    process.env.CROSSREF_EMAIL ||
    'support@flux.study';

  return {
    app: {
      nodeEnv,
      isTest,
      isProduction,
    },
    academic: {
      contactEmail,
      userAgent: `FluxResearchPlatform/1.0 (mailto:${contactEmail}; https://flux.study)`,
    },
    providers: {
      openAlexApiKey: process.env.OPENALEX_API_KEY,
      openAlexEmail: process.env.OPENALEX_EMAIL || contactEmail,
      crossrefEmail: process.env.CROSSREF_EMAIL || contactEmail,
      ncbiApiKey: process.env.NCBI_API_KEY,
      ncbiEmail: process.env.NCBI_EMAIL || contactEmail,
      ncbiBaseUrl:
        process.env.NCBI_EUTILS_BASE_URL ||
        'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
      semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY,
      semanticScholarBaseUrl:
        process.env.SEMANTIC_SCHOLAR_API_URL ||
        'https://api.semanticscholar.org/graph/v1',
      unpaywallEmail: process.env.UNPAYWALL_EMAIL || contactEmail,
      unpaywallBaseUrl:
        process.env.UNPAYWALL_API_URL || 'https://api.unpaywall.org/v2',
      dblpBaseUrl:
        process.env.DBLP_API_URL || 'https://dblp.org/search/publ/api',
      arxivBaseUrl:
        process.env.ARXIV_API_URL || 'https://export.arxiv.org/api/query',
      openLibraryBaseUrl:
        process.env.OPENLIBRARY_API_URL || 'https://openlibrary.org/api/books',
    },
    outbox: {
      queue: process.env.LIBRARY_OUTBOX_QUEUE || 'flux_library_outbox',
      pollIntervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 2000,
      batchSize: Number(process.env.OUTBOX_BATCH_SIZE) || 50,
      maxRetries: Number(process.env.OUTBOX_MAX_RETRIES) || 5,
      leaseMs:
        Number(process.env.OUTBOX_LEASE_MS || process.env.OUTBOX_LOCK_TTL_MS) ||
        30000,
      workerEnabled: process.env.OUTBOX_WORKER_ENABLED,
    },
    ingestion: {
      priorityQueue:
        process.env.LIBRARY_INGESTION_QUEUE_PRIORITY ||
        'flux_library_ingestion_priority',
      standardQueue:
        process.env.LIBRARY_INGESTION_QUEUE_STANDARD ||
        'flux_library_ingestion_standard',
      captureQueue:
        process.env.LIBRARY_INGESTION_QUEUE_CAPTURE ||
        'flux_library_ingestion_capture',
      concurrency: Number(process.env.INGESTION_QUEUE_CONCURRENCY) || 4,
    },
    extraction: {
      pdfMaxPages: Number(process.env.PDF_MAX_PAGES) || 100,
      webFetchTimeoutMs: Number(process.env.WEB_FETCH_TIMEOUT_MS) || 10000,
      pdfMaxIndexPages: Number.parseInt(
        process.env.LIBRARY_PDF_MAX_INDEX_PAGES ||
          process.env.PDF_MAX_INDEX_PAGES ||
          '100',
        10,
      ),
    },
    capture: {
      secret: process.env.URL_CAPTURE_SECRET,
    },
    retraction: {
      syncIntervalHours:
        Number(process.env.RETRACTION_SYNC_INTERVAL_HOURS) || 24,
      enableGitlabDump: process.env.ENABLE_RETRACTION_GITLAB_DUMP === 'true',
    },
    http: {
      defaultTimeoutMs: Number(process.env.LIBRARY_HTTP_TIMEOUT_MS) || 10000,
      maxRedirects: Number(process.env.LIBRARY_HTTP_MAX_REDIRECTS) || 5,
    },
  };
});

@Injectable()
export class LibraryConfigService {
  constructor(private readonly configService: ConfigService) {}

  get config(): LibraryConfig {
    return this.configService.get<LibraryConfig>('library') || libraryConfig();
  }

  get app() {
    return this.config.app;
  }

  get academic() {
    return this.config.academic;
  }

  get providers() {
    return this.config.providers;
  }

  get outbox() {
    return this.config.outbox;
  }

  get ingestion() {
    return this.config.ingestion;
  }

  get extraction() {
    return this.config.extraction;
  }

  get capture() {
    return this.config.capture;
  }

  get retraction() {
    return this.config.retraction;
  }

  get http() {
    return this.config.http;
  }
}

export function escapeRedisGlob(segment: string): string {
  return String(segment ?? '').replace(/([*?[\]\\])/g, '\\$1');
}

/**
 * Redis Key Namespaces for Library Module (redis-core convention)
 * Colon-separated hierarchical structure with user/project scope isolation.
 */
export const LIBRARY_REDIS_KEYS = {
  // Scope Versioning (O(1) atomic invalidation)
  scopeVersion: (scopeKey: string) => `library:ver:scope:${scopeKey}`,

  // Collections (supports versioned key)
  collections: (scopeId: string, version: number | string = 0) =>
    `library:${scopeId}:collections:v${version}`,
  collectionTree: (scopeId: string, version: number | string = 0) =>
    `library:${scopeId}:collections:tree:v${version}`,
  collectionsPattern: (projectId: string) =>
    `library:${escapeRedisGlob(projectId)}:collections*`,

  // Tags (supports versioned key)
  tags: (scopeId: string, version: number | string = 0) =>
    `library:${scopeId}:tags:v${version}`,
  tagsPattern: (projectId: string) =>
    `library:${escapeRedisGlob(projectId)}:tags*`,

  // Saved Searches
  savedSearches: (scopeId: string) => `library:${scopeId}:saved-searches`,
  savedSearchesPattern: (scopeId: string) =>
    `library:${escapeRedisGlob(scopeId)}:saved-searches*`,

  // Feed Subscriptions
  feedSubscriptions: (userId: string) =>
    `library:user:${userId}:feed-subscriptions`,

  // Item Types (Static system registry)
  itemTypes: (includeSpecial: boolean) =>
    `library:system:item-types:${includeSpecial ? 'all' : 'bibliographic'}`,

  // Items Cache (Cache-Aside Pattern)
  item: (itemId: string) => `library:item:${itemId}`,
  itemDetails: (itemId: string) => `library:item:${itemId}:details`,
  itemFulltext: (itemId: string) => `library:item:${itemId}:fulltext`,
  itemAttachments: (itemId: string) => `library:item:${itemId}:attachments`,
  attachmentAnnotations: (attachmentId: string) =>
    `library:attachment:${attachmentId}:annotations`,
  itemNotes: (itemId: string) => `library:item:${itemId}:notes`,
  itemUserOverlay: (itemId: string, userId: string) =>
    `library:item:${itemId}:u:${userId}`,
  itemsList: (
    scopeKey: string,
    optionsHash: string,
    version: number | string = 0,
  ) => `library:${scopeKey}:items:list:v${version}:${optionsHash}`,
  itemsPattern: (scopeKey: string) =>
    `library:${escapeRedisGlob(scopeKey)}:items*`,
  itemPattern: (itemId: string) => `library:item:${escapeRedisGlob(itemId)}*`,
  counts: (userId: string, projectId?: string | null) =>
    projectId
      ? `library:counts:proj:${projectId}:u:${userId}`
      : userId.startsWith('proj:') || userId.startsWith('user:')
        ? `library:counts:${userId}`
        : `library:counts:user:${userId}`,
  countsPattern: (scopeId: string) =>
    `library:counts:*${escapeRedisGlob(scopeId)}*`,

  // Search & Facets Cache
  searchItems: (scopeKey: string, version: string, filterHash: string) =>
    `library:search:items:${scopeKey}:v${version}:${filterHash}`,
  searchFacets: (scopeKey: string, version: string, filterHash: string) =>
    `library:search:facets:${scopeKey}:v${version}:${filterHash}`,
  searchFacetsPattern: (scopeId: string) =>
    `library:search:facets:*${escapeRedisGlob(scopeId)}*`,
  searchItemsPattern: (scopeId: string) =>
    `library:search:items:*${escapeRedisGlob(scopeId)}*`,
  searchVersion: (scopeKey: string) => `library:search:version:${scopeKey}`,

  // Reader Write-Behind Buffer (High-Frequency Coalescing)
  readerProgress: (userId: string) => `library:reader:progress:${userId}`,
  readerDirtyUsers: () => 'library:reader:dirty_users',

  // Sync Sequence & Retention Checkpoints (High-Concurrency CDC Polling)
  syncSequence: (scopeKey: string) => `library:sync:seq:${scopeKey}`,
  minRetainedSequence: (scopeKey: string) =>
    `library:sync:min-seq:${scopeKey}`,

  // Citation & CSL Styles Cache
  doiNegotiation: (format: string, doi: string) =>
    format === 'meta'
      ? `library:doi-cn:meta:${doi}`
      : `library:doi-cn:cite:${format}:${doi}`,
  cslStyleXml: (styleName: string, scopeId?: string) =>
    scopeId ? `csl:xml:${scopeId}:${styleName}` : `csl:xml:${styleName}`,
  cslCustomStylesList: (scopeId?: string) =>
    scopeId ? `csl:${scopeId}:custom-styles-list` : 'csl:custom-styles-list',
  cslStylesCatalogIndex: () => 'csl:catalog:styles-index',
};

export const LIBRARY_OUTBOX_QUEUE = libraryConfig().outbox.queue;
export const LIBRARY_OUTBOX_JOB = 'dispatch_outbox_event';
