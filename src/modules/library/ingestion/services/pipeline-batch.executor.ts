import { Injectable, Logger } from '@nestjs/common';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { ReconcileStage } from '@/modules/library/ingestion/stages/reconcile.stage';
import { MatchStage } from '@/modules/library/ingestion/stages/match.stage';
import { CommitStage } from '@/modules/library/ingestion/stages/commit.stage';
import { PipelineSideEffectsService } from './pipeline-side-effects.service';
import { IngestionSubmissionEnvelope } from '@/modules/library/ingestion/types/submission.types';
import { MetadataCandidate } from '@/modules/library/ingestion/types/metadata-candidate.types';
import { IngestionRunAggregate } from '@/modules/library/ingestion/domain/ingestion-run.aggregate';
import { IngestionSagaSession } from './ingestion-saga.orchestrator';
import { IngestionStatus, Prisma } from '@prisma/client';
import { mapPayloadToSource } from '@/modules/library/ingestion/domain/enrichment-patch.builder';

@Injectable()
export class PipelineBatchExecutor {
  private readonly logger = new Logger(PipelineBatchExecutor.name);

  constructor(
    private readonly repo: IngestionRepository,
    private readonly reconcile: ReconcileStage,
    private readonly match: MatchStage,
    private readonly commit: CommitStage,
    private readonly sideEffects: PipelineSideEffectsService,
  ) {}

  async processRecordBatch(params: {
    scopeId: string;
    runId: string;
    envelope: IngestionSubmissionEnvelope;
    resolvedScope: { userId: string; projectId?: string };
    aggregate: IngestionRunAggregate;
    session: IngestionSagaSession;
    normalizedCandidates: MetadataCandidate[];
    enrichedCandidates: MetadataCandidate[];
  }): Promise<void> {
    const {
      scopeId,
      runId,
      envelope,
      resolvedScope,
      aggregate,
      session,
      normalizedCandidates,
      enrichedCandidates,
    } = params;

    const createdItemIds: string[] = [];
    const total = normalizedCandidates.length;
    let processed = 0;
    let succeeded = 0;
    let duplicates = 0;
    let failed = 0;
    const progressItems: Array<{
      title: string;
      status: 'SUCCEEDED' | 'DUPLICATE' | 'FAILED';
      itemId?: string;
      error?: string;
    }> = [];

    for (const initialCand of normalizedCandidates) {
      const itemTitle =
        initialCand.normalizedMetadata?.title ||
        initialCand.normalizedMetadata?.shortTitle ||
        'Untitled Record';

      try {
        const matchingEnriched = enrichedCandidates.filter(
          (ec) =>
            ec.sourceKind === 'PROVIDER' &&
            (ec.rawEvidenceRef === initialCand.candidateId ||
              (ec.normalizedMetadata?.doi &&
                initialCand.normalizedMetadata?.doi &&
                ec.normalizedMetadata.doi.toLowerCase() ===
                  initialCand.normalizedMetadata.doi.toLowerCase()) ||
              (ec.normalizedMetadata?.title &&
                initialCand.normalizedMetadata?.title &&
                ec.normalizedMetadata.title.toLowerCase() ===
                  initialCand.normalizedMetadata.title.toLowerCase())),
        );
        const candidatesForRecord = [initialCand, ...matchingEnriched];
        const itemDecision = await this.reconcile.execute(candidatesForRecord);
        const matchRes = await this.match.execute({
          scope: resolvedScope,
          proposedItem: itemDecision.proposedItem,
        });

        if (matchRes.matchType === 'EXACT' && matchRes.targetItemId) {
          createdItemIds.push(matchRes.targetItemId);
          duplicates++;
          progressItems.push({
            title: itemTitle,
            status: 'DUPLICATE',
            itemId: matchRes.targetItemId,
          });
        } else {
          if (matchRes.matchType === 'PROBABLE' && matchRes.targetItemId) {
            await this.repo
              .createReviewCase(resolvedScope, runId, {
                targetItemId: matchRes.targetItemId,
                reason: `Probable match with existing item "${matchRes.targetItemTitle}"`,
                evidence: {
                  matchReason: matchRes.matchReason,
                  confidence: matchRes.confidence,
                  details: matchRes.evidence,
                } as unknown as Prisma.InputJsonValue,
                options: {
                  proposedMetadata: itemDecision.proposedItem,
                } as unknown as Prisma.InputJsonValue,
                assignedToId: resolvedScope.userId,
              })
              .catch(() => undefined);
          }

          await this.sideEffects.scanRetraction(itemDecision.proposedItem);

          const created = await this.commit.execute({
            scopeId: resolvedScope.projectId || resolvedScope.userId,
            item: itemDecision.proposedItem,
            options: {
              collectionIds: envelope.collectionIds,
              tagIds: envelope.tagIds,
              userId: resolvedScope.userId,
              source: mapPayloadToSource(envelope.payload.kind),
            },
          });
          if (created?.id) {
            createdItemIds.push(created.id);
            succeeded++;
            progressItems.push({
              title: itemTitle,
              status: 'SUCCEEDED',
              itemId: created.id,
            });

            await this.sideEffects.materializeNotes(
              resolvedScope.userId,
              resolvedScope.projectId,
              created.id,
              itemDecision.proposedItem?.notes,
              created,
            );
          } else {
            failed++;
            progressItems.push({
              title: itemTitle,
              status: 'FAILED',
              error: 'Commit returned empty record',
            });
          }
        }
      } catch (itemErr: unknown) {
        failed++;
        progressItems.push({
          title: itemTitle,
          status: 'FAILED',
          error:
            itemErr instanceof Error ? itemErr.message : 'Processing failed',
        });
      } finally {
        processed++;
        const isFinal = processed === total;
        const shouldCheckpoint =
          isFinal ||
          total <= 10 ||
          processed % 5 === 0 ||
          (total > 50 && processed % 10 === 0);

        if (shouldCheckpoint) {
          try {
            await this.repo.updateRunProgress(scopeId, runId, {
              total,
              processed,
              succeeded,
              duplicates,
              failed,
              percentage: Math.round((processed / total) * 100),
              status: 'RUNNING',
              currentTitle: itemTitle,
              items: progressItems.slice(-20),
            });
          } catch {
            // Non-critical progress checkpoint failure
          }
        }
      }
    }

    await session.executeStep(
      'COMMIT',
      async () => {
        await this.repo.updateRunStatus(
          scopeId,
          runId,
          IngestionStatus.COMPLETED,
          {
            itemId: createdItemIds[0],
            completedAt: new Date(),
            executionLog: {
              total,
              processed,
              succeeded,
              duplicates,
              failed,
              percentage: 100,
              status: 'COMPLETED',
              items: progressItems.slice(-50),
            } as unknown as Prisma.InputJsonValue,
          },
        );

        aggregate.recordProgress(succeeded, failed);
        aggregate.complete();

        return {
          itemIds: createdItemIds,
          totalProcessed: createdItemIds.length,
          succeeded,
          duplicates,
          failed,
        };
      },
      {
        outputSnapshot: (res: {
          itemIds: string[];
          totalProcessed: number;
          succeeded: number;
          duplicates: number;
          failed: number;
        }) => ({
          itemIds: res.itemIds,
          totalProcessed: res.totalProcessed,
          succeeded: res.succeeded,
          duplicates: res.duplicates,
          failed: res.failed,
        }),
      },
    );
  }
}
