import { DuplicateDetectorService } from './duplicate-detector.service';
import { RetractionScannerProvider } from '../providers/base-metadata.provider';
import { PipelineSideEffectsService } from './pipeline-side-effects.service';
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
import { ConfirmCapturedUrlDto } from '@/modules/library/ingestion/dto/ingestion.dto';
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
import { toItemData } from '@/modules/library/ingestion/stages/commit.stage';
import { ItemMetadata } from '@/modules/library/ingestion/types/metadata.types';
import { ParsedFeed } from '@/modules/library/ingestion/parsers/rss-atom-feed.parser';
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
    @Optional() sideEffects?: PipelineSideEffectsService,
  ) {
    this.feedRetrieval =
      feedRetrieval ?? new FeedRetrievalService(this.feedsRepo, ssrfGuard);
    this.sideEffects =
      sideEffects ??
      new PipelineSideEffectsService(
        this.repo,
        this.catalogGateway,
        this.extractionGateway,
        this.retractionScanner,
      );
  }

  private readonly feedRetrieval: FeedRetrievalService;
  private readonly sideEffects: PipelineSideEffectsService;

  /**
   * Resilient Academic RSS / Atom Feed Fetcher.
   * Delegates to FeedRetrievalService.
   */
  async fetchAcademicFeed(
    feedUrl: string,
    forceRefresh = false,
    userId?: string,
  ): Promise<ParsedFeed> {
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
    const projectId =
      typeof contextOrScopeId === 'object'
        ? contextOrScopeId.projectId ||
          (contextOrScopeId.scopeId &&
          contextOrScopeId.scopeId !== contextOrScopeId.userId
            ? contextOrScopeId.scopeId
            : undefined)
        : scopeId && scopeId !== userId
          ? scopeId
          : undefined;
    const effectiveScopeId = projectId || scopeId || userId || 'unassigned';

    if (!this.urlCaptureProvider?.captureFromUrl) {
      throw new SubsystemUnavailableException(
        'UrlCaptureProvider is unavailable',
        { provider: 'UrlCaptureProvider' },
      );
    }

    const result = await this.urlCaptureProvider.captureFromUrl(url, {
      scopeId: effectiveScopeId,
      projectId,
      userId,
    });

    const effectiveToken = result.previewToken || randomUUID();
    const { previewToken: _discard, ...metaWithoutToken } = result;
    const tokenHash = createHash('sha256').update(effectiveToken).digest('hex');
    const metadataDigest = this.urlCaptureProvider.calculateMetadataDigest
      ? this.urlCaptureProvider.calculateMetadataDigest(metaWithoutToken)
      : '';

    const boundCanonicalMetadata = {
      ...metaWithoutToken,
      userId: userId || effectiveScopeId,
      ...(projectId ? { projectId } : {}),
      scopeId: effectiveScopeId,
    };

    await this.repo.createCapturePreview({
      sourceUrl: result.url || url,
      userId: userId || effectiveScopeId,
      canonicalMetadata:
        boundCanonicalMetadata as unknown as Prisma.InputJsonValue,
      metadataDigest,
      tokenHash,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    return {
      ...result,
      previewToken: effectiveToken,
    };
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

    const rawCanonical =
      preview.canonicalMetadata &&
      typeof preview.canonicalMetadata === 'object' &&
      !Array.isArray(preview.canonicalMetadata)
        ? (preview.canonicalMetadata as Record<string, unknown>)
        : {};
    const boundUserId =
      typeof rawCanonical.userId === 'string' ? rawCanonical.userId : undefined;
    if (boundUserId && boundUserId !== targetUserId) {
      throw new ForbiddenException('Access denied to capture preview');
    }
    const boundProjectId =
      typeof rawCanonical.projectId === 'string'
        ? rawCanonical.projectId
        : undefined;
    if (boundProjectId && projectId && boundProjectId !== projectId) {
      throw new ForbiddenException(
        'Capture preview project scope does not match confirmation project scope',
      );
    }
    if (boundProjectId && !projectId) {
      throw new ForbiddenException(
        'Capture preview is bound to a project scope and cannot be confirmed without matching projectId',
      );
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
      const asArray = (val: unknown): unknown[] | undefined =>
        !hasDtoCreators && Array.isArray(val) ? val : undefined;
      let authors = hasDtoCreators
        ? undefined
        : (canonical.authors as string[] | undefined);
      const normalizedCreators = mergeCanonicalCreators({
        creators: hasDtoCreators ? dto.creators : asArray(canonical.creators),
        contributors: asArray(canonical.contributors),
        authors: asArray(canonical.authors),
        editors: asArray(canonical.editors),
        itemType,
      });

      if (!authors && normalizedCreators && normalizedCreators.length > 0) {
        authors = normalizedCreators.map((c) =>
          c.lastName && c.firstName
            ? `${c.lastName}, ${c.firstName}`
            : c.fullName || c.lastName || c.firstName || 'Unknown',
        );
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
        if (!reservedPreviewKeys.has(k) && v !== undefined && v !== null && v !== '') {
          passthroughFields[k] = v;
        }
      }

      const baselineHarmonized = harmonizeZoteroFields<Record<string, unknown>>(
        { ...canonicalExtraFields, ...passthroughFields, itemType, extraFields: canonicalExtraFields },
        { itemType, syncExtraFields: false },
      );

      const userOverriddenRecord: Record<string, unknown> = {};
      for (const dtoField of ['title', 'abstract', 'doi', 'year', 'publicationTitle'] as const) {
        const dtoVal = dto[dtoField];
        const baselineVal =
          baselineHarmonized[dtoField] ?? canonical[dtoField] ?? canonicalExtraFields[dtoField];
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
          existingMeta: canonicalExtraFields,
          dataRecord: userOverriddenRecord,
          updatedMetadata: canonicalExtraFields,
        });
      }

      const effectiveTags =
        Array.isArray(dto.tags) && dto.tags.length > 0
          ? dto.tags
          : Array.isArray(canonical.tags)
            ? (canonical.tags as string[])
            : Array.isArray(canonical.keywords)
              ? (canonical.keywords as string[])
              : [];
      const effectiveCollectionId =
        dto.collectionId || (canonical.collectionId as string | undefined) || undefined;

      const baseItemData = toItemData(
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
          url: (passthroughFields.url as string | undefined) || preview.sourceUrl,
          itemType,
          authors,
          creators: normalizedCreators,
          tags: effectiveTags,
          keywords: effectiveTags,
          labels: effectiveTags,
          extraFields: canonicalExtraFields,
        } as ItemMetadata,
        {
          userId: targetUserId,
          collectionIds: effectiveCollectionId
            ? [effectiveCollectionId]
            : undefined,
        },
      );

      const itemData: CreateItemData = {
        ...baseItemData,
        title:
          dto.title ||
          (baseItemData.title !== 'Untitled Document'
            ? baseItemData.title
            : undefined) ||
          (canonical.title as string | undefined) ||
          'Untitled',
        authors,
        creators: normalizedCreators,
        contributors: (hasDtoCreators
          ? normalizedCreators
          : canonical.contributors ||
            normalizedCreators) as CreateItemData['contributors'],
        collectionId: effectiveCollectionId,
        extraFields:
          baseItemData.extraFields &&
          Object.keys(baseItemData.extraFields).length > 0
            ? baseItemData.extraFields
            : undefined,
        uploadedById: targetUserId,
      };

      const scrapedPdfFileId = this.extractPreviewPdfFileId(canonical);
      const scrapedPdfFilename =
        (typeof canonicalExtraFields.filename === 'string' &&
          canonicalExtraFields.filename) ||
        (typeof canonical.filename === 'string' && canonical.filename) ||
        undefined;

      await this.sideEffects.scanRetraction(
        itemData as unknown as Record<string, unknown>,
        { localOnly: true },
      );

      const runPostCommitSideEffects = async (
        targetItem: ItemDetail,
        isExistingMatch = false,
      ) => {
        if (!targetItem?.id) return;
        const parentMeta = {
          ...(canonical as Record<string, unknown>),
          ...(itemData as unknown as Record<string, unknown>),
          ...(targetItem as unknown as Record<string, unknown>),
        };
        if (scrapedPdfFileId) {
          await this.sideEffects.attachFile(
            targetUserId,
            projectId,
            targetItem.id,
            scrapedPdfFileId,
            scrapedPdfFilename,
            0,
            parentMeta,
          );
        }
        if (isExistingMatch && effectiveCollectionId) {
          await this.sideEffects.assignItemToCollection(
            targetUserId,
            effectiveCollectionId,
            targetItem.id,
            projectId,
          );
        }
        void this.sideEffects
          .autoCaptureWebAssets({
            userId: targetUserId,
            projectId,
            itemId: targetItem.id,
            payloadKind: 'URL',
            sourceUrl: itemData.url || preview.sourceUrl,
            proposedItem: parentMeta,
            existingFileId: scrapedPdfFileId,
          })
          .catch(() => {});
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
              const allowDuplicate = Boolean(
                (dto as unknown as Record<string, unknown>).allowDuplicate,
              );
              if (!dto.userOverride && !allowDuplicate) {
                throw new ConflictException({
                  message:
                    'An item with this DOI/identifier already exists in your library',
                  existingItemId: match.exactMatch.id,
                  matchReason: match.exactMatch.matchReason,
                });
              }

              if (!allowDuplicate) {
                let enrichedExisting: ItemDetail | undefined;
                if (this.catalogGateway?.getItem) {
                  try {
                    const existing = await this.catalogGateway.getItem(
                      targetUserId,
                      match.exactMatch.id,
                      projectId,
                    );
                    enrichedExisting = existing ?? undefined;
                    if (existing && this.catalogGateway?.updateItem) {
                      const patch = buildEnrichmentPatch(existing, itemData);
                      if (Object.keys(patch).length > 0) {
                        const updated = await this.catalogGateway.updateItem(
                          targetUserId,
                          match.exactMatch.id,
                          patch,
                          { projectId },
                        );
                        enrichedExisting = updated ?? existing;
                      }
                    }
                  } catch {
                    // Non-critical additive enrichment on duplicate URL capture
                  }
                }
                const targetExisting =
                  enrichedExisting ??
                  ({
                    id: match.exactMatch.id,
                    title: match.exactMatch.title || itemData.title,
                  } as ItemDetail);
                await runPostCommitSideEffects(targetExisting, true);
                return targetExisting;
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

      await runPostCommitSideEffects(createdItem, false);

      return createdItem;
    } catch (err) {
      await this.repo.releaseCapturePreview(tokenHash).catch(() => {});
      throw err;
    }
  }

  private extractPreviewPdfFileId(metaInput: unknown): string | undefined {
    if (!metaInput || typeof metaInput !== 'object' || Array.isArray(metaInput))
      return undefined;
    const meta = metaInput as Record<string, unknown>;
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
    for (const v of [
      scraped.pdfFileId,
      meta.pdfFileId,
      extra.pdfFileId,
      extra.fileId,
      meta.fileId,
    ]) {
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  }

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
            const pdfFileId = this.extractPreviewPdfFileId(p.canonicalMetadata);
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
