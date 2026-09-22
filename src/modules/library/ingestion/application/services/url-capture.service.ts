import {
  Injectable,
  Logger,
  Optional,
  Inject,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { IngestionRepository } from '../../infrastructure/repositories/ingestion.repository';
import { Prisma } from '@prisma/client';
import { UrlCaptureProvider } from '../../infrastructure/providers/url-capture.provider';
import { TransactionService } from '../../../shared-kernel/outbox/transaction.service';
import {
  BIBLIOGRAPHY_FACADE,
  IBibliographyFacade,
  CATALOG_FACADE,
  ICatalogFacade,
} from '../../../bibliography/bibliography.facade';
import {
  READER_FACADE,
  IReaderFacade,
  CONTENT_FACADE,
  IContentFacade,
} from '../../../reader/reader.facade';
import { createHash } from 'crypto';

@Injectable()
export class UrlCaptureService {
  private readonly logger = new Logger(UrlCaptureService.name);

  constructor(
    private readonly repo: IngestionRepository,
    @Optional() private readonly urlCaptureProvider?: UrlCaptureProvider,
    @Optional() private readonly txService?: TransactionService,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogFacade?: ICatalogFacade,
    @Optional()
    @Inject(CONTENT_FACADE)
    private readonly contentFacade?: IContentFacade,
  ) {}

  /**
   * Captures metadata from a URL and creates a temporary preview record with a cryptographic token.
   */
  async captureUrl(
    url: string,
    contextOrScopeId:
      | string
      | {
          scopeId?: string;
          projectId?: string;
          userId?: string;
        },
  ): Promise<any> {
    const scopeId =
      typeof contextOrScopeId === 'string'
        ? contextOrScopeId
        : contextOrScopeId.scopeId || contextOrScopeId.projectId || '';
    const userId =
      typeof contextOrScopeId === 'object'
        ? contextOrScopeId.userId
        : undefined;
    const effectiveScopeId = scopeId || userId || 'unassigned';

    let result: any;
    if (this.urlCaptureProvider?.captureFromUrl) {
      result = await this.urlCaptureProvider.captureFromUrl(url, {
        scopeId: effectiveScopeId,
        userId,
      });
    } else {
      result = {
        title: 'Blog Post',
        url,
        scopeId: effectiveScopeId,
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

    await this.repo.createCapturePreview({
      sourceUrl: result.url || url,
      userId: userId || effectiveScopeId,
      canonicalMetadata: metaWithoutToken,
      metadataDigest,
      tokenHash,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    return result;
  }

  /**
   * Confirms a previously captured URL by validating its token, claiming it atomically,
   * and committing an Item to the library.
   */
  async confirmCapturedUrl(
    scopeId: string,
    userId: string,
    dto: any,
  ): Promise<any> {
    const targetUserId = userId || scopeId;
    const projectId = scopeId && scopeId !== targetUserId ? scopeId : undefined;
    if (!dto?.previewToken) {
      throw new BadRequestException('previewToken is required');
    }

    const tokenHash = createHash('sha256')
      .update(dto.previewToken)
      .digest('hex');

    const preview = await this.repo.findCapturePreviewByTokenHash(tokenHash);

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
        preview.canonicalMetadata,
        dto.previewToken,
        { scopeId, userId: targetUserId },
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

    const canonical = preview.canonicalMetadata || {};
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
      uploadedById: targetUserId,
    };

    let createdItem: any = null;
    if (this.txService?.executeInTransaction) {
      createdItem = await this.txService.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: any) => {
          const claimedCount = await this.repo.claimCapturePreview(tokenHash, tx);

          if (!claimedCount || claimedCount === 0) {
            throw new ConflictException(
              'Capture preview has already been confirmed or claimed',
            );
          }

          if (this.catalogFacade?.createItem) {
            return this.catalogFacade.createItem(
              targetUserId,
              itemData,
              { tx, helpers, source: 'url', projectId },
              projectId,
            );
          }

          throw new Error(
            'CatalogFacade is required to confirm captured URL item',
          );
        },
      );
    } else {
      const updateRes = await this.repo.claimCapturePreview(tokenHash);

      if (!updateRes || updateRes === 0) {
        throw new ConflictException(
          'Capture preview has already been confirmed or claimed',
        );
      }

      if (this.catalogFacade?.createItem) {
        createdItem = await this.catalogFacade.createItem(
          targetUserId,
          itemData,
          { source: 'url', projectId },
          projectId,
        );
      } else {
        throw new Error(
          'CatalogFacade is required to confirm captured URL item',
        );
      }
    }

    if (
      createdItem?.id &&
      itemData.url &&
      this.contentFacade?.captureWebSnapshot
    ) {
      void this.contentFacade
        .captureWebSnapshot(itemData.url, createdItem.id, targetUserId)
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
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    return this.repo.deleteExpiredCapturePreviews(cutoff);
  }
}
