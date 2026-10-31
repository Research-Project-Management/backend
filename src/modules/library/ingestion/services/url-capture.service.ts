import { DuplicateDetectorService } from './duplicate-detector.service';
import { RetractionScannerProvider } from '../providers/retraction-scanner.provider';
import {
  Injectable,
  Logger,
  Optional,
  Inject,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { Prisma } from '@prisma/client';
import { SubsystemUnavailableException } from '@/modules/library/core/errors/domain.exception';
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
  CreateItemData,
  harmonizeZoteroFields,
  mergeCanonicalCreators,
  SsrfGuardService,
  ItemProvenancePolicy,
  isPlaceholderItemTitle,
  UNIT_OF_WORK,
  IUnitOfWork,
} from '@/modules/library/core';
import { calculateTitleSimilarity } from '@/modules/library/ingestion/domain/deduplication.domain';
import { buildEnrichmentPatch } from '@/modules/library/ingestion/domain/enrichment-patch.builder';
import { ParsedAcademicFeed } from '@/modules/library/ingestion/parsers/rss-atom-feed.parser';
import { createHash, randomUUID } from 'crypto';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import { FeedRetrievalService } from './feed-retrieval.service';
import { FeedsRepository } from '@/modules/library/ingestion/repositories/feeds.repository';

@Injectable()
export class UrlCaptureService {
  private readonly logger = new Logger(UrlCaptureService.name);

  constructor(
    private readonly repo: IngestionRepository,
    @Optional() private readonly urlCaptureProvider?: UrlCaptureProvider,
    @Optional() @Inject(UNIT_OF_WORK) private readonly txService?: IUnitOfWork,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
    @Optional()
    @Inject(EXTRACTION_FACADE)
    private readonly extractionGateway?: IExtractionFacade,
    @Optional() private readonly ssrfGuard?: SsrfGuardService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional() private readonly feedsRepo?: FeedsRepository,
    @Optional() feedRetrieval?: FeedRetrievalService,
    @Optional() private readonly duplicateDetector?: DuplicateDetectorService,
    @Optional() private readonly retractionScanner?: RetractionScannerProvider,
  ) {
    this.feedRetrieval =
      feedRetrieval ?? new FeedRetrievalService(this.feedsRepo, ssrfGuard);
  }

  private readonly feedRetrieval: FeedRetrievalService;

  /**
   * Resilient Academic RSS / Atom Feed Fetcher.
   * Delegates to FeedRetrievalService.
   */
  async fetchAcademicFeed(
    feedUrl: string,
    forceRefresh = false,
    userId?: string,
  ): Promise<ParsedAcademicFeed> {
    return this.feedRetrieval.fetchAcademicFeed(feedUrl, forceRefresh, userId);
  }

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
  ): Promise<CapturedItemMetadata> {
    const scopeId =
      typeof contextOrScopeId === 'string'
        ? contextOrScopeId
        : contextOrScopeId.scopeId || contextOrScopeId.projectId || '';
    const userId =
      typeof contextOrScopeId === 'object'
        ? contextOrScopeId.userId
        : undefined;
    const effectiveScopeId = scopeId || userId || 'unassigned';

    if (!this.urlCaptureProvider?.captureFromUrl) {
      throw new SubsystemUnavailableException(
        'UrlCaptureProvider is unavailable',
        { provider: 'UrlCaptureProvider' },
      );
    }

    const result = await this.urlCaptureProvider.captureFromUrl(url, {
      scopeId: effectiveScopeId,
      userId,
    });

    const { previewToken, ...metaWithoutToken } = result;
    const tokenHash = previewToken
      ? createHash('sha256').update(previewToken).digest('hex')
      : createHash('sha256')
          .update(`${userId || effectiveScopeId}:${url}:${randomUUID()}`)
          .digest('hex');
    const metadataDigest = this.urlCaptureProvider.calculateMetadataDigest
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
    scopeId: string | undefined,
    userId: string,
    dto: ConfirmCapturedUrlDto,
  ): Promise<ItemDetail> {
    const targetUserId = userId || scopeId || '';
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

    if (preview.userId && preview.userId !== targetUserId) {
      throw new ForbiddenException('Access denied to capture preview');
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
        {
          scopeId: scopeId || targetUserId || 'unassigned',
          userId: targetUserId,
        },
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

    const claimedCount = await this.repo.claimCapturePreview(tokenHash);

    if (!claimedCount || claimedCount === 0) {
      throw new ConflictException(
        'Capture preview has already been confirmed or claimed',
      );
    }

    try {
      const canonical =
        (preview.canonicalMetadata as Record<string, unknown>) || {};
      const itemType =
        dto.itemType || (canonical.itemType as string | undefined) || 'webpage';

      const hasDtoCreators =
        Array.isArray(dto.creators) && dto.creators.length > 0;
      let authors = hasDtoCreators
        ? undefined
        : (canonical.authors as string[] | undefined);
      const normalizedCreators = mergeCanonicalCreators({
        creators: hasDtoCreators
          ? dto.creators
          : Array.isArray(canonical.creators)
            ? (canonical.creators as unknown[])
            : undefined,
        contributors: hasDtoCreators
          ? undefined
          : Array.isArray(canonical.contributors)
            ? (canonical.contributors as unknown[])
            : undefined,
        authors: hasDtoCreators
          ? undefined
          : Array.isArray(canonical.authors)
            ? (canonical.authors as unknown[])
            : undefined,
        editors: hasDtoCreators
          ? undefined
          : Array.isArray(canonical.editors)
            ? (canonical.editors as unknown[])
            : undefined,
        itemType,
      });

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
          ? { ...(harmonized.extraFields as Record<string, unknown>) }
          : { ...canonicalExtraFields };

      const baselineHarmonized = harmonizeZoteroFields<Record<string, unknown>>(
        {
          ...canonicalExtraFields,
          ...passthroughFields,
          itemType,
          extraFields: canonicalExtraFields,
        },
        { itemType, syncExtraFields: false },
      );

      const userOverriddenRecord: Record<string, unknown> = {};
      for (const dtoField of [
        'title',
        'abstract',
        'doi',
        'year',
        'publicationTitle',
      ] as const) {
        const dtoVal = dto[dtoField];
        const baselineVal =
          baselineHarmonized[dtoField] ??
          canonical[dtoField] ??
          canonicalExtraFields[dtoField];
        if (
          dtoVal !== undefined &&
          dtoVal !== null &&
          dtoVal !== '' &&
          String(dtoVal).trim() !== String(baselineVal ?? '').trim()
        ) {
          userOverriddenRecord[dtoField] = dtoVal;
        }
      }
      if (Object.keys(userOverriddenRecord).length > 0) {
        ItemProvenancePolicy.applyManualEditLocks({
          existingMeta: syncedExtraFields,
          dataRecord: userOverriddenRecord,
          updatedMetadata: syncedExtraFields,
        });
      }

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
        contributors: (hasDtoCreators
          ? normalizedCreators
          : canonical.contributors ||
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
        license:
          (harmonized.license as string | undefined) ??
          (canonical.license as string | undefined),
        extra: canonical.extra as string | undefined,
        extraFields:
          Object.keys(syncedExtraFields).length > 0
            ? syncedExtraFields
            : undefined,
        citationKey:
          (harmonized.citationKey as string | undefined) ??
          (canonical.citationKey as string | undefined),
        libraryCatalog: canonical.libraryCatalog as string | undefined,
        callNumber: canonical.callNumber as string | undefined,
        archive: canonical.archive as string | undefined,
        collectionId:
          dto.collectionId ||
          (canonical.collectionId as string | undefined) ||
          undefined,
        tags:
          Array.isArray(dto.tags) && dto.tags.length > 0
            ? dto.tags
            : Array.isArray(canonical.tags)
              ? (canonical.tags as string[])
              : Array.isArray(canonical.keywords)
                ? (canonical.keywords as string[])
                : [],
        labels:
          Array.isArray(dto.tags) && dto.tags.length > 0
            ? dto.tags
            : Array.isArray(canonical.keywords)
              ? (canonical.keywords as string[])
              : Array.isArray(canonical.tags)
                ? (canonical.tags as string[])
                : [],
        keywords:
          Array.isArray(dto.tags) && dto.tags.length > 0
            ? dto.tags
            : Array.isArray(canonical.keywords)
              ? (canonical.keywords as string[])
              : Array.isArray(canonical.tags)
                ? (canonical.tags as string[])
                : [],
        uploadedById: targetUserId,
      };

      if (this.duplicateDetector?.checkDuplicates) {
        try {
          const match = await this.duplicateDetector.checkDuplicates(
            { userId: targetUserId, projectId },
            {
              doi: itemData.doi,
              title: itemData.title,
              arxivId: (itemData as Record<string, unknown>).arxivId as string,
              pmid: (itemData as Record<string, unknown>).pmid as string,
              isbn: (itemData as Record<string, unknown>).isbn as string,
            },
          );
          if (match?.exactMatch) {
            const existingTitle = match.exactMatch.title?.trim();
            const proposedTitle = itemData.title?.trim();
            const isGeneric = (t?: string) =>
              !t || t.length <= 5 || isPlaceholderItemTitle(t);
            const titlesConflict =
              Boolean(proposedTitle) &&
              Boolean(existingTitle) &&
              !isGeneric(proposedTitle) &&
              !isGeneric(existingTitle) &&
              calculateTitleSimilarity(
                proposedTitle ?? '',
                existingTitle ?? '',
              ) < 0.5;

            if (!titlesConflict) {
              this.logger.warn(
                `URL capture matched existing item ${match.exactMatch.id} (${match.exactMatch.matchReason})`,
              );
              if (
                this.catalogGateway?.getItem &&
                this.catalogGateway?.updateItem
              ) {
                try {
                  const existing = await this.catalogGateway.getItem(
                    targetUserId,
                    match.exactMatch.id,
                    projectId,
                  );
                  const patch = buildEnrichmentPatch(existing, itemData);
                  if (Object.keys(patch).length > 0) {
                    await this.catalogGateway.updateItem(
                      targetUserId,
                      match.exactMatch.id,
                      patch,
                      { projectId },
                    );
                  }
                } catch {
                  // Non-critical additive enrichment on duplicate URL capture
                }
              }
              if (
                !dto.userOverride &&
                !(dto as unknown as Record<string, unknown>).allowDuplicate
              ) {
                throw new ConflictException({
                  message:
                    'An item with this DOI/identifier already exists in your library',
                  existingItemId: match.exactMatch.id,
                  matchReason: match.exactMatch.matchReason,
                });
              }
            }
          }
        } catch (err: unknown) {
          if (err instanceof ConflictException) throw err;
          this.logger.warn(
            `Duplicate check skipped during confirmCapturedUrl: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (this.retractionScanner?.checkRetraction) {
        try {
          const retraction = await this.retractionScanner.checkRetraction(
            itemData.doi,
            (itemData as Record<string, unknown>).pmid as string,
          );
          if (retraction?.status === 'retracted') {
            itemData.isRetracted = true;
            itemData.retractionNature =
              retraction.details?.nature || 'retraction';
            itemData.retractionDetails = retraction.details;
            itemData.retractionCheckedAt = new Date();
          } else if (retraction?.status === 'clean') {
            itemData.isRetracted = false;
            itemData.retractionCheckedAt = new Date();
          }
        } catch (err: unknown) {
          this.logger.warn(
            `Retraction check skipped during confirmCapturedUrl: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (!this.catalogGateway?.createItem) {
        throw new SubsystemUnavailableException(
          'CatalogGateway is required to confirm captured URL item',
          { gateway: 'CatalogGateway' },
        );
      }

      const createdItem = await this.catalogGateway.createItem(
        targetUserId,
        itemData,
        { source: 'url', projectId },
        projectId,
      );

      if (
        createdItem?.id &&
        itemData.url &&
        this.extractionGateway?.captureWebSnapshot
      ) {
        await this.extractionGateway
          .captureWebSnapshot(
            itemData.url,
            createdItem.id,
            targetUserId,
            projectId,
          )
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Background snapshot capture failed for confirmed URL item ${createdItem.id}: ${msg}`,
            );
          });
      }

      return createdItem;
    } catch (err) {
      await this.repo.releaseCapturePreview(tokenHash).catch(() => {});
      throw err;
    }
  }

  /**
   * Cleans up expired and consumed preview records.
   */
  async cleanupExpiredPreviews(retentionDays = 7): Promise<number> {
    const cutoff =
      retentionDays <= 0
        ? new Date()
        : new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    if (this.repo.findExpiredCapturePreviews) {
      let expiredIds: string[] = [];
      try {
        const expiredList = await this.repo.findExpiredCapturePreviews(cutoff);
        if (!Array.isArray(expiredList) || expiredList.length === 0) {
          return 0;
        }
        expiredIds = expiredList
          .map((p) => p?.id)
          .filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          );

        if (this.storagePort?.deleteFile) {
          for (const p of expiredList) {
            if (p.claimedAt) continue;
            const meta =
              p.canonicalMetadata &&
              typeof p.canonicalMetadata === 'object' &&
              !Array.isArray(p.canonicalMetadata)
                ? (p.canonicalMetadata as Record<string, unknown>)
                : {};
            const extra =
              meta.extraFields &&
              typeof meta.extraFields === 'object' &&
              !Array.isArray(meta.extraFields)
                ? (meta.extraFields as Record<string, unknown>)
                : {};
            const scraped =
              meta.scrapedData &&
              typeof meta.scrapedData === 'object' &&
              !Array.isArray(meta.scrapedData)
                ? (meta.scrapedData as Record<string, unknown>)
                : {};
            const pdfFileId =
              (typeof scraped.pdfFileId === 'string' && scraped.pdfFileId) ||
              (typeof meta.pdfFileId === 'string' && meta.pdfFileId) ||
              (typeof extra.pdfFileId === 'string' && extra.pdfFileId) ||
              (typeof extra.fileId === 'string' && extra.fileId) ||
              (typeof meta.fileId === 'string' && meta.fileId);
            if (pdfFileId) {
              await this.storagePort
                .deleteFile(pdfFileId)
                .catch(() => undefined);
            }
          }
        }
      } catch {
        // Ignore blob cleanup errors during preview sweep
      }
      if (expiredIds.length > 0) {
        return this.repo.deleteExpiredCapturePreviews(cutoff, expiredIds);
      }
    }
    return this.repo.deleteExpiredCapturePreviews(cutoff);
  }
}
