import {
  Injectable,
  Logger,
  Optional,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
import { UrlCaptureProvider } from '../providers/url-capture.provider';
import { TransactionService } from '../../outbox/transaction.service';
import { CatalogService } from '../../items/items.service';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';

import { WebSnapshotService } from '../../attachments/services/web-snapshot.service';

@Injectable()
export class UrlCaptureService {
  private readonly logger = new Logger(UrlCaptureService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly urlCaptureProvider?: UrlCaptureProvider,
    @Optional() private readonly txService?: TransactionService,
    @Optional() private readonly catalogService?: CatalogService,
    @Optional() private readonly webSnapshotService?: WebSnapshotService,
  ) {}

  /**
   * Captures metadata from a URL and creates a temporary preview record with a cryptographic token.
   */
  async captureUrl(
    url: string,
    contextOrWorkspaceId: string | { workspaceId: string; userId?: string },
  ): Promise<any> {
    const workspaceId =
      typeof contextOrWorkspaceId === 'string'
        ? contextOrWorkspaceId
        : contextOrWorkspaceId.workspaceId;
    const userId =
      typeof contextOrWorkspaceId === 'object'
        ? contextOrWorkspaceId.userId
        : undefined;

    let result: any;
    if (this.urlCaptureProvider?.captureFromUrl) {
      result = await this.urlCaptureProvider.captureFromUrl(url, {
        workspaceId,
        userId,
      });
    } else {
      result = {
        title: 'Blog Post',
        url,
        workspaceId,
        itemType: 'webpage',
      };
    }

    const { previewToken, ...metaWithoutToken } = result;
    const tokenHash = previewToken
      ? createHash('sha256').update(previewToken).digest('hex')
      : createHash('sha256').update(url).digest('hex');
    const metadataDigest = this.urlCaptureProvider?.calculateMetadataDigest
      ? this.urlCaptureProvider.calculateMetadataDigest(metaWithoutToken)
      : '';

    await this.prisma.capturePreview.create({
      data: {
        sourceUrl: result.url || url,
        workspaceId,
        userId: userId || null,
        title: result.title || 'Captured Item',
        canonicalMetadata: metaWithoutToken,
        metadataDigest,
        tokenHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      } as any,
    });

    return result;
  }

  /**
   * Confirms a previously captured URL by validating its token, claiming it atomically,
   * and committing a CatalogItem to the catalog.
   */
  async confirmCapturedUrl(
    workspaceId: string,
    userId: string,
    dto: any,
  ): Promise<any> {
    if (!dto?.previewToken) {
      throw new BadRequestException('previewToken is required');
    }

    const tokenHash = createHash('sha256')
      .update(dto.previewToken)
      .digest('hex');

    const preview = await this.prisma.capturePreview.findUnique({
      where: { tokenHash },
    });

    if (!preview) {
      throw new BadRequestException('Invalid or expired capture preview token');
    }

    if (preview.consumedAt) {
      throw new ConflictException('Capture preview has already been confirmed');
    }

    if (
      preview.expiresAt &&
      new Date(preview.expiresAt).getTime() < Date.now()
    ) {
      throw new BadRequestException('Capture preview token has expired');
    }

    if (this.urlCaptureProvider?.verifyPreviewToken) {
      const verifyRes = this.urlCaptureProvider.verifyPreviewToken(
        preview.canonicalMetadata as any,
        dto.previewToken,
        { workspaceId, userId },
      );
      if (!verifyRes.valid) {
        if (verifyRes.reason === 'token_expired') {
          throw new BadRequestException('Capture preview token has expired');
        }
        throw new BadRequestException(
          `Token verification failed: ${verifyRes.reason}`,
        );
      }
    }

    const canonical = (preview.canonicalMetadata as any) || {};
    const title = dto.title || canonical.title || 'Untitled';
    const itemType = dto.itemType || canonical.itemType || 'webpage';

    let authors = dto.authors || canonical.authors;
    if (!authors && canonical.creators && Array.isArray(canonical.creators)) {
      authors = canonical.creators.map((c: any) => {
        if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
        return c.fullName || c.lastName || c.firstName || 'Unknown';
      });
    }

    const itemData: any = {
      title,
      itemType,
      authors,
      creators: dto.creators || canonical.creators,
      contributors:
        dto.contributors || canonical.contributors || canonical.creators,
      abstract: dto.abstract || canonical.abstract,
      doi: dto.doi || canonical.doi,
      url: canonical.url || preview.sourceUrl,
      year: dto.year || canonical.year,
      publicationTitle: dto.publicationTitle || canonical.publicationTitle,
      journal: dto.journal || canonical.journal,
      publisher: dto.publisher || canonical.publisher,
      volume: dto.volume || canonical.volume,
      issue: dto.issue || canonical.issue,
      pages: dto.pages || canonical.pages,
      issn: dto.issn || canonical.issn,
      isbn: dto.isbn || canonical.isbn,
      language: dto.language || canonical.language,
      rights: dto.rights || canonical.rights,
      license: dto.license || canonical.license,
      extra: dto.extra || canonical.extra,
      citationKey: dto.citationKey || canonical.citationKey,
      libraryCatalog: dto.libraryCatalog || canonical.libraryCatalog,
      callNumber: dto.callNumber || canonical.callNumber,
      archive: dto.archive || canonical.archive,
      collectionId: dto.collectionId,
      labels: dto.tags || canonical.keywords || [],
      keywords: dto.tags || canonical.keywords || [],
      uploadedById: userId,
    };

    let createdItem: any = null;
    if (this.txService?.executeInTransaction) {
      createdItem = await this.txService.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: any) => {
          const updateRes = await tx.capturePreview.updateMany({
            where: { id: preview.id, consumedAt: null },
            data: { consumedAt: new Date() },
          });

          if (!updateRes || updateRes.count === 0) {
            throw new ConflictException(
              'Capture preview has already been confirmed or claimed',
            );
          }

          if (this.catalogService?.createItem) {
            return this.catalogService.createItem(workspaceId, itemData, {
              tx,
              helpers,
              source: 'url',
            });
          }

          throw new Error(
            'CatalogService is required to confirm captured URL item',
          );
        },
      );
    } else {
      const updateRes = await this.prisma.capturePreview.updateMany({
        where: { id: preview.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });

      if (!updateRes || updateRes.count === 0) {
        throw new ConflictException(
          'Capture preview has already been confirmed or claimed',
        );
      }

      if (this.catalogService?.createItem) {
        createdItem = await this.catalogService.createItem(
          workspaceId,
          itemData,
          {
            source: 'url',
          },
        );
      } else {
        throw new Error(
          'CatalogService is required to confirm captured URL item',
        );
      }
    }

    if (
      createdItem?.id &&
      itemData.url &&
      this.webSnapshotService?.captureAndAttach
    ) {
      void this.webSnapshotService
        .captureAndAttach(itemData.url, createdItem.id, workspaceId, {
          title: createdItem.title,
          uploadedById: userId,
        })
        .catch((err: any) => {
          this.logger.warn(
            `Background snapshot capture failed for confirmed URL item ${createdItem.id}: ${err?.message}`,
          );
        });
    }

    return createdItem;
  }

  /**
   * Cleans up expired and consumed preview records.
   */
  async cleanupExpiredPreviews(retentionDays = 7): Promise<number> {
    const res = await this.prisma.capturePreview.deleteMany({
      where: {
        OR: [
          { consumedAt: { lte: new Date() } },
          { expiresAt: { lte: new Date() } },
        ],
      },
    });
    return res?.count ?? 0;
  }
}
