import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { ResolveStage } from '@/modules/library/ingestion/stages/resolve.stage';
import {
  CommitStage,
  isPreExistingMatchItem,
} from '@/modules/library/ingestion/stages/commit.stage';
import { PipelineSideEffectsService } from './pipeline-side-effects.service';
import { IngestionSubmissionEnvelope } from '@/modules/library/ingestion/types/ingestion.types';
import { MetadataCandidate } from '@/modules/library/ingestion/types/metadata.types';
import { IngestionRunAggregate } from '@/modules/library/ingestion/domain/ingestion-run.domain';
import { IngestionSagaSession } from './ingestion-saga.orchestrator';
import { IngestionStatus, Prisma } from '@prisma/client';
import { mapPayloadToSource } from '@/modules/library/ingestion/domain/enrichment-patch.mapper';
import {
  CATALOG_FACADE,
  ICatalogFacade,
  MetadataCoalescePolicy,
  verifyCandidateMatch,
} from '@/modules/library/core';

function extractSurname(raw: unknown): string {
  if (!raw) return '';
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    const part = trimmed.includes(',') ? trimmed.split(',')[0].trim() : trimmed;
    return (part.split(/\s+/).pop() || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }
  if (typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    const candidate =
      (typeof rec.lastName === 'string' && rec.lastName.trim()) ||
      (typeof rec.family === 'string' && rec.family.trim()) ||
      (typeof rec.fullName === 'string' && rec.fullName.trim()) ||
      (typeof rec.name === 'string' && rec.name.trim()) ||
      '';
    return extractSurname(candidate);
  }
  return '';
}

function isCompatibleTitleProviderMatch(
  recordCand: MetadataCandidate,
  providerCand: MetadataCandidate,
): boolean {
  return verifyCandidateMatch(recordCand, providerCand);
}

function serializeSubRunRecordPayload(
  cand: Pick<MetadataCandidate, 'normalizedMetadata'> &
    Partial<MetadataCandidate>,
): {
  kind: 'RECORD';
  format: 'CSL_JSON';
  content: string;
} {
  return {
    kind: 'RECORD',
    format: 'CSL_JSON',
    content: JSON.stringify([cand.normalizedMetadata || {}]),
  };
}

@Injectable()
export class PipelineBatchExecutor {
  private readonly logger = new Logger(PipelineBatchExecutor.name);

  constructor(
    private readonly repo: IngestionRepository,
    private readonly resolveStage: ResolveStage,
    private readonly commit: CommitStage,
    private readonly sideEffects: PipelineSideEffectsService,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
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
      candidateKey?: string;
      retryPayload?: ReturnType<typeof serializeSubRunRecordPayload>;
    }> = [];

    // Retry idempotency: inspect prior progress on this runId and track in-batch committed keys
    const committedRecordKeys = new Map<
      string,
      { itemId: string; status: 'SUCCEEDED' | 'DUPLICATE' }
    >();
    try {
      const existingRun = await this.repo.findRunById(scopeId, runId);
      const existingLog = existingRun?.executionLog as
        | {
            committedKeys?: Record<
              string,
              { itemId?: string; status?: 'SUCCEEDED' | 'DUPLICATE' }
            >;
            items?: Array<{
              title?: string;
              status?: 'SUCCEEDED' | 'DUPLICATE' | 'FAILED';
              itemId?: string;
              candidateKey?: string;
            }>;
          }
        | null
        | undefined;
      if (existingLog?.committedKeys && typeof existingLog.committedKeys === 'object') {
        for (const [key, entry] of Object.entries(existingLog.committedKeys)) {
          if (
            key &&
            entry?.itemId &&
            (entry.status === 'SUCCEEDED' || entry.status === 'DUPLICATE')
          ) {
            committedRecordKeys.set(key, {
              itemId: entry.itemId,
              status: entry.status,
            });
          }
        }
      }
      if (Array.isArray(existingLog?.items)) {
        for (const prev of existingLog.items) {
          if (
            prev?.itemId &&
            (prev.status === 'SUCCEEDED' || prev.status === 'DUPLICATE')
          ) {
            const key = prev.candidateKey || '';
            if (key) {
              committedRecordKeys.set(key, {
                itemId: prev.itemId,
                status: prev.status,
              });
            }
          }
        }
      }
    } catch {
      // Non-critical prior run progress check
    }

    // Pre-index provider candidates in O(N) to avoid O(N^2) filtering across large batches
    const byEvidenceRef = new Map<string, MetadataCandidate[]>();
    const byDoi = new Map<string, MetadataCandidate[]>();
    const byTitle = new Map<string, MetadataCandidate[]>();
    const byArxivId = new Map<string, MetadataCandidate[]>();
    const byPmid = new Map<string, MetadataCandidate[]>();
    const byIsbn = new Map<string, MetadataCandidate[]>();

    for (const ec of enrichedCandidates) {
      if (ec.sourceKind !== 'PROVIDER') continue;
      if (ec.rawEvidenceRef) {
        const list = byEvidenceRef.get(ec.rawEvidenceRef) || [];
        list.push(ec);
        byEvidenceRef.set(ec.rawEvidenceRef, list);
      }
      const ecDoi = ec.normalizedMetadata?.doi?.trim().toLowerCase();
      if (ecDoi) {
        const list = byDoi.get(ecDoi) || [];
        list.push(ec);
        byDoi.set(ecDoi, list);
      }
      const ecTitle = ec.normalizedMetadata?.title?.trim().toLowerCase();
      if (ecTitle) {
        const list = byTitle.get(ecTitle) || [];
        list.push(ec);
        byTitle.set(ecTitle, list);
      }
      const ecArxiv = ec.normalizedMetadata?.arxivId?.trim().toLowerCase();
      if (ecArxiv) {
        const list = byArxivId.get(ecArxiv) || [];
        list.push(ec);
        byArxivId.set(ecArxiv, list);
      }
      const ecPmid = ec.normalizedMetadata?.pmid?.trim().toLowerCase();
      if (ecPmid) {
        const list = byPmid.get(ecPmid) || [];
        list.push(ec);
        byPmid.set(ecPmid, list);
      }
      const ecIsbn = ec.normalizedMetadata?.isbn?.trim().toLowerCase();
      if (ecIsbn) {
        const list = byIsbn.get(ecIsbn) || [];
        list.push(ec);
        byIsbn.set(ecIsbn, list);
      }
    }

    try {
      await this.repo.updateRunProgress(scopeId, runId, {
        total,
        processed: 0,
        succeeded: 0,
        duplicates: 0,
        failed: 0,
        percentage: 0,
        status: 'RUNNING',
        currentTitle:
          normalizedCandidates[0]?.normalizedMetadata?.title ||
          'Processing batch...',
        items: [],
      });
    } catch (progressErr: unknown) {
      this.logger.warn(
        `Failed to checkpoint initial progress for run ${runId}: ${progressErr instanceof Error ? progressErr.message : String(progressErr)}`,
      );
    }

    let lastCheckpointAt = Date.now();
    const inFlightRecordCommitPromises = new Map<
      string,
      Promise<{ itemId?: string; status: 'SUCCEEDED' | 'DUPLICATE' | 'FAILED' }>
    >();

    const processSingleRecordCandidate = async (
      initialCand: MetadataCandidate,
    ): Promise<void> => {
      const itemTitle =
        initialCand.normalizedMetadata?.title ||
        initialCand.normalizedMetadata?.shortTitle ||
        'Untitled Record';
      const candDoiKey = initialCand.normalizedMetadata?.doi
        ?.trim()
        .toLowerCase();
      const candArxivKey = initialCand.normalizedMetadata?.arxivId
        ?.trim()
        .toLowerCase();
      const candPmidKey = initialCand.normalizedMetadata?.pmid
        ?.trim()
        .toLowerCase();
      const candIsbnKey = initialCand.normalizedMetadata?.isbn
        ?.trim()
        .toLowerCase();
      const candYearKey = initialCand.normalizedMetadata?.year
        ? String(initialCand.normalizedMetadata.year)
        : '';
      const rawCandAuthors = initialCand.normalizedMetadata?.authors?.length
        ? initialCand.normalizedMetadata.authors
        : initialCand.normalizedMetadata?.creators;
      const candAuthorKey =
        Array.isArray(rawCandAuthors) && rawCandAuthors.length > 0
          ? extractSurname(rawCandAuthors[0])
          : '';
      const candidateKey = candDoiKey
        ? `doi:${candDoiKey}`
        : candArxivKey
          ? `arxiv:${candArxivKey}`
          : candPmidKey
            ? `pmid:${candPmidKey}`
            : candIsbnKey
              ? `isbn:${candIsbnKey}`
              : `title:${itemTitle.trim().toLowerCase()}|year:${candYearKey}|author:${candAuthorKey}`;
      const legacyCandidateKey = `title:${itemTitle.trim().toLowerCase()}|year:${candYearKey}`;
      const retryPayload = serializeSubRunRecordPayload(initialCand);

      let alreadyCommitted =
        committedRecordKeys.get(candidateKey) ||
        (!candAuthorKey
          ? committedRecordKeys.get(legacyCandidateKey)
          : undefined);

      if (!alreadyCommitted) {
        const pendingSameKey = inFlightRecordCommitPromises.get(candidateKey);
        if (pendingSameKey) {
          const settled = await pendingSameKey;
          if (
            settled.itemId &&
            (settled.status === 'SUCCEEDED' || settled.status === 'DUPLICATE')
          ) {
            alreadyCommitted = {
              itemId: settled.itemId,
              status: settled.status,
            };
          }
        }
      }

      let resolveInFlightLock:
        | ((val: {
            itemId?: string;
            status: 'SUCCEEDED' | 'DUPLICATE' | 'FAILED';
          }) => void)
        | undefined;
      if (!alreadyCommitted && !inFlightRecordCommitPromises.has(candidateKey)) {
        inFlightRecordCommitPromises.set(
          candidateKey,
          new Promise((resolve) => {
            resolveInFlightLock = resolve;
          }),
        );
      }

      try {
        if (alreadyCommitted) {
          createdItemIds.push(alreadyCommitted.itemId);
          duplicates++;
          progressItems.push({
            title: itemTitle,
            status: 'DUPLICATE',
            itemId: alreadyCommitted.itemId,
            candidateKey,
          });
          resolveInFlightLock?.({
            itemId: alreadyCommitted.itemId,
            status: 'DUPLICATE',
          });
          return;
        }

        const matchedSet = new Set<MetadataCandidate>();
        const refMatches = byEvidenceRef.get(initialCand.candidateId);
        if (refMatches) refMatches.forEach((m) => matchedSet.add(m));

        const candDoi = initialCand.normalizedMetadata?.doi
          ?.trim()
          .toLowerCase();
        if (candDoi) {
          const doiMatches = byDoi.get(candDoi);
          if (doiMatches) doiMatches.forEach((m) => matchedSet.add(m));
        }

        const candTitle = initialCand.normalizedMetadata?.title
          ?.trim()
          .toLowerCase();
        if (candTitle) {
          const titleMatches = byTitle.get(candTitle);
          if (titleMatches) {
            titleMatches.forEach((m) => {
              if (isCompatibleTitleProviderMatch(initialCand, m)) {
                matchedSet.add(m);
              }
            });
          }
        }

        const candArxiv = initialCand.normalizedMetadata?.arxivId
          ?.trim()
          .toLowerCase();
        if (candArxiv) {
          const arxivMatches = byArxivId.get(candArxiv);
          if (arxivMatches) arxivMatches.forEach((m) => matchedSet.add(m));
        }

        const candPmid = initialCand.normalizedMetadata?.pmid
          ?.trim()
          .toLowerCase();
        if (candPmid) {
          const pmidMatches = byPmid.get(candPmid);
          if (pmidMatches) pmidMatches.forEach((m) => matchedSet.add(m));
        }

        const candIsbn = initialCand.normalizedMetadata?.isbn
          ?.trim()
          .toLowerCase();
        if (candIsbn) {
          const isbnMatches = byIsbn.get(candIsbn);
          if (isbnMatches) isbnMatches.forEach((m) => matchedSet.add(m));
        }

        const candidatesForRecord = [initialCand, ...Array.from(matchedSet)];
        const itemDecision =
          typeof this.resolveStage?.coalesceAndVerify === 'function'
            ? await this.resolveStage.coalesceAndVerify(candidatesForRecord)
            : MetadataCoalescePolicy.coalesceCandidates(candidatesForRecord);
        const matchRes = this.resolveStage?.match
          ? await this.resolveStage.match({
              scope: resolvedScope,
              proposedItem: itemDecision.proposedItem,
            })
          : { matchType: 'NO_MATCH' as const, confidence: 0 };

        if (matchRes.matchType === 'EXACT' && matchRes.targetItemId) {
          try {
            const { existingRecord: existingRec } =
              await this.sideEffects.enrichExistingMatchedItem({
                userId: resolvedScope.userId,
                projectId: resolvedScope.projectId,
                targetItemId: matchRes.targetItemId,
                candidateItem: itemDecision.proposedItem,
              });
            await this.sideEffects.materializeNotes(
              resolvedScope.userId,
              resolvedScope.projectId,
              matchRes.targetItemId,
              itemDecision.proposedItem?.notes,
              existingRec,
            );
          } catch (enrichErr: unknown) {
            this.logger.warn(
              `Additive enrichment on duplicate item ${matchRes.targetItemId} failed: ${enrichErr instanceof Error ? enrichErr.message : String(enrichErr)}`,
            );
          }

          if (envelope.collectionIds && envelope.collectionIds.length > 0) {
            await Promise.all(
              envelope.collectionIds.map((colId) =>
                this.sideEffects.assignItemToCollection(
                  resolvedScope.userId,
                  colId,
                  matchRes.targetItemId!,
                  resolvedScope.projectId,
                ),
              ),
            );
          }

          createdItemIds.push(matchRes.targetItemId);
          duplicates++;
          committedRecordKeys.set(candidateKey, {
            itemId: matchRes.targetItemId,
            status: 'DUPLICATE',
          });
          progressItems.push({
            title: itemTitle,
            status: 'DUPLICATE',
            itemId: matchRes.targetItemId,
            candidateKey,
          });
          resolveInFlightLock?.({
            itemId: matchRes.targetItemId,
            status: 'DUPLICATE',
          });
        } else {
          await this.sideEffects.scanRetraction(itemDecision.proposedItem, {
            localOnly: true,
          });

          const created = await this.commit.execute({
            scopeId: resolvedScope.projectId || resolvedScope.userId,
            item: itemDecision.proposedItem,
            options: {
              collectionIds: envelope.collectionIds,
              tagIds: envelope.tagIds,
              userId: resolvedScope.userId,
              source: mapPayloadToSource(envelope.payload.kind),
              skipPreMatch: true,
            },
          });
          if (created?.id) {
            const wasPreExisting = isPreExistingMatchItem(created);
            if (!wasPreExisting) {
              await this.sideEffects.recordProbableMatchReviewCase({
                scope: resolvedScope,
                runId,
                matchResult: matchRes,
                proposedMetadata: itemDecision.proposedItem,
                createdItemId: created.id,
              });
            }
            createdItemIds.push(created.id);
            const itemStatus = wasPreExisting ? 'DUPLICATE' : 'SUCCEEDED';
            if (wasPreExisting) {
              duplicates++;
            } else {
              succeeded++;
            }
            committedRecordKeys.set(candidateKey, {
              itemId: created.id,
              status: itemStatus,
            });
            progressItems.push({
              title: itemTitle,
              status: itemStatus,
              itemId: created.id,
              candidateKey,
            });

            await this.sideEffects.materializeNotes(
              resolvedScope.userId,
              resolvedScope.projectId,
              created.id,
              itemDecision.proposedItem?.notes,
              created,
            );
            resolveInFlightLock?.({
              itemId: created.id,
              status: itemStatus,
            });
          } else {
            failed++;
            progressItems.push({
              title: itemTitle,
              status: 'FAILED',
              error: 'Commit returned empty record',
              candidateKey,
              retryPayload,
            });
            resolveInFlightLock?.({ status: 'FAILED' });
          }
        }
      } catch (itemErr: unknown) {
        failed++;
        progressItems.push({
          title: itemTitle,
          status: 'FAILED',
          error:
            itemErr instanceof Error ? itemErr.message : 'Processing failed',
          candidateKey,
          retryPayload,
        });
        resolveInFlightLock?.({ status: 'FAILED' });
      } finally {
        inFlightRecordCommitPromises.delete(candidateKey);
        processed++;
        const isFinal = processed === total;
        const now = Date.now();
        const countMilestone =
          total <= 10 ||
          processed % 5 === 0 ||
          (total > 50 && processed % 10 === 0);
        const shouldCheckpoint =
          isFinal || (countMilestone && now - lastCheckpointAt >= 500);

        if (shouldCheckpoint) {
          lastCheckpointAt = now;
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
              committedKeys: Object.fromEntries(committedRecordKeys),
              items: progressItems.slice(-20),
            });
          } catch (cpErr: unknown) {
            this.logger.warn(
              `Failed to checkpoint batch progress for run ${runId}: ${cpErr instanceof Error ? cpErr.message : String(cpErr)}`,
            );
          }
        }
      }
    };

    const BATCH_COMMIT_CONCURRENCY = 6;
    let nextCandidateIndex = 0;
    const workerCount = Math.min(
      BATCH_COMMIT_CONCURRENCY,
      normalizedCandidates.length,
    );
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextCandidateIndex < normalizedCandidates.length) {
          const idx = nextCandidateIndex++;
          const cand = normalizedCandidates[idx];
          if (cand) {
            await processSingleRecordCandidate(cand);
          }
        }
      }),
    );

    await session.executeStep(
      'COMMIT',
      async () => {
        const isAllFailed = succeeded === 0 && duplicates === 0 && failed > 0;
        const finalStatus = isAllFailed
          ? IngestionStatus.FAILED_FINAL
          : IngestionStatus.COMPLETED;
        await this.repo.updateRunStatus(
          scopeId,
          runId,
          finalStatus,
          {
            itemId: createdItemIds[0],
            completedAt: new Date(),
            ...(isAllFailed
              ? {
                  lastError:
                    progressItems.find((i) => i.error)?.error ||
                    'All records in batch failed',
                }
              : {}),
            executionLog: {
              total,
              processed,
              succeeded,
              duplicates,
              failed,
              percentage: 100,
              status: isAllFailed ? 'FAILED_FINAL' : 'COMPLETED',
              committedKeys: Object.fromEntries(committedRecordKeys),
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
