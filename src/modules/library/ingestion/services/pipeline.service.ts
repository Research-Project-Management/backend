import {
  Injectable,
  Logger,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import { IngestionSubmissionEnvelope } from '../types/submission.types';
import { IngestionRepository } from '../ingestion.repository';
import { IdentifyStage } from '../stages/identify.stage';
import { NormalizeStage } from '../stages/normalize.stage';
import { EnrichStage } from '../stages/enrich.stage';
import { ReconcileStage } from '../stages/reconcile.stage';
import { MatchStage } from '../stages/match.stage';
import { CommitStage } from '../stages/commit.stage';
import { LibraryItemSource } from '../../outbox/outbox.events';
import { ItemsService } from '../../items/items.service';
import { NotesService } from '../../notes/notes.service';
import { AttachmentsService } from '../../attachments/attachments.service';
import { getFileContentPath } from '../../../storage/storage.port';
import { IngestionStatus, Prisma } from '@prisma/client';

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    private readonly ingestionRepo: IngestionRepository,
    private readonly identifyStage: IdentifyStage,
    private readonly normalizeStage: NormalizeStage,
    private readonly enrichStage: EnrichStage,
    private readonly reconcileStage: ReconcileStage,
    private readonly matchStage: MatchStage,
    private readonly commitStage: CommitStage,
    private readonly itemsService: ItemsService,
    private readonly notesService: NotesService,
    private readonly attachmentsService: AttachmentsService,
  ) {}

  /**
   * Executes the multi-stage ingestion pipeline.
   */
  async executePipeline(
    runId: string,
    workspaceId: string,
    envelope: IngestionSubmissionEnvelope,
  ): Promise<void> {
    // Stage 1: IDENTIFY & PARSE
    const identifyStart = Date.now();
    const identifiedCandidates = await this.identifyStage.execute(
      runId,
      envelope.payload,
      workspaceId,
    );
    const initialCandidates = identifiedCandidates.map((candidate) => ({
      ...candidate,
      normalizedMetadata: {
        ...candidate.normalizedMetadata,
        ...(envelope.overrides || {}),
      },
    }));
    await this.ingestionRepo.createStage(runId, {
      stageName: 'IDENTIFY',
      durationMs: Date.now() - identifyStart,
      success: true,
      outputSnapshot: {
        candidateCount: initialCandidates.length,
      },
    });

    for (const cand of initialCandidates) {
      await this.ingestionRepo.createCandidate(runId, {
        sourceProvider: cand.sourceName,
        sourceRecordId: cand.sourceRecordId,
        confidenceScore: cand.confidenceScore,
        metadataPayload: cand.normalizedMetadata as Prisma.InputJsonValue,
      });
    }

    if (initialCandidates.length === 0) {
      throw new BadRequestException(
        'No valid bibliographic metadata could be identified from input',
      );
    }

    // Stage 2: NORMALIZE
    const normalizeStart = Date.now();
    const normalizedCandidates =
      await this.normalizeStage.execute(initialCandidates);
    await this.ingestionRepo.createStage(runId, {
      stageName: 'NORMALIZE',
      durationMs: Date.now() - normalizeStart,
      success: true,
      outputSnapshot: {
        candidateCount: normalizedCandidates.length,
      },
    });

    // Stage 3: ENRICH (Crossref, OpenAlex, PubMed, arXiv)
    const enrichStart = Date.now();
    const enrichedCandidates = await this.enrichStage.execute(
      workspaceId,
      normalizedCandidates,
    );
    await this.ingestionRepo.createStage(runId, {
      stageName: 'ENRICH',
      durationMs: Date.now() - enrichStart,
      success: true,
      outputSnapshot: {
        candidateCount: enrichedCandidates.length,
      },
    });

    // ── Multi-Record Ingestion Handling (BibTeX / RIS batches) ────────────────
    if (envelope.payload.kind === 'RECORD' && enrichedCandidates.length > 1) {
      const createdItemIds: string[] = [];
      const total = enrichedCandidates.length;
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

      for (const candidate of enrichedCandidates) {
        const itemTitle =
          candidate.normalizedMetadata?.title ||
          candidate.normalizedMetadata?.shortTitle ||
          'Untitled Record';

        try {
          const itemDecision = await this.reconcileStage.execute([candidate]);
          const matchRes = await this.matchStage.execute(
            workspaceId,
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
            const created = await this.commitStage.execute(
              workspaceId,
              itemDecision.proposedItem,
              {
                collectionIds: envelope.collectionIds,
                tagIds: envelope.tagIds,
                userId: envelope.userId,
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
            await this.ingestionRepo.updateRunProgress(workspaceId, runId, {
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

      await this.ingestionRepo.createStage(runId, {
        stageName: 'COMMIT',
        durationMs: Date.now() - identifyStart,
        success: true,
        outputSnapshot: {
          itemIds: createdItemIds,
          totalProcessed: createdItemIds.length,
          succeeded,
          duplicates,
          failed,
        },
      });

      await this.ingestionRepo.updateRunStatus(
        workspaceId,
        runId,
        IngestionStatus.READY,
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
      return;
    }

    // Stage 4: RECONCILE (Field Provenance & Conflict Detection)
    const reconcileStart = Date.now();
    const decision = await this.reconcileStage.execute(enrichedCandidates);
    await this.ingestionRepo.createStage(runId, {
      stageName: 'RECONCILE',
      durationMs: Date.now() - reconcileStart,
      success: true,
      outputSnapshot: {
        conflictCount: decision.conflicts.length,
        fieldCount: Object.keys(decision.selectedFields).length,
      },
    });

    // Stage 5: MATCH (Duplicate Detection)
    const matchStart = Date.now();
    const matchResult = await this.matchStage.execute(
      workspaceId,
      decision.proposedItem,
    );
    await this.ingestionRepo.createStage(runId, {
      stageName: 'MATCH',
      durationMs: Date.now() - matchStart,
      success: true,
      outputSnapshot: matchResult as unknown as Prisma.InputJsonValue,
    });

    // ── Decision Branching ─────────────────────────────────────────────────────

    // EXACT DOI match → Additive metadata enrichment of the existing item.
    // Only fields that are null/empty on the existing item are updated (safe merge).
    // Fields provided by the user via overrides always win (they are in the reconciled proposal).
    if (matchResult.matchType === 'EXACT' && matchResult.targetItemId) {
      const enrichExistingStart = Date.now();
      let enrichedItem: any = null;
      const enrichPatch: Record<string, any> = {};

      if (this.itemsService) {
        // Fetch current state to build a null-safe patch
        const existing = await this.itemsService.getItem(
          workspaceId,
          matchResult.targetItemId,
        );

        const p = decision.proposedItem;

        // Build patch: only overwrite fields that are currently empty on the existing item
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
        maybeEnrich('title', p.title);
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
          enrichedItem = await this.itemsService.updateItem(
            workspaceId,
            matchResult.targetItemId,
            undefined,
            enrichPatch,
          );
          this.logger.log(
            `[EXACT_MERGE] Enriched item ${matchResult.targetItemId} with ${Object.keys(enrichPatch).join(', ')}`,
          );
        } else {
          enrichedItem = existing;
          this.logger.log(
            `[EXACT_MERGE] Item ${matchResult.targetItemId} already fully populated — no patch needed`,
          );
        }

        // Attach uploaded file to existing item if a file was provided and not yet attached
        if (
          envelope.payload.kind === 'FILE' &&
          envelope.payload.fileId &&
          this.attachmentsService
        ) {
          const uploadedFileIdentifier = envelope.payload.fileId;
          const uploadedFilename = envelope.payload.filename || 'document.pdf';
          try {
            await this.attachmentsService.createAttachment({
              workspaceId,
              catalogItemId: matchResult.targetItemId,
              fileId: uploadedFileIdentifier,
              filename: uploadedFilename,
              url: getFileContentPath(uploadedFileIdentifier),
              mimeType: 'application/pdf',
              size: 0,
            });
            this.logger.log(
              `[EXACT_MERGE] Attached uploaded file ${uploadedFileIdentifier} to item ${matchResult.targetItemId}`,
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

        // Add literature notes from proposed item if not already recorded
        if (Array.isArray(p.notes) && p.notes.length > 0 && this.notesService) {
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
            const noteSource =
              typeof noteItem === 'object' && noteItem !== null
                ? typeof (noteItem as Record<string, unknown>).source ===
                  'string'
                  ? String((noteItem as Record<string, unknown>).source)
                  : undefined
                : undefined;
            await this.notesService.createLiteratureNote(
              workspaceId,
              matchResult.targetItemId,
              envelope.userId || 'system',
              noteContent.trim(),
              noteSource,
            );
            this.logger.log(
              `[EXACT_MERGE] Added literature note to item ${matchResult.targetItemId}`,
            );
          }
        }
      }

      await this.ingestionRepo.createDecision(runId, {
        decisionType: 'UPDATE',
        decisionReason:
          'Exact DOI match — additive enrichment applied to existing item',
        proposedItem: decision.proposedItem as unknown as Prisma.InputJsonValue,
        duplicateMatch: matchResult as unknown as Prisma.InputJsonValue,
      });

      await this.ingestionRepo.createStage(runId, {
        stageName: 'ENRICH_EXISTING',
        durationMs: Date.now() - enrichExistingStart,
        success: true,
        outputSnapshot: {
          itemId: matchResult.targetItemId,
          patchedFields: Object.keys(enrichPatch),
          patchCount: Object.keys(enrichPatch).length,
        },
      });

      await this.ingestionRepo.updateRunStatus(
        workspaceId,
        runId,
        IngestionStatus.READY,
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
                title: decision.proposedItem?.title || 'Document',
                status: 'DUPLICATE',
                itemId: matchResult.targetItemId,
              },
            ],
          } as unknown as Prisma.InputJsonValue,
        },
      );
      return;
    }

    // PROBABLE fuzzy match → Queue for human review (unchanged)
    if (matchResult.matchType === 'PROBABLE' && matchResult.targetItemId) {
      await this.ingestionRepo.createDecision(runId, {
        decisionType: 'REVIEW',
        decisionReason: 'Probable duplicate matched via fuzzy title similarity',
        proposedItem: decision.proposedItem as unknown as Prisma.InputJsonValue,
        duplicateMatch: matchResult as unknown as Prisma.InputJsonValue,
      });

      await this.ingestionRepo.createReviewCase(workspaceId, runId, {
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

      await this.ingestionRepo.updateRunStatus(
        workspaceId,
        runId,
        IngestionStatus.NEEDS_REVIEW,
        { completedAt: new Date() },
      );
      return;
    }

    // Stage 6: COMMIT (create new CatalogItem via CommitStage)
    const commitStart = Date.now();
    const createdItem = await this.commitStage.execute(
      workspaceId,
      decision.proposedItem,
      {
        collectionIds: envelope.collectionIds,
        tagIds: envelope.tagIds,
        userId: envelope.userId,
        source: this.mapPayloadToSource(envelope.payload.kind),
        fileId:
          envelope.payload.kind === 'FILE'
            ? envelope.payload.fileId
            : undefined,
        filename:
          envelope.payload.kind === 'FILE'
            ? envelope.payload.filename
            : undefined,
      },
    );

    await this.ingestionRepo.createStage(runId, {
      stageName: 'COMMIT',
      durationMs: Date.now() - commitStart,
      success: true,
      outputSnapshot: { itemId: createdItem?.id },
    });

    await this.ingestionRepo.updateRunStatus(
      workspaceId,
      runId,
      IngestionStatus.READY,
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
              title: createdItem?.title || 'Document',
              status: 'SUCCEEDED',
              itemId: createdItem?.id,
            },
          ],
        } as unknown as Prisma.InputJsonValue,
      },
    );
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
