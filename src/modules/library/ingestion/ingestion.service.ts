import {
  Injectable,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
  Optional,
} from '@nestjs/common';
import {
  CatalogRepository,
  CatalogItemWithRelations,
} from '../catalog/catalog.repository';
import { BibtexFormatter } from '../citation/formatters/bibtex.formatter';
import { BibtexParser } from '../citation/parsers/bibtex.parser';
import { RisFormatter } from '../citation/formatters/ris.formatter';
import { DoiResolver } from '../citation/resolvers/doi.resolver';
import { MetadataService } from '../metadata/metadata.service';
import { RedisCacheService } from '../../../core/cache/redis-cache.service';
import { PdfDoiExtractor } from '../attachments/pdf-extractor.service';
import {
  IngestDocumentDto,
  BatchIngestDto,
  IngestionSourceType,
} from './dto/ingestion.dto';
import { AcademicMetadataReducer } from '../metadata/metadata-reducer';

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
  item?: CatalogItemWithRelations;
  paper?: CatalogItemWithRelations;
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);
  private readonly BATCH_CONCURRENCY = 5;

  constructor(
    @Inject(forwardRef(() => CatalogRepository))
    private readonly catalogRepo: CatalogRepository,
    private readonly bibtexFormatter: BibtexFormatter,
    private readonly bibtexParser: BibtexParser,
    private readonly risFormatter: RisFormatter,
    private readonly doiResolver: DoiResolver,
    private readonly metadataService: MetadataService,
    private readonly PdfDoiExtractor: PdfDoiExtractor,
    @Optional() private readonly redisCache?: RedisCacheService,
  ) {}

  /**
   * Universal ingestion pipeline for single document
   */
  async ingest(
    userId: string,
    dto: IngestDocumentDto,
  ): Promise<IngestionResult> {
    let draft = AcademicMetadataReducer.fromDto(dto);

    // 1. Multi-source Metadata Resolution & Parsing
    switch (dto.sourceType) {
      case IngestionSourceType.IDENTIFIER:
      case IngestionSourceType.DOI: {
        const query = dto.query || dto.doi;
        if (!query) {
          throw new BadRequestException('Query identifier or DOI is required');
        }

        try {
          const resolved = await this.metadataService.resolve(query);
          if (resolved?.metadata) {
            draft = AcademicMetadataReducer.merge(draft, resolved.metadata);
          }
        } catch (err: any) {
          this.logger.warn(
            `Failed to resolve identifier (${query}): ${err.message}`,
          );
        }

        if (!draft.title) {
          draft.title = query;
        }
        break;
      }

      case IngestionSourceType.BIBTEX: {
        if (!dto.bibtex) {
          throw new BadRequestException('BibTeX content is required');
        }
        const parsedEntries = this.bibtexParser.parse(dto.bibtex);
        if (parsedEntries && parsedEntries.length > 0) {
          draft = AcademicMetadataReducer.mergeBibtex(draft, parsedEntries[0]);
        }
        if (!draft.title) draft.title = 'BibTeX Entry';
        break;
      }

      case IngestionSourceType.RIS: {
        if (!dto.ris) {
          throw new BadRequestException('RIS content is required');
        }
        const parsedEntries = this.risFormatter.parse(dto.ris);
        if (parsedEntries && parsedEntries.length > 0) {
          draft = AcademicMetadataReducer.merge(draft, parsedEntries[0]);
        }
        if (!draft.title) draft.title = 'RIS Entry';
        break;
      }

      case IngestionSourceType.PDF:
      case IngestionSourceType.STORAGE:
      case IngestionSourceType.MANUAL:
      default: {
        if (!draft.title) {
          draft.title = draft.filename
            ? AcademicMetadataReducer.cleanFilenameForTitleSearch(
                draft.filename,
              )
            : 'Untitled Paper';
        }

        // Step 1: Deep PDF extraction (Zotero-grade XMP & Text Analysis)
        if (draft.fileUrl) {
          try {
            const pdfMeta = await this.PdfDoiExtractor.extractMetadataFromUrl(
              draft.fileUrl,
            );
            if (pdfMeta) {
              if (pdfMeta.doi && !draft.doi) {
                draft.doi = pdfMeta.doi;
              }
              if (pdfMeta.arxivId && !draft.arxivId) {
                draft.arxivId = pdfMeta.arxivId;
              }
              if (pdfMeta.pmid && !draft.pmid) {
                draft.pmid = pdfMeta.pmid;
              }
              if (pdfMeta.keywords && pdfMeta.keywords.length > 0) {
                draft.labels = Array.from(
                  new Set([...draft.labels, ...pdfMeta.keywords]),
                );
              }
              if (pdfMeta.abstract && !draft.abstract) {
                draft.abstract = pdfMeta.abstract;
              }
              if (
                pdfMeta.title &&
                (!draft.title ||
                  draft.title.toLowerCase().startsWith('untitled') ||
                  draft.title.toLowerCase().endsWith('.pdf') ||
                  draft.title.includes('_'))
              ) {
                draft.title = pdfMeta.title;
              }
              if (pdfMeta.authors?.length && draft.authors.length === 0) {
                draft.authors = [...pdfMeta.authors];
              }
              if (pdfMeta.year && !draft.year) {
                draft.year = pdfMeta.year;
              }
              this.logger.debug(
                `Deep PDF extraction completed for ${draft.filename} — DOI: ${draft.doi || 'none'}, arXiv: ${draft.arxivId || 'none'}, Tags: ${draft.labels.length}, Title: ${draft.title}`,
              );
            }
          } catch (err: any) {
            this.logger.debug(`PDF deep extraction skipped: ${err?.message}`);
          }
        }

        // Step 2: Authoritative resolution via CrossRef, OpenAlex, arXiv, PubMed, Semantic Scholar
        const queryCandidate =
          draft.doi ||
          draft.arxivId ||
          draft.pmid ||
          dto.query ||
          (draft.title &&
          draft.title.length > 8 &&
          !draft.title.toLowerCase().startsWith('untitled') &&
          !draft.title.toLowerCase().endsWith('.pdf')
            ? draft.title
            : '');

        if (
          queryCandidate &&
          (draft.authors.length === 0 ||
            !draft.year ||
            !draft.journal ||
            !draft.abstract ||
            draft.labels.length === 0)
        ) {
          try {
            const resolved = await this.metadataService.resolve(queryCandidate);
            if (resolved?.metadata) {
              const m = resolved.metadata;
              if (
                /^\d{4}\.\d{4,5}/i.test(draft.title) ||
                draft.title.includes('_') ||
                draft.title.toLowerCase().endsWith('.pdf') ||
                draft.title.toLowerCase().startsWith('untitled')
              ) {
                if (m.title && m.title.length > 5) draft.title = m.title;
              }
              draft = AcademicMetadataReducer.merge(draft, m);
            }
          } catch (err: any) {
            this.logger.debug(
              `Background metadata enrichment skipped for "${queryCandidate}": ${err.message}`,
            );
          }
        }

        break;
      }
    }

    // 2. Resolve Workspace and Unique Citation Key
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(
      dto.workspaceId,
    );

    const baseCitationKey =
      draft.explicitCitationKey ||
      this.bibtexFormatter.generateCitationKey(
        draft.title,
        draft.authors,
        draft.year,
      );

    const citationKey = await this.catalogRepo.resolveUniqueCitationKey(
      targetWsId,
      baseCitationKey,
    );

    // 3. Construct Primary File Payload
    const primaryFilePayload = dto.primaryFile
      ? dto.primaryFile
      : draft.storageId || draft.fileUrl
        ? {
            fileId: draft.storageId,
            filename: draft.filename,
            url: draft.fileUrl,
            size: dto.size || 0,
            mimeType: dto.mimeType || 'application/pdf',
          }
        : undefined;

    // 4. DOI dedup guard (Zotero pattern) — return existing paper silently if DOI already in workspace.
    if (draft.doi && draft.doi.trim().length > 3) {
      const existing = await this.catalogRepo.findItemByDoi(
        targetWsId,
        draft.doi,
      );
      if (existing) {
        this.logger.debug(
          `DOI dedup: paper "${existing.title}" (${existing.id}) already exists for DOI ${draft.doi} — skipping creation`,
        );
        return {
          id: existing.id,
          title: existing.title,
          citationKey: existing.citationKey || citationKey,
          sourceType: dto.sourceType,
          doi: existing.doi || undefined,
          year: existing.year,
          authors: Array.isArray(existing.authors) ? existing.authors : [],
          ragStatus: 'none',
          collectionId: existing.collectionId,
          fileUrl: existing.fileUrl,
          paper: existing,
        };
      }
    }

    // 5. Persist Master Paper Entity
    const paper = await this.catalogRepo.createItem({
      workspaceId: targetWsId,
      uploadedById: userId,
      title: draft.title,
      shortTitle: draft.shortTitle || undefined,
      filename: draft.filename,
      fileUrl: draft.fileUrl,
      size: dto.size || 0,
      mimeType: dto.mimeType || 'application/pdf',
      authors: draft.authors,
      editors: draft.editors || [],
      year: draft.year,
      publicationDate: draft.publicationDate || undefined,
      doi: draft.doi,
      journal: draft.journal,
      publicationTitle: draft.publicationTitle || draft.journal,
      journalAbbr: draft.journalAbbr || undefined,
      publisher: draft.publisher,
      place: draft.place || undefined,
      volume: draft.volume,
      issue: draft.issue,
      section: draft.section || undefined,
      pages: draft.pages,
      series: draft.series || undefined,
      seriesTitle: draft.seriesTitle || undefined,
      issn: draft.issn,
      isbn: draft.isbn,
      pmid: draft.pmid || undefined,
      pmcid: draft.pmcid || undefined,
      url: draft.url,
      language: draft.language || undefined,
      abstract: draft.abstract,
      itemType: draft.itemType,
      citationKey,
      labels: draft.labels,
      notes: draft.notes,
      rights: draft.rights || undefined,
      license: draft.license || undefined,
      archive: draft.archive || undefined,
      archiveLocation: draft.archiveLocation || undefined,
      callNumber: draft.callNumber || undefined,
      libraryCatalog: draft.libraryCatalog || undefined,
      extra: draft.extra || undefined,
      ...(dto.collectionId && { collectionId: dto.collectionId }),
      ...(primaryFilePayload && { primaryFile: primaryFilePayload }),
    });

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

  // ─── Batch helpers ────────────────────────────────────────────────────────

  /** Split an array into fixed-size chunks for rate-limited concurrent processing. */
  private chunked<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Batch ingest multiple items with chunked concurrency.
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

    const successful: IngestionResult[] = [];
    const failed: Array<{ item: IngestDocumentDto; error: string }> = [];

    for (const chunk of this.chunked(dto.items, this.BATCH_CONCURRENCY)) {
      const results = await Promise.allSettled(
        chunk.map((item) => this.ingest(userId, item)),
      );
      results.forEach((res, index) => {
        if (res.status === 'fulfilled') {
          successful.push(res.value);
        } else {
          failed.push({
            item: chunk[index],
            error: (res.reason as Error)?.message || 'Unknown ingestion error',
          });
        }
      });
    }

    return {
      total: dto.items.length,
      successCount: successful.length,
      failedCount: failed.length,
      successful,
      failed,
    };
  }
}
