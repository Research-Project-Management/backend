import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Optional,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { IngestionStatus } from '@prisma/client';
import { LibraryTransactionService } from '../sync-core/library-transaction.service';
import { CatalogService } from '../catalog/catalog.service';
import { IdempotencyRepository } from '../sync-core/idempotency.repository';
import { AttachmentsService } from '../attachments/attachments.service';
import { ExtractorService } from '../attachments/extractor.service';
import { BibtexParser } from '../citation/formatters/bibtex.parser';
import { FullTextIndexer } from '../discovery/full-text-indexer';
import {
  StartIngestionDto,
  IngestDoiDto,
  IngestBibtexDto,
} from './dto/ingestion.dto';
import { createHash, randomUUID } from 'crypto';
import {
  UrlCaptureConnector,
  CapturedPaperMetadata,
} from './url-capture.connector';
import { ConfirmCapturedUrlDto } from './dto/capture-url.dto';
import { QueryClassifier } from './metadata/metadata.classifier';
import { normalizeDoi } from './metadata/metadata.identifiers';
import {
  CANONICAL_METADATA_SERVICE,
  CanonicalMetadataResolver,
  ResolvedMetadata,
} from './metadata/metadata.contracts';
import {
  IngestionCommand,
  IngestionResult,
  IngestionRunSnapshot,
  IUnifiedIngestionService,
} from './ingestion.contracts';
import {
  calculateIngestionRequestHash,
  INGESTION_LIMITS,
  validateUrlSecurity,
} from './ingestion.policy';
import {
  IngestionException,
  IngestionValidationException,
  IngestionUnsupportedSourceException,
  IngestionMetadataNotFoundException,
  IngestionIdempotencyConflictException,
} from './ingestion.errors';

@Injectable()
export class IngestionService implements IUnifiedIngestionService {
  private readonly logger = new Logger(IngestionService.name);

  private readonly extractorService?: ExtractorService;
  private readonly bibtexParser?: BibtexParser;

  private getBibtexParser(): BibtexParser {
    return this.bibtexParser || new BibtexParser();
  }

  private getExtractorService(): ExtractorService {
    return this.extractorService || new ExtractorService();
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly libraryTx: LibraryTransactionService,
    private readonly catalogService: CatalogService,
    private readonly urlCapture: UrlCaptureConnector,
    @Optional()
    @Inject(CANONICAL_METADATA_SERVICE)
    private readonly metadataService?: CanonicalMetadataResolver,
    @Optional()
    private readonly idempotencyRepo?: IdempotencyRepository,
    @Optional()
    private readonly attachmentsService?: AttachmentsService,
    @Optional()
    extractorService?: ExtractorService,
    @Optional()
    bibtexParser?: BibtexParser,
    @Optional()
    private readonly fullTextIndexer?: FullTextIndexer,
  ) {
    this.extractorService = extractorService;
    this.bibtexParser = bibtexParser;
  }

  /**
   * Unified entry point coordinating all ingestion sources (DOI, URL, BibTeX, PDF, Zotero).
   * Enforces idempotency, external resolution outside transactions, atomic commit, and observability.
   */
  async ingest(command: IngestionCommand): Promise<IngestionResult> {
    const startTime = Date.now();
    const runId = randomUUID();

    this.logger.log(
      JSON.stringify({
        event: 'library.ingestion.started',
        runId,
        workspaceId: command.workspaceId,
        source: command.source,
      }),
    );

    // 1. Idempotency Check & Claim
    const idempotencyKey = command.idempotencyKey?.trim();
    if (idempotencyKey && this.idempotencyRepo) {
      const requestHash = calculateIngestionRequestHash(command);
      const claimResult = await this.idempotencyRepo.claim(
        command.workspaceId,
        idempotencyKey,
        requestHash,
        INGESTION_LIMITS.DEFAULT_IDEMPOTENCY_TTL_SECONDS,
      );

      if (claimResult.status === 'cached') {
        this.logger.log(
          JSON.stringify({
            event: 'library.ingestion.idempotency_cache_hit',
            runId,
            workspaceId: command.workspaceId,
            idempotencyKey,
          }),
        );
        return claimResult.record.responseBody as unknown as IngestionResult;
      }

      if (claimResult.status === 'in_progress') {
        throw new IngestionIdempotencyConflictException(
          'An ingestion request with this idempotency key is currently in progress.',
        );
      }

      if (claimResult.status === 'mismatch') {
        throw new IngestionIdempotencyConflictException(
          'Idempotency key reused with mismatched request payload.',
        );
      }
    }

    try {
      let result: IngestionResult;

      switch (command.source) {
        case 'doi':
          result = await this.handleDoi(command, runId);
          break;
        case 'url':
          result = await this.handleUrl(command, runId);
          break;
        case 'bibtex':
          result = await this.handleBibtex(command, runId);
          break;
        case 'pdf':
          result = await this.handlePdf(command, runId);
          break;
        case 'zotero':
          result = await this.handleZotero(command, runId);
          break;
        default:
          throw new IngestionUnsupportedSourceException((command as any).source);
      }

      // Record successful result in Idempotency store
      if (idempotencyKey && this.idempotencyRepo) {
        await this.idempotencyRepo.markSucceeded(
          command.workspaceId,
          idempotencyKey,
          200,
          result,
        );
      }

      const durationMs = Date.now() - startTime;
      this.logger.log(
        JSON.stringify({
          event: result.deduplicated
            ? 'library.ingestion.deduplicated'
            : 'library.ingestion.committed',
          runId,
          workspaceId: command.workspaceId,
          source: command.source,
          itemId: result.itemId,
          deduplicated: result.deduplicated,
          durationMs,
        }),
      );

      return result;
    } catch (err: any) {
      if (idempotencyKey && this.idempotencyRepo) {
        await this.idempotencyRepo.markFailed(
          command.workspaceId,
          idempotencyKey,
        );
      }

      this.logger.error(
        JSON.stringify({
          event: 'library.ingestion.failed',
          runId,
          workspaceId: command.workspaceId,
          source: command.source,
          errorName: err instanceof Error ? err.name : 'UnknownError',
          errorCategory: err?.category || 'execution_failed',
        }),
      );

      throw err;
    }
  }

  // ─── Source Handlers ────────────────────────────────────────────────────────

  /**
   * Handles DOI ingestion with external metadata resolution outside transaction.
   */
  private async handleDoi(
    command: Extract<IngestionCommand, { source: 'doi' }>,
    runId: string,
  ): Promise<IngestionResult> {
    const rawDoi = command.doi?.trim();
    if (!rawDoi) {
      throw new IngestionValidationException('DOI is required');
    }

    const cleanDoi =
      normalizeDoi(rawDoi) ||
      rawDoi.replace(/^https?:\/\/doi\.org\//i, '');
    if (!cleanDoi) {
      throw new IngestionValidationException(`Invalid DOI format: ${rawDoi}`);
    }

    // 1. External Resolution outside transaction
    if (!this.metadataService) {
      throw new IngestionException(
        'Metadata service is not available',
        'provider_unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const resolved = await this.metadataService.resolve({ query: cleanDoi });
    if (!resolved) {
      throw new IngestionMetadataNotFoundException(cleanDoi);
    }

    const meta = resolved.metadata;
    const title = (meta.title || `Publication (${cleanDoi})`).trim();
    const authors =
      meta.authors && meta.authors.length > 0 ? meta.authors : undefined;
    const year = meta.year ?? undefined;
    const journal = meta.journal || meta.publicationTitle;
    const itemType = meta.itemType || 'journalArticle';
    const userId = command.userId || 'system';

    // 2. Atomic Transaction
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      // Deduplicate check
      const existing = tx.catalogItem?.findFirst
        ? await tx.catalogItem.findFirst({
            where: {
              workspaceId: command.workspaceId,
              doi: cleanDoi,
              deletedAt: null,
            },
          })
        : null;

      if (existing) {
        return {
          runId,
          status: 'completed',
          itemId: existing.id,
          attachmentIds: [],
          deduplicated: true,
          item: existing,
        };
      }

      const item = await this.catalogService.createItem(
        command.workspaceId,
        {
          itemType,
          title,
          authors,
          year,
          journal,
          abstract: meta.abstract,
          doi: cleanDoi,
          url: meta.url || `https://doi.org/${cleanDoi}`,
          uploadedById: userId,
          collectionId: command.collectionId,
        },
        { tx, helpers },
      );

      // Persist tags if present
      if (meta.tags && meta.tags.length > 0) {
        await this.persistItemTags(
          tx,
          helpers,
          command.workspaceId,
          item.id,
          meta.tags,
        );
      }

      await helpers.publishOutbox(
        command.workspaceId,
        item.id,
        'library.item.ingested_doi',
        {
          doi: cleanDoi,
          itemId: item.id,
          title,
          itemType,
          authors,
          year,
          canonicalId: resolved.canonicalId,
        },
      );

      return {
        runId,
        status: 'completed',
        itemId: item.id,
        attachmentIds: [],
        deduplicated: false,
        item,
      };
    });
  }

  /**
   * Handles URL capture / confirm ingestion.
   */
  private async handleUrl(
    command: Extract<IngestionCommand, { source: 'url' }>,
    runId: string,
  ): Promise<IngestionResult> {
    const rawUrl = command.url?.trim();
    if (!rawUrl) {
      throw new IngestionValidationException('URL is required');
    }

    validateUrlSecurity(rawUrl);

    // If previewToken is provided, confirm captured preview directly
    if (command.previewToken) {
      const item = await this.confirmCapturedUrl(
        command.workspaceId,
        command.userId || 'system',
        {
          previewToken: command.previewToken,
          url: rawUrl,
          ...(command.overrides || {}),
        },
      );

      return {
        runId,
        status: 'completed',
        itemId: item.id,
        attachmentIds: [],
        deduplicated: false,
        item,
      };
    }

    // Direct URL resolution outside transaction
    const captured = await this.captureUrl(rawUrl, {
      workspaceId: command.workspaceId,
      userId: command.userId,
    });

    const overrides = command.overrides || {};
    const title = (overrides.title || captured.title || 'Untitled Document').trim();
    const abstract =
      overrides.abstract !== undefined ? overrides.abstract : captured.abstract;
    const doi =
      overrides.doi !== undefined
        ? overrides.doi
        : captured.doi
          ? normalizeDoi(captured.doi) || captured.doi
          : undefined;
    const year = overrides.year !== undefined ? overrides.year : captured.year;
    const publicationTitle =
      overrides.publicationTitle !== undefined
        ? overrides.publicationTitle
        : captured.publicationTitle;
    const itemType = overrides.itemType || captured.itemType || 'webpage';

    const creators =
      overrides.creators && overrides.creators.length > 0
        ? overrides.creators
        : captured.creators || [];
    const authors = creators
      .map((c: any) => {
        if (typeof c === 'string') return c;
        if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
        return c.lastName || c.firstName || '';
      })
      .filter(Boolean);

    const userId = command.userId || 'system';

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      // Deduplicate check by DOI or exact canonical URL
      let existing = null;
      if (doi && tx.catalogItem?.findFirst) {
        existing = await tx.catalogItem.findFirst({
          where: {
            workspaceId: command.workspaceId,
            doi,
            deletedAt: null,
          },
        });
      }
      if (!existing && tx.catalogItem?.findFirst) {
        existing = await tx.catalogItem.findFirst({
          where: {
            workspaceId: command.workspaceId,
            url: rawUrl,
            deletedAt: null,
          },
        });
      }

      if (existing) {
        return {
          runId,
          status: 'completed',
          itemId: existing.id,
          attachmentIds: [],
          deduplicated: true,
          item: existing,
        };
      }

      const item = await this.catalogService.createItem(
        command.workspaceId,
        {
          itemType,
          title,
          abstract,
          doi,
          url: rawUrl,
          year,
          journal: publicationTitle,
          authors: authors.length > 0 ? authors : undefined,
          uploadedById: userId,
          collectionId: command.collectionId,
        },
        { tx, helpers },
      );

      const tags = overrides.tags || (captured as any).tags || [];
      if (tags.length > 0) {
        await this.persistItemTags(
          tx,
          helpers,
          command.workspaceId,
          item.id,
          tags,
        );
      }

      await helpers.publishOutbox(
        command.workspaceId,
        item.id,
        'library.item.ingested_url',
        {
          itemId: item.id,
          url: rawUrl,
          title,
          itemType,
        },
      );

      return {
        runId,
        status: 'completed',
        itemId: item.id,
        attachmentIds: [],
        deduplicated: false,
        item,
      };
    });
  }

  /**
   * Handles BibTeX ingestion.
   */
  private async handleBibtex(
    command: Extract<IngestionCommand, { source: 'bibtex' }>,
    runId: string,
  ): Promise<IngestionResult> {
    const rawContent = command.content?.trim();
    if (!rawContent) {
      throw new IngestionValidationException('BibTeX content is required');
    }

    if (Buffer.byteLength(rawContent, 'utf8') > INGESTION_LIMITS.MAX_BIBTEX_SIZE_BYTES) {
      throw new IngestionValidationException('BibTeX content exceeds maximum allowed size (10MB)');
    }

    // 1. Parse BibTeX outside transaction
    const entries = this.getBibtexParser().parse(rawContent);
    if (entries.length === 0) {
      throw new IngestionValidationException('No valid BibTeX entries found in input');
    }

    const primaryEntry = entries[0];
    let resolvedDoiMeta: ResolvedMetadata | null = null;

    if (primaryEntry.doi && this.metadataService) {
      const cleanDoi = normalizeDoi(primaryEntry.doi);
      if (cleanDoi) {
        try {
          resolvedDoiMeta = await this.metadataService.resolve({ query: cleanDoi });
        } catch {
          // Fall back gracefully to BibTeX parsed fields
        }
      }
    }

    const title = (
      resolvedDoiMeta?.metadata.title ||
      primaryEntry.title ||
      'Imported BibTeX Reference'
    ).trim();

    const authors =
      resolvedDoiMeta?.metadata.authors && resolvedDoiMeta.metadata.authors.length > 0
        ? resolvedDoiMeta.metadata.authors
        : primaryEntry.authors && primaryEntry.authors.length > 0
          ? primaryEntry.authors
          : undefined;

    const year = resolvedDoiMeta?.metadata.year ?? primaryEntry.year ?? undefined;
    const journal =
      resolvedDoiMeta?.metadata.journal ||
      resolvedDoiMeta?.metadata.publicationTitle ||
      primaryEntry.journal;
    const doi = resolvedDoiMeta?.metadata.doi || primaryEntry.doi;
    const itemType =
      resolvedDoiMeta?.metadata.itemType ||
      primaryEntry.itemType ||
      'journalArticle';
    const userId = command.userId || 'system';

    // 2. Open Library Transaction
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      // Deduplicate check by DOI or title+year
      let existing = null;
      if (doi && tx.catalogItem?.findFirst) {
        existing = await tx.catalogItem.findFirst({
          where: {
            workspaceId: command.workspaceId,
            doi,
            deletedAt: null,
          },
        });
      }
      if (!existing && year && tx.catalogItem?.findFirst) {
        existing = await tx.catalogItem.findFirst({
          where: {
            workspaceId: command.workspaceId,
            title: { equals: title, mode: 'insensitive' },
            year,
            deletedAt: null,
          },
        });
      }

      if (existing) {
        return {
          runId,
          status: 'completed',
          itemId: existing.id,
          attachmentIds: [],
          deduplicated: true,
          item: existing,
        };
      }

      const item = await this.catalogService.createItem(
        command.workspaceId,
        {
          itemType,
          title,
          authors,
          year,
          journal,
          doi,
          abstract: resolvedDoiMeta?.metadata.abstract || primaryEntry.abstract,
          citationKey: primaryEntry.citationKey,
          volume: primaryEntry.volume,
          issue: primaryEntry.issue,
          pages: primaryEntry.pages,
          publisher: primaryEntry.publisher,
          uploadedById: userId,
          collectionId: command.collectionId,
        },
        { tx, helpers },
      );

      await helpers.publishOutbox(
        command.workspaceId,
        item.id,
        'library.item.ingested_bibtex',
        { itemId: item.id, title, citationKey: primaryEntry.citationKey },
      );

      return {
        runId,
        status: 'completed',
        itemId: item.id,
        attachmentIds: [],
        deduplicated: false,
        item,
      };
    });
  }

  /**
   * Handles PDF upload / ingestion.
   * Performs file validation, checksum calculation, text/metadata extraction outside transaction,
   * atomic item + attachment creation in transaction, and triggers async page indexing post-commit.
   */
  private async handlePdf(
    command: Extract<IngestionCommand, { source: 'pdf' }>,
    runId: string,
  ): Promise<IngestionResult> {
    const filename = (command.filename || 'document.pdf').trim();
    const mimeType = command.mimeType || 'application/pdf';
    const size = command.size || command.buffer?.length || 0;
    const fileUrl = command.fileUrl || '';
    const userId = command.userId || 'system';

    if (size > INGESTION_LIMITS.MAX_PDF_SIZE_BYTES) {
      throw new IngestionValidationException(
        `PDF file size (${size} bytes) exceeds maximum limit of 50MB`,
      );
    }

    // 1. Calculate or use SHA-256 Checksum
    let fileHash = command.fileHash;
    if (!fileHash && command.buffer && this.attachmentsService) {
      fileHash = this.attachmentsService.calculateChecksum(command.buffer);
    }
    if (!fileHash && command.buffer) {
      fileHash = createHash('sha256').update(command.buffer).digest('hex');
    }
    if (!fileHash) {
      fileHash = createHash('sha256')
        .update(`${filename}-${size}-${fileUrl}`)
        .digest('hex');
    }

    // 2. Extract PDF Metadata outside transaction
    let extracted: any = command.extractedMeta || {};
    if (command.buffer && Object.keys(extracted).length === 0) {
      try {
        const bufMeta = this.getExtractorService().extractMetadataFromBuffer(command.buffer);
        extracted = { ...bufMeta };
      } catch (err: any) {
        this.logger.warn(`PDF buffer extraction error: ${err.message}`);
      }
    }

    // If DOI or arXiv extracted, attempt canonical metadata enrichment outside transaction
    let resolvedMeta: ResolvedMetadata | null = null;
    const potentialDoi = extracted.doi ? normalizeDoi(extracted.doi) : null;
    if (potentialDoi && this.metadataService) {
      try {
        resolvedMeta = await this.metadataService.resolve({ query: potentialDoi });
      } catch {
        // Fall back to extracted fields
      }
    }

    const title = (
      resolvedMeta?.metadata.title ||
      extracted.title ||
      filename.replace(/\.pdf$/i, '') ||
      'Uploaded Document'
    ).trim();

    const authors =
      resolvedMeta?.metadata.authors && resolvedMeta.metadata.authors.length > 0
        ? resolvedMeta.metadata.authors
        : extracted.authors && extracted.authors.length > 0
          ? extracted.authors
          : undefined;

    const year = resolvedMeta?.metadata.year ?? extracted.year ?? undefined;
    const doi = resolvedMeta?.metadata.doi || potentialDoi || undefined;
    const abstract = resolvedMeta?.metadata.abstract || extracted.abstract || undefined;
    const journal =
      resolvedMeta?.metadata.journal ||
      resolvedMeta?.metadata.publicationTitle ||
      extracted.journal ||
      undefined;
    const itemType = resolvedMeta?.metadata.itemType || 'journalArticle';

    // 3. Open Library Transaction for Atomic Finalization
    const result = await this.libraryTx.executeInTransaction(async (tx, helpers) => {
      // Check attachment deduplication by fileHash within workspace
      const existingAttachment = tx.catalogAttachment?.findFirst
        ? await tx.catalogAttachment.findFirst({
            where: {
              fileHash,
              catalogItem: {
                workspaceId: command.workspaceId,
                deletedAt: null,
              },
            },
            include: { catalogItem: true },
          })
        : null;

      if (existingAttachment) {
        this.logger.log(
          JSON.stringify({
            event: 'library.attachment.deduplicated',
            fileHash,
            attachmentId: existingAttachment.id,
            catalogItemId: existingAttachment.catalogItemId,
          }),
        );

        return {
          runId,
          status: 'completed' as const,
          itemId: existingAttachment.catalogItemId,
          attachmentIds: [existingAttachment.id],
          deduplicated: true,
          item: existingAttachment.catalogItem,
        };
      }

      // Check if item with same DOI already exists
      let targetItemId: string;
      let isItemDeduplicated = false;
      let targetItem: any = null;

      if (doi && tx.catalogItem?.findFirst) {
        const existingItem = await tx.catalogItem.findFirst({
          where: {
            workspaceId: command.workspaceId,
            doi,
            deletedAt: null,
          },
        });
        if (existingItem) {
          targetItemId = existingItem.id;
          targetItem = existingItem;
          isItemDeduplicated = true;
        }
      }

      if (!targetItem) {
        // Create new CatalogItem atomically
        targetItem = await this.catalogService.createItem(
          command.workspaceId,
          {
            itemType,
            title,
            authors,
            year,
            journal,
            doi,
            abstract,
            fileUrl: fileUrl || `/files/${filename}`,
            filename,
            size,
            mimeType,
            uploadedById: userId,
            collectionId: command.collectionId,
          },
          { tx, helpers },
        );
        targetItemId = targetItem.id;
      } else {
        targetItemId = targetItem.id;
      }

      // Create CatalogAttachment + Revision 1 atomically
      const attachment = await tx.catalogAttachment.create({
        data: {
          catalogItemId: targetItemId,
          filename,
          url: fileUrl || `/files/${filename}`,
          mimeType,
          size,
          fileHash,
          fileId: command.fileId || null,
          attachmentType: 'primary_pdf',
          revisions: {
            create: {
              revisionNumber: 1,
              url: fileUrl || `/files/${filename}`,
              fileHash,
              sizeBytes: size,
              comment: 'Initial PDF attachment',
            },
          },
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'Attachment',
        entityId: attachment.id,
        action: 'create',
        version: 1,
        data: attachment,
      });

      await helpers.publishOutbox(
        command.workspaceId,
        attachment.id,
        'library.attachment.created',
        {
          attachmentId: attachment.id,
          catalogItemId: targetItemId,
          fileHash,
          filename,
        },
      );

      // If keywords / tags extracted, persist tags
      const tags = resolvedMeta?.metadata.tags || extracted.keywords || [];
      if (tags.length > 0) {
        await this.persistItemTags(
          tx,
          helpers,
          command.workspaceId,
          targetItemId,
          tags,
        );
      }

      return {
        runId,
        status: 'completed' as const,
        itemId: targetItemId,
        attachmentIds: [attachment.id],
        deduplicated: isItemDeduplicated,
        item: targetItem,
      };
    });

    // 4. Post-Commit Asynchronous PDF Indexing
    if (command.buffer && result.attachmentIds.length > 0) {
      void this.indexPdfPagesAsync(result.attachmentIds[0], command.buffer);
    }

    return result;
  }

  /**
   * Handles Zotero source via unified ingestion boundary.
   */
  private async handleZotero(
    command: Extract<IngestionCommand, { source: 'zotero' }>,
    runId: string,
  ): Promise<IngestionResult> {
    const payload = (command.payload as any) || {};
    const title = (payload.title || `Zotero Item (${command.externalItemKey})`).trim();
    const authors = payload.authors || [];
    const year = payload.year ? parseInt(String(payload.year), 10) : undefined;
    const doi = payload.doi ? normalizeDoi(payload.doi) || payload.doi : undefined;
    const userId = command.userId || 'system';

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      // Check existing Zotero item binding
      const existingBinding = await tx.zoteroItemBinding.findFirst({
        where: {
          workspaceId: command.workspaceId,
          entityType: 'item',
          remoteKey: command.externalItemKey,
        },
      });

      if (existingBinding) {
        const existingItem = await tx.catalogItem.findUnique({
          where: { id: existingBinding.entityId },
        });
        if (existingItem && !existingItem.deletedAt) {
          return {
            runId,
            status: 'completed',
            itemId: existingItem.id,
            attachmentIds: [],
            deduplicated: true,
            item: existingItem,
          };
        }
      }

      const item = await this.catalogService.createItem(
        command.workspaceId,
        {
          itemType: payload.itemType || 'journalArticle',
          title,
          authors: authors.length > 0 ? authors : undefined,
          year,
          doi,
          abstract: payload.abstractNote || payload.abstract,
          journal: payload.publicationTitle || payload.journal,
          uploadedById: userId,
          collectionId: command.collectionId,
        },
        { tx, helpers },
      );

      // Link to ZoteroBinding if connectionId is available
      if (command.connectionId) {
        const binding = await tx.zoteroBinding.findFirst({
          where: {
            connectionId: command.connectionId,
            workspaceId: command.workspaceId,
          },
        });
        if (binding) {
          await tx.zoteroItemBinding.upsert({
            where: {
              bindingId_remoteKey: {
                bindingId: binding.id,
                remoteKey: command.externalItemKey,
              },
            },
            create: {
              bindingId: binding.id,
              workspaceId: command.workspaceId,
              entityType: 'item',
              entityId: item.id,
              remoteKey: command.externalItemKey,
              remoteVersion: BigInt(payload.version ? Number(payload.version) : 1),
              syncState: 'synced',
            },
            update: {
              entityId: item.id,
              remoteVersion: BigInt(payload.version ? Number(payload.version) : 1),
              syncState: 'synced',
            },
          });
        }
      }

      await helpers.publishOutbox(
        command.workspaceId,
        item.id,
        'library.zotero.item_synced',
        {
          itemId: item.id,
          externalItemKey: command.externalItemKey,
          connectionId: command.connectionId,
        },
      );

      return {
        runId,
        status: 'completed',
        itemId: item.id,
        attachmentIds: [],
        deduplicated: false,
        item,
      };
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async persistItemTags(
    tx: import('@prisma/client').Prisma.TransactionClient,
    helpers: import('../sync-core/library-transaction.service').TransactionHelpers,
    workspaceId: string,
    itemId: string,
    tags: string[],
  ): Promise<void> {
    const cleanTags = Array.from(
      new Set(
        tags
          .map((t) => (typeof t === 'string' ? t.trim() : ''))
          .filter((t) => t.length > 0),
      ),
    ).slice(0, 30);

    for (const tagName of cleanTags) {
      const tag = await tx.catalogTag.upsert({
        where: {
          workspaceId_name: {
            workspaceId,
            name: tagName,
          },
        },
        create: {
          workspaceId,
          name: tagName,
          color: '#3b82f6',
          type: 'manual',
        },
        update: {},
      });

      await tx.catalogItemTag.upsert({
        where: {
          tagId_catalogItemId: {
            tagId: tag.id,
            catalogItemId: itemId,
          },
        },
        create: {
          tagId: tag.id,
          catalogItemId: itemId,
        },
        update: {},
      });

      await helpers.appendChange(workspaceId, {
        entityType: 'CatalogItemTag',
        entityId: `${tag.id}:${itemId}`,
        action: 'create',
        version: 1,
        data: { tagId: tag.id, catalogItemId: itemId },
      });
    }
  }

  /**
   * Asynchronously extracts text pages from PDF buffer and indexes them for Discovery search.
   */
  private async indexPdfPagesAsync(attachmentId: string, buffer: Buffer): Promise<void> {
    if (!this.extractorService || !this.fullTextIndexer) return;
    try {
      this.logger.log(
        JSON.stringify({
          event: 'library.extraction.started',
          attachmentId,
        }),
      );

      const text = await this.extractorService.extractFromBuffer(buffer);
      if (text) {
        await this.fullTextIndexer.indexAttachmentPages(attachmentId, [
          {
            pageIndex: 1,
            textContent: text,
            charOffset: 0,
          },
        ]);

        this.logger.log(
          JSON.stringify({
            event: 'library.extraction.completed',
            attachmentId,
          }),
        );
      }
    } catch (err: any) {
      this.logger.warn(
        JSON.stringify({
          event: 'library.extraction.failed',
          attachmentId,
          errorMessage: err.message,
        }),
      );
    }
  }

  // ─── Legacy & Specialized Public Methods ────────────────────────────────────

  /**
   * Captures and previews academic metadata from any public URL with SSRF filtering and signed preview token.
   */
  async captureUrl(
    targetUrl: string,
    context?: { workspaceId?: string; userId?: string },
  ): Promise<CapturedPaperMetadata> {
    const canonicalUrl = targetUrl.trim();
    validateUrlSecurity(canonicalUrl);

    const classified = QueryClassifier.classify(canonicalUrl);
    let meta: CapturedPaperMetadata | null = null;

    if (
      this.metadataService &&
      (classified.type === 'DOI' ||
        classified.type === 'ARXIV' ||
        classified.type === 'PMID' ||
        classified.type === 'ISBN')
    ) {
      try {
        const resolved = await this.metadataService.resolve({
          query: canonicalUrl,
        });
        if (resolved) {
          meta = this.mapResolvedToCaptured(resolved, canonicalUrl, context);
        }
      } catch (err: any) {
        this.logger.warn(
          JSON.stringify({
            event: 'library.metadata.capture_fallback',
            queryType: classified.type,
            errorName: err instanceof Error ? err.name : 'UnknownError',
          }),
        );
      }
    }

    if (!meta) {
      meta = await this.urlCapture.captureFromUrl(canonicalUrl, context);
    }

    if (context?.workspaceId && context?.userId && meta.previewToken) {
      const tokenHash = this.urlCapture.hashToken(meta.previewToken);
      const metadataDigest = this.urlCapture.calculateMetadataDigest(meta);

      const parts = meta.previewToken.split('.');
      const expiresAt =
        parts.length === 5
          ? parseInt(parts[3], 10)
          : Date.now() + 15 * 60 * 1000;

      const sanitizedCanonical = { ...meta };
      delete (sanitizedCanonical as any).previewToken;

      await this.prisma.capturePreview.create({
        data: {
          workspaceId: context.workspaceId,
          userId: context.userId,
          sourceUrl: meta.url,
          canonicalMetadata: sanitizedCanonical as any,
          metadataDigest,
          tokenHash,
          expiresAt: new Date(expiresAt),
        },
      });
    }

    return meta;
  }

  private mapResolvedToCaptured(
    resolved: ResolvedMetadata,
    originalUrl: string,
    context?: { workspaceId?: string; userId?: string },
  ): CapturedPaperMetadata {
    const m = resolved.metadata;
    const creators = (m.authors || []).map((name) => {
      if (name.includes(',')) {
        const parts = name.split(',');
        return { lastName: parts[0].trim(), firstName: parts[1]?.trim() };
      }
      const parts = name.split(' ');
      const lastName = parts.pop() || name;
      const firstName = parts.join(' ');
      return { lastName, firstName: firstName || undefined };
    });

    const rawItemType = m.itemType || 'journalArticle';
    const validTypes: CapturedPaperMetadata['itemType'][] = [
      'journalArticle',
      'preprint',
      'webpage',
      'book',
      'conferencePaper',
    ];
    const itemType = validTypes.includes(rawItemType as any)
      ? (rawItemType as CapturedPaperMetadata['itemType'])
      : 'journalArticle';

    const captured: CapturedPaperMetadata = {
      title: m.title || 'Untitled Document',
      abstract: m.abstract,
      creators: creators.length > 0 ? creators : undefined,
      year: m.year ?? undefined,
      doi: m.doi,
      url: m.url || originalUrl,
      publicationTitle: m.journal || m.publicationTitle,
      itemType,
      rawMetadata: {
        canonicalId: resolved.canonicalId,
        provenance: resolved.provenance,
      },
    };

    return this.urlCapture.attachPreviewToken(captured, context);
  }

  /**
   * Confirms and persists captured URL metadata into a CatalogItem within a single atomic transaction.
   */
  async confirmCapturedUrl(
    workspaceId: string,
    userId: string,
    dto: ConfirmCapturedUrlDto,
  ) {
    if (!dto.previewToken) {
      throw new BadRequestException('previewToken is strictly required');
    }

    const tokenHash = this.urlCapture.hashToken(dto.previewToken);

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const preview = await tx.capturePreview.findUnique({
        where: { tokenHash },
      });

      if (!preview) {
        throw new BadRequestException('Invalid or unrecognised preview token');
      }

      if (preview.workspaceId !== workspaceId) {
        throw new BadRequestException('Preview token does not belong to this workspace');
      }
      if (preview.userId !== userId) {
        throw new BadRequestException('Preview token does not belong to this user');
      }

      if (preview.expiresAt.getTime() < Date.now()) {
        throw new BadRequestException('Preview token has expired');
      }

      if (preview.consumedAt !== null) {
        throw new ConflictException('Preview token has already been consumed');
      }

      const canonicalMeta = preview.canonicalMetadata as any;
      const verification = this.urlCapture.verifyPreviewToken(
        canonicalMeta,
        dto.previewToken,
        { workspaceId, userId },
      );

      if (!verification.valid) {
        throw new BadRequestException(
          `Preview token validation failed: ${verification.reason || 'invalid_token'}`,
        );
      }

      const updateResult = await tx.capturePreview.updateMany({
        where: { id: preview.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });

      if (updateResult.count === 0) {
        throw new ConflictException('Preview token has already been consumed');
      }

      const title = dto.title?.trim() || canonicalMeta.title;
      const abstract =
        dto.abstract !== undefined ? dto.abstract : canonicalMeta.abstract;
      const doi = dto.doi !== undefined ? dto.doi : canonicalMeta.doi;
      const year = dto.year !== undefined ? dto.year : canonicalMeta.year;
      const publicationTitle =
        dto.publicationTitle !== undefined
          ? dto.publicationTitle
          : canonicalMeta.publicationTitle;

      const rawItemType =
        dto.itemType || canonicalMeta.itemType || 'journalArticle';
      const validItemTypes = [
        'journalArticle',
        'book',
        'bookSection',
        'conferencePaper',
        'preprint',
        'report',
        'thesis',
        'webpage',
        'manuscript',
        'dataset',
        'document',
      ];
      const itemType = validItemTypes.includes(rawItemType)
        ? rawItemType
        : 'journalArticle';

      const creators =
        dto.creators && dto.creators.length > 0
          ? dto.creators
          : canonicalMeta.creators || [];
      const authors = creators
        .map((c: any) => {
          if (typeof c === 'string') return c;
          if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
          return c.lastName || c.firstName || '';
        })
        .filter(Boolean);

      const item = await this.catalogService.createItem(
        workspaceId,
        {
          itemType,
          title,
          abstract,
          doi,
          url: dto.url || canonicalMeta.url,
          year,
          journal: publicationTitle,
          authors: authors.length > 0 ? authors : undefined,
          uploadedById: userId || 'system',
        },
        { tx, helpers },
      );

      const rawTags: string[] =
        dto.tags && dto.tags.length > 0 ? dto.tags : canonicalMeta.tags || [];
      if (rawTags.length > 0) {
        await this.persistItemTags(tx, helpers, workspaceId, item.id, rawTags);
      }

      await helpers.publishOutbox(
        workspaceId,
        item.id,
        'library.item.ingested_url',
        {
          itemId: item.id,
          url: dto.url || canonicalMeta.url,
          title,
          itemType,
          previewId: preview.id,
        },
      );

      return item;
    });
  }

  async cleanupExpiredPreviews(olderThanDays = 7): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const result = await this.prisma.capturePreview.deleteMany({
      where: {
        OR: [{ consumedAt: { lte: cutoff } }, { expiresAt: { lte: cutoff } }],
      },
    });
    return result.count;
  }

  async startRun(
    workspaceId: string,
    userId: string,
    dto: StartIngestionDto,
  ): Promise<IngestionRunSnapshot> {
    const inputHash = createHash('sha256')
      .update(dto.rawInput || JSON.stringify(dto.items || []))
      .digest('hex');

    const run = await this.prisma.ingestionRun.create({
      data: {
        workspaceId,
        inputParams: {
          sourceType: dto.sourceType,
          rawInput: dto.rawInput,
          totalItems: dto.items?.length || 1,
        },
        inputHash,
        status: IngestionStatus.RECEIVED,
      },
    });

    await this.prisma.ingestionStage.create({
      data: {
        ingestionRunId: run.id,
        stageName: 'INPUT_RECEIVED',
        durationMs: 0,
        success: true,
      },
    });

    const params = (run.inputParams as any) || {};

    return {
      id: run.id,
      workspaceId: run.workspaceId,
      sourceType: params.sourceType || dto.sourceType,
      status: run.status,
      totalItems: params.totalItems || 1,
      processedItems: 0,
      failedItems: 0,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    };
  }

  async getRunStatus(runId: string): Promise<IngestionRunSnapshot> {
    const run = await this.prisma.ingestionRun.findUnique({
      where: { id: runId },
      include: { stages: { orderBy: { executedAt: 'asc' } } },
    });

    if (!run) {
      throw new NotFoundException(`IngestionRun ${runId} not found`);
    }

    const params = (run.inputParams as any) || {};
    return {
      id: run.id,
      workspaceId: run.workspaceId,
      sourceType: params.sourceType || 'UNKNOWN',
      status: run.status,
      totalItems: params.totalItems || 1,
      processedItems: 0,
      failedItems: 0,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    };
  }

  async ingestDoi(workspaceId: string, userId: string, dto: IngestDoiDto) {
    const result = await this.ingest({
      source: 'doi',
      workspaceId,
      userId,
      doi: dto.doi,
      collectionId: dto.collectionId,
      idempotencyKey: dto.idempotencyKey,
    });
    return result.item;
  }

  async ingestBibtex(
    workspaceId: string,
    userId: string,
    dto: IngestBibtexDto,
  ) {
    const result = await this.ingest({
      source: 'bibtex',
      workspaceId,
      userId,
      content: dto.bibtex,
      collectionId: dto.collectionId,
      idempotencyKey: dto.idempotencyKey,
    });
    return result.item;
  }
}
