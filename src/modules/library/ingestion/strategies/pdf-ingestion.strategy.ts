import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
import { CatalogService } from '../../catalog/catalog.service';
import { TransactionService } from '../../sync/services/transaction.service';
import { CatalogItemMapper } from '../../catalog/mappers/catalog-item.mapper';
import {
  STORAGE_PORT,
  IStoragePort,
  getFileContentPath,
} from '../../../storage/storage.port';
import {
  PdfExtractorProvider,
  type ExtractedPdfMetadata,
} from '../../attachments/providers/pdf-extractor.provider';
import { IngestionValidationException } from '../errors/ingestion.errors';
import { IngestionCommand, IngestionResult } from '../types/ingestion.types';
import { METADATA_PORT, MetadataPort } from '../metadata/types/metadata.types';
import { IngestionStatus, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import {
  IIngestionStrategy,
  IngestionExecutionContext,
} from './ingestion-strategy.interface';

@Injectable()
export class PdfIngestionStrategy implements IIngestionStrategy<
  IngestionCommand & { source: 'pdf' }
> {
  readonly source = 'pdf';
  private readonly logger = new Logger(PdfIngestionStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    @Inject(PdfExtractorProvider)
    private readonly extractorService?: any,
    @Optional()
    @Inject(CatalogService)
    private readonly catalogService?: CatalogService,
    @Optional()
    @Inject(TransactionService)
    private readonly libraryTx?: TransactionService,
    @Optional()
    @Inject(METADATA_PORT)
    private readonly metadataPort?: MetadataPort,
  ) {}

  canHandle(source: string): boolean {
    return source === 'pdf';
  }

  async execute(
    command: IngestionCommand & { source: 'pdf' },
    context: IngestionExecutionContext,
  ): Promise<IngestionResult> {
    const { workspaceId, runId, requestHash } = context;

    let fileRecord: any;
    if (this.storagePort?.readOwnedFile) {
      try {
        fileRecord = await this.storagePort.readOwnedFile({
          workspaceId,
          fileId: command.fileId,
        });
      } catch (err: any) {
        if (
          err?.status === 403 ||
          err?.message?.includes('Access denied') ||
          err?.name === 'ForbiddenException'
        ) {
          throw new IngestionValidationException(
            err.message || 'Access denied: file does not belong to workspace',
          );
        }
        if (err?.status === 404 || err?.name === 'NotFoundException') {
          throw new IngestionValidationException(
            err.message || 'File not found in workspace storage',
          );
        }
        throw err;
      }
    }

    let hash = '';
    let extractedDoc: any = null;
    if (fileRecord?.buffer) {
      const magic = fileRecord.buffer.slice(0, 5).toString('ascii');
      if (!magic.startsWith('%PDF')) {
        throw new IngestionValidationException(
          'Missing %PDF magic bytes in uploaded file',
        );
      }

      hash = createHash('sha256').update(fileRecord.buffer).digest('hex');

      if (this.extractorService?.extractDocumentFromBuffer) {
        try {
          extractedDoc = await this.extractorService.extractDocumentFromBuffer(
            fileRecord.buffer,
          );
        } catch (err: any) {
          this.logger.warn(`PDF extraction failed: ${err?.message}`);
        }
      }
    }

    const contentUrl = command.fileId
      ? getFileContentPath(command.fileId)
      : fileRecord?.url || fileRecord?.contentUrl || '';

    return await context.withKeyLock(
      `${workspaceId}:pdf:${hash || command.fileId}`,
      async () => {
        if (hash) {
          const claim = await this.prisma.libraryDedupClaim.findUnique({
            where: {
              workspaceId_claimType_claimValue: {
                workspaceId,
                claimType: 'pdf_sha256',
                claimValue: hash,
              },
            },
            include: {
              catalogItem: {
                include: { attachments: true },
              },
            },
          });

          if (claim?.catalogItem) {
            if (claim.catalogItem.deletedAt) {
              await this.prisma.catalogItem.update({
                where: { id: claim.catalogItem.id },
                data: { deletedAt: null },
              });
              claim.catalogItem.deletedAt = null;
            }
            const it = CatalogItemMapper.toDomain(claim.catalogItem);
            const result: IngestionResult = {
              runId,
              status: 'completed',
              itemId: it.id,
              attachmentIds: it.attachments?.map((a: any) => a.id) || [],
              deduplicated: true,
              item: it,
            };
            await context.saveIdempotency(
              workspaceId,
              command.idempotencyKey,
              requestHash,
              result,
            );
            await context.updateRunStatus(
              workspaceId,
              runId,
              IngestionStatus.READY,
              { itemId: it.id, completedAt: new Date() },
            );
            return result;
          }
        }

        // Also check if an attachment with same fileId or fileHash exists
        const existingAtt = await this.prisma.catalogAttachment.findFirst({
          where: {
            OR: [
              {
                fileId: command.fileId,
                catalogItem: { workspaceId },
              },
              ...(hash
                ? [
                    {
                      fileHash: hash,
                      catalogItem: { workspaceId },
                    },
                  ]
                : []),
            ],
          },
          include: {
            catalogItem: {
              include: { attachments: true },
            },
          },
        });

        if (existingAtt?.catalogItem) {
          if (existingAtt.catalogItem.deletedAt) {
            await this.prisma.catalogItem.update({
              where: { id: existingAtt.catalogItem.id },
              data: { deletedAt: null },
            });
            existingAtt.catalogItem.deletedAt = null;
          }
          const it = CatalogItemMapper.toDomain(existingAtt.catalogItem);
          const result: IngestionResult = {
            runId,
            status: 'completed',
            itemId: it.id,
            attachmentIds: it.attachments?.map((a: any) => a.id) || [
              existingAtt.id,
            ],
            deduplicated: true,
            item: it,
          };
          await context.saveIdempotency(
            workspaceId,
            command.idempotencyKey,
            requestHash,
            result,
          );
          await context.updateRunStatus(
            workspaceId,
            runId,
            IngestionStatus.READY,
            { itemId: it.id, completedAt: new Date() },
          );
          return result;
        }

        // ── Resolve Metadata from Extractors & Authoritative Providers ──
        const extractedMeta: ExtractedPdfMetadata =
          extractedDoc?.metadata || extractedDoc || {};

        let arxivId = extractedMeta.arxivId || extractedDoc?.arxivId;

        if (!arxivId && command.filename) {
          const m = command.filename.match(
            /(?:arxiv[:_.\-]*)?(\d{4}\.\d{4,5}(?:v\d+)?)/i,
          );
          if (m) arxivId = m[1];
        }

        const doi =
          command.overrides?.doi || extractedMeta.doi || extractedDoc?.doi;

        let candidateTitle =
          command.overrides?.title ||
          extractedMeta.title ||
          extractedDoc?.title ||
          '';

        if (candidateTitle) {
          candidateTitle = candidateTitle
            .replace(/\.pdf$/i, '')
            .replace(/^(paper|document|untitled)$/i, '')
            .trim();
        }

        // Determine query to resolve from metadata providers (CrossRef, OpenAlex, Semantic Scholar, arXiv):
        // 1. arXiv ID
        // 2. DOI
        // 3. Candidate Title (if clean and > 8 chars)
        const queryId =
          arxivId ||
          doi ||
          (candidateTitle &&
          candidateTitle.length > 8 &&
          !candidateTitle.toLowerCase().endsWith('.pdf')
            ? candidateTitle
            : null);

        let resolvedMeta: any = null;
        if (queryId && this.metadataPort?.resolve) {
          try {
            this.logger.log(
              `Resolving academic metadata for query: "${queryId}"`,
            );
            resolvedMeta = await this.metadataPort.resolve({
              query: queryId,
              workspaceId,
            });
            if (resolvedMeta?.metadata) {
              this.logger.log(
                `Successfully resolved metadata: "${resolvedMeta.metadata.title}" by ${resolvedMeta.metadata.authors?.join(', ')}`,
              );
            }
          } catch (err: any) {
            this.logger.warn(
              `Metadata lookup failed for query "${queryId}": ${err?.message}`,
            );
          }
        }
        const meta = resolvedMeta?.metadata || {};

        let createdItem: any = null;
        let createdAttachment: any = null;
        let isDedup = false;

        // Clean fallback filename title
        const cleanFilenameTitle = command.filename
          ? command.filename
              .replace(/\.pdf$/i, '')
              .replace(/^[0-9._-]+/, '')
              .replace(/[_-]+/g, ' ')
              .trim()
          : '';

        const resolvedTitle =
          command.overrides?.title ||
          meta.title ||
          (candidateTitle && candidateTitle.length > 5
            ? candidateTitle
            : null) ||
          cleanFilenameTitle ||
          command.filename?.replace(/\.pdf$/i, '') ||
          'PDF Document';

        const resolvedAuthors =
          command.overrides?.authors ||
          meta.authors ||
          (extractedMeta.authors && extractedMeta.authors.length > 0
            ? extractedMeta.authors
            : undefined) ||
          [];

        const resolvedCreators =
          meta.creators ||
          (resolvedAuthors.length > 0
            ? resolvedAuthors.map((authorName: string, idx: number) => {
                const parts = authorName.split(/\s+/);
                return {
                  creatorType: 'author',
                  fullName: authorName,
                  firstName:
                    parts.length > 1 ? parts.slice(0, -1).join(' ') : '',
                  lastName:
                    parts.length > 1 ? parts[parts.length - 1] : authorName,
                  orderIndex: idx,
                };
              })
            : undefined);

        const pdfItemData: any = {
          title: resolvedTitle,
          filename: command.filename || 'PDF Document',
          fileId: command.fileId,
          fileUrl: contentUrl,
          uploadedById: command.userId || 'system',
          collectionId: command.collectionId,
          authors: resolvedAuthors,
          creators: resolvedCreators,
          abstract:
            command.overrides?.abstract ||
            meta.abstract ||
            extractedMeta.abstract ||
            extractedDoc?.abstract ||
            '',
          doi: command.overrides?.doi || meta.doi || doi || '',
          arxivId: arxivId || meta.arxivId || '',
          pmid: command.overrides?.pmid || meta.pmid || '',
          pmcid: command.overrides?.pmcid || meta.pmcid || '',
          isbn: command.overrides?.isbn || meta.isbn || '',
          issn: command.overrides?.issn || meta.issn || '',
          year:
            command.overrides?.year ||
            meta.year ||
            extractedMeta.year ||
            extractedDoc?.year ||
            null,
          publicationDate:
            command.overrides?.publicationDate ||
            meta.publicationDate ||
            (meta.year ? String(meta.year) : ''),
          publicationTitle:
            command.overrides?.publicationTitle ||
            meta.publicationTitle ||
            meta.journal ||
            '',
          publisher: command.overrides?.publisher || meta.publisher || '',
          place: command.overrides?.place || meta.place || '',
          volume: command.overrides?.volume || meta.volume || '',
          issue: command.overrides?.issue || meta.issue || '',
          pages: command.overrides?.pages || meta.pages || '',
          series: command.overrides?.series || meta.series || '',
          seriesTitle: command.overrides?.seriesTitle || meta.seriesTitle || '',
          seriesText: command.overrides?.seriesText || meta.seriesText || '',
          journalAbbr:
            command.overrides?.journalAbbr ||
            meta.journalAbbr ||
            meta.journalAbbreviation ||
            '',
          citationKey: command.overrides?.citationKey || meta.citationKey || '',
          shortTitle: command.overrides?.shortTitle || meta.shortTitle || '',
          rights: command.overrides?.rights || meta.rights || '',
          license: command.overrides?.license || meta.license || '',
          language: command.overrides?.language || meta.language || '',
          url:
            command.overrides?.url ||
            meta.url ||
            (arxivId ? `https://arxiv.org/abs/${arxivId}` : ''),
          labels:
            command.overrides?.keywords ||
            command.overrides?.tags ||
            meta.keywords ||
            meta.tags ||
            extractedMeta.keywords ||
            [],
          keywords:
            command.overrides?.keywords ||
            command.overrides?.tags ||
            meta.keywords ||
            meta.tags ||
            extractedMeta.keywords ||
            [],
          extraFields: {
            ...(meta.extraFields || {}),
            ...(command.overrides?.extraFields || {}),
          },
          itemType:
            command.overrides?.itemType || meta.itemType || 'journalArticle',
        };

        if (this.libraryTx?.executeInTransaction) {
          createdItem = await this.libraryTx.executeInTransaction(
            async (tx: Prisma.TransactionClient, helpers: any) => {
              // Check race condition in tx
              if (hash) {
                const raceClaim = await tx.libraryDedupClaim.findUnique({
                  where: {
                    workspaceId_claimType_claimValue: {
                      workspaceId,
                      claimType: 'pdf_sha256',
                      claimValue: hash,
                    },
                  },
                  include: { catalogItem: { include: { attachments: true } } },
                });
                if (raceClaim?.catalogItem) {
                  if (raceClaim.catalogItem.deletedAt) {
                    await tx.catalogItem.update({
                      where: { id: raceClaim.catalogItem.id },
                      data: { deletedAt: null },
                    });
                    raceClaim.catalogItem.deletedAt = null;
                  }
                  isDedup = true;
                  return raceClaim.catalogItem;
                }
              }

              let item: any;
              if (this.catalogService?.createItem) {
                item = await this.catalogService.createItem(
                  workspaceId,
                  pdfItemData,
                  {
                    tx,
                    helpers,
                    source: 'pdf',
                  },
                );
              } else {
                throw new Error(
                  'CatalogService is required to create PDF item',
                );
              }

              // Create attachment for PDF with canonical content URL
              createdAttachment = await tx.catalogAttachment.create({
                data: {
                  catalogItemId: item.id,
                  fileId: command.fileId || null,
                  filename:
                    command.filename || fileRecord?.filename || 'document.pdf',
                  url: contentUrl,
                  fileHash: hash || null,
                  size: fileRecord?.size || fileRecord?.buffer?.length || 0,
                  mimeType: 'application/pdf',
                  attachmentType: 'primary_pdf',
                  revisions: {
                    create: {
                      revisionNumber: 1,
                      fileHash: hash || '',
                      sizeBytes:
                        fileRecord?.size || fileRecord?.buffer?.length || 0,
                      url: contentUrl,
                    },
                  },
                },
              });

              if (command.fileId && tx.file?.updateMany) {
                await tx.file.updateMany({
                  where: { id: command.fileId },
                  data: {
                    linkedToType: 'Paper',
                    linkedToId: item.id,
                  },
                });
              }

              if (hash) {
                await tx.libraryDedupClaim.upsert({
                  where: {
                    workspaceId_claimType_claimValue: {
                      workspaceId,
                      claimType: 'pdf_sha256',
                      claimValue: hash,
                    },
                  },
                  update: {
                    catalogItemId: item.id,
                  },
                  create: {
                    workspaceId,
                    claimType: 'pdf_sha256',
                    claimValue: hash,
                    catalogItemId: item.id,
                  },
                });
              }

              return item;
            },
          );
        } else if (this.catalogService?.createItem) {
          createdItem = await this.catalogService.createItem(
            workspaceId,
            pdfItemData,
            {
              source: 'pdf',
            },
          );
        }

        const itemWithUrl = createdItem
          ? CatalogItemMapper.toDomain({
              ...createdItem,
              attachments:
                createdItem.attachments ||
                (createdAttachment ? [createdAttachment] : []),
            })
          : createdItem;

        const result: IngestionResult = {
          runId,
          status: 'completed',
          itemId: itemWithUrl?.id,
          attachmentIds: createdAttachment
            ? [createdAttachment.id]
            : itemWithUrl?.attachments?.length
              ? itemWithUrl.attachments.map((a: any) => a.id)
              : [],
          deduplicated: isDedup,
          item: itemWithUrl,
        };
        await context.saveIdempotency(
          workspaceId,
          command.idempotencyKey,
          requestHash,
          result,
        );
        await context.updateRunStatus(
          workspaceId,
          runId,
          IngestionStatus.READY,
          { itemId: result.itemId, completedAt: new Date() },
        );

        return result;
      },
    );
  }
}
