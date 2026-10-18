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
  SCHEMA_V42_DATA,
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
  harmonizeZoteroFields,
  CATALOG_FACADE,
  ICatalogFacade,
  EXTRACTION_FACADE,
  IExtractionFacade,
} from '@/modules/library/core';
import { getFileContentPath } from '@/modules/storage/storage.port';
import { IngestionStatus, Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { IngestionRunAggregate } from '@/modules/library/ingestion/domain/ingestion-run.aggregate';
import {
  IngestionSagaOrchestrator,
  IngestionSagaSession,
} from './ingestion-saga.orchestrator';
import {
  MetadataCandidate,
  ReconciliationDecision,
} from '@/modules/library/ingestion/types/metadata-candidate.types';

const SYSTEM_RESERVED_KEYS = new Set([
  'id',
  'userId',
  'projectId',
  'deletedAt',
  'createdAt',
  'updatedAt',
  'version',
  'citationCount',
  'referenceCount',
  'crossrefEnriched',
  'retractionStatus',
  'isRetracted',
]);

const NON_SCALAR_ENRICH_KEYS = new Set([
  ...SYSTEM_RESERVED_KEYS,
  'title',
  'authors',
  'editors',
  'creators',
  'contributors',
  'keywords',
  'labels',
  'tags',
  'notes',
  'extraFields',
]);

const SCALAR_METADATA_FIELDS: string[] = Array.from(
  new Set([
    ...SCHEMA_V42_DATA.distinctFieldKeys,
    ...ITEM_COLUMN_METADATA_FIELDS,
    ...Object.keys(FIELD_ALIASES),
    ...Object.values(FIELD_ALIASES),
  ]),
).filter((key) => !NON_SCALAR_ENRICH_KEYS.has(key));

function sanitizeOverrides(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  if (!overrides || typeof overrides !== 'object') return {};
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(overrides)) {
    if (!SYSTEM_RESERVED_KEYS.has(key)) {
      clean[key] = val;
    }
  }
  return clean;
}

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
  ) {
    this.orchestrator = sagaOrchestrator ?? new IngestionSagaOrchestrator(repo);
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
      await this.processRecordBatch({
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
      await this.handleBlockedSubmission({
        scopeId,
        runId,
        envelope,
        decision,
        aggregate,
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

            const enrichPatch = this.buildEnrichmentPatch(
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

            await this.attachFile(
              resolvedScope.userId,
              resolvedScope.projectId,
              targetItemId,
              uploadedFileIdentifier,
              uploadedFilename,
              payloadSize,
            );

            await this.materializeNotes(
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
    await this.scanRetraction(decision.proposedItem);

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
      await this.attachFile(
        resolvedScope.userId,
        resolvedScope.projectId,
        createdItem.id,
        uploadedFileIdentifier,
        uploadedFilename,
        payloadSize,
      );

      await this.materializeNotes(
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

  // Helper Domain Routines

  private async processRecordBatch(params: {
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
        const matchRes = await this.match.execute(
          resolvedScope,
          itemDecision.proposedItem,
        );

        if (matchRes.matchType === 'EXACT' && matchRes.targetItemId) {
          createdItemIds.push(matchRes.targetItemId);
          duplicates++;
          progressItems.push({
            title: itemTitle,
            status: 'DUPLICATE',
            itemId: matchRes.targetItemId,
          });
        } else {
          await this.scanRetraction(itemDecision.proposedItem);

          const created = await this.commit.execute(
            resolvedScope.projectId || resolvedScope.userId,
            itemDecision.proposedItem,
            {
              collectionIds: envelope.collectionIds,
              tagIds: envelope.tagIds,
              userId: resolvedScope.userId,
              source: this.mapPayloadToSource(envelope.payload.kind),
            },
          );
          if (created?.id) {
            createdItemIds.push(created.id);
            succeeded++;
            progressItems.push({
              title: itemTitle,
              status: 'SUCCEEDED',
              itemId: created.id,
            });

            await this.materializeNotes(
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

  private async handleBlockedSubmission(params: {
    scopeId: string;
    runId: string;
    envelope: IngestionSubmissionEnvelope;
    decision: ReconciliationDecision;
    aggregate: IngestionRunAggregate;
  }): Promise<void> {
    const { scopeId, runId, envelope, decision, aggregate } = params;
    const wafKind =
      (decision.proposedItem?.extraFields?.wafKind as string) ||
      'WAF_CLOUDFLARE_TURNSTILE';
    const blockedSourceLabel =
      getSubmissionPayloadLabel(envelope.payload) ||
      decision.proposedItem?.url ||
      'Document';

    await this.repo.updateRunStatus(scopeId, runId, IngestionStatus.COMPLETED, {
      completedAt: new Date(),
      executionLog: {
        total: 1,
        processed: 1,
        succeeded: 0,
        duplicates: 0,
        failed: 0,
        percentage: 100,
        status: 'BLOCKED',
        ingestionStatus: 'BLOCKED',
        wafKind,
        promptUploadPdf: true,
        currentTitle: blockedSourceLabel,
        message:
          'Website is protected by WAF / Cloudflare Turnstile. Please upload the PDF file directly.',
        items: [
          {
            title: blockedSourceLabel,
            status: 'BLOCKED',
            error:
              'Website is protected by WAF / Cloudflare Turnstile. Please upload the PDF file directly.',
          },
        ],
      } as unknown as Prisma.InputJsonValue,
    });

    aggregate.recordProgress(0, 1);
    aggregate.complete();
  }

  private buildEnrichmentPatch(
    existingRec: Record<string, unknown> | null | undefined,
    rawProposed: Record<string, unknown>,
  ): Record<string, unknown> {
    const resolvedType =
      (typeof rawProposed.itemType === 'string' && rawProposed.itemType) ||
      (typeof existingRec?.itemType === 'string' && existingRec.itemType) ||
      'journalArticle';
    const p = harmonizeZoteroFields(rawProposed, {
      itemType: resolvedType,
      syncExtraFields: true,
    });
    const enrichPatch: Record<string, unknown> = {};

    const maybeEnrich = (field: string, val: unknown) => {
      if (val == null || val === '') return;
      const current = existingRec?.[field];
      if (
        current == null ||
        current === '' ||
        (Array.isArray(current) && current.length === 0)
      ) {
        enrichPatch[field] = val;
      }
    };

    if (p.title && p.title !== 'Untitled Document') {
      const currentTitle = String(existingRec?.title || '').trim();
      if (
        !currentTitle ||
        currentTitle === 'Untitled Document' ||
        currentTitle === 'Uploaded Document' ||
        /\.pdf$/i.test(currentTitle) ||
        /^10\.\d{4,9}\//.test(currentTitle)
      ) {
        enrichPatch['title'] = p.title;
      }
    }

    for (const field of SCALAR_METADATA_FIELDS) {
      maybeEnrich(field, p[field]);
    }

    const pExtra =
      p.extraFields &&
      typeof p.extraFields === 'object' &&
      !Array.isArray(p.extraFields)
        ? (p.extraFields as Record<string, unknown>)
        : undefined;
    if (pExtra) {
      const existingExtra =
        existingRec?.extraFields &&
        typeof existingRec.extraFields === 'object' &&
        !Array.isArray(existingRec.extraFields)
          ? (existingRec.extraFields as Record<string, unknown>)
          : {};
      const mergedExtra: Record<string, unknown> = { ...existingExtra };
      let extraChanged = false;
      for (const [efKey, efVal] of Object.entries(pExtra)) {
        if (efVal == null || efVal === '') continue;
        if (mergedExtra[efKey] == null || mergedExtra[efKey] === '') {
          mergedExtra[efKey] = efVal;
          extraChanged = true;
        }
        maybeEnrich(efKey, efVal);
      }
      if (extraChanged) {
        enrichPatch['extraFields'] = mergedExtra;
      }
    }

    const existingAuthors = existingRec?.authors as unknown[] | undefined;
    const existingEditors = existingRec?.editors as unknown[] | undefined;
    const existingCreators = existingRec?.creators as unknown[] | undefined;
    const existingKeywords = (existingRec?.keywords || existingRec?.labels) as
      unknown[] | undefined;

    const pAuthors = p.authors as unknown[] | undefined;
    const pEditors = p.editors as unknown[] | undefined;
    const pCreators = p.creators as unknown[] | undefined;
    const pKeywords = p.keywords as unknown[] | undefined;

    if (pAuthors?.length && !existingAuthors?.length) {
      enrichPatch['authors'] = pAuthors;
    }
    if (pEditors?.length && !existingEditors?.length) {
      enrichPatch['editors'] = pEditors;
    }
    if (pCreators?.length && !existingCreators?.length) {
      enrichPatch['creators'] = pCreators;
    }
    if (pKeywords?.length && !existingKeywords?.length) {
      enrichPatch['keywords'] = pKeywords;
      enrichPatch['labels'] = pKeywords;
    }

    return enrichPatch;
  }

  private async scanRetraction(
    proposedItem?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.retractionScanner || !proposedItem) return;
    try {
      const scanRes = await this.retractionScanner.scan(
        typeof proposedItem.doi === 'string' ? proposedItem.doi : undefined,
        typeof proposedItem.pmid === 'string' ? proposedItem.pmid : undefined,
        typeof proposedItem.title === 'string' ? proposedItem.title : undefined,
      );
      if (scanRes) {
        proposedItem.isRetracted = true;
        proposedItem.retractionNature = scanRes.nature;
        proposedItem.retractionDetails = scanRes;
        proposedItem.retractionCheckedAt = new Date().toISOString();
        this.logger.warn(
          `[RETRACTION_INGESTION_GUARD] Flagged imported item "${String(proposedItem.title ?? '')}" as ${scanRes.nature}`,
        );
      }
    } catch (scanErr: unknown) {
      const msg = scanErr instanceof Error ? scanErr.message : String(scanErr);
      this.logger.warn(`Retraction check during ingestion skipped: ${msg}`);
    }
  }

  private async attachFile(
    userId: string,
    projectId: string | undefined,
    itemId: string,
    fileId?: string,
    filename?: string,
    size?: number,
  ): Promise<void> {
    if (!fileId || !this.extractionGateway?.createAttachment) return;
    try {
      await this.extractionGateway.createAttachment(
        {
          itemId,
          fileId,
          filename: filename || 'document.pdf',
          url: getFileContentPath(fileId),
          mimeType: 'application/pdf',
          size: size || 0,
          userId,
        },
        projectId,
      );
      this.logger.log(`[ATTACHMENT] Attached file ${fileId} to item ${itemId}`);
    } catch (err: unknown) {
      this.logger.warn(
        `[ATTACHMENT] Failed to attach file ${fileId} to item ${itemId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async materializeNotes(
    userId: string,
    projectId: string | undefined,
    itemId: string,
    notes?: unknown[],
    createdItem?: Record<string, unknown> | null,
  ): Promise<void> {
    if (
      !Array.isArray(notes) ||
      notes.length === 0 ||
      !this.catalogGateway?.createNote
    ) {
      return;
    }

    // If CommitStage already persisted notes via buildCommandCreateInput (notesList / notes / noteCount),
    // skip creating duplicate note rows.
    const existingNotes = Array.isArray(createdItem?.notes)
      ? createdItem.notes
      : Array.isArray(createdItem?.notesList)
        ? createdItem.notesList
        : [];
    if (
      existingNotes.length > 0 ||
      (typeof createdItem?.noteCount === 'number' && createdItem.noteCount > 0)
    ) {
      return;
    }

    const seenContents = new Set<string>();
    for (const noteItem of notes) {
      const rawContent =
        typeof noteItem === 'object' && noteItem !== null
          ? (noteItem as Record<string, unknown>).content
          : undefined;
      const noteSource =
        typeof noteItem === 'object' && noteItem !== null
          ? String((noteItem as Record<string, unknown>).source ?? '')
          : '';
      const noteContent =
        typeof noteItem === 'string'
          ? noteItem
          : typeof rawContent === 'string'
            ? rawContent
            : '';

      const trimmed = noteContent.trim();
      if (!trimmed || seenContents.has(trimmed.toLowerCase())) continue;
      seenContents.add(trimmed.toLowerCase());

      try {
        await this.catalogGateway.createNote(userId, {
          itemId,
          contentMd: trimmed,
          title: noteSource || 'Imported Note',
          projectId,
          createdById: userId,
        });
        this.logger.log(
          `[NOTE] Created note for item ${itemId} (source: ${noteSource || 'unknown'})`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[NOTE] Failed to create note for item ${itemId}: ${msg}`,
        );
      }
    }
  }

  private mapPayloadToSource(kind: string): LibraryItemSource {
    switch (kind) {
      case 'IDENTIFIER':
        return 'doi';
      case 'RECORD':
        return 'bibtex';
      case 'URL':
        return 'url';
      case 'FILE':
        return 'pdf';
      case 'CONNECTOR':
        return 'external_sync';
      default:
        return 'manual';
    }
  }
}
