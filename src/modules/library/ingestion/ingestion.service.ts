import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { IngestionStatus } from '@prisma/client';
import { LibraryTransactionService } from '../sync-core/library-transaction.service';
import { CatalogService } from '../catalog/catalog.service';
import {
  StartIngestionDto,
  IngestDoiDto,
  IngestBibtexDto,
} from './dto/ingestion.dto';
import { createHash } from 'crypto';
import {
  UrlCaptureConnector,
  CapturedPaperMetadata,
} from './url-capture.connector';
import { ConfirmCapturedUrlDto } from './dto/capture-url.dto';

export interface IngestionRunSnapshot {
  id: string;
  workspaceId: string;
  sourceType: string;
  status: IngestionStatus;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  startedAt: Date;
  completedAt?: Date | null;
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly libraryTx: LibraryTransactionService,
    private readonly catalogService: CatalogService,
    private readonly urlCapture: UrlCaptureConnector,
  ) {}

  /**
   * Captures and previews academic metadata from any public URL with SSRF filtering and signed preview token.
   * Persists CapturePreview record for anti-replay and one-time consumption verification.
   */
  async captureUrl(
    targetUrl: string,
    context?: { workspaceId?: string; userId?: string },
  ): Promise<CapturedPaperMetadata> {
    const meta = await this.urlCapture.captureFromUrl(targetUrl, context);

    if (context?.workspaceId && context?.userId && meta.previewToken) {
      const tokenHash = this.urlCapture.hashToken(meta.previewToken);
      const metadataDigest = this.urlCapture.calculateMetadataDigest(meta);

      const parts = meta.previewToken.split('.');
      const expiresAt =
        parts.length === 5
          ? parseInt(parts[3], 10)
          : Date.now() + 15 * 60 * 1000;

      // Ensure raw previewToken is never persisted inside canonicalMetadata JSON column
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

  /**
   * Confirms and persists captured URL metadata into a CatalogItem within a single atomic transaction.
   * Strictly verifies cryptographic preview token against tampering, expiration, cross-workspace access, and replay.
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
      // 1. Fetch persistent CapturePreview record
      const preview = await tx.capturePreview.findUnique({
        where: { tokenHash },
      });

      if (!preview) {
        throw new BadRequestException('Invalid or unrecognised preview token');
      }

      // 2. Validate tenant & user ownership
      if (preview.workspaceId !== workspaceId) {
        throw new BadRequestException(
          'Preview token does not belong to this workspace',
        );
      }
      if (preview.userId !== userId) {
        throw new BadRequestException(
          'Preview token does not belong to this user',
        );
      }

      // 3. Validate expiration
      if (preview.expiresAt.getTime() < Date.now()) {
        throw new BadRequestException('Preview token has expired');
      }

      // 4. Validate one-time consumption (Anti-Replay)
      if (preview.consumedAt !== null) {
        throw new ConflictException('Preview token has already been consumed');
      }

      // 5. Verify cryptographic HMAC signature against canonical metadata
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

      // 6. Mark preview consumed atomically using atomic CAS update
      const updateResult = await tx.capturePreview.updateMany({
        where: { id: preview.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });

      if (updateResult.count === 0) {
        throw new ConflictException('Preview token has already been consumed');
      }

      // 7. Merge explicit user overrides (if any) with canonical metadata
      const title = dto.title?.trim() || canonicalMeta.title;
      const abstract =
        dto.abstract !== undefined ? dto.abstract : canonicalMeta.abstract;
      const doi = dto.doi !== undefined ? dto.doi : canonicalMeta.doi;
      const year = dto.year !== undefined ? dto.year : canonicalMeta.year;
      const publicationTitle =
        dto.publicationTitle !== undefined
          ? dto.publicationTitle
          : canonicalMeta.publicationTitle;

      // Preserve academic itemType with allowlist verification
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

      // Preserve structured creators and map deterministically to authors: string[]
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

      // 8. Create CatalogItem atomically via CatalogService (NO nested transaction!)
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

      // 9. Persist tags and item-tag relations atomically within the same transaction
      const rawTags: string[] =
        dto.tags && dto.tags.length > 0 ? dto.tags : canonicalMeta.tags || [];
      const normalizedTags = Array.from(
        new Set(
          rawTags
            .map((t: string) => (typeof t === 'string' ? t.trim() : ''))
            .filter((t: string) => t.length > 0),
        ),
      ).slice(0, 50);

      if (normalizedTags.length > 0) {
        for (const tagName of normalizedTags) {
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
                catalogItemId: item.id,
              },
            },
            create: {
              tagId: tag.id,
              catalogItemId: item.id,
            },
            update: {},
          });

          await helpers.appendChange(workspaceId, {
            entityType: 'CatalogItemTag',
            entityId: `${tag.id}:${item.id}`,
            action: 'create',
            version: 1,
            data: { tagId: tag.id, catalogItemId: item.id },
          });
        }
      }

      // 10. Publish outbox event
      await helpers.publishOutbox(
        workspaceId,
        item.id,
        'library.item.ingested_url',
        {
          itemId: item.id,
          url: dto.url || canonicalMeta.url,
          title,
          itemType,
          tags: normalizedTags,
          previewId: preview.id,
        },
      );

      return item;
    });
  }

  /**
   * Cleans up expired and consumed CapturePreview records past their retention window.
   */
  async cleanupExpiredPreviews(olderThanDays = 7): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const result = await this.prisma.capturePreview.deleteMany({
      where: {
        OR: [{ consumedAt: { lte: cutoff } }, { expiresAt: { lte: cutoff } }],
      },
    });
    return result.count;
  }

  /**
   * Initializes a durable ingestion run record.
   */
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

    // Record first stage
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

  /**
   * Retrieves status and stages of an ingestion run.
   */
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

  /**
   * Ingest single item by DOI and commit atomically to catalog.
   */
  async ingestDoi(workspaceId: string, userId: string, dto: IngestDoiDto) {
    const cleanDoi = dto.doi.trim().replace(/^https?:\/\/doi\.org\//, '');

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const item = await this.catalogService.createItem(workspaceId, {
        itemType: 'journalArticle',
        title: `Publication (${cleanDoi})`,
        doi: cleanDoi,
        uploadedById: userId || 'system',
      });

      await helpers.publishOutbox(
        workspaceId,
        item.id,
        'library.item.ingested_doi',
        { doi: cleanDoi, itemId: item.id },
      );

      return item;
    });
  }

  /**
   * Ingest BibTeX records and commit to catalog.
   */
  async ingestBibtex(
    workspaceId: string,
    userId: string,
    dto: IngestBibtexDto,
  ) {
    const raw = dto.bibtex.trim();
    const titleMatch = raw.match(/title\s*=\s*[{"]([^}"]+)[}"]/i);
    const title = titleMatch ? titleMatch[1] : 'Imported BibTeX Reference';

    const authorMatch = raw.match(/author\s*=\s*[{"]([^}"]+)[}"]/i);
    const authors = authorMatch
      ? authorMatch[1].split(' and ').map((a) => a.trim())
      : [];

    const yearMatch = raw.match(/year\s*=\s*[{"]?(\d{4})[}"]?/i);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : undefined;

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const item = await this.catalogService.createItem(workspaceId, {
        itemType: 'journalArticle',
        title,
        authors,
        year,
        uploadedById: userId || 'system',
      });

      await helpers.publishOutbox(
        workspaceId,
        item.id,
        'library.item.ingested_bibtex',
        { itemId: item.id, title },
      );

      return item;
    });
  }
}
