import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
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
import {
  buildEnrichmentPatch,
  mapPayloadToSource,
} from '@/modules/library/ingestion/domain/enrichment-patch.builder';
import { ReconciliationPolicy } from '@/modules/library/ingestion/policies/reconciliation.policy';
import { CATALOG_FACADE, ICatalogFacade } from '@/modules/library/core';

function extractSurname(raw: unknown): string {
  if (!raw) return '';
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    const part = trimmed.includes(',')
      ? trimmed.split(',')[0].trim()
      : trimmed;
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

function extractAuthorSurnames(authors: unknown): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(authors)) return set;
  for (const a of authors) {
    const s = extractSurname(a);
    if (s) set.add(s);
  }
  return set;
}

function isCompatibleTitleProviderMatch(
  recordCand: MetadataCandidate,
  providerCand: MetadataCandidate,
): boolean {
  const policyVerifier = (
    ReconciliationPolicy as unknown as {
      verifyCandidateMatch?: (
        a: MetadataCandidate,
        b: MetadataCandidate,
      ) => boolean;
    }
  ).verifyCandidateMatch;
  if (typeof policyVerifier === 'function') {
    return policyVerifier(recordCand, providerCand);
  }
  if (
    providerCand.rawEvidenceRef &&
    recordCand.candidateId &&
    providerCand.rawEvidenceRef === recordCand.candidateId
  ) {
    return true;
  }
  const rMeta = recordCand.normalizedMetadata || {};
  const pMeta = providerCand.normalizedMetadata || {};
  const rDoi = rMeta.doi?.trim().toLowerCase();
  const pDoi = pMeta.doi?.trim().toLowerCase();
  if (rDoi && pDoi && rDoi !== pDoi) return false;
  const rArxiv = rMeta.arxivId?.trim().toLowerCase();
  const pArxiv = pMeta.arxivId?.trim().toLowerCase();
  if (rArxiv && pArxiv && rArxiv !== pArxiv) return false;
  const rPmid = rMeta.pmid?.trim().toLowerCase();
  const pPmid = pMeta.pmid?.trim().toLowerCase();
  if (rPmid && pPmid && rPmid !== pPmid) return false;
  const rIsbn = rMeta.isbn?.trim().toLowerCase();
  const pIsbn = pMeta.isbn?.trim().toLowerCase();
  if (rIsbn && pIsbn && rIsbn !== pIsbn) return false;

  const rYear = Number(rMeta.year);
  const pYear = Number(pMeta.year);
  if (
    Number.isFinite(rYear) &&
    rYear > 0 &&
    Number.isFinite(pYear) &&
    pYear > 0 &&
    Math.abs(rYear - pYear) > 1
  ) {
    return false;
  }

  const rAuthors = extractAuthorSurnames(
    rMeta.authors?.length ? rMeta.authors : rMeta.creators,
  );
  const pAuthors = extractAuthorSurnames(
    pMeta.authors?.length ? pMeta.authors : pMeta.creators,
  );
  if (rAuthors.size > 0 && pAuthors.size > 0) {
    let shared = 0;
    for (const name of rAuthors) {
      if (pAuthors.has(name)) shared++;
    }
    if (shared === 0) return false;
  }

  if (
    providerCand.rawEvidenceRef &&
    recordCand.candidateId &&
    providerCand.rawEvidenceRef !== recordCand.candidateId
  ) {
    if ((rDoi || pDoi) && rDoi !== pDoi) return false;
    if ((rArxiv || pArxiv) && rArxiv !== pArxiv) return false;
    if ((rPmid || pPmid) && rPmid !== pPmid) return false;
    if ((rIsbn || pIsbn) && rIsbn !== pIsbn) return false;
    if ((rAuthors.size === 0) !== (pAuthors.size === 0)) return false;
  }
  return true;
}

export function serializeSubRunRecordPayload(
  cand: Pick<MetadataCandidate, 'normalizedMetadata'>,
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
    private readonly reconcile: ReconcileStage,
    private readonly match: MatchStage,
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
            items?: Array<{
              title?: string;
              status?: 'SUCCEEDED' | 'DUPLICATE' | 'FAILED';
              itemId?: string;
              candidateKey?: string;
            }>;
          }
        | null
        | undefined;
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
    } catch {
      // Non-critical initial progress checkpoint
    }

    for (const initialCand of normalizedCandidates) {
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
      const candAuthorKey = Array.isArray(rawCandAuthors) && rawCandAuthors.length > 0
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

      const alreadyCommitted =
        committedRecordKeys.get(candidateKey) ||
        (!candAuthorKey
          ? committedRecordKeys.get(legacyCandidateKey)
          : undefined);
      if (alreadyCommitted) {
        createdItemIds.push(alreadyCommitted.itemId);
        duplicates++;
        processed++;
        progressItems.push({
          title: itemTitle,
          status: 'DUPLICATE',
          itemId: alreadyCommitted.itemId,
          candidateKey,
        });
        continue;
      }

      try {
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
        const itemDecision = await this.reconcile.execute(candidatesForRecord);
        const matchRes = await this.match.execute({
          scope: resolvedScope,
          proposedItem: itemDecision.proposedItem,
        });

        if (matchRes.matchType === 'EXACT' && matchRes.targetItemId) {
          await this.sideEffects.scanRetraction(itemDecision.proposedItem, {
            localOnly: true,
          });

          if (this.catalogGateway) {
            try {
              const existing = await this.catalogGateway.getItem(
                resolvedScope.userId,
                matchRes.targetItemId,
                resolvedScope.projectId,
              );
              const existingRec = existing as
                | Record<string, unknown>
                | null
                | undefined;
              const enrichPatch = buildEnrichmentPatch(
                existingRec,
                itemDecision.proposedItem,
              );
              if (Object.keys(enrichPatch).length > 0) {
                await this.catalogGateway.updateItem(
                  resolvedScope.userId,
                  matchRes.targetItemId,
                  enrichPatch,
                  { projectId: resolvedScope.projectId },
                );
              }
              await this.sideEffects.materializeNotes(
                resolvedScope.userId,
                resolvedScope.projectId,
                matchRes.targetItemId,
                itemDecision.proposedItem?.notes,
                existingRec,
              );
            } catch {
              // Non-critical additive enrichment on duplicate
            }
          }

          // Ensure duplicate items are assigned to target envelope collections
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
            if (matchRes.matchType === 'PROBABLE' && matchRes.targetItemId) {
              await this.repo
                .createReviewCase(resolvedScope, runId, {
                  targetItemId: matchRes.targetItemId,
                  reason: `Probable match with existing item "${matchRes.targetItemTitle}"`,
                  evidence: {
                    matchReason: matchRes.matchReason,
                    confidence: matchRes.confidence,
                    details: matchRes.evidence,
                    createdItemId: created.id,
                  } as unknown as Prisma.InputJsonValue,
                  options: {
                    proposedMetadata: itemDecision.proposedItem,
                  } as unknown as Prisma.InputJsonValue,
                  assignedToId: resolvedScope.userId,
                })
                .catch(() => undefined);
            }
            createdItemIds.push(created.id);
            succeeded++;
            committedRecordKeys.set(candidateKey, {
              itemId: created.id,
              status: 'SUCCEEDED',
            });
            progressItems.push({
              title: itemTitle,
              status: 'SUCCEEDED',
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
          } else {
            failed++;
            progressItems.push({
              title: itemTitle,
              status: 'FAILED',
              error: 'Commit returned empty record',
              candidateKey,
              retryPayload,
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
          candidateKey,
          retryPayload,
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
