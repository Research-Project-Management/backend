import {
  Injectable,
  Logger,
  Optional,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { IngestionSubmissionEnvelope } from '@/modules/library/ingestion/types/submission.types';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import {
  IdentifyStage,
  applyUserOverridesToCandidate,
} from '@/modules/library/ingestion/stages/identify.stage';
import { EnrichStage } from '@/modules/library/ingestion/stages/enrich.stage';
import { ReconcileStage } from '@/modules/library/ingestion/stages/reconcile.stage';
import { MatchStage } from '@/modules/library/ingestion/stages/match.stage';
import { CommitStage } from '@/modules/library/ingestion/stages/commit.stage';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { RetractionScannerProvider } from '@/modules/library/ingestion/providers/retraction-scanner.provider';
import {
  LibraryItemSource,
  CATALOG_FACADE,
  ICatalogFacade,
  EXTRACTION_FACADE,
  IExtractionFacade,
} from '@/modules/library/core';
import { IngestionStatus, Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { IngestionRunAggregate } from '@/modules/library/ingestion/domain/ingestion-run.aggregate';
import { IngestionSagaOrchestrator } from './ingestion-saga.orchestrator';
import {
  sanitizeOverrides,
  buildEnrichmentPatch,
  mapPayloadToSource,
} from '@/modules/library/ingestion/domain/enrichment-patch.builder';
import {
  isNonRetryableIngestionError,
  isRetryableIngestionError,
} from '@/modules/library/ingestion/domain/ingestion-error.classifier';
import { PipelineSideEffectsService } from './pipeline-side-effects.service';
import { PipelineBatchExecutor } from './pipeline-batch.executor';
import { UrlCaptureService } from './url-capture.service';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';

function resolveScope(
  scopeId: string,
  envelope: IngestionSubmissionEnvelope,
): { userId: string; projectId?: string } {
  const isProject =
    Boolean(scopeId) &&
    scopeId !== 'user' &&
    scopeId !== 'me' &&
    scopeId !== envelope.userId &&
    isUUID(scopeId);
  const userId = envelope.userId || (scopeId !== 'user' ? scopeId : 'system');
  const projectId = envelope.projectId || (isProject ? scopeId : undefined);
  return { userId, projectId };
}

function getSubmissionPayloadLabel(
  payload: IngestionSubmissionEnvelope['payload'],
): string | undefined {
  if ('filename' in payload && payload.filename) return payload.filename;
  if ('url' in payload && payload.url) return payload.url;
  if ('value' in payload && payload.value) return payload.value;
  return undefined;
}

function getSubmissionPayloadSize(
  payload: IngestionSubmissionEnvelope['payload'],
): number {
  return 'size' in payload && typeof payload.size === 'number' ? payload.size : 0;
}

function markErrStatusTransitioned(err: unknown): void {
  if (err && typeof err === 'object') {
    Object.defineProperty(err, '__runStatusTransitioned', {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }
}

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);
  private readonly orchestrator: IngestionSagaOrchestrator;
  private readonly sideEffects: PipelineSideEffectsService;
  private readonly batchExecutor: PipelineBatchExecutor;
  private readonly normalizer = new NormalizationPolicy();
  private lastGcRunAt = 0;
  private static readonly GC_THROTTLE_INTERVAL_MS = 15 * 60_000;

  constructor(
    private readonly repo: IngestionRepository,
    private readonly identify: IdentifyStage,
    private readonly enrich: EnrichStage,
    private readonly reconcile: ReconcileStage,
    private readonly match: MatchStage,
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
  ) {
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
        reconcile,
        match,
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
    const explicitFinalAttempt = options?.isFinalAttempt ?? envelope?.isFinalAttempt;
    let succeeded = false;
    let caughtError: unknown = null;
    try {
      await this.executePipelineStages(runId, scopeId, envelope, {
        isFinalAttempt: explicitFinalAttempt ?? true,
      });
      succeeded = true;
    } catch (err: unknown) {
      caughtError = err;
      const nonRetryable = this.isNonRetryableError(err);
      const retryable = !nonRetryable && this.isRetryableError(err);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (explicitFinalAttempt === false && nonRetryable) {
        await this.repo.updateRunStatus(scopeId, runId, IngestionStatus.FAILED_FINAL, {
          lastError: errMsg,
          completedAt: new Date(),
        }).catch(() => undefined);
      } else if (explicitFinalAttempt === undefined && retryable) {
        await this.repo.updateRunStatus(scopeId, runId, IngestionStatus.FAILED_RETRYABLE, {
          lastError: errMsg,
        }).catch(() => undefined);
      }
      markErrStatusTransitioned(err);
      throw err;
    } finally {
      const nonRetryable = caughtError ? this.isNonRetryableError(caughtError) : false;
      const retryable = caughtError && !nonRetryable ? this.isRetryableError(caughtError) : false;
      if (succeeded || explicitFinalAttempt === true || nonRetryable || (explicitFinalAttempt === undefined && !retryable)) {
        await this.cleanupOffloadedPayload(envelope);
      }
      if (Date.now() - this.lastGcRunAt > PipelineService.GC_THROTTLE_INTERVAL_MS) {
        this.lastGcRunAt = Date.now();
        void this.runTerminalMaintenanceGc(envelope);
      }
    }
  }

  private async cleanupOffloadedPayload(
    envelope: IngestionSubmissionEnvelope,
  ): Promise<void> {
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[PipelineGC] Failed to delete offloaded claim-check blob ${claimCheckFileId}: ${msg}`,
        );
      }
    }
  }

  private async runTerminalMaintenanceGc(
    _envelope?: IngestionSubmissionEnvelope,
  ): Promise<void> {
    try {
      if (this.urlCapture?.cleanupExpiredPreviews) {
        await this.urlCapture.cleanupExpiredPreviews(7).catch(() => undefined);
      }
      await this.repo.purgeOldRuns(7).catch(() => undefined);
    } catch {
      // Non-critical background GC
    }
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
      | Record<string, unknown>
      | null
      | undefined;
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
    const {
      initialCandidates: normalizedCandidates,
      sanitizedOverrides,
    } = await session.executeStep(
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
          applyUserOverridesToCandidate(candidate, overrides, this.normalizer),
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

    // Stage 2: ENRICH (Crossref, OpenAlex, PubMed, arXiv)
    const enrichedCandidates = await session.executeStep(
      'ENRICH',
      async () => {
        const results = await this.enrich.execute({
          scopeId,
          candidates: normalizedCandidates,
        });

        // Resilient URL Fallback: If a URL had a direct identifier (skipping HTML scrape in IDENTIFY)
        // and external providers failed or returned nothing in ENRICH, fall back to HTML scraping.
        if (
          envelope.payload.kind === 'URL' &&
          !results.some((c) => c.sourceKind === 'PROVIDER') &&
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
              results.push(
                applyUserOverridesToCandidate(
                  scrapedFallback,
                  sanitizedOverrides,
                  this.normalizer,
                ),
              );
            }
          } catch {
            // Non-critical fallback scrape
          }
        }

        return results;
      },
      {
        outputSnapshot: (res) => ({
          candidateCount: res.length,
        }),
      },
    );

    // Multi-Record Ingestion Handling (BibTeX / RIS / Connector batches)
    if (
      (envelope.payload.kind === 'RECORD' ||
        envelope.payload.kind === 'CONNECTOR') &&
      normalizedCandidates.length > 1
    ) {
      await this.batchExecutor.processRecordBatch({
        scopeId,
        runId,
        envelope,
        resolvedScope,
        aggregate,
        session,
        normalizedCandidates,
        enrichedCandidates,
      });
      return;
    }

    // Stage 4: RECONCILE (Field Provenance & Conflict Detection)
    const decision = await session.executeStep(
      'RECONCILE',
      async () => this.reconcile.execute(enrichedCandidates),
      {
        outputSnapshot: (res) => ({
          conflictCount: res.conflicts.length,
          fieldCount: Object.keys(res.selectedFields).length,
        }),
      },
    );

    // Upstream site blocked by WAF / Cloudflare Turnstile
    if (decision.proposedItem?.extraFields?.ingestionStatus === 'BLOCKED') {
      const blockedSourceLabel =
        getSubmissionPayloadLabel(envelope.payload) ||
        decision.proposedItem?.url ||
        'Document';
      await this.sideEffects.handleBlockedSubmission({
        scopeId,
        runId,
        envelope,
        decision,
        aggregate,
        sourceLabel: blockedSourceLabel,
      });
      return;
    }

    // Stage 5: MATCH (Duplicate Detection)
    const matchResult = await session.executeStep(
      'MATCH',
      async () =>
        this.match.execute({
          scope: resolvedScope,
          proposedItem: decision.proposedItem,
        }),
      {
        outputSnapshot: (res) => res as unknown as Prisma.InputJsonValue,
      },
    );

    const uploadedFileIdentifier =
      envelope.payload.kind === 'FILE'
        ? envelope.payload.fileId
        : decision.proposedItem?.fileId;
    const uploadedFilename =
      envelope.payload.kind === 'FILE'
        ? envelope.payload.filename || 'document.pdf'
        : decision.proposedItem?.filename || 'document.pdf';
    const payloadSize = getSubmissionPayloadSize(envelope.payload);

    // EXACT DOI match → Additive metadata enrichment of existing item
    if (matchResult.matchType === 'EXACT' && matchResult.targetItemId) {
      const targetItemId = matchResult.targetItemId;
      await session.executeStep(
        'ENRICH_EXISTING',
        async () => {
          await this.sideEffects.scanRetraction(decision.proposedItem, {
            localOnly: true,
          });
          let patchedFields: string[] = [];
          if (this.catalogGateway) {
            const existing = await this.catalogGateway.getItem(
              resolvedScope.userId,
              targetItemId,
              resolvedScope.projectId,
            );
            const existingRec = existing as
              Record<string, unknown> | null | undefined;

            const enrichPatch = buildEnrichmentPatch(
              existingRec,
              decision.proposedItem,
            );
            patchedFields = Object.keys(enrichPatch);

            if (patchedFields.length > 0) {
              await this.catalogGateway.updateItem(
                resolvedScope.userId,
                targetItemId,
                enrichPatch,
                { projectId: resolvedScope.projectId },
              );
              this.logger.log(
                `[EXACT_MERGE] Enriched item ${targetItemId} with ${patchedFields.join(', ')}`,
              );
            } else {
              this.logger.log(
                `[EXACT_MERGE] Item ${targetItemId} already fully populated — no patch needed`,
              );
            }

            await this.sideEffects.attachFile(
              resolvedScope.userId,
              resolvedScope.projectId,
              targetItemId,
              uploadedFileIdentifier,
              uploadedFilename,
              payloadSize,
              {
                ...(existingRec || {}),
                ...(decision.proposedItem || {}),
              },
            );

            await this.sideEffects.autoCaptureWebAssets({
              userId: resolvedScope.userId,
              projectId: resolvedScope.projectId,
              itemId: targetItemId,
              payloadKind: envelope.payload.kind,
              sourceUrl:
                envelope.payload.kind === 'URL'
                  ? envelope.payload.url
                  : undefined,
              proposedItem: {
                ...(existingRec || {}),
                ...(decision.proposedItem || {}),
              },
              existingFileId:
                uploadedFileIdentifier ||
                (typeof existingRec?.fileId === 'string'
                  ? existingRec.fileId
                  : undefined),
              overrides: envelope.overrides,
            });

            await this.sideEffects.materializeNotes(
              resolvedScope.userId,
              resolvedScope.projectId,
              targetItemId,
              decision.proposedItem?.notes,
              existingRec,
            );

            if (envelope.collectionIds && envelope.collectionIds.length > 0) {
              for (const colId of envelope.collectionIds) {
                await this.sideEffects.assignItemToCollection(
                  resolvedScope.userId,
                  colId,
                  targetItemId,
                  resolvedScope.projectId,
                );
              }
            }
          }

          const exactSourceLabel =
            getSubmissionPayloadLabel(envelope.payload) ||
            decision.proposedItem?.filename ||
            decision.proposedItem?.title ||
            'Document';

          await this.repo.updateRunStatus(
            scopeId,
            runId,
            IngestionStatus.COMPLETED,
            {
              itemId: matchResult.targetItemId,
              completedAt: new Date(),
              executionLog: {
                total: 1,
                processed: 1,
                succeeded: 0,
                duplicates: 1,
                failed: 0,
                percentage: 100,
                status: 'COMPLETED',
                currentTitle: decision.proposedItem?.title || 'Document',
                items: [
                  {
                    title: exactSourceLabel,
                    itemName: decision.proposedItem?.title || 'Document',
                    status: 'DUPLICATE',
                    itemId: matchResult.targetItemId,
                  },
                ],
              } as unknown as Prisma.InputJsonValue,
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

    // Retraction Check: Auto-scan against Retraction Watch & Crossref before commit
    await this.sideEffects.scanRetraction(decision.proposedItem);

    // Stage 6: COMMIT (Create new Item via CommitStage with Saga Compensation)
    const createdItem = await session.executeStep(
      'COMMIT',
      async () =>
        this.commit.execute({
          scopeId: resolvedScope.projectId || resolvedScope.userId,
          item: decision.proposedItem,
          options: {
            collectionIds: envelope.collectionIds,
            tagIds: envelope.tagIds,
            userId: resolvedScope.userId,
            source: this.mapPayloadToSource(envelope.payload.kind),
            filename: uploadedFilename,
            skipPreMatch: true,
          },
        }),
      {
        outputSnapshot: (res) => ({ itemId: res?.id }),
        compensate: async (item) => {
          const wasPreExisting =
            Boolean(
              (item as { __wasPreExistingMatch?: boolean } | null | undefined)
                ?.__wasPreExistingMatch,
            ) ||
            matchResult.matchType === 'EXACT' ||
            Boolean(matchResult.targetItemId && item?.id === matchResult.targetItemId);
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
      if (matchResult.matchType === 'PROBABLE' && matchResult.targetItemId) {
        await this.repo.createReviewCase(resolvedScope, runId, {
          targetItemId: matchResult.targetItemId,
          reason: `Probable match with existing item "${matchResult.targetItemTitle}"`,
          evidence: {
            matchReason: matchResult.matchReason,
            confidence: matchResult.confidence,
            details: matchResult.evidence,
            ...(createdItem?.id ? { createdItemId: createdItem.id } : {}),
          } as unknown as Prisma.InputJsonValue,
          options: {
            proposedMetadata: decision.proposedItem,
          } as unknown as Prisma.InputJsonValue,
          assignedToId: resolvedScope.userId,
        });
      }

      if (createdItem?.id) {
        await this.sideEffects.attachFile(
          resolvedScope.userId,
          resolvedScope.projectId,
          createdItem.id,
          uploadedFileIdentifier,
          uploadedFilename,
          payloadSize,
          {
            ...(decision.proposedItem || {}),
            ...(createdItem as unknown as Record<string, unknown>),
          },
        );

        await this.sideEffects.autoCaptureWebAssets({
          userId: resolvedScope.userId,
          projectId: resolvedScope.projectId,
          itemId: createdItem.id,
          payloadKind: envelope.payload.kind,
          sourceUrl:
            envelope.payload.kind === 'URL'
              ? envelope.payload.url
              : undefined,
          proposedItem: {
            ...(decision.proposedItem || {}),
            ...(createdItem as unknown as Record<string, unknown>),
          },
          existingFileId: uploadedFileIdentifier,
          overrides: envelope.overrides,
        });

        await this.sideEffects.materializeNotes(
          resolvedScope.userId,
          resolvedScope.projectId,
          createdItem.id,
          decision.proposedItem?.notes,
          createdItem,
        );
      }

      const commitSourceLabel =
        getSubmissionPayloadLabel(envelope.payload) ||
        decision.proposedItem?.filename ||
        createdItem?.title ||
        'Document';

      await this.repo.updateRunStatus(
        scopeId,
        runId,
        IngestionStatus.COMPLETED,
        {
          itemId: createdItem?.id,
          completedAt: new Date(),
          executionLog: {
            total: 1,
            processed: 1,
            succeeded: 1,
            duplicates: 0,
            failed: 0,
            percentage: 100,
            status: 'COMPLETED',
            currentTitle: createdItem?.title || 'Document',
            items: [
              {
                title: commitSourceLabel,
                itemName: createdItem?.title || 'Document',
                status: 'SUCCEEDED',
                itemId: createdItem?.id,
              },
            ],
          } as unknown as Prisma.InputJsonValue,
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
