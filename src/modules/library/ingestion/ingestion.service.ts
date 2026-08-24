import { Injectable, BadRequestException, Logger, Inject, forwardRef } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PaperRepository, PaperWithRelations } from '../paper/paper.repository';
import { BibtexFormatter } from '../reference/formatters/bibtex.formatter';
import { BibtexParser } from '../reference/parsers/bibtex.parser';
import { RisFormatter } from '../reference/formatters/ris.formatter';
import { DoiResolver } from '../reference/resolvers/doi.resolver';
import { UnifiedFetcherService } from '../reference/fetchers/unified-fetcher.service';
import {
  IngestDocumentDto,
  BatchIngestDto,
  IngestionSourceType,
} from './dto/ingestion.dto';

export interface IngestionResult {
  id: string;
  title: string;
  citationKey: string;
  sourceType: IngestionSourceType;
  doi?: string;
  year?: number | null;
  authors: string[];
  ragStatus?: string;
  collectionId?: string | null;
  fileUrl?: string | null;
  paper?: PaperWithRelations;
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    @Inject(forwardRef(() => PaperRepository))
    private readonly paperRepo: PaperRepository,
    private readonly bibtexFormatter: BibtexFormatter,
    private readonly bibtexParser: BibtexParser,
    private readonly risFormatter: RisFormatter,
    private readonly doiResolver: DoiResolver,
    private readonly unifiedFetcher: UnifiedFetcherService,
  ) {}

  /**
   * Universal ingestion pipeline for single document
   */
  async ingest(
    userId: string,
    dto: IngestDocumentDto,
  ): Promise<IngestionResult> {
    let title = dto.title?.trim() || '';
    let authors = dto.authors || [];
    let year = dto.year || null;
    let doi = dto.doi?.trim() || '';
    let journal = dto.journal || '';
    let publisher = dto.publisher || '';
    let volume = dto.volume || '';
    let issue = dto.issue || '';
    let pages = dto.pages || '';
    let issn = dto.issn || '';
    let isbn = dto.isbn || '';
    let url = dto.url || '';
    let abstract = dto.abstract || '';
    let itemType = dto.itemType || 'journalArticle';
    let fileUrl = dto.fileUrl || '';
    let filename =
      dto.filename || (fileUrl ? fileUrl.split('/').pop() || 'paper.pdf' : 'document.pdf');
    const storageId = dto.storageFileId || dto.primaryFile?.fileId || null;
    let labels: string[] = dto.tags || [];
    let notes: any[] = dto.notes || [];
    let explicitCitationKey = dto.citationKey?.trim() || '';

    // 1. Multi-source Metadata Resolution & Parsing
    switch (dto.sourceType) {
      case IngestionSourceType.IDENTIFIER:
      case IngestionSourceType.DOI: {
        const query = dto.query || dto.doi;
        if (!query) {
          throw new BadRequestException('Query identifier or DOI is required');
        }

        try {
          const resolved = await this.unifiedFetcher.resolve(query);
          if (resolved?.metadata) {
            const m = resolved.metadata;
            title = title || m.title;
            authors = authors.length ? authors : m.authors || [];
            year = year || m.year || null;
            doi = doi || m.doi || '';
            journal = journal || m.journal || '';
            publisher = publisher || m.publisher || '';
            volume = volume || m.volume || '';
            issue = issue || m.issue || '';
            pages = pages || m.pages || '';
            issn = issn || m.issn || '';
            isbn = isbn || m.isbn || '';
            url = url || m.url || '';
            abstract = abstract || m.abstract || '';
            itemType = itemType || m.itemType || 'journalArticle';
            if (!labels.length && m.keywords?.length) {
              labels = m.keywords;
            }
            if (!notes.length && m.tldr) {
              notes = [
                {
                  id: randomUUID(),
                  content: `💡 **TL;DR Summary**:\n${m.tldr}`,
                  createdAt: new Date().toISOString(),
                },
              ];
            }
            if (!fileUrl && m.openAccessPdfUrl) {
              fileUrl = m.openAccessPdfUrl;
            }
          }
        } catch (err: any) {
          this.logger.warn(`Failed to resolve identifier (${query}): ${err.message}`);
        }

        if (!title) {
          title = query;
        }
        break;
      }

      case IngestionSourceType.BIBTEX: {
        if (!dto.bibtex) {
          throw new BadRequestException('BibTeX content is required');
        }
        const parsedEntries = this.bibtexParser.parse(dto.bibtex);
        if (parsedEntries && parsedEntries.length > 0) {
          const entry = parsedEntries[0];
          title = title || entry.title;
          authors = authors.length ? authors : entry.authors || [];
          year = year || entry.year || null;
          doi = doi || entry.doi || '';
          journal = journal || entry.journal || '';
          publisher = publisher || entry.publisher || '';
          volume = volume || entry.volume || '';
          issue = issue || entry.issue || '';
          pages = pages || entry.pages || '';
          issn = issn || entry.issn || '';
          isbn = isbn || entry.isbn || '';
          url = url || entry.url || '';
          abstract = abstract || entry.abstract || '';
          itemType = itemType || entry.itemType || 'journalArticle';
          if (!labels.length && (entry as any).keywords?.length) {
            labels = (entry as any).keywords;
          }
          if (!notes.length && (entry as any).annote) {
            notes = [
              {
                id: randomUUID(),
                content: (entry as any).annote,
                createdAt: new Date().toISOString(),
              },
            ];
          }
          if (!explicitCitationKey && entry.citationKey?.trim()) {
            explicitCitationKey = entry.citationKey.trim();
          }
        }
        if (!title) title = 'BibTeX Entry';
        break;
      }

      case IngestionSourceType.RIS: {
        if (!dto.ris) {
          throw new BadRequestException('RIS content is required');
        }
        const parsedEntries = this.risFormatter.parse(dto.ris);
        if (parsedEntries && parsedEntries.length > 0) {
          const entry = parsedEntries[0];
          title = title || entry.title;
          authors = authors.length ? authors : entry.authors || [];
          year = year || entry.year || null;
          doi = doi || entry.doi || '';
          journal = journal || entry.journal || '';
          publisher = publisher || entry.publisher || '';
          volume = volume || entry.volume || '';
          issue = issue || entry.issue || '';
          pages = pages || entry.pages || '';
          url = url || entry.url || '';
          abstract = abstract || entry.abstract || '';
          itemType = itemType || entry.itemType || 'journalArticle';
          if (!labels.length && (entry as any).keywords?.length) {
            labels = (entry as any).keywords;
          }
        }
        if (!title) title = 'RIS Entry';
        break;
      }

      case IngestionSourceType.PDF:
      case IngestionSourceType.STORAGE:
      case IngestionSourceType.MANUAL:
      default: {
        if (!title) {
          title = filename ? filename.replace(/\.[^/.]+$/, '') : 'Untitled Paper';
        }

        // Auto-enrich metadata if fields are missing (e.g. uploaded from PDF or filename)
        const queryCandidate =
          doi ||
          dto.query ||
          (title && title.length > 4 && !title.toLowerCase().startsWith('untitled') ? title : '');

        if (queryCandidate && (authors.length === 0 || !year || !journal || !abstract)) {
          try {
            const resolved = await this.unifiedFetcher.resolve(queryCandidate);
            if (resolved?.metadata) {
              const m = resolved.metadata;
              // If current title looks like an arXiv ID or raw filename, adopt real authoritative title
              if (/^\d{4}\.\d{4,5}/i.test(title) || title.includes('_') || title.toLowerCase().endsWith('.pdf')) {
                if (m.title && m.title.length > 5) {
                  title = m.title;
                }
              }
              if (!authors.length && m.authors?.length) authors = m.authors;
              if (!year && m.year) year = m.year;
              if (!doi && m.doi) doi = m.doi;
              if (!journal && m.journal) journal = m.journal;
              if (!publisher && m.publisher) publisher = m.publisher;
              if (!volume && m.volume) volume = m.volume;
              if (!issue && m.issue) issue = m.issue;
              if (!pages && m.pages) pages = m.pages;
              if (!issn && m.issn) issn = m.issn;
              if (!isbn && m.isbn) isbn = m.isbn;
              if (!url && m.url) url = m.url;
              if (!abstract && m.abstract) abstract = m.abstract;
              if (itemType === 'journalArticle' && m.itemType) itemType = m.itemType;
              if (!labels.length && m.keywords?.length) {
                labels = m.keywords;
              }
              if (!notes.length && m.tldr) {
                notes = [
                  {
                    id: randomUUID(),
                    content: `💡 **TL;DR Summary**:\n${m.tldr}`,
                    createdAt: new Date().toISOString(),
                  },
                ];
              }
              if (!fileUrl && m.openAccessPdfUrl) fileUrl = m.openAccessPdfUrl;
            }
          } catch (err: any) {
            this.logger.debug(`Background metadata enrichment skipped for "${queryCandidate}": ${err.message}`);
          }
        }

        break;
      }
    }

    // 2. Resolve Workspace and Unique Citation Key
    const ws = await this.paperRepo.resolveWorkspace(dto.workspaceId);
    const targetWsId = ws?.id || dto.workspaceId;

    const baseCitationKey =
      explicitCitationKey ||
      this.bibtexFormatter.generateCitationKey(title, authors, year);

    const citationKey = await this.paperRepo.resolveUniqueCitationKey(
      targetWsId,
      baseCitationKey,
    );

    // 3. Construct Primary File Payload
    const primaryFilePayload = dto.primaryFile
      ? dto.primaryFile
      : storageId || fileUrl
        ? {
            fileId: storageId,
            filename,
            url: fileUrl,
            size: dto.size || 0,
            mimeType: dto.mimeType || 'application/pdf',
          }
        : undefined;

    // 4. Persist Master Paper Entity
    const paper = (await this.paperRepo.createPaper({
      workspaceId: targetWsId,
      uploadedById: userId,
      title,
      filename,
      fileUrl,
      size: dto.size || 0,
      mimeType: dto.mimeType || 'application/pdf',
      authors,
      year,
      doi,
      journal,
      publisher,
      volume,
      issue,
      pages,
      issn,
      isbn,
      url,
      abstract,
      itemType,
      citationKey,
      labels,
      notes,
      ...(dto.collectionId && { collectionId: dto.collectionId }),
      ...(primaryFilePayload && { primaryFile: primaryFilePayload }),
    })) as PaperWithRelations;

    return {
      id: paper.id,
      title: paper.title,
      citationKey: paper.citationKey || citationKey,
      sourceType: dto.sourceType,
      doi: paper.doi || undefined,
      year: paper.year,
      authors: Array.isArray(paper.authors) ? paper.authors : [],
      ragStatus: 'none',
      collectionId: paper.collectionId,
      fileUrl: paper.fileUrl,
      paper,
    };
  }

  /**
   * Deep Seam: Batch ingest multiple items in parallel
   */
  async batchIngest(userId: string, dto: BatchIngestDto) {
    if (!dto.items || dto.items.length === 0) {
      return {
        total: 0,
        successCount: 0,
        failedCount: 0,
        successful: [],
        failed: [],
      };
    }

    const results = await Promise.allSettled(
      dto.items.map((item) => this.ingest(userId, item)),
    );

    const successful: IngestionResult[] = [];
    const failed: Array<{ item: IngestDocumentDto; error: string }> = [];

    results.forEach((res, index) => {
      if (res.status === 'fulfilled') {
        successful.push(res.value);
      } else {
        failed.push({
          item: dto.items[index],
          error: (res.reason as Error)?.message || 'Unknown ingestion error',
        });
      }
    });

    return {
      total: dto.items.length,
      successCount: successful.length,
      failedCount: failed.length,
      successful,
      failed,
    };
  }

  // ── In-Memory Job Store for Async Batch Processing ───────────────────────
  private readonly jobs = new Map<string, IngestionJobStatus>();

  /**
   * Enqueues an asynchronous batch ingestion job and starts background processing
   */
  async createAsyncBatchJob(
    userId: string,
    dto: BatchIngestDto,
  ): Promise<{ jobId: string; status: string; total: number }> {
    const jobId = randomUUID();
    const items = dto.items || [];

    const job: IngestionJobStatus = {
      jobId,
      status: 'processing',
      total: items.length,
      processed: 0,
      successCount: 0,
      failedCount: 0,
      progressPercentage: 0,
      successful: [],
      failed: [],
      createdAt: new Date().toISOString(),
    };

    this.jobs.set(jobId, job);

    // Process asynchronously without blocking HTTP response
    setImmediate(async () => {
      for (const item of items) {
        try {
          const res = await this.ingest(userId, item);
          job.successful.push(res);
          job.successCount++;
        } catch (err: any) {
          job.failed.push({
            item,
            error: err?.message || 'Failed to ingest item',
          });
          job.failedCount++;
        } finally {
          job.processed++;
          job.progressPercentage = Math.round(
            (job.processed / job.total) * 100,
          );
        }
      }
      job.status = job.failedCount === job.total ? 'failed' : 'completed';
      job.completedAt = new Date().toISOString();
      this.logger.log(
        `Async Ingestion Job ${jobId} finished (${job.successCount}/${job.total} success)`,
      );
    });

    return {
      jobId,
      status: 'processing',
      total: items.length,
    };
  }

  /**
   * Poll status of an async batch ingestion job
   */
  getJobStatus(jobId: string): IngestionJobStatus {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new BadRequestException(`Ingestion job with ID ${jobId} not found`);
    }
    return job;
  }
}

export interface IngestionJobStatus {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  total: number;
  processed: number;
  successCount: number;
  failedCount: number;
  progressPercentage: number;
  successful: IngestionResult[];
  failed: Array<{ item: IngestDocumentDto; error: string }>;
  createdAt: string;
  completedAt?: string;
}
