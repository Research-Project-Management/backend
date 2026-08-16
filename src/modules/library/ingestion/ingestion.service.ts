import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PaperRepository } from '../paper/paper.repository';
import { BibtexFormatter } from '../reference/formatters/bibtex.formatter';
import { DoiResolver } from '../reference/resolvers/doi.resolver';
import {
  IngestDocumentDto,
  BatchIngestDto,
  IngestionSourceType,
} from './dto/ingestion.dto';
import { RagStatus } from '@prisma/client';
import { assertNever } from '@/core/utils/error.util';

export interface IngestionResult {
  id: string;
  title: string;
  citationKey: string;
  sourceType: IngestionSourceType;
  doi?: string;
  year?: number | null;
  authors: string[];
  ragStatus: string;
  collectionId?: string | null;
  fileUrl?: string | null;
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly paperRepo: PaperRepository,
    private readonly bibtexFormatter: BibtexFormatter,
    private readonly doiResolver: DoiResolver,
  ) {}

  /**
   * Deep Seam: Ingest an academic document from any source (DOI, BibTeX, PDF, Storage)
   * into the library with automatic metadata resolution and citation key generation.
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
    let publisher = '';
    let volume = '';
    let issue = '';
    let pages = '';
    let abstract = '';
    let itemType = 'journalArticle';
    const fileUrl = dto.fileUrl || '';
    let filename = fileUrl ? fileUrl.split('/').pop() || 'paper.pdf' : '';
    const storageId = dto.storageFileId || null;
    let ragStatus: RagStatus | null = null;

    // 1. Resolve metadata depending on source type (Exhaustive Discriminated Union switch)
    switch (dto.sourceType) {
      case IngestionSourceType.DOI: {
        if (!dto.doi) {
          throw new BadRequestException(
            'DOI string is required for DOI ingestion',
          );
        }
        const resolved = await this.doiResolver.resolve(dto.doi);
        if (resolved) {
          title = title || resolved.title;
          authors = authors.length ? authors : resolved.authors;
          year = year || resolved.year;
          doi = resolved.doi || dto.doi;
          journal = journal || resolved.journal || '';
          publisher = resolved.publisher || '';
          volume = resolved.volume || '';
          issue = resolved.issue || '';
          pages = resolved.pages || '';
          abstract = resolved.abstract || '';
          itemType = resolved.itemType || 'journalArticle';
        } else if (!title) {
          title = `Publication (DOI: ${dto.doi})`;
        }
        ragStatus = RagStatus.indexed;
        break;
      }
      case IngestionSourceType.BIBTEX: {
        if (!dto.bibtex) {
          throw new BadRequestException(
            'BibTeX content is required for BibTeX ingestion',
          );
        }
        const titleMatch = dto.bibtex.match(/title\s*=\s*[{"]([^}"]+)[}"]/i);
        const authorMatch = dto.bibtex.match(/author\s*=\s*[{"]([^}"]+)[}"]/i);
        const yearMatch = dto.bibtex.match(/year\s*=\s*[{"]?(\d{4})[}"]?/i);
        const journalMatch = dto.bibtex.match(
          /journal\s*=\s*[{"]([^}"]+)[}"]/i,
        );
        const doiMatch = dto.bibtex.match(/doi\s*=\s*[{"]([^}"]+)[}"]/i);

        title = title || (titleMatch ? titleMatch[1].trim() : 'BibTeX Entry');
        if (!authors.length && authorMatch) {
          authors = authorMatch[1].split(/\s+and\s+/i).map((a) => a.trim());
        }
        year = year || (yearMatch ? parseInt(yearMatch[1], 10) : null);
        journal = journal || (journalMatch ? journalMatch[1].trim() : '');
        doi = doi || (doiMatch ? doiMatch[1].trim() : '');
        ragStatus = RagStatus.indexed;
        break;
      }
      case IngestionSourceType.PDF:
      case IngestionSourceType.STORAGE: {
        if (!title) {
          title = 'Untitled Uploaded Paper';
        }
        filename = filename || 'document.pdf';
        ragStatus =
          dto.triggerRag !== false ? RagStatus.pending : RagStatus.indexed;
        break;
      }
      default: {
        assertNever(dto.sourceType);
      }
    }

    // 2. Generate unique citation key
    const citationKey = this.bibtexFormatter.generateCitationKey(
      title,
      authors,
      year,
    );

    // 3. Persist Paper / Reference entity in database
    const paper = await this.paperRepo.createPaper({
      workspaceId: dto.workspaceId,
      uploadedById: userId,
      title,
      filename,
      fileUrl,
      authors,
      year,
      doi,
      journal,
      publisher,
      volume,
      issue,
      pages,
      abstract,
      itemType,
      citationKey,
      ragStatus,
      labels: dto.tags || [],
      ...(dto.collectionId && { collectionId: dto.collectionId }),
      ...(storageId && { primaryFile: { fileId: storageId, url: fileUrl } }),
    });

    // 4. Background RAG Dispatch Hook (if applicable)
    if (
      dto.triggerRag !== false &&
      (dto.sourceType === IngestionSourceType.PDF ||
        dto.sourceType === IngestionSourceType.STORAGE)
    ) {
      this.logger.log(
        `Queued background RAG vectorization for paper: ${paper.id} (${title})`,
      );
    }

    return {
      id: paper.id,
      title: paper.title,
      citationKey: paper.citationKey || citationKey,
      sourceType: dto.sourceType,
      doi: paper.doi || undefined,
      year: paper.year,
      authors: Array.isArray(paper.authors) ? paper.authors : [],
      ragStatus:
        paper.ragStatus === RagStatus.pending
          ? 'pending'
          : paper.ragStatus === RagStatus.indexed
            ? 'ready'
            : 'none',
      collectionId: paper.collectionId,
      fileUrl: paper.fileUrl,
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
}
