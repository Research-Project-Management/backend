import {
  Injectable,
  Logger,
  Inject,
  Optional,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';

import { PrismaService } from '../../../core/database/prisma.service';
import {
  IngestionCommand,
  IngestionResult,
  IngestionRunSnapshot,
  IUnifiedIngestionService,
  UNIFIED_INGESTION_SERVICE,
} from './types/ingestion.contracts';
import {
  IngestionException,
  IngestionValidationException,
  IngestionIdempotencyConflictException,
  IngestionDuplicateConflictException,
  IngestionRateLimitException,
  IngestionStorageException,
} from './errors/ingestion.errors';
import {
  calculateIngestionRequestHash,
  INGESTION_LIMITS,
} from './policies/ingestion.policy';
import { normalizeTags } from './metadata/metadata.identifiers';
import { IdempotencyRepository } from '../sync/idempotency.repository';
import { LibraryTransactionService } from '../sync/library-transaction.service';
import {
  CANONICAL_METADATA_SERVICE,
  ICanonicalMetadataService,
} from './metadata/metadata.contracts';
import { ExtractorService } from '../attachments/providers/extractor.provider';
import { UrlCaptureConnector } from './providers/url-capture.connector';
import { BibtexParser } from '../citation/formatters/bibtex.parser';

import { STORAGE_PORT, IStoragePort } from '../../storage/storage.port';
import { IngestionStatus } from '@prisma/client';
import { CatalogService } from '../catalog/catalog.service';
import {
  LIBRARY_EVENT_TYPES,
  buildItemCreatedOutboxPayload,
} from '../sync/library-event-catalog';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { prepareDoiIngestion } from './sources/doi';
import { prepareUrlIngestion } from './sources/url';
import { prepareBibtexIngestion } from './sources/bibtex';
import { preparePdfIngestion } from './sources/pdf';
import { prepareZoteroIngestion } from './sources/zotero';
import {
  StartIngestionDto,
  IngestDoiDto,
  IngestBibtexDto,
} from './dto/ingestion.dto';
import { ConfirmCapturedUrlDto } from './dto/capture-url.dto';

@Injectable()
export class IngestionService implements IUnifiedIngestionService {
  private readonly logger = new Logger(IngestionService.name);
  private catalogService?: any;

  constructor(
    private readonly prisma: PrismaService,
    private readonly libraryTx: LibraryTransactionService,
    private readonly idempotencyRepo: IdempotencyRepository,
    private readonly extractorService: ExtractorService,
    private readonly bibtexParser: BibtexParser,
    @Inject(STORAGE_PORT) private readonly storagePort: IStoragePort,
    @Optional() private readonly urlConnector?: UrlCaptureConnector,
    @Optional()
    @Inject(CANONICAL_METADATA_SERVICE)
    private readonly metadataService?: ICanonicalMetadataService,
    @Optional() private readonly catalogServiceParam?: CatalogService,
  ) {
    if (catalogServiceParam) {
      this.catalogService = catalogServiceParam;
    } else if ((idempotencyRepo as any)?.createItem) {
      this.catalogService = idempotencyRepo as any;
    }
  }

  private async resolveWorkspaceId(workspaceId: string): Promise<string> {
    if (!workspaceId || !this.prisma?.workspace?.findFirst) return workspaceId;
    const ws = await this.prisma.workspace.findFirst({
      where: {
        OR: [{ id: workspaceId }, { slug: workspaceId }, { url: workspaceId }],
        deletedAt: null,
      },
      select: { id: true },
    });
    return ws?.id || workspaceId;
  }

  async ingest(command: IngestionCommand): Promise<IngestionResult> {
    command.workspaceId = await this.resolveWorkspaceId(command.workspaceId);
    const runId = randomUUID();
    const startTime = Date.now();
    const idempotencyKey = command.idempotencyKey?.trim();
    const requestHash = calculateIngestionRequestHash(command);
    const keyFingerprint = idempotencyKey
      ? IdempotencyRepository.getFingerprint(idempotencyKey)
      : undefined;

    this.logger.log(
      JSON.stringify({
        event: 'library.ingestion.started',
        runId,
        workspaceId: command.workspaceId,
        source: command.source,
        hasIdempotencyKey: Boolean(idempotencyKey),
        idempotencyKeyFp: keyFingerprint,
      }),
    );

    // 1. Concurrent Atomic Idempotency Check
    let leaseToken: string | undefined;
    if (idempotencyKey) {
      const claimResult = await this.idempotencyRepo.claim(
        command.workspaceId,
        idempotencyKey,
        requestHash,
        INGESTION_LIMITS.DEFAULT_IDEMPOTENCY_TTL_SECONDS,
      );

      if (claimResult.status === 'mismatch') {
        throw new IngestionIdempotencyConflictException(
          `Idempotency key has already been used with different request parameters`,
        );
      }

      if (claimResult.status === 'in_progress') {
        throw new IngestionIdempotencyConflictException(
          `A concurrent ingestion request with this idempotency key is already processing`,
        );
      }

      if (claimResult.status === 'acquired') {
        leaseToken = claimResult.leaseToken;
      }

      if (claimResult.status === 'cached' && claimResult.record.responseBody) {
        this.logger.log(
          JSON.stringify({
            event: 'library.ingestion.idempotency_cache_hit',
            workspaceId: command.workspaceId,
            idempotencyKeyFp: keyFingerprint,
          }),
        );
        return claimResult.record.responseBody as unknown as IngestionResult;
      }
    }

    // 2. Mandatory IngestionRun persistence (RECEIVED -> PROCESSING)
    const safeInputParams = this.buildSafeInputParams(command);
    try {
      if (this.prisma.ingestionRun?.create) {
        await this.prisma.ingestionRun.create({
          data: {
            id: runId,
            workspaceId: command.workspaceId,
            status: IngestionStatus.RECEIVED,
            inputHash: requestHash,
            inputParams: safeInputParams,
          },
        });
        if (this.prisma.ingestionRun?.update) {
          await this.prisma.ingestionRun.update({
            where: { id: runId },
            data: {
              status: IngestionStatus.DETECTED,
              attempts: { increment: 1 },
            },
          });
        }
      }
    } catch (runErr: any) {
      this.logger.error(
        `Mandatory IngestionRun persistence failed: ${runErr.message}`,
      );
      if (idempotencyKey) {
        await this.idempotencyRepo
          .markFailed(command.workspaceId, idempotencyKey, leaseToken)
          .catch(() => {});
      }
      throw runErr;
    }

    try {
      let result: IngestionResult;

      switch (command.source) {
        case 'doi': {
          const prep = await prepareDoiIngestion(
            command.workspaceId,
            command.doi,
            this.prisma,
            this.metadataService,
          );

          if (prep.deduplicated) {
            result = {
              runId,
              status: 'completed',
              itemId: prep.existingItem.id,
              attachmentIds:
                prep.existingItem.attachments?.map((a: any) => a.id) || [],
              deduplicated: true,
              item: prep.existingItem,
            };
            if (idempotencyKey) {
              await this.idempotencyRepo.markSucceeded(
                command.workspaceId,
                idempotencyKey,
                200,
                result,
                leaseToken,
              );
            }
            await this.finalizeIngestionRun(
              runId,
              IngestionStatus.READY,
              result.itemId,
            );
            return result;
          }

          result = await this.commitItemTransaction({
            runId,
            workspaceId: command.workspaceId,
            userId: command.userId,
            collectionId: command.collectionId,
            source: 'doi',
            itemData: prep.itemData!,
            idempotencyKey,
            leaseToken,
          });
          break;
        }

        case 'url': {
          const prep = await prepareUrlIngestion(
            command.workspaceId,
            command.url,
            command.previewToken,
            command.overrides,
            this.prisma,
            this.urlConnector,
          );

          if (prep.deduplicated) {
            result = {
              runId,
              status: 'completed',
              itemId: prep.existingItem.id,
              attachmentIds:
                prep.existingItem.attachments?.map((a: any) => a.id) || [],
              deduplicated: true,
              item: prep.existingItem,
            };
            if (idempotencyKey) {
              await this.idempotencyRepo.markSucceeded(
                command.workspaceId,
                idempotencyKey,
                200,
                result,
                leaseToken,
              );
            }
            await this.finalizeIngestionRun(
              runId,
              IngestionStatus.READY,
              result.itemId,
            );
            return result;
          }

          result = await this.commitItemTransaction({
            runId,
            workspaceId: command.workspaceId,
            userId: command.userId,
            collectionId: command.collectionId,
            source: 'url',
            itemData: prep.itemData!,
            previewToken: command.previewToken,
            idempotencyKey,
            leaseToken,
          });
          break;
        }

        case 'bibtex': {
          const prep = await prepareBibtexIngestion(
            command.workspaceId,
            command.content,
            this.prisma,
            this.bibtexParser,
          );

          if (prep.deduplicated) {
            result = {
              runId,
              status: 'completed',
              itemId: prep.existingItem.id,
              attachmentIds:
                prep.existingItem.attachments?.map((a: any) => a.id) || [],
              deduplicated: true,
              item: prep.existingItem,
            };
            if (idempotencyKey) {
              await this.idempotencyRepo.markSucceeded(
                command.workspaceId,
                idempotencyKey,
                200,
                result,
                leaseToken,
              );
            }
            await this.finalizeIngestionRun(
              runId,
              IngestionStatus.READY,
              result.itemId,
            );
            return result;
          }

          result = await this.commitItemTransaction({
            runId,
            workspaceId: command.workspaceId,
            userId: command.userId,
            collectionId: command.collectionId,
            source: 'bibtex',
            itemData: prep.itemData!,
            idempotencyKey,
            leaseToken,
          });
          break;
        }

        case 'pdf': {
          const prep = await preparePdfIngestion(
            command.workspaceId,
            {
              fileId: command.fileId,
              filename: command.filename,
              collectionId: command.collectionId,
              overrides: command.overrides,
            },
            this.prisma,
            this.extractorService,
            this.storagePort,
          );

          if (prep.deduplicated) {
            result = {
              runId,
              status: 'completed',
              itemId: prep.existingItem.id,
              attachmentIds: prep.existingAttachmentId
                ? [prep.existingAttachmentId]
                : prep.existingItem.attachments?.map((a: any) => a.id) || [],
              deduplicated: true,
              item: prep.existingItem,
            };
            if (idempotencyKey) {
              await this.idempotencyRepo.markSucceeded(
                command.workspaceId,
                idempotencyKey,
                200,
                result,
                leaseToken,
              );
            }
            await this.finalizeIngestionRun(
              runId,
              IngestionStatus.READY,
              result.itemId,
            );
            return result;
          }

          result = await this.commitItemTransaction({
            runId,
            workspaceId: command.workspaceId,
            userId: command.userId,
            collectionId: command.collectionId,
            source: 'pdf',
            itemData: prep.itemData!,
            attachmentData: {
              filename: prep.filename,
              fileUrl: prep.fileUrl,
              fileId: prep.fileId,
              mimeType: prep.mimeType,
              sizeBytes: prep.sizeBytes,
              fileHash: prep.fileHash,
            },
            idempotencyKey,
            leaseToken,
          });
          break;
        }

        case 'zotero': {
          const prep = await prepareZoteroIngestion(
            command.workspaceId,
            command.connectionId,
            command.externalItemKey,
            command.payload,
            this.prisma,
          );

          if (prep.deduplicated) {
            result = {
              runId,
              status: 'completed',
              itemId: prep.existingItem.id,
              attachmentIds:
                prep.existingItem.attachments?.map((a: any) => a.id) || [],
              deduplicated: true,
              item: prep.existingItem,
            };
            if (idempotencyKey) {
              await this.idempotencyRepo.markSucceeded(
                command.workspaceId,
                idempotencyKey,
                200,
                result,
                leaseToken,
              );
            }
            await this.finalizeIngestionRun(
              runId,
              IngestionStatus.READY,
              result.itemId,
            );
            return result;
          }

          result = await this.commitItemTransaction({
            runId,
            workspaceId: command.workspaceId,
            userId: command.userId,
            collectionId: command.collectionId,
            source: 'zotero',
            itemData: prep.itemData!,
            zoteroBinding: {
              bindingId: prep.bindingId,
              externalItemKey: command.externalItemKey,
            },
            idempotencyKey,
            leaseToken,
          });
          break;
        }

        default:
          throw new IngestionValidationException(
            `Unsupported ingestion source: ${(command as any).source}`,
          );
      }

      // 3. Update IngestionRun to READY
      await this.finalizeIngestionRun(
        runId,
        IngestionStatus.READY,
        result.itemId,
      );

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
      if (idempotencyKey) {
        await this.idempotencyRepo.markFailed(
          command.workspaceId,
          idempotencyKey,
          leaseToken,
        );
      }

      const isRetryable =
        err instanceof IngestionRateLimitException ||
        err instanceof IngestionStorageException ||
        err?.status === 503 ||
        err?.status === 502 ||
        err?.status === 504 ||
        err?.code === 'ECONNRESET' ||
        err?.code === 'ETIMEDOUT';

      const finalStatus = isRetryable
        ? IngestionStatus.FAILED_RETRYABLE
        : IngestionStatus.FAILED_FINAL;

      try {
        await this.finalizeIngestionRun(
          runId,
          finalStatus,
          undefined,
          err.message,
        );
      } catch (finalizeErr: any) {
        this.logger.error(
          `Failed to finalize failed ingestion run ${runId}: ${finalizeErr.message}`,
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
          errorMessage: err.message,
        }),
      );

      if (err instanceof IngestionException) {
        throw err;
      }
      throw err;
    }
  }

  async getRunStatus(
    workspaceId: string,
    runId: string,
  ): Promise<IngestionRunSnapshot> {
    const run = await this.prisma.ingestionRun.findFirst({
      where: { id: runId, workspaceId },
      include: { stages: { orderBy: { executedAt: 'asc' } } },
    });

    if (!run) {
      throw new NotFoundException(
        `IngestionRun ${runId} not found in workspace`,
      );
    }

    const params = (run.inputParams as any) || {};
    return {
      id: run.id,
      workspaceId: run.workspaceId,
      sourceType: params.source || params.sourceType || 'UNKNOWN',
      status: run.status,
      totalItems: params.totalItems || 1,
      processedItems: run.status === IngestionStatus.READY ? 1 : 0,
      failedItems: run.status === IngestionStatus.FAILED_FINAL ? 1 : 0,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    };
  }

  // ── Atomic Ingestion Transaction ──────────────────────────────────────────

  private async commitItemTransaction(options: {
    runId: string;
    workspaceId: string;
    userId?: string;
    collectionId?: string;
    source: string;
    itemData: any;
    attachmentData?: {
      filename: string;
      fileUrl: string;
      fileId?: string;
      mimeType: string;
      sizeBytes: number;
      fileHash: string;
    };
    zoteroBinding?: {
      bindingId: string;
      externalItemKey: string;
    };
    previewToken?: string;
    idempotencyKey?: string;
    leaseToken?: string;
  }): Promise<IngestionResult> {
    const {
      runId,
      workspaceId,
      userId,
      collectionId,
      source,
      itemData,
      attachmentData,
      zoteroBinding,
      previewToken,
      idempotencyKey,
      leaseToken,
    } = options;

    try {
      return await this.libraryTx.executeInTransaction(async (tx, helpers) => {
        // 1. Consume CapturePreview immediately to ensure single-use atomic locking
        if (options.previewToken && tx.capturePreview?.updateMany) {
          const tokenHash =
            this.urlConnector?.hashToken(options.previewToken) ||
            options.previewToken;
          let previewRecord: any = null;
          if (tx.capturePreview?.findUnique) {
            previewRecord = await tx.capturePreview.findUnique({
              where: { tokenHash },
            });
          }
          const whereClause = previewRecord?.id
            ? { id: previewRecord.id, consumedAt: null }
            : { tokenHash, consumedAt: null };

          const updateRes = await tx.capturePreview.updateMany({
            where: whereClause,
            data: { consumedAt: new Date() },
          });
          if (
            updateRes &&
            typeof updateRes.count === 'number' &&
            updateRes.count === 0
          ) {
            throw new ConflictException(
              'Preview token has already been consumed',
            );
          }
        }

        // Resolve a valid user ID for uploader relation
        let effectiveUserId = userId;
        if (!effectiveUserId) {
          const member = await tx.workspaceMember?.findFirst?.({
            where: { workspaceId },
          });
          effectiveUserId = member?.userId;
        }
        if (!effectiveUserId) {
          const user = await tx.user?.findFirst?.();
          effectiveUserId = user?.id || 'system-ingestion';
        }

        let rawCreators = itemData.creators || [];
        if (
          (!rawCreators || rawCreators.length === 0) &&
          Array.isArray(itemData.authors) &&
          itemData.authors.length > 0
        ) {
          rawCreators = itemData.authors.map((authStr: string) => {
            const trimmed = String(authStr || '').trim();
            if (trimmed.includes(',')) {
              const [last, ...firstParts] = trimmed.split(',');
              const firstName = firstParts.join(',').trim();
              const lastName = last.trim();
              return {
                creatorType: 'author',
                firstName,
                lastName,
                fullName:
                  [firstName, lastName].filter(Boolean).join(' ').trim() ||
                  trimmed,
              };
            }
            const parts = trimmed.split(/\s+/);
            if (parts.length > 1) {
              const lastName = parts.pop() || '';
              const firstName = parts.join(' ');
              return {
                creatorType: 'author',
                firstName,
                lastName,
                fullName: trimmed,
              };
            }
            return {
              creatorType: 'author',
              firstName: '',
              lastName: trimmed,
              fullName: trimmed,
            };
          });
        }

        const cleanCreators = rawCreators.map((c: any, index: number) => ({
          creatorType: c.creatorType || 'author',
          firstName: c.firstName || '',
          lastName: c.lastName || '',
          fullName:
            typeof c === 'string'
              ? c
              : c.fullName ||
                [c.firstName, c.lastName].filter(Boolean).join(' ').trim(),
          orderIndex: index,
        }));

        const cleanAuthors: string[] =
          itemData.authors && itemData.authors.length > 0
            ? itemData.authors
            : cleanCreators.map((c: any) => c.fullName).filter(Boolean);

        let finalExtra = itemData.extra || '';
        if (itemData.arxivId && !finalExtra.includes(itemData.arxivId)) {
          finalExtra = finalExtra
            ? `${finalExtra}\narXiv: ${itemData.arxivId}`
            : `arXiv: ${itemData.arxivId}`;
        }

        // Create CatalogItem (delegate to CatalogService if provided, else direct transactional Prisma)
        let catalogItem: any;
        const itemCreateData = {
          workspaceId,
          collectionId: collectionId || null,
          title: itemData.title,
          abstract: itemData.abstract || '',
          doi: itemData.doi || null,
          citationKey: itemData.citationKey || null,
          year: itemData.year || null,
          publicationDate: itemData.publicationDate || null,
          publicationTitle:
            itemData.publicationTitle || itemData.journal || null,
          journal: itemData.journal || itemData.publicationTitle || null,
          publisher: itemData.publisher || null,
          place: itemData.place || null,
          volume: itemData.volume || null,
          issue: itemData.issue || null,
          section: itemData.section || null,
          partNumber: itemData.partNumber || null,
          partTitle: itemData.partTitle || null,
          pages: itemData.pages || null,
          series: itemData.series || null,
          seriesTitle: itemData.seriesTitle || null,
          seriesText: itemData.seriesText || null,
          issn: itemData.issn || null,
          isbn: itemData.isbn || null,
          pmid: itemData.pmid || null,
          pmcid: itemData.pmcid || null,
          journalAbbr: itemData.journalAbbr || null,
          shortTitle: itemData.shortTitle || null,
          rights: itemData.rights || itemData.license || null,
          license: itemData.license || itemData.rights || null,
          archive: itemData.archive || null,
          archiveLocation: itemData.archiveLocation || null,
          libraryCatalog: itemData.libraryCatalog || null,
          callNumber: itemData.callNumber || null,
          extra: finalExtra || null,
          labels: normalizeTags([
            ...(Array.isArray(itemData.tags) ? itemData.tags : []),
            ...(Array.isArray(itemData.labels) ? itemData.labels : []),
            ...(Array.isArray(itemData.keywords) ? itemData.keywords : []),
          ]),
          keywords: normalizeTags([
            ...(Array.isArray(itemData.keywords) ? itemData.keywords : []),
            ...(Array.isArray(itemData.tags) ? itemData.tags : []),
            ...(Array.isArray(itemData.labels) ? itemData.labels : []),
          ]),
          url: itemData.url || null,
          itemType: itemData.itemType || 'journalArticle',
          authors: cleanAuthors,
          filename: attachmentData?.filename || itemData.filename || 'document',
          fileUrl: attachmentData?.fileUrl || itemData.fileUrl || '',
          size: attachmentData?.sizeBytes || itemData.size || 0,
          mimeType:
            attachmentData?.mimeType || itemData.mimeType || 'application/pdf',
          uploadedById: effectiveUserId,
          contributors:
            cleanCreators.length > 0
              ? {
                  create: cleanCreators,
                }
              : undefined,
        };

        if (this.catalogService?.createItem) {
          catalogItem = await this.catalogService.createItem(
            workspaceId,
            itemCreateData,
            { tx, helpers, source: (source as any) || 'manual' },
          );
        } else {
          catalogItem = await tx.catalogItem.create({
            data: itemCreateData,
            include: {
              contributors: true,
              attachments: true,
            },
          });
          if (helpers?.appendChange) {
            await helpers.appendChange(workspaceId, {
              entityType: 'item',
              entityId: catalogItem.id,
              action: 'create',
              version: 1,
              data: {
                title: catalogItem.title,
                doi: catalogItem.doi,
                source,
              },
            });
          }
          if (helpers?.publishOutbox) {
            const outboxPayload = buildItemCreatedOutboxPayload({
              itemId: catalogItem.id,
              workspaceId,
              title: catalogItem.title,
              doi: catalogItem.doi,
              source: (source as any) || 'manual',
            });
            await helpers.publishOutbox(
              workspaceId,
              catalogItem.id,
              LIBRARY_EVENT_TYPES.ITEM_CREATED,
              outboxPayload,
            );
          }
        }

        // 2. Register Database Deduplication Claims within transaction
        if (itemData.doi && tx.libraryDedupClaim?.create) {
          await tx.libraryDedupClaim.create({
            data: {
              workspaceId,
              claimType: 'doi',
              claimValue: itemData.doi.toLowerCase().trim(),
              catalogItemId: catalogItem.id,
            },
          });
        }

        const attachmentIds: string[] = [];

        // Create Attachment + Revision if PDF
        if (attachmentData && tx.catalogAttachment?.create) {
          const attachment = await tx.catalogAttachment.create({
            data: {
              catalogItemId: catalogItem.id,
              filename: attachmentData.filename,
              url: attachmentData.fileUrl,
              fileHash: attachmentData.fileHash,
              fileId: attachmentData.fileId || null,
              size: attachmentData.sizeBytes,
              mimeType: attachmentData.mimeType,
              attachmentType: 'primary_pdf',
            },
          });

          attachmentIds.push(attachment.id);

          if (attachmentData.fileHash && tx.libraryDedupClaim?.create) {
            await tx.libraryDedupClaim.create({
              data: {
                workspaceId,
                claimType: 'pdf_sha256',
                claimValue: attachmentData.fileHash.toLowerCase().trim(),
                catalogItemId: catalogItem.id,
              },
            });
          }

          if (tx.attachmentRevision?.create) {
            await tx.attachmentRevision.create({
              data: {
                attachmentId: attachment.id,
                revisionNumber: 1,
                fileHash: attachmentData.fileHash,
                sizeBytes: attachmentData.sizeBytes,
                url: attachmentData.fileUrl,
                comment: 'Initial ingestion revision',
              },
            });
          }

          if (helpers?.publishOutbox) {
            await helpers.publishOutbox(
              workspaceId,
              attachment.id,
              'library.attachment.extraction_requested',
              {
                attachmentId: attachment.id,
                catalogItemId: catalogItem.id,
                workspaceId,
                fileId: attachmentData.fileId || null,
                filename: attachmentData.filename,
              },
            );
          }
        }

        // Bind Zotero remote item if applicable
        if (zoteroBinding && tx.zoteroItemBinding?.create) {
          await tx.zoteroItemBinding.create({
            data: {
              workspaceId,
              bindingId: zoteroBinding.bindingId,
              remoteKey: zoteroBinding.externalItemKey,
              entityType: 'item',
              entityId: catalogItem.id,
              syncState: 'synced',
            },
          });
        }

        const finalResult: IngestionResult = {
          runId,
          status: 'completed',
          itemId: catalogItem.id,
          attachmentIds,
          deduplicated: false,
          item: catalogItem,
        };

        // Mark Idempotency succeeded in the SAME database transaction
        if (idempotencyKey) {
          const marked = await this.idempotencyRepo.markSucceededInTx(
            tx,
            workspaceId,
            idempotencyKey,
            200,
            finalResult,
            leaseToken,
          );
          if (!marked) {
            throw new ConflictException(
              'Idempotency lease expired or lost to concurrent worker',
            );
          }
        }

        return finalResult;
      });
    } catch (txErr: any) {
      const isPrismaP2002 = txErr?.code === 'P2002';
      const modelName = String(txErr?.meta?.modelName || '').toLowerCase();
      const targetStr = (
        Array.isArray(txErr?.meta?.target)
          ? txErr.meta.target.join('_')
          : String(
              txErr?.meta?.target ||
                txErr?.meta?.constraint ||
                txErr?.message ||
                '',
            )
      ).toLowerCase();

      const targetArray = Array.isArray(txErr?.meta?.target)
        ? txErr.meta.target.map((t: string) => String(t).toLowerCase())
        : [];

      const isDedupConstraint =
        modelName.includes('librarydedupclaim') ||
        targetStr.includes('librarydedupclaim') ||
        targetStr.includes('library_dedup_claims') ||
        targetStr.includes('papers_workspace_id_doi_key') ||
        targetStr.includes('claim_type') ||
        targetStr.includes('claim_value') ||
        targetStr.includes('claimtype') ||
        targetStr.includes('claimvalue') ||
        (targetArray.includes('claim_value') &&
          targetArray.includes('claim_type')) ||
        (targetArray.includes('claimvalue') &&
          targetArray.includes('claimtype')) ||
        (targetArray.includes('doi') &&
          (targetArray.includes('workspace_id') ||
            targetArray.includes('workspaceid')));

      const isDedupCollision = isPrismaP2002 && isDedupConstraint;

      if (isDedupCollision) {
        this.logger.log(
          JSON.stringify({
            event: 'library.ingestion.concurrent_dedup_contention_resolved',
            workspaceId,
            source,
          }),
        );
        let existingItem: any = null;
        const maxRetries = 10;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          if (itemData.doi) {
            if (this.prisma.libraryDedupClaim?.findUnique) {
              const claim = await this.prisma.libraryDedupClaim.findUnique({
                where: {
                  workspaceId_claimType_claimValue: {
                    workspaceId,
                    claimType: 'doi',
                    claimValue: itemData.doi.toLowerCase().trim(),
                  },
                },
                include: {
                  catalogItem: {
                    include: { attachments: true, contributors: true },
                  },
                },
              });
              existingItem = claim?.catalogItem;
            }
            if (!existingItem && this.prisma.catalogItem?.findFirst) {
              existingItem = await this.prisma.catalogItem.findFirst({
                where: {
                  workspaceId,
                  doi: itemData.doi.toLowerCase().trim(),
                },
                include: { attachments: true, contributors: true },
              });
            }
          }
          if (!existingItem && attachmentData?.fileHash) {
            if (this.prisma.libraryDedupClaim?.findUnique) {
              const claim = await this.prisma.libraryDedupClaim.findUnique({
                where: {
                  workspaceId_claimType_claimValue: {
                    workspaceId,
                    claimType: 'pdf_sha256',
                    claimValue: attachmentData.fileHash.toLowerCase().trim(),
                  },
                },
                include: {
                  catalogItem: {
                    include: { attachments: true, contributors: true },
                  },
                },
              });
              existingItem = claim?.catalogItem;
            }
            if (!existingItem && this.prisma.catalogAttachment?.findFirst) {
              const existingAttachment =
                await this.prisma.catalogAttachment.findFirst({
                  where: {
                    fileHash: attachmentData.fileHash.toLowerCase().trim(),
                    catalogItem: { workspaceId },
                  },
                  include: {
                    catalogItem: {
                      include: { attachments: true, contributors: true },
                    },
                  },
                });
              existingItem = existingAttachment?.catalogItem;
            }
          }

          if (existingItem) {
            break;
          }

          if (attempt < maxRetries) {
            await new Promise((res) => setTimeout(res, 25 * attempt));
          }
        }

        if (existingItem) {
          // Soft-delete recovery policy: restore item if previously soft-deleted
          if (
            existingItem.deletedAt !== null &&
            this.prisma.catalogItem?.update
          ) {
            await this.prisma.catalogItem.update({
              where: { id: existingItem.id },
              data: { deletedAt: null },
            });
            existingItem.deletedAt = null;
          }

          const dedupResult: IngestionResult = {
            runId,
            status: 'completed',
            itemId: existingItem.id,
            attachmentIds:
              existingItem.attachments?.map((a: any) => a.id) || [],
            deduplicated: true,
            item: existingItem,
          };
          if (idempotencyKey) {
            await this.idempotencyRepo.markSucceeded(
              workspaceId,
              idempotencyKey,
              200,
              dedupResult,
              leaseToken,
            );
          }
          return dedupResult;
        }
      }

      this.logger.error(
        `Transaction commit failed for ingestion: ${txErr.message}`,
      );
      throw txErr;
    }
  }

  private buildSafeInputParams(command: IngestionCommand): Record<string, any> {
    const safe: Record<string, any> = {
      source: command.source,
      workspaceId: command.workspaceId,
    };

    switch (command.source) {
      case 'doi':
        safe.doi = command.doi;
        break;
      case 'url': {
        try {
          const parsed = new URL(command.url);
          safe.origin = parsed.origin;
          safe.hostname = parsed.hostname;
          safe.urlHash = crypto
            .createHash('sha256')
            .update(command.url)
            .digest('hex');
        } catch {
          safe.hostname = 'invalid-url';
        }
        break;
      }
      case 'bibtex':
        safe.contentLength = (command.content || '').length;
        break;
      case 'pdf':
        safe.fileId = command.fileId;
        if (command.filename) safe.filename = command.filename;
        break;
      case 'zotero':
        safe.connectionId = command.connectionId;
        safe.externalItemKey = command.externalItemKey;
        break;
    }

    return safe;
  }

  private async finalizeIngestionRun(
    runId: string,
    status: IngestionStatus,
    itemId?: string,
    lastError?: string,
  ): Promise<void> {
    const isTerminal =
      status === IngestionStatus.READY ||
      status === IngestionStatus.FAILED_RETRYABLE ||
      status === IngestionStatus.FAILED_FINAL;

    try {
      if (this.prisma.ingestionRun?.update) {
        await this.prisma.ingestionRun.update({
          where: { id: runId },
          data: {
            status,
            itemId: itemId || null,
            lastError: lastError || null,
            ...(isTerminal ? { completedAt: new Date() } : {}),
          },
        });
      }
    } catch (dbErr: any) {
      this.logger.error(
        JSON.stringify({
          event: 'library.ingestion.run_terminal_update_failed',
          runId,
          status,
          error: dbErr?.message,
        }),
      );
      throw new IngestionStorageException(
        `Failed to persist terminal ingestion run state for runId ${runId}: ${dbErr?.message}`,
        { cause: dbErr },
      );
    }
  }

  // ── Backward-Compatible Legacy Wrappers ───────────────────────────────────

  async startRun(
    workspaceId: string,
    userId: string,
    dto: StartIngestionDto,
  ): Promise<IngestionRunSnapshot> {
    const result = await this.ingest({
      source: (dto.sourceType as any) || 'doi',
      workspaceId,
      userId,
      doi: dto.rawInput || '',
      url: dto.rawInput || '',
      content: dto.rawInput || '',
      idempotencyKey: dto.idempotencyKey,
    });

    return this.getRunStatus(workspaceId, result.runId);
  }

  async captureUrl(
    url: string,
    contextOrWorkspaceId: string | { workspaceId: string; userId?: string },
  ) {
    const wsId =
      typeof contextOrWorkspaceId === 'string'
        ? contextOrWorkspaceId
        : contextOrWorkspaceId?.workspaceId;
    const userId =
      typeof contextOrWorkspaceId === 'object'
        ? contextOrWorkspaceId?.userId
        : undefined;

    if (!this.urlConnector) {
      throw new IngestionValidationException(
        'UrlCaptureConnector is not configured',
      );
    }
    const captured = await this.urlConnector.captureFromUrl(url, {
      workspaceId: wsId,
      userId,
    });

    if (this.prisma.capturePreview?.create && captured.previewToken) {
      const sanitizedMeta = { ...captured };
      delete (sanitizedMeta as any).previewToken;
      const tokenHash = this.urlConnector.hashToken(captured.previewToken);
      const metadataDigest =
        this.urlConnector.calculateMetadataDigest(captured);
      await this.prisma.capturePreview.create({
        data: {
          workspaceId: wsId || 'unassigned',
          userId: userId || 'system',
          sourceUrl: url,
          canonicalMetadata: sanitizedMeta as any,
          metadataDigest,
          tokenHash,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });
    }

    return captured;
  }

  async cleanupExpiredPreviews(retentionDays: number = 7): Promise<number> {
    if ((this.prisma as any)?.capturePreview?.deleteMany) {
      const threshold = new Date(Date.now() - retentionDays * 86400 * 1000);
      const res = await (this.prisma as any).capturePreview.deleteMany({
        where: {
          OR: [
            { consumedAt: { lte: threshold } },
            { expiresAt: { lte: threshold } },
          ],
        },
      });
      return res?.count || 0;
    }
    return 0;
  }

  async confirmCapturedUrl(
    workspaceId: string,
    userId: string,
    dto: ConfirmCapturedUrlDto,
  ) {
    const result = await this.ingest({
      source: 'url',
      workspaceId,
      userId,
      url: dto.url || '',
      previewToken: dto.previewToken,
      collectionId: dto.collectionId,
      overrides: {
        title: dto.title,
        abstract: dto.abstract,
        doi: dto.doi,
        year: dto.year,
        publicationTitle: dto.publicationTitle,
        itemType: dto.itemType,
        creators: dto.creators,
        tags: dto.tags,
        url: dto.url,
      },
    });
    return result.item;
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
