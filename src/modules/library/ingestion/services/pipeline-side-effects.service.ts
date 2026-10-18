import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { RetractionScannerProvider } from '@/modules/library/ingestion/providers/retraction-scanner.provider';
import {
  CATALOG_FACADE,
  ICatalogFacade,
  EXTRACTION_FACADE,
  IExtractionFacade,
} from '@/modules/library/core';
import { getFileContentPath } from '@/modules/storage/storage.port';
import { IngestionStatus, Prisma } from '@prisma/client';
import { IngestionSubmissionEnvelope } from '@/modules/library/ingestion/types/submission.types';
import { ReconciliationDecision } from '@/modules/library/ingestion/types/metadata-candidate.types';
import { IngestionRunAggregate } from '@/modules/library/ingestion/domain/ingestion-run.aggregate';

@Injectable()
export class PipelineSideEffectsService {
  private readonly logger = new Logger(PipelineSideEffectsService.name);

  constructor(
    private readonly repo: IngestionRepository,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
    @Optional()
    @Inject(EXTRACTION_FACADE)
    private readonly extractionGateway?: IExtractionFacade,
    @Optional()
    private readonly retractionScanner?: RetractionScannerProvider,
  ) {}

  async scanRetraction(proposedItem?: Record<string, unknown>): Promise<void> {
    if (!this.retractionScanner || !proposedItem) return;
    try {
      const lookupRes = await this.retractionScanner.lookup(
        typeof proposedItem.doi === 'string' ? proposedItem.doi : undefined,
        typeof proposedItem.pmid === 'string' ? proposedItem.pmid : undefined,
      );
      if (lookupRes.status === 'retracted') {
        const details = lookupRes.details;
        proposedItem.isRetracted = true;
        proposedItem.retractionNature = details.nature;
        proposedItem.retractionDetails = details;
        proposedItem.retractionCheckedAt = new Date().toISOString();
        const titleStr =
          typeof proposedItem.title === 'string' ||
          typeof proposedItem.title === 'number'
            ? String(proposedItem.title)
            : '';
        this.logger.warn(
          `[RETRACTION_INGESTION_GUARD] Flagged imported item "${titleStr}" as ${details.nature}`,
        );
      }
    } catch (scanErr: unknown) {
      const msg = scanErr instanceof Error ? scanErr.message : String(scanErr);
      this.logger.warn(`Retraction check during ingestion skipped: ${msg}`);
    }
  }

  async attachFile(
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

  async materializeNotes(
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
      const rawNoteSource =
        typeof noteItem === 'object' && noteItem !== null
          ? (noteItem as Record<string, unknown>).source
          : undefined;
      const noteSource =
        typeof rawNoteSource === 'string' || typeof rawNoteSource === 'number'
          ? String(rawNoteSource)
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

  async handleBlockedSubmission(params: {
    scopeId: string;
    runId: string;
    envelope: IngestionSubmissionEnvelope;
    decision: ReconciliationDecision;
    aggregate: IngestionRunAggregate;
    sourceLabel?: string;
  }): Promise<void> {
    const { scopeId, runId, decision, aggregate, sourceLabel } = params;
    const wafKind =
      (decision.proposedItem?.extraFields?.wafKind as string) ||
      'WAF_CLOUDFLARE_TURNSTILE';
    const blockedSourceLabel =
      sourceLabel || decision.proposedItem?.url || 'Document';

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
}
