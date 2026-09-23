import {
  Injectable,
  Logger,
  Optional,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { IngestionSubmissionEnvelope } from '../../domain/types/submission.types';
import { IngestionRepository } from '../../infrastructure/repositories/ingestion.repository';
import { IdentifyStage } from '../../infrastructure/stages/identify.stage';
import { NormalizeStage } from '../../infrastructure/stages/normalize.stage';
import { EnrichStage } from '../../infrastructure/stages/enrich.stage';
import { ReconcileStage } from '../../infrastructure/stages/reconcile.stage';
import { MatchStage } from '../../infrastructure/stages/match.stage';
import { CommitStage } from '../../infrastructure/stages/commit.stage';
import { RetractionScannerProvider } from '../../infrastructure/providers/retraction-scanner.provider';
import {
  BIBLIOGRAPHY_FACADE,
  IBibliographyFacade,
  CATALOG_FACADE,
  ICatalogFacade,
} from '../../../bibliography/bibliography.facade';
import {
  READER_FACADE,
  IReaderFacade,
  CONTENT_FACADE,
  IContentFacade,
} from '../../../reader/reader.facade';
import { LibraryItemSource } from '../../../shared-kernel/outbox/outbox.events';
import { getFileContentPath } from '@/modules/storage/storage.port';
import { IngestionStatus, Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { IngestionRunAggregate } from '../../domain/model/ingestion-run.aggregate';
import { IngestionSagaOrchestrator } from './ingestion-saga.orchestrator';

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
    scopeId !== 'personal' &&
    scopeId !== envelope.userId &&
    isUUID(scopeId);
  const userId = envelope.userId || (scopeId !== 'user' ? scopeId : 'system');
  const projectId = envelope.projectId || (isProject ? scopeId : undefined);
  return { userId, projectId };
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
    private readonly catalogFacade?: ICatalogFacade,
    @Optional()
    @Inject(CONTENT_FACADE)
    private readonly contentFacade?: IContentFacade,
    @Optional()
    sagaOrchestrator?: IngestionSagaOrchestrator,
    @Optional()
    private readonly retractionScanner?: RetractionScannerProvider,
  ) {
    this.orchestrator =
      sagaOrchestrator ??
      new IngestionSagaOrchestrator(repo, catalogFacade);
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

    const aggregate = existingRun
      ? IngestionRunAggregate.reconstitute({
          id: existingRun.id,
          userId: existingRun.userId,
          projectId: existingRun.projectId,
          sourceType:
            (existingRun.inputParams as any)?.sourceType ||
            envelope.payload.kind,
          status: 'RUNNING',
          totalItems: (existingRun.inputParams as any)?.totalItems || 1,
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
    const { initialCandidates, sanitizedOverrides } = await session.executeStep(
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

        for (const cand of candidates) {
          await this.repo.createCandidate(runId, {
            sourceProvider: cand.sourceName,
            sourceRecordId: cand.sourceRecordId,
            confidenceScore: cand.confidenceScore,
            metadataPayload: cand.normalizedMetadata as Prisma.InputJsonValue,
          });
        }

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

    // ── Multi-Record Ingestion Handling (BibTeX / RIS batches) ────────────────
    if (envelope.payload.kind === 'RECORD' && normalizedCandidates.length > 1) {
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
          const itemDecision =
            await this.reconcile.execute(candidatesForRecord);
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
            if (this.retractionScanner) {
              try {
                const scanRes = await this.retractionScanner.scan(
                  itemDecision.proposedItem?.doi,
                  itemDecision.proposedItem?.pmid,
                  itemDecision.proposedItem?.title,
                );
                if (scanRes) {
                  (itemDecision.proposedItem as any).isRetracted = true;
                  (itemDecision.proposedItem as any).retractionNature = scanRes.nature;
                  (itemDecision.proposedItem as any).retractionDetails = scanRes;
                  (itemDecision.proposedItem as any).retractionCheckedAt = new Date().toISOString();
                }
              } catch {
                // Non-blocking scan error
              }
            }

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
            } else {
              failed++;
              progressItems.push({
                title: itemTitle,
                status: 'FAILED',
                error: 'Commit returned empty record',
              });
            }
          }
        } catch (itemErr: any) {
          failed++;
          progressItems.push({
            title: itemTitle,
            status: 'FAILED',
            error: itemErr?.message || 'Processing failed',
          });
        } finally {
          processed++;
          try {
            await this.repo.updateRunProgress(scopeId, runId, {
              total,
              processed,
              succeeded,
              duplicates,
              failed,
              percentage: Math.round((processed / total) * 100),
              currentTitle: itemTitle,
              status: 'PROCESSING',
              items: progressItems.slice(-30),
            });
          } catch {
            // Checkpoint error is non-fatal to the ingestion pipeline
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
          outputSnapshot: (res) => ({
            itemIds: res.itemIds,
            totalProcessed: res.totalProcessed,
            succeeded: res.succeeded,
            duplicates: res.duplicates,
            failed: res.failed,
          }),
        },
      );
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

    // Stage 5: MATCH (Duplicate Detection)
    const matchResult = await session.executeStep(
      'MATCH',
      async () => this.match.execute(resolvedScope, decision.proposedItem),
      {
        outputSnapshot: (res) => res as unknown as Prisma.InputJsonValue,
      },
    );

    // ── Decision Branching ─────────────────────────────────────────────────────

    // EXACT DOI match → Additive metadata enrichment of the existing item.
    if (matchResult.matchType === 'EXACT' && matchResult.targetItemId) {
      const targetItemId = matchResult.targetItemId;
      await session.executeStep(
        'ENRICH_EXISTING',
        async () => {
          let enrichedItem: any = null;
          const enrichPatch: Record<string, any> = {};

          if (this.catalogFacade) {
            const existing = await this.catalogFacade.getItem(
              resolvedScope.userId,
              targetItemId,
              resolvedScope.projectId,
            );

            const p = decision.proposedItem;

            const maybeEnrich = (field: string, proposed: any) => {
              if (proposed == null || proposed === '') return;
              const current = (existing as any)?.[field];
              if (
                current == null ||
                current === '' ||
                (Array.isArray(current) && current.length === 0)
              ) {
                enrichPatch[field] = proposed;
              }
            };

            maybeEnrich('abstract', p.abstract);

            if (p.title && p.title !== 'Untitled Document') {
              const currentTitle = String((existing as any)?.title || '').trim();
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

            maybeEnrich('journal', p.journal);
            maybeEnrich('publicationTitle', p.publicationTitle);
            maybeEnrich('publicationDate', p.publicationDate);
            maybeEnrich('publisher', p.publisher);
            maybeEnrich('place', p.place);
            maybeEnrich('volume', p.volume);
            maybeEnrich('issue', p.issue);
            maybeEnrich('pages', p.pages);
            maybeEnrich('section', p.section);
            maybeEnrich('partNumber', p.partNumber);
            maybeEnrich('partTitle', p.partTitle);
            maybeEnrich('series', p.series);
            maybeEnrich('seriesTitle', p.seriesTitle);
            maybeEnrich('seriesText', p.seriesText);
            maybeEnrich('year', p.year);
            maybeEnrich('url', p.url);
            maybeEnrich('arxivId', p.arxivId);
            maybeEnrich('pmid', p.pmid);
            maybeEnrich('pmcid', p.pmcid);
            maybeEnrich('itemType', p.itemType);
            maybeEnrich('type', p.type);
            maybeEnrich('citationKey', p.citationKey);
            maybeEnrich('issn', p.issn);
            maybeEnrich('isbn', p.isbn);
            maybeEnrich('language', p.language);
            maybeEnrich('rights', p.rights);
            maybeEnrich('license', p.license);
            maybeEnrich('extra', p.extra);
            maybeEnrich('libraryCatalog', p.libraryCatalog);
            maybeEnrich('callNumber', p.callNumber);
            maybeEnrich('archive', p.archive);
            maybeEnrich('archiveLocation', p.archiveLocation);
            maybeEnrich('extraFields', p.extraFields);
            if (p.authors?.length && !existing?.authors?.length) {
              enrichPatch['authors'] = p.authors;
            }
            if (p.editors?.length && !existing?.editors?.length) {
              enrichPatch['editors'] = p.editors;
            }
            if (p.creators?.length && !existing?.creators?.length) {
              enrichPatch['creators'] = p.creators;
            }
            if (p.keywords?.length && !existing?.keywords?.length) {
              enrichPatch['keywords'] = p.keywords;
              enrichPatch['labels'] = p.keywords;
            }

            if (Object.keys(enrichPatch).length > 0) {
              enrichedItem = await this.catalogFacade.updateItem(
                resolvedScope.userId,
                targetItemId,
                enrichPatch,
                { projectId: resolvedScope.projectId },
              );
              this.logger.log(
                `[EXACT_MERGE] Enriched item ${targetItemId} with ${Object.keys(enrichPatch).join(', ')}`,
              );
            } else {
              enrichedItem = existing;
              this.logger.log(
                `[EXACT_MERGE] Item ${targetItemId} already fully populated — no patch needed`,
              );
            }

            const uploadedFileIdentifier =
              envelope.payload.kind === 'FILE'
                ? envelope.payload.fileId
                : (decision.proposedItem as any)?.fileId;
            const uploadedFilename =
              envelope.payload.kind === 'FILE'
                ? envelope.payload.filename || 'document.pdf'
                : (decision.proposedItem as any)?.filename || 'document.pdf';

            if (uploadedFileIdentifier && this.contentFacade) {
              try {
                await this.contentFacade.createAttachment(
                  {
                    itemId: matchResult.targetItemId,
                    fileId: uploadedFileIdentifier,
                    filename: uploadedFilename,
                    url: getFileContentPath(uploadedFileIdentifier),
                    mimeType: 'application/pdf',
                    size: 0,
                    userId: resolvedScope.userId,
                  },
                  resolvedScope.projectId || resolvedScope.userId,
                );
                this.logger.log(
                  `[EXACT_MERGE] Attached file ${uploadedFileIdentifier} to item ${matchResult.targetItemId}`,
                );
              } catch (attachmentError: unknown) {
                const errorMessage =
                  attachmentError instanceof Error
                    ? attachmentError.message
                    : String(attachmentError);
                this.logger.warn(
                  `[EXACT_MERGE] Failed to attach file ${uploadedFileIdentifier} to item ${matchResult.targetItemId}: ${errorMessage}`,
                );
              }
            }

            if (
              Array.isArray(p.notes) &&
              p.notes.length > 0 &&
              this.contentFacade
            ) {
              for (const noteItem of p.notes) {
                const rawContent =
                  typeof noteItem === 'object' && noteItem !== null
                    ? (noteItem as Record<string, unknown>).content
                    : undefined;
                const noteContent =
                  typeof noteItem === 'string'
                    ? noteItem
                    : typeof rawContent === 'string'
                      ? rawContent
                      : '';
                if (!noteContent.trim()) continue;
                await this.contentFacade.createNote(resolvedScope.userId, {
                  itemId: matchResult.targetItemId,
                  contentMd: noteContent.trim(),
                  title: 'Literature Note',
                  projectId: resolvedScope.projectId,
                });
                this.logger.log(
                  `[EXACT_MERGE] Added literature note to item ${matchResult.targetItemId}`,
                );
              }
            }
          }

          await this.repo.createDecision(runId, {
            decisionType: 'UPDATE',
            decisionReason:
              'Exact DOI match — additive enrichment applied to existing item',
            proposedItem: decision.proposedItem as unknown as Prisma.InputJsonValue,
            duplicateMatch: matchResult as unknown as Prisma.InputJsonValue,
          });

          const exactSourceLabel =
            (envelope.payload as any).filename ||
            (envelope.payload as any).url ||
            (envelope.payload as any).value ||
            (decision.proposedItem as any)?.filename ||
            decision.proposedItem?.title ||
            'Document';

          await this.repo.updateRunStatus(scopeId, runId, IngestionStatus.COMPLETED, {
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
          });

          aggregate.recordProgress(1, 0);
          aggregate.complete();

          return {
            itemId: matchResult.targetItemId,
            patchedFields: Object.keys(enrichPatch),
            patchCount: Object.keys(enrichPatch).length,
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

    // PROBABLE fuzzy match → Record duplicate suspect for library Duplicate Items view (Zotero model: non-blocking, commit continues)
    if (matchResult.matchType === 'PROBABLE' && matchResult.targetItemId) {
      await this.repo.createDecision(runId, {
        decisionType: 'DUPLICATE_SUSPECT',
        decisionReason: 'Probable duplicate matched via fuzzy title similarity (recorded for Duplicate Items review)',
        proposedItem: decision.proposedItem as unknown as Prisma.InputJsonValue,
        duplicateMatch: matchResult as unknown as Prisma.InputJsonValue,
      });

      await this.repo.createReviewCase(scopeId, runId, {
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
      });
      // Zotero design: Ingest does not pause or block. Continue to commit so document is immediately in library.
    }

    // Retraction Check: Auto-scan against Retraction Watch & Crossref before commit
    if (this.retractionScanner) {
      try {
        const scanRes = await this.retractionScanner.scan(
          decision.proposedItem?.doi,
          decision.proposedItem?.pmid,
          decision.proposedItem?.title,
        );
        if (scanRes) {
          (decision.proposedItem as any).isRetracted = true;
          (decision.proposedItem as any).retractionNature = scanRes.nature;
          (decision.proposedItem as any).retractionDetails = scanRes;
          (decision.proposedItem as any).retractionCheckedAt = new Date().toISOString();
          this.logger.warn(
            `[RETRACTION_INGESTION_GUARD] Flagged imported item "${decision.proposedItem?.title}" as ${scanRes.nature}`,
          );
        }
      } catch (scanErr: any) {
        this.logger.warn(
          `Retraction check during ingestion skipped: ${scanErr?.message}`,
        );
      }
    }

    // Stage 6: COMMIT (create new Item via CommitStage with Saga Compensation)
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
            fileId:
              envelope.payload.kind === 'FILE'
                ? envelope.payload.fileId
                : (decision.proposedItem as any)?.fileId,
            filename:
              envelope.payload.kind === 'FILE'
                ? envelope.payload.filename
                : (decision.proposedItem as any)?.filename,
          },
        );
      },
      {
        outputSnapshot: (res) => ({ itemId: res?.id }),
        compensate: async (item) => {
          if (item?.id && this.catalogFacade?.deleteItem) {
            this.logger.warn(
              `[SAGA_COMPENSATION] Rolling back committed item ${item.id} for run ${runId}`,
            );
            await this.catalogFacade.deleteItem(
              resolvedScope.userId,
              item.id,
              resolvedScope.projectId,
            );
          }
        },
      },
    );

    try {
      const commitSourceLabel =
        (envelope.payload as any).filename ||
        (envelope.payload as any).url ||
        (envelope.payload as any).value ||
        (decision.proposedItem as any)?.filename ||
        createdItem?.title ||
        'Document';

      await this.repo.updateRunStatus(scopeId, runId, IngestionStatus.COMPLETED, {
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
      });

      aggregate.recordProgress(1, 0);
      aggregate.complete();
    } catch (finalErr: any) {
      await session.rollback('COMMIT', finalErr?.message || String(finalErr));
      throw finalErr;
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

export { PipelineService as IngestionPipelineRunner };
