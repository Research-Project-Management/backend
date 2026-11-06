import {
  Injectable,
  Logger,
  Optional,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { IngestionSubmissionEnvelope } from '@/modules/library/ingestion/types/ingestion.types';
import { DuplicateMatchResult } from '@/modules/library/ingestion/types/metadata.types';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import {
  IdentifyStage,
  applyUserOverridesToCandidate,
} from '@/modules/library/ingestion/stages/identify.stage';
import { ResolveStage } from '@/modules/library/ingestion/stages/resolve.stage';
import {
  CommitStage,
  isPreExistingMatchItem,
} from '@/modules/library/ingestion/stages/commit.stage';
import { NormalizationPolicy } from '@/modules/library/ingestion/domain/normalization.policy';
import { RetractionScannerProvider } from '@/modules/library/ingestion/providers/base-metadata.provider';
import {
  LibraryItemSource,
  CATALOG_FACADE,
  ICatalogFacade,
  EXTRACTION_FACADE,
  IExtractionFacade,
  MetadataCoalescePolicy,
} from '@/modules/library/core';
import { IngestionStatus } from '@prisma/client';
import { IngestionRunAggregate } from '@/modules/library/ingestion/domain/ingestion-run.domain';
import { IngestionSagaOrchestrator } from './ingestion-saga.orchestrator';
import {
  sanitizeOverrides,
  mapPayloadToSource,
} from '@/modules/library/ingestion/domain/enrichment-patch.mapper';
import {
  isNonRetryableIngestionError,
  isRetryableIngestionError,
} from '@/modules/library/ingestion/types/metadata.types';
import { PipelineSideEffectsService } from './pipeline-side-effects.service';
import { PipelineBatchExecutor } from './pipeline-batch.executor';
import { UrlCaptureService } from './url-capture.service';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';

import {
  resolveScope,
  getSubmissionPayloadLabel,
  getSubmissionPayloadSize,
  markRunStatusTransitioned,
  createSingleItemExecutionLog,
} from './ingestion-saga.orchestrator';

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);
  private readonly orchestrator: IngestionSagaOrchestrator;
  private readonly sideEffects: PipelineSideEffectsService;
  private readonly batchExecutor: PipelineBatchExecutor;
  private readonly normalizer: NormalizationPolicy;
  private lastGcRunAt = 0;
  private static readonly GC_THROTTLE_INTERVAL_MS = 15 * 60_000;

  constructor(
    private readonly repo: IngestionRepository,
    private readonly identify: IdentifyStage,
    private readonly resolve: ResolveStage,
    private readonly commit: CommitStage,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
    @Optional()
    @Inject(EXTRACTION_FACADE)
    private readonly extractionGateway?: IExtractionFacade,
    @Optional()
    sagaOrchestrator?: IngestionSagaOrchestrator,
    @Optional()
    private readonly retractionScanner?: RetractionScannerProvider,
    @Optional()
    batchExecutor?: PipelineBatchExecutor,
    @Optional()
    sideEffects?: PipelineSideEffectsService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    private readonly urlCapture?: UrlCaptureService,
    @Optional()
    normalizer?: NormalizationPolicy,
  ) {
    this.normalizer = normalizer ?? new NormalizationPolicy();
    this.orchestrator = sagaOrchestrator ?? new IngestionSagaOrchestrator(repo);
    this.sideEffects =
      sideEffects ??
      new PipelineSideEffectsService(
        repo,
        catalogGateway,
        extractionGateway,
        retractionScanner,
      );
    this.batchExecutor =
      batchExecutor ??
      new PipelineBatchExecutor(
        repo,
        resolve,
        commit,
        this.sideEffects,
        catalogGateway,
      );
  }

  /**
   * Determines whether an ingestion error is permanently non-retryable
   * (e.g., 4xx validation error, empty/malformed bibliographic metadata).
   */
  isNonRetryableError(err: unknown): boolean {
    return isNonRetryableIngestionError(err);
  }

  /**
   * Determines whether an ingestion error is transient/retryable (e.g., network
   * timeout, rate limit, 5xx upstream failure, transient DB connection drop).
   */
  isRetryableError(err: unknown): boolean {
    if (this.isNonRetryableError(err)) return false;
    return isRetryableIngestionError(err);
  }

  /**
   * Executes the multi-stage ingestion pipeline.
   */
  async executePipeline(
    runId: string,
    scopeId: string,
    envelope: IngestionSubmissionEnvelope,
    options?: { isFinalAttempt?: boolean },
  ): Promise<void> {
    const explicitFinalAttempt =
      options?.isFinalAttempt ?? envelope?.isFinalAttempt;
    let succeeded = false;
    let preserveBlobForRetry = false;
    try {
      await this.executePipelineStages(runId, scopeId, envelope, {
        isFinalAttempt: explicitFinalAttempt ?? true,
      });
      succeeded = true;
    } catch (err: unknown) {
      const nonRetryable = this.isNonRetryableError(err);
      const retryable = !nonRetryable && this.isRetryableError(err);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (retryable && explicitFinalAttempt !== true) {
        preserveBlobForRetry = true;
      }
      if (explicitFinalAttempt === false && nonRetryable) {
        await this.repo
          .updateRunStatus(scopeId, runId, IngestionStatus.FAILED_FINAL, {
            lastError: errMsg,
            completedAt: new Date(),
          })
          .then(() => markRunStatusTransitioned(runId))
          .catch((e: unknown) =>
            this.logger.warn(
              `Failed to update run status for run ${runId}: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
      } else if (explicitFinalAttempt === undefined && retryable) {
        await this.repo
          .updateRunStatus(scopeId, runId, IngestionStatus.FAILED_RETRYABLE, {
            lastError: errMsg,
          })
          .then(() => markRunStatusTransitioned(runId))
          .catch((e: unknown) =>
            this.logger.warn(
              `Failed to update run status for run ${runId}: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
      }
      throw err;
    } finally {
      if (!preserveBlobForRetry) {
        await this.cleanupOffloadedPayload(envelope);
      }
      if (
        Date.now() - this.lastGcRunAt >
        PipelineService.GC_THROTTLE_INTERVAL_MS
      ) {
        this.lastGcRunAt = Date.now();
        void this.runMaintenanceGc({ retentionDays: 7 }).catch(() => undefined);
      }
    }
  }

  private async cleanupOffloadedPayload(
    envelope?: IngestionSubmissionEnvelope,
  ): Promise<boolean> {
    const payload = envelope?.payload;
    const claimCheckFileId =
      payload?.kind === 'RECORD' &&
      payload.isOffloaded === true &&
      typeof payload.fileId === 'string'
        ? payload.fileId
        : undefined;

    if (claimCheckFileId && this.storagePort?.deleteFile) {
      try {
        await this.storagePort.deleteFile(claimCheckFileId);
        return true;
      } catch (err: unknown) {
        this.logger.warn(
          `[PipelineGC] Failed to delete offloaded claim-check blob ${claimCheckFileId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return false;
  }

  async runMaintenanceGc(options?: {
    envelope?: IngestionSubmissionEnvelope;
    retentionDays?: number;
  }): Promise<{
    deletedClaimCheckBlob: boolean;
    expiredPreviewsDeleted: number;
    purgedRuns: number;
  }> {
    const retentionDays = options?.retentionDays ?? 7;
    const [deletedClaimCheckBlob, expiredPreviewsDeleted, purgedRuns] =
      await Promise.all([
        options?.envelope
          ? this.cleanupOffloadedPayload(options.envelope)
          : Promise.resolve(false),
        this.urlCapture?.cleanupExpiredPreviews
          ? this.urlCapture.cleanupExpiredPreviews(retentionDays).catch((err: unknown) => {
              this.logger.warn(`[PipelineGC] Failed to cleanup expired previews: ${err instanceof Error ? err.message : String(err)}`);
              return 0;
            })
          : Promise.resolve(0),
        typeof this.repo?.purgeOldRuns === 'function'
          ? this.repo.purgeOldRuns(retentionDays).catch((err: unknown) => {
              this.logger.warn(`[PipelineGC] Failed to purge old runs: ${err instanceof Error ? err.message : String(err)}`);
              return 0;
            })
          : Promise.resolve(0),
      ]);

    return { deletedClaimCheckBlob, expiredPreviewsDeleted, purgedRuns };
  }

  private async executePipelineStages(
    runId: string,
    scopeId: string,
    envelope: IngestionSubmissionEnvelope,
    options?: { isFinalAttempt?: boolean },
  ): Promise<void> {
    const resolvedScope = resolveScope(scopeId, envelope);

    const existingRun = await this.repo
      .findRunById(scopeId, runId)
      .catch(() => null);

    const existingInputParams = existingRun?.inputParams as
      Record<string, unknown> | null | undefined;
    const aggregate = existingRun
      ? IngestionRunAggregate.reconstitute({
          id: existingRun.id,
          userId: existingRun.userId,
          projectId: existingRun.projectId,
          sourceType:
            (typeof existingInputParams?.sourceType === 'string'
              ? existingInputParams.sourceType
              : undefined) || envelope.payload.kind,
          status: 'RUNNING',
          totalItems:
            typeof existingInputParams?.totalItems === 'number'
              ? existingInputParams.totalItems
              : 1,
          processedItems: 0,
          failedItems: 0,
          startedAt: existingRun.startedAt,
        })
      : IngestionRunAggregate.create({
          id: runId,
          userId: resolvedScope.userId,
          projectId: resolvedScope.projectId,
          sourceType: envelope.payload.kind,
          totalItems: 1,
        });

    const session = this.orchestrator.createSession(runId, scopeId, aggregate, {
      isFinalAttempt: options?.isFinalAttempt,
    });

    // Stage 1: IDENTIFY & NORMALIZE
    const { initialCandidates: normalizedCandidates, sanitizedOverrides } =
      await session.executeStep(
        'IDENTIFY',
        async () => {
          const identifiedCandidates = await this.identify.execute({
            runId,
            payload: envelope.payload,
            scopeId,
            userId: resolvedScope.userId,
            projectId: resolvedScope.projectId,
          });
          const overrides = sanitizeOverrides(envelope.overrides);
          const candidates = identifiedCandidates.map((candidate) =>
            applyUserOverridesToCandidate(
              candidate,
              overrides,
              this.normalizer,
            ),
          );

          if (candidates.length === 0) {
            throw new BadRequestException(
              'No valid bibliographic metadata could be identified from input',
            );
          }

          return {
            initialCandidates: candidates,
            sanitizedOverrides: overrides,
          };
        },
        {
          outputSnapshot: (res) => ({
            candidateCount: res.initialCandidates.length,
          }),
        },
      );

    // =========================================================================
    // Stage 2: RESOLVE (Unified Deduplication, Authoritative Enrich & Canonical Reconcile)
    // =========================================================================
    const uploadedFileIdentifier =
      envelope.payload.kind === 'FILE' ? envelope.payload.fileId : undefined;
    const uploadedFilename =
      envelope.payload.kind === 'FILE'
        ? envelope.payload.filename || 'document.pdf'
        : 'document.pdf';
    const payloadSize = getSubmissionPayloadSize(envelope.payload);

    const resolution = await session.executeStep(
      'RESOLVE',
      async () => {
        const isSingleCandidate =
          normalizedCandidates.length === 1 &&
          envelope.payload.kind !== 'RECORD' &&
          envelope.payload.kind !== 'CONNECTOR';

        // 1. Early Deduplication Check (Fast-path for single item: O(1) in-catalog match)
        let earlyMatch: DuplicateMatchResult = {
          matchType: 'NO_MATCH',
          confidence: 0,
        };
        const rawNormMeta = (normalizedCandidates[0]?.normalizedMetadata || {}) as Record<string, unknown>;
        if (
          isSingleCandidate &&
          normalizedCandidates[0]?.normalizedMetadata &&
          this.resolve.match
        ) {
          earlyMatch = await this.resolve.match({
            scope: resolvedScope,
            proposedItem: normalizedCandidates[0].normalizedMetadata,
          });

          const rawCandExtra = (rawNormMeta.extraFields && typeof rawNormMeta.extraFields === 'object'
            ? rawNormMeta.extraFields
            : {}) as Record<string, unknown>;
          const hasCredibleLocalTitle =
            typeof rawNormMeta.title === 'string' &&
            rawNormMeta.title.trim().length > 5 &&
            !rawCandExtra.isFilenameTitle;
          const deferFileEarlyMatch =
            envelope.payload.kind === 'FILE' && !hasCredibleLocalTitle;

          if (earlyMatch.matchType === 'EXACT' && earlyMatch.targetItemId && !deferFileEarlyMatch) {
            return {
              isDuplicate: true,
              isBatch: false,
              matchResult: earlyMatch,
              proposedItem: normalizedCandidates[0].normalizedMetadata,
            };
          }
        }

        // 2. Authoritative Single-Hit Enrichment (Only for NEW items)
        const enriched = await this.resolve.execute({
          scopeId,
          candidates: normalizedCandidates,
        });

        // Resilient URL Scrape Fallback
        if (
          envelope.payload.kind === 'URL' &&
          !enriched.some((c) => c.sourceKind === 'PROVIDER') &&
          (!normalizedCandidates[0]?.normalizedMetadata?.title ||
            normalizedCandidates[0]?.normalizedMetadata?.title ===
              'Untitled Document') &&
          this.identify.resolveUrlFallback
        ) {
          try {
            const scrapedFallback = await this.identify.resolveUrlFallback(
              envelope.payload,
              scopeId,
            );
            if (scrapedFallback) {
              const fallbackCandidate = applyUserOverridesToCandidate(
                scrapedFallback,
                sanitizedOverrides,
                this.normalizer,
              );
              enriched.push(fallbackCandidate);
              // If HTML scrape discovered a new identifier not in the original URL, enrich it through ResolveStage
              const fbMeta = (fallbackCandidate.normalizedMetadata || {}) as Record<string, unknown>;
              const fbExtra = (fbMeta.extraFields || {}) as Record<string, unknown>;
              const foundNewId = ['doi', 'arxivId', 'pmid', 'isbn'].some(
                (k) => Boolean(fbMeta[k] && fbMeta[k] !== rawNormMeta[k]),
              );
              if (foundNewId && !fbExtra.alreadyResolvedByMirror) {
                const fbEnriched = await this.resolve.execute({
                  scopeId,
                  candidates: [fallbackCandidate],
                });
                for (const ec of fbEnriched) {
                  if (ec.sourceKind === 'PROVIDER') enriched.push(ec);
                }
              }
            }
          } catch {
            // Non-critical fallback scrape
          }
        }

        // 3. Multi-Record Batch Ingestion Handling
        if (
          (envelope.payload.kind === 'RECORD' ||
            envelope.payload.kind === 'CONNECTOR') &&
          normalizedCandidates.length > 1
        ) {
          return {
            isDuplicate: false,
            isBatch: true,
            enrichedCandidates: enriched,
          };
        }

        // 4. Canonical Coalesce & Verification (Produces field provenance & proposed item)
        const decision =
          typeof this.resolve.coalesceAndVerify === 'function'
            ? await this.resolve.coalesceAndVerify(enriched)
            : MetadataCoalescePolicy.coalesceCandidates(enriched);

        // 5. Secondary Match check if identifier was discovered or stripped during enrich/reconcile
        const propRec = (decision.proposedItem || {}) as Record<string, unknown>;
        const propExtra = (propRec.extraFields && typeof propRec.extraFields === 'object'
          ? propRec.extraFields
          : {}) as Record<string, unknown>;
        const citationTrapTriggered = Boolean(propExtra.rejectedCitedDoi);
        let finalMatch: DuplicateMatchResult = citationTrapTriggered
          ? { matchType: 'NO_MATCH', confidence: 0 }
          : earlyMatch;
        const discoveredNewId = ['doi', 'arxivId', 'pmid', 'pmcid', 'isbn'].some(
          (k) => Boolean(propRec[k] && !rawNormMeta[k]),
        );
        if (
          finalMatch.matchType !== 'EXACT' &&
          (discoveredNewId || citationTrapTriggered) &&
          this.resolve.match
        ) {
          finalMatch = await this.resolve.match({
            scope: resolvedScope,
            proposedItem: decision.proposedItem,
          });
        }

        return {
          isDuplicate: finalMatch.matchType === 'EXACT',
          isBatch: false,
          matchResult: finalMatch,
          proposedItem: decision.proposedItem,
          decision,
          enrichedCandidates: enriched,
        };
      },
      {
        outputSnapshot: (res) => ({
          isDuplicate: res.isDuplicate,
          isBatch: res.isBatch,
          matchType: res.matchResult?.matchType,
          targetItemId: res.matchResult?.targetItemId,
        }),
      },
    );

    // Multi-Record Batch Processing
    if (resolution.isBatch && resolution.enrichedCandidates) {
      await this.batchExecutor.processRecordBatch({
        scopeId,
        runId,
        envelope,
        resolvedScope,
        aggregate,
        session,
        normalizedCandidates,
        enrichedCandidates: resolution.enrichedCandidates,
      });
      return;
    }

    // Upstream site blocked by WAF / Cloudflare Turnstile
    if (
      resolution.decision?.proposedItem?.extraFields?.ingestionStatus ===
      'BLOCKED'
    ) {
      const blockedSourceLabel =
        getSubmissionPayloadLabel(envelope.payload) ||
        resolution.decision.proposedItem?.url ||
        'Document';
      await this.sideEffects.handleBlockedSubmission({
        scopeId,
        runId,
        envelope,
        decision: resolution.decision,
        aggregate,
        sourceLabel: blockedSourceLabel,
      });
      return;
    }

    const finalFileIdentifier =
      uploadedFileIdentifier || resolution.proposedItem?.fileId;
    const finalFilename =
      uploadedFilename !== 'document.pdf'
        ? uploadedFilename
        : resolution.proposedItem?.filename || 'document.pdf';

    const matchResult = resolution.matchResult;

    // EXACT match → Fast-track additive metadata enrichment & file attachment of existing item
    if (resolution.isDuplicate && matchResult?.targetItemId) {
      const targetItemId = matchResult.targetItemId;
      const candidateItem = resolution.proposedItem || {};

      await session.executeStep(
        'ENRICH_EXISTING',
        async () => {
          const { existingRecord: existingRec, patchedFields } =
            await this.sideEffects.enrichExistingMatchedItem({
              userId: resolvedScope.userId,
              projectId: resolvedScope.projectId,
              targetItemId,
              candidateItem,
            });

          if (this.catalogGateway?.getItem) {
            await this.sideEffects.runPostPersistSideEffects(
              targetItemId,
              {
                userId: resolvedScope.userId,
                projectId: resolvedScope.projectId,
                envelope,
              },
              candidateItem,
              {
                fileId: finalFileIdentifier,
                filename: finalFilename,
                payloadSize,
                existingRecord: existingRec,
                assignCollections: true,
              },
            );
          }

          const exactSourceLabel =
            getSubmissionPayloadLabel(envelope.payload) ||
            finalFilename ||
            candidateItem.title ||
            'Document';

          await this.repo.updateRunStatus(
            scopeId,
            runId,
            IngestionStatus.COMPLETED,
            {
              itemId: matchResult.targetItemId,
              completedAt: new Date(),
              executionLog: createSingleItemExecutionLog({
                sourceLabel: exactSourceLabel,
                itemTitle: candidateItem.title || 'Document',
                itemId: matchResult.targetItemId,
                status: 'DUPLICATE',
              }),
            },
          );

          aggregate.recordProgress(1, 0);
          aggregate.complete();

          return {
            itemId: matchResult.targetItemId,
            patchedFields,
            patchCount: patchedFields.length,
          };
        },
        {
          outputSnapshot: (res) => ({
            itemId: res.itemId,
            patchedFields: res.patchedFields,
            patchCount: res.patchCount,
          }),
        },
      );
      return;
    }

    // =========================================================================
    // Stage 3: COMMIT (Create New Item via Saga Transaction)
    // =========================================================================
    const itemToCommit = resolution.proposedItem || {};

    // Retraction Check: Auto-scan against Retraction Watch & Crossref before commit
    await this.sideEffects.scanRetraction(itemToCommit);

    // Stage 3: COMMIT (Create new Item via CommitStage with Saga Compensation)
    const createdItem = await session.executeStep(
      'COMMIT',
      async () =>
        this.commit.execute({
          scopeId: resolvedScope.projectId || resolvedScope.userId,
          item: itemToCommit,
          options: {
            collectionIds: envelope.collectionIds,
            tagIds: envelope.tagIds,
            userId: resolvedScope.userId,
            source: this.mapPayloadToSource(envelope.payload.kind),
            filename: finalFilename,
            skipPreMatch: true,
          },
        }),
      {
        outputSnapshot: (res) => ({ itemId: res?.id }),
        compensate: async (item) => {
          const wasPreExisting =
            isPreExistingMatchItem(item) ||
            matchResult?.matchType === 'EXACT' ||
            Boolean(
              matchResult?.targetItemId &&
              item?.id === matchResult.targetItemId,
            );
          if (item?.id && !wasPreExisting && this.catalogGateway?.deleteItem) {
            this.logger.warn(
              `[SAGA_COMPENSATION] Rolling back committed item ${item.id} for run ${runId}`,
            );
            await this.catalogGateway.deleteItem(
              resolvedScope.userId,
              item.id,
              resolvedScope.projectId,
            );
          }
        },
      },
    );

    try {
      // PROBABLE fuzzy match → Non-blocking duplicate suspect review record (after COMMIT succeeds)
      if (matchResult?.matchType === 'PROBABLE' && matchResult.targetItemId) {
        await this.sideEffects.recordProbableMatchReviewCase({
          scope: resolvedScope,
          runId,
          matchResult,
          proposedMetadata: itemToCommit,
          createdItemId: createdItem?.id,
        });
      }

      if (createdItem?.id) {
        const wasPreExistingMatch = isPreExistingMatchItem(createdItem);
        await this.sideEffects.runPostPersistSideEffects(
          createdItem.id,
          {
            userId: resolvedScope.userId,
            projectId: resolvedScope.projectId,
            envelope,
          },
          itemToCommit || {},
          {
            fileId: finalFileIdentifier,
            filename: finalFilename,
            payloadSize,
            existingRecord: createdItem,
            assignCollections:
              wasPreExistingMatch && !this.catalogGateway?.assignItemsToCollection,
            skipNotes: wasPreExistingMatch,
          },
        );
      }

      const commitSourceLabel =
        getSubmissionPayloadLabel(envelope.payload) ||
        itemToCommit?.filename ||
        createdItem?.title ||
        'Document';

      await this.repo.updateRunStatus(
        scopeId,
        runId,
        IngestionStatus.COMPLETED,
        {
          itemId: createdItem?.id,
          completedAt: new Date(),
          executionLog: createSingleItemExecutionLog({
            sourceLabel: commitSourceLabel,
            itemTitle: createdItem?.title || 'Document',
            itemId: createdItem?.id,
            status: 'SUCCEEDED',
          }),
        },
      );

      aggregate.recordProgress(1, 0);
      aggregate.complete();
    } catch (finalErr: unknown) {
      const errMsg =
        finalErr instanceof Error ? finalErr.message : String(finalErr);
      await session.rollback('COMMIT', errMsg);
      throw finalErr;
    }
  }

  private mapPayloadToSource(kind: string): LibraryItemSource {
    return mapPayloadToSource(kind);
  }
}
