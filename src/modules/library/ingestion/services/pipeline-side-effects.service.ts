import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { RetractionScannerProvider } from '@/modules/library/ingestion/providers/retraction-scanner.provider';
import {
  CATALOG_FACADE,
  ICatalogFacade,
  EXTRACTION_FACADE,
  IExtractionFacade,
  formatAttachmentFilename,
  DEFAULT_RENAME_PATTERN,
  RenamerItemMetadata,
  isPlaceholderItemTitle,
} from '@/modules/library/core';
import { getFileContentPath } from '@/modules/storage/storage.port';
import { IngestionStatus, Prisma } from '@prisma/client';
import { IngestionSubmissionEnvelope } from '@/modules/library/ingestion/types/submission.types';
import { ReconciliationDecision } from '@/modules/library/ingestion/types/metadata-candidate.types';
import { IngestionRunAggregate } from '@/modules/library/ingestion/domain/ingestion-run.aggregate';
import { UrlMetadataScraperService } from './url-metadata-scraper.service';

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
    @Optional()
    private readonly urlScraper?: UrlMetadataScraperService,
  ) {}

  async assignItemToCollection(
    userId: string,
    collectionId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    if (!this.catalogGateway?.assignItemsToCollection) return;
    try {
      await this.catalogGateway.assignItemsToCollection(
        userId,
        collectionId,
        [itemId],
        projectId,
      );
    } catch (err: unknown) {
      this.logger.debug(
        `Could not assign duplicate item ${itemId} to collection ${collectionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async scanRetraction(
    proposedItem?: Record<string, unknown>,
    options?: { localOnly?: boolean },
  ): Promise<void> {
    if (!this.retractionScanner || !proposedItem) return;
    try {
      const doi =
        typeof proposedItem.doi === 'string' ? proposedItem.doi : undefined;
      const pmid =
        typeof proposedItem.pmid === 'string' ? proposedItem.pmid : undefined;

      const res = await this.retractionScanner.lookup(doi, pmid, options);

      if (res.status === 'retracted' && res.details) {
        proposedItem.isRetracted = true;
        proposedItem.retractionNature = res.details.nature;
        proposedItem.retractionDetails = res.details;
        proposedItem.retractionCheckedAt = new Date().toISOString();
        const titleStr =
          typeof proposedItem.title === 'string' ||
          typeof proposedItem.title === 'number'
            ? String(proposedItem.title)
            : '';
        this.logger.warn(
          `[RETRACTION_INGESTION_GUARD] Flagged imported item "${titleStr}" as ${res.details.nature}`,
        );
      } else if (res.status === 'clean') {
        proposedItem.isRetracted = false;
        proposedItem.retractionCheckedAt = new Date().toISOString();
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
    parentMetadata?: Record<string, unknown> | null,
    options?: { rethrowOnError?: boolean },
  ): Promise<void> {
    if (!fileId || !this.extractionGateway?.createAttachment) return;
    if (parentMetadata) {
      const existingAttachments = Array.isArray(parentMetadata.attachments)
        ? (parentMetadata.attachments as Array<{
            fileId?: string | null;
            url?: string | null;
            size?: number | null;
            extractedText?: string | null;
          }>)
        : [];
      const alreadyHasFile = existingAttachments.some(
        (att) =>
          att &&
          (att.fileId === fileId ||
            (typeof att.url === 'string' && att.url.includes(fileId))) &&
          (att.size == null || att.size > 0 || Boolean(att.extractedText)),
      );
      if (alreadyHasFile) {
        return;
      }
    }
    try {
      const fallbackFilename = filename || 'document.pdf';
      let resolvedFilename = fallbackFilename;

      if (parentMetadata) {
        const rawTitle =
          typeof parentMetadata.title === 'string'
            ? parentMetadata.title.trim()
            : '';
        const isGenericTitle =
          isPlaceholderItemTitle(rawTitle) ||
          (parentMetadata.extraFields &&
            typeof parentMetadata.extraFields === 'object' &&
            (parentMetadata.extraFields as Record<string, unknown>)
              .isFilenameTitle === true);

        if (!isGenericTitle) {
          const rawContributors = Array.isArray(parentMetadata.contributors)
            ? parentMetadata.contributors
            : Array.isArray(parentMetadata.creators)
              ? parentMetadata.creators
              : Array.isArray(parentMetadata.authors)
                ? parentMetadata.authors.map((a, idx) =>
                    typeof a === 'string'
                      ? { fullName: a, name: a, orderIndex: idx }
                      : a,
                  )
                : [];

          const renamerInput: RenamerItemMetadata = {
            title: rawTitle,
            shortTitle:
              typeof parentMetadata.shortTitle === 'string'
                ? parentMetadata.shortTitle
                : undefined,
            year:
              typeof parentMetadata.year === 'number'
                ? parentMetadata.year
                : undefined,
            publicationDate:
              typeof parentMetadata.publicationDate === 'string'
                ? parentMetadata.publicationDate
                : undefined,
            publicationTitle:
              typeof parentMetadata.publicationTitle === 'string'
                ? parentMetadata.publicationTitle
                : typeof parentMetadata.journal === 'string'
                  ? parentMetadata.journal
                  : undefined,
            journalAbbr:
              typeof parentMetadata.journalAbbr === 'string'
                ? parentMetadata.journalAbbr
                : undefined,
            publisher:
              typeof parentMetadata.publisher === 'string'
                ? parentMetadata.publisher
                : undefined,
            citationKey:
              typeof parentMetadata.citationKey === 'string'
                ? parentMetadata.citationKey
                : undefined,
            itemType:
              typeof parentMetadata.itemType === 'string'
                ? parentMetadata.itemType
                : undefined,
            doi:
              typeof parentMetadata.doi === 'string'
                ? parentMetadata.doi
                : undefined,
            contributors:
              rawContributors as RenamerItemMetadata['contributors'],
          };

          const formatted = formatAttachmentFilename(
            DEFAULT_RENAME_PATTERN,
            renamerInput,
            fallbackFilename,
          );
          if (formatted && formatted.trim().length > 4) {
            resolvedFilename = formatted;
          }
        }
      }

      await this.extractionGateway.createAttachment(
        {
          itemId,
          fileId,
          filename: resolvedFilename,
          url: getFileContentPath(fileId),
          mimeType: 'application/pdf',
          size: size || 0,
          userId,
        },
        projectId,
      );
      this.logger.log(
        `[ATTACHMENT] Attached file ${fileId} ("${resolvedFilename}") to item ${itemId}`,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `[ATTACHMENT] Failed to attach file ${fileId} to item ${itemId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (options?.rethrowOnError) {
        throw err;
      }
    }
  }

  /**
   * Automatically downloads & attaches Open-Access PDFs and captures Web Snapshots
   * during URL or Identifier ingestion (Zotero 7 Connector parity).
   */
  async autoCaptureWebAssets(params: {
    userId: string;
    projectId?: string;
    itemId: string;
    payloadKind: string;
    sourceUrl?: string;
    proposedItem?: Record<string, unknown>;
    existingFileId?: string;
    overrides?: Record<string, unknown>;
  }): Promise<{ attachedPdfFileId?: string; capturedSnapshot: boolean }> {
    const {
      userId,
      projectId,
      itemId,
      payloadKind,
      sourceUrl,
      proposedItem,
      existingFileId,
      overrides,
    } = params;

    let attachedPdfFileId = existingFileId;
    let capturedSnapshot = false;

    const shouldAttachOaPdf = overrides?.attachOaPdf !== false;
    const shouldSaveSnapshot = overrides?.saveSnapshot !== false;

    // 1. Auto Open-Access PDF Download & Stored Attachment
    if (shouldAttachOaPdf && !attachedPdfFileId && this.urlScraper) {
      const candidateOaUrl =
        (typeof proposedItem?.openAccessPdfUrl === 'string' &&
          proposedItem.openAccessPdfUrl.trim()) ||
        (typeof proposedItem?.pdfUrl === 'string' &&
          proposedItem.pdfUrl.trim()) ||
        (typeof proposedItem?.fileUrl === 'string' &&
          /^https?:\/\//i.test(proposedItem.fileUrl.trim()) &&
          proposedItem.fileUrl.trim()) ||
        '';

      if (candidateOaUrl && /^https?:\/\//i.test(candidateOaUrl)) {
        try {
          const scraped = await this.urlScraper.scrape(candidateOaUrl, {
            scopeId: projectId || userId,
            userId,
          });
          if (scraped?.isPdf && scraped.fileId) {
            attachedPdfFileId = scraped.fileId;
            await this.attachFile(
              userId,
              projectId,
              itemId,
              scraped.fileId,
              scraped.filename || 'document.pdf',
              scraped.fileBuffer?.length || 0,
              proposedItem,
            );
            this.logger.log(
              `[AUTO_OA_PDF] Downloaded & attached Open Access PDF (${scraped.fileId}) from ${candidateOaUrl} to item ${itemId}`,
            );

            // In-house Semantic Extraction: If PDF has extracted keywords, automatically synchronize them into item tags
            if (
              Array.isArray(scraped.keywords) &&
              scraped.keywords.length > 0 &&
              this.catalogGateway?.updateItem
            ) {
              try {
                await this.catalogGateway.updateItem(
                  userId,
                  itemId,
                  { keywords: scraped.keywords },
                  { projectId },
                );
                this.logger.log(
                  `[IN_HOUSE_EXTRACTION] Auto-synced ${scraped.keywords.length} keywords from PDF into item tags for ${itemId}`,
                );
              } catch (kwSyncErr: unknown) {
                this.logger.debug(
                  `[IN_HOUSE_EXTRACTION] Non-fatal keyword sync failed for ${itemId}: ${kwSyncErr instanceof Error ? kwSyncErr.message : String(kwSyncErr)}`,
                );
              }
            }
          }
        } catch (oaErr: unknown) {
          this.logger.debug(
            `[AUTO_OA_PDF] Non-fatal error downloading OA PDF from ${candidateOaUrl}: ${oaErr instanceof Error ? oaErr.message : String(oaErr)}`,
          );
        }
      }
    }

    // 2. Auto Web Snapshot Capture (.html)
    if (shouldSaveSnapshot && this.extractionGateway?.captureWebSnapshot) {
      const itemType =
        typeof proposedItem?.itemType === 'string'
          ? proposedItem.itemType
          : '';
      const isWebOrientedType = [
        'webpage',
        'blogPost',
        'forumPost',
        'newspaperArticle',
        'magazineArticle',
        'encyclopediaArticle',
      ].includes(itemType);

      const snapshotTargetUrl =
        (typeof sourceUrl === 'string' &&
          /^https?:\/\//i.test(sourceUrl.trim()) &&
          sourceUrl.trim()) ||
        (typeof proposedItem?.url === 'string' &&
          /^https?:\/\//i.test(proposedItem.url.trim()) &&
          proposedItem.url.trim()) ||
        '';

      const isPdfDirectUrl = /\.pdf(?:$|\?|#)/i.test(snapshotTargetUrl);

      if (
        snapshotTargetUrl &&
        !isPdfDirectUrl &&
        (payloadKind === 'URL' || (isWebOrientedType && !attachedPdfFileId))
      ) {
        try {
          await this.extractionGateway.captureWebSnapshot(
            snapshotTargetUrl,
            itemId,
            userId,
            projectId,
          );
          capturedSnapshot = true;
          this.logger.log(
            `[AUTO_SNAPSHOT] Captured Web Snapshot from ${snapshotTargetUrl} for item ${itemId}`,
          );
        } catch (snapErr: unknown) {
          this.logger.debug(
            `[AUTO_SNAPSHOT] Non-fatal snapshot capture skipped for ${snapshotTargetUrl}: ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`,
          );
        }
      }
    }

    return { attachedPdfFileId, capturedSnapshot };
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

    const existingNotes = Array.isArray(createdItem?.notes)
      ? createdItem.notes
      : Array.isArray(createdItem?.notesList)
        ? createdItem.notesList
        : [];
    if (
      existingNotes.length === 0 &&
      typeof createdItem?.noteCount === 'number' &&
      createdItem.noteCount > 0
    ) {
      return;
    }

    const seenContents = new Set<string>();
    for (const existingNote of existingNotes) {
      if (typeof existingNote === 'string' && existingNote.trim()) {
        seenContents.add(existingNote.trim().toLowerCase());
      } else if (existingNote && typeof existingNote === 'object') {
        const rec = existingNote as Record<string, unknown>;
        const txt = rec.contentMd ?? rec.content ?? rec.note;
        if (typeof txt === 'string' && txt.trim()) {
          seenContents.add(txt.trim().toLowerCase());
        }
      }
    }
    const notesToCreate: Array<{
      contentMd: string;
      title: string;
      noteSource: string;
    }> = [];

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
      notesToCreate.push({
        contentMd: trimmed,
        title: noteSource || 'Imported Note',
        noteSource,
      });
    }

    const createNote = this.catalogGateway?.createNote?.bind(this.catalogGateway);
    if (!createNote) return;

    await Promise.all(
      notesToCreate.map(async ({ contentMd, title, noteSource }) => {
        try {
          await createNote(userId, {
            itemId,
            contentMd,
            title,
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
      }),
    );
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
