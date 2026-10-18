import {
  Injectable,
  Logger,
  Optional,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { IngestionSubmissionEnvelope } from '@/modules/library/ingestion/types/submission.types';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { IdentifyStage } from '@/modules/library/ingestion/stages/identify.stage';
import { NormalizeStage } from '@/modules/library/ingestion/stages/normalize.stage';
import { EnrichStage } from '@/modules/library/ingestion/stages/enrich.stage';
import { ReconcileStage } from '@/modules/library/ingestion/stages/reconcile.stage';
import { MatchStage } from '@/modules/library/ingestion/stages/match.stage';
import { CommitStage } from '@/modules/library/ingestion/stages/commit.stage';
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
import { PipelineSideEffectsService } from './pipeline-side-effects.service';
import { PipelineBatchExecutor } from './pipeline-batch.executor';

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
  if ('size' in payload && typeof payload.size === 'number') {
    return payload.size;
  }
  return 0;
}

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);
  private readonly orchestrator: IngestionSagaOrchestrator;
  private readonly sideEffects: PipelineSideEffectsService;
  private readonly batchExecutor: PipelineBatchExecutor;

  constructor(
    private readonly repo: IngestionRepository,
    private readonly identify: IdentifyStage,
    private readonly normalize: NormalizeStage,
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
      );
  }

  /**
   * Executes the multi-stage ingestion pipeline.
   */
  async executePipeline(
    runId: string,
    scopeId: string,
    envelope: IngestionSubmissionEnvelope,
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

    const session = this.orchestrator.createSession(runId, scopeId, aggregate);

    // Stage 1: IDENTIFY & PARSE
    const { initialCandidates } = await session.executeStep(
      'IDENTIFY',
      async () => {
        const identifiedCandidates = await this.identify.execute(
          runId,
          envelope.payload,
          scopeId,
        );
        const overrides = sanitizeOverrides(envelope.overrides);
        const candidates = identifiedCandidates.map((candidate) => ({
          ...candidate,
          normalizedMetadata: {
            ...candidate.normalizedMetadata,
            ...overrides,
          },
        }));

        if (candidates.length === 0) {
          throw new BadRequestException(
            'No valid bibliographic metadata could be identified from input',
          );
        }

        return { initialCandidates: candidates, sanitizedOverrides: overrides };
      },
      {
        outputSnapshot: (res) => ({
          candidateCount: res.initialCandidates.length,
        }),
      },
    );

    // Stage 2: NORMALIZE
    const normalizedCandidates = await session.executeStep(
      'NORMALIZE',
      async () => this.normalize.execute(initialCandidates),
      {
        outputSnapshot: (res) => ({
          candidateCount: res.length,
        }),
      },
    );

    // Stage 3: ENRICH (Crossref, OpenAlex, PubMed, arXiv)
    const enrichedCandidates = await session.executeStep(
      'ENRICH',
      async () => this.enrich.execute(scopeId, normalizedCandidates),
      {
        outputSnapshot: (res) => ({
          candidateCount: res.length,
        }),
      },
    );

    // Multi-Record Ingestion Handling (BibTeX / RIS batches)
    if (envelope.payload.kind === 'RECORD' && normalizedCandidates.length > 1) {
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
      async () => this.match.execute(resolvedScope, decision.proposedItem),
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
            );

            await this.sideEffects.materializeNotes(
              resolvedScope.userId,
              resolvedScope.projectId,
              targetItemId,
              decision.proposedItem?.notes,
            );
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

    // PROBABLE fuzzy match → Non-blocking duplicate suspect review record
    if (matchResult.matchType === 'PROBABLE' && matchResult.targetItemId) {
      await this.repo.createReviewCase(resolvedScope, runId, {
        targetItemId: matchResult.targetItemId,
        reason: `Probable match with existing item "${matchResult.targetItemTitle}"`,
        evidence: {
          matchReason: matchResult.matchReason,
          confidence: matchResult.confidence,
          details: matchResult.evidence,
        } as unknown as Prisma.InputJsonValue,
        options: {
          proposedMetadata: decision.proposedItem,
        } as unknown as Prisma.InputJsonValue,
        assignedToId: resolvedScope.userId,
      });
    }

    // Retraction Check: Auto-scan against Retraction Watch & Crossref before commit
    await this.sideEffects.scanRetraction(decision.proposedItem);

    // Stage 6: COMMIT (Create new Item via CommitStage with Saga Compensation)
    const createdItem = await session.executeStep(
      'COMMIT',
      async () => {
        return this.commit.execute(
          resolvedScope.projectId || resolvedScope.userId,
          decision.proposedItem,
          {
            collectionIds: envelope.collectionIds,
            tagIds: envelope.tagIds,
            userId: resolvedScope.userId,
            source: this.mapPayloadToSource(envelope.payload.kind),
            fileId: uploadedFileIdentifier,
            filename: uploadedFilename,
          },
        );
      },
      {
        outputSnapshot: (res) => ({ itemId: res?.id }),
        compensate: async (item) => {
          if (item?.id && this.catalogGateway?.deleteItem) {
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

    if (createdItem?.id) {
      await this.sideEffects.attachFile(
        resolvedScope.userId,
        resolvedScope.projectId,
        createdItem.id,
        uploadedFileIdentifier,
        uploadedFilename,
        payloadSize,
      );

      await this.sideEffects.materializeNotes(
        resolvedScope.userId,
        resolvedScope.projectId,
        createdItem.id,
        decision.proposedItem?.notes,
        createdItem,
      );
    }

    try {
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
