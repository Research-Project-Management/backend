import {
  Injectable,
  Logger,
  Optional,
  Inject,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { Prisma } from '@prisma/client';
import {
  UrlCaptureProvider,
  CapturedItemMetadata,
} from '@/modules/library/ingestion/providers/url-capture.provider';
import { ConfirmCapturedUrlDto } from '@/modules/library/ingestion/dto/capture-url.dto';
import {
  CATALOG_FACADE,
  ICatalogFacade,
  EXTRACTION_FACADE,
  IExtractionFacade,
  ItemDetail,
  TransactionService,
  CreateItemData,
  harmonizeZoteroFields,
  resolveCanonicalCreatorRole,
} from '@/modules/library/core';
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
    private readonly catalogGateway?: ICatalogFacade,
    @Optional()
    @Inject(EXTRACTION_FACADE)
    private readonly extractionGateway?: IExtractionFacade,
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
  ): Promise<
    | CapturedItemMetadata
    | {
        title: string;
        url: string;
        scopeId: string;
        itemType: string;
        previewToken?: string;
      }
  > {
    const scopeId =
      typeof contextOrScopeId === 'string'
        ? contextOrScopeId
        : contextOrScopeId.scopeId || contextOrScopeId.projectId || '';
    const userId =
      typeof contextOrScopeId === 'object'
        ? contextOrScopeId.userId
        : undefined;
    const effectiveScopeId = scopeId || userId || 'unassigned';

    let result:
      | CapturedItemMetadata
      | {
          title: string;
          url: string;
          scopeId: string;
          itemType: string;
          previewToken?: string;
        };
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
      canonicalMetadata: metaWithoutToken as unknown as Prisma.InputJsonValue,
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
    dto: ConfirmCapturedUrlDto,
  ): Promise<ItemDetail> {
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

    if (preview.claimedAt) {
      throw new ConflictException('Capture preview has already been confirmed');
    }

    if (
      preview.expiresAt &&
      new Date(preview.expiresAt).getTime() < Date.now()
    ) {
      throw new BadRequestException('Capture preview token has expired');
    }

    if (this.urlCaptureProvider?.verifyPreviewToken) {
      const canonicalMeta =
        preview.canonicalMetadata &&
        typeof preview.canonicalMetadata === 'object' &&
        !Array.isArray(preview.canonicalMetadata)
          ? (preview.canonicalMetadata as {
              url?: string;
              title: string;
              doi?: string;
              year?: number;
            })
          : { title: '' };
      const verifyRes = this.urlCaptureProvider.verifyPreviewToken(
        canonicalMeta,
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

    const canonical =
      (preview.canonicalMetadata as Record<string, unknown>) || {};
    const itemType = (canonical.itemType as string | undefined) || 'webpage';

    let authors = canonical.authors as string[] | undefined;
    const normalizedCreators = Array.isArray(canonical.creators)
      ? (
          canonical.creators as Array<{
            creatorType?: string;
            lastName?: string;
            firstName?: string;
            fullName?: string;
            name?: string;
            fieldMode?: number;
          }>
        ).map((c) => ({
          ...c,
          creatorType: resolveCanonicalCreatorRole(c.creatorType, { itemType }),
        }))
      : undefined;

    if (!authors && normalizedCreators && normalizedCreators.length > 0) {
      authors = normalizedCreators.map((c) => {
        if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
        return c.fullName || c.lastName || c.firstName || 'Unknown';
      });
    }

    const canonicalExtraFields =
      canonical.extraFields &&
      typeof canonical.extraFields === 'object' &&
      !Array.isArray(canonical.extraFields)
        ? { ...(canonical.extraFields as Record<string, unknown>) }
        : {};

    const reservedPreviewKeys = new Set([
      'previewToken',
      'scopeId',
      'userId',
      'projectId',
      'collectionId',
      'uploadedById',
      'extraFields',
    ]);
    const passthroughFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(canonical)) {
      if (reservedPreviewKeys.has(k)) continue;
      if (v !== undefined && v !== null && v !== '') {
        passthroughFields[k] = v;
      }
    }

    const harmonized = harmonizeZoteroFields<Record<string, unknown>>(
      {
        ...canonicalExtraFields,
        ...passthroughFields,
        ...(dto.title ? { title: dto.title } : {}),
        ...(dto.abstract ? { abstract: dto.abstract } : {}),
        ...(dto.doi ? { doi: dto.doi } : {}),
        ...(dto.year ? { year: dto.year } : {}),
        ...(dto.publicationTitle
          ? { publicationTitle: dto.publicationTitle }
          : {}),
        itemType,
        extraFields: canonicalExtraFields,
      },
      { itemType, syncExtraFields: true },
    );

    const syncedExtraFields =
      harmonized.extraFields &&
      typeof harmonized.extraFields === 'object' &&
      !Array.isArray(harmonized.extraFields)
        ? (harmonized.extraFields as Record<string, unknown>)
        : canonicalExtraFields;

    const title =
      dto.title ||
      (harmonized.title as string | undefined) ||
      (canonical.title as string | undefined) ||
      'Untitled';

    const itemData: CreateItemData = {
      ...syncedExtraFields,
      ...passthroughFields,
      ...harmonized,
      title,
      itemType,
      authors,
      creators: normalizedCreators,
      contributors: (canonical.contributors ||
        normalizedCreators) as CreateItemData['contributors'],
      abstract:
        dto.abstract ||
        (harmonized.abstract as string | undefined) ||
        (canonical.abstract as string | undefined),
      doi:
        dto.doi ||
        (harmonized.doi as string | undefined) ||
        (canonical.doi as string | undefined),
      url:
        (harmonized.url as string | undefined) ||
        (canonical.url as string | undefined) ||
        preview.sourceUrl,
      year:
        dto.year ||
        (harmonized.year as number | undefined) ||
        (canonical.year as number | undefined),
      publicationTitle:
        dto.publicationTitle ||
        (harmonized.publicationTitle as string | undefined) ||
        (canonical.publicationTitle as string | undefined),
      journal:
        (harmonized.journal as string | undefined) ??
        (canonical.journal as string | undefined),
      publisher:
        (harmonized.publisher as string | undefined) ??
        (canonical.publisher as string | undefined),
      volume:
        (harmonized.volume as string | undefined) ??
        (canonical.volume as string | undefined),
      issue:
        (harmonized.issue as string | undefined) ??
        (canonical.issue as string | undefined),
      pages:
        (harmonized.pages as string | undefined) ??
        (canonical.pages as string | undefined),
      issn:
        (harmonized.issn as string | undefined) ??
        (canonical.issn as string | undefined),
      isbn:
        (harmonized.isbn as string | undefined) ??
        (canonical.isbn as string | undefined),
      language: canonical.language as string | undefined,
      rights:
        (harmonized.rights as string | undefined) ??
        (canonical.rights as string | undefined),
      license: harmonized.license ?? canonical.license,
      extra: canonical.extra as string | undefined,
      extraFields:
        Object.keys(syncedExtraFields).length > 0
          ? syncedExtraFields
          : undefined,
      citationKey:
        (harmonized.citationKey as string | undefined) ??
        (canonical.citationKey as string | undefined),
      libraryCatalog: canonical.libraryCatalog,
      callNumber: canonical.callNumber as string | undefined,
      archive: canonical.archive as string | undefined,
      collectionId: undefined,
      labels: canonical.keywords || canonical.tags || [],
      keywords: canonical.keywords || canonical.tags || [],
      uploadedById: targetUserId,
    };

    let createdItem: ItemDetail;
    if (this.txService?.executeInTransaction) {
      createdItem = await this.txService.executeInTransaction(
        async (tx: Prisma.TransactionClient, _helpers: unknown) => {
          const claimedCount = await this.repo.claimCapturePreview(
            tokenHash,
            tx,
          );

          if (!claimedCount || claimedCount === 0) {
            throw new ConflictException(
              'Capture preview has already been confirmed or claimed',
            );
          }

          if (this.catalogGateway?.createItem) {
            return this.catalogGateway.createItem(
              targetUserId,
              itemData,
              { source: 'url', projectId },
              projectId,
            );
          }

          throw new Error(
            'CatalogGateway is required to confirm captured URL item',
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

      if (this.catalogGateway?.createItem) {
        createdItem = await this.catalogGateway.createItem(
          targetUserId,
          itemData,
          { source: 'url', projectId },
          projectId,
        );
      } else {
        throw new Error(
          'CatalogGateway is required to confirm captured URL item',
        );
      }
    }

    if (
      createdItem?.id &&
      itemData.url &&
      this.extractionGateway?.captureWebSnapshot
    ) {
      void this.extractionGateway
        .captureWebSnapshot(itemData.url, createdItem.id, targetUserId)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Background snapshot capture failed for confirmed URL item ${createdItem.id}: ${msg}`,
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
