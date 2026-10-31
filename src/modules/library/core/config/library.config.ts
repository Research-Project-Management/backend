import { registerAs } from '@nestjs/config';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface LibraryConfig {
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
    ocrMaxWorkers: number;
    ocrTimeoutMs: number;
    mextractTimeoutMs: number;
    pdfMaxPages: number;
    webFetchTimeoutMs: number;
    pdfMaxIndexPages: number;
  };
  ocr: {
    enabled?: string;
    maxPages: number;
    renderScale: number;
    concurrency: number;
    languages?: string;
    tesseractLangPath?: string;
  };
  mextract: {
    modelName: string;
    apiUrl?: string;
  };
  webFetch: {
    stealthScraperUrl?: string;
    headlessScraperUrl?: string;
    flaresolverrUrl?: string;
  };
  capture: {
    secret?: string;
  };
  retraction: {
    syncIntervalHours: number;
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
      ocrMaxWorkers: Number(process.env.OCR_MAX_WORKERS) || 2,
      ocrTimeoutMs: Number(process.env.OCR_TIMEOUT_MS) || 60000,
      mextractTimeoutMs: Number(process.env.MEXTRACT_TIMEOUT_MS) || 15000,
      pdfMaxPages: Number(process.env.PDF_MAX_PAGES) || 100,
      webFetchTimeoutMs: Number(process.env.WEB_FETCH_TIMEOUT_MS) || 10000,
      pdfMaxIndexPages: Number.parseInt(
        process.env.LIBRARY_PDF_MAX_INDEX_PAGES ||
          process.env.PDF_MAX_INDEX_PAGES ||
          '100',
        10,
      ),
    },
    ocr: {
      enabled: process.env.PDF_OCR_ENABLED,
      maxPages: Number.parseInt(process.env.PDF_OCR_MAX_PAGES || '200', 10),
      renderScale: Number.parseFloat(process.env.PDF_OCR_RENDER_SCALE || '3'),
      concurrency: Number.parseInt(process.env.PDF_OCR_CONCURRENCY || '2', 10),
      languages: process.env.PDF_OCR_LANGUAGES,
      tesseractLangPath: process.env.TESSERACT_LANG_PATH,
    },
    mextract: {
      modelName:
        process.env.MEXTRACT_MODEL_NAME || 'Xenova/Qwen2.5-0.5B-Instruct',
      apiUrl: process.env.MEXTRACT_API_URL,
    },
    webFetch: {
      stealthScraperUrl: process.env.STEALTH_SCRAPER_URL,
      headlessScraperUrl: process.env.HEADLESS_SCRAPER_URL,
      flaresolverrUrl: process.env.FLARESOLVERR_URL,
    },
    capture: {
      secret: process.env.URL_CAPTURE_SECRET,
    },
    retraction: {
      syncIntervalHours:
        Number(process.env.RETRACTION_SYNC_INTERVAL_HOURS) || 12,
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

  get ocr() {
    return this.config.ocr;
  }

  get mextract() {
    return this.config.mextract;
  }

  get webFetch() {
    return this.config.webFetch;
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
