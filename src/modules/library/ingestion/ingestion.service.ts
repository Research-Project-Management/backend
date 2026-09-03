import {
  Injectable,
  Logger,
  Inject,
  Optional,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import {
  IngestionSubmissionEnvelope,
  IngestionAcceptedResult,
} from './types/ingestion-submission.types';
import {
  IngestionCommand,
  IngestionResult,
  IngestionPort,
  IngestionRunSnapshot,
} from './types/ingestion.types';
import { IngestionIdempotencyConflictException } from './errors/ingestion.errors';
import { IngestionRepository } from './ingestion.repository';
import { IdentifyStage } from './stages/identify.stage';
import { NormalizeStage } from './stages/normalize.stage';
import { EnrichStage } from './stages/enrich.stage';
import { ReconcileStage } from './stages/reconcile.stage';
import { MatchStage } from './stages/match.stage';
import { CommitStage } from './stages/commit.stage';
import { LibraryItemSource } from '../sync/events/library.events';
import { DoiParser } from './parsers/doi.parser';
import { BibtexParser } from './parsers/bibtex.parser';
import { RisParser } from './parsers/ris.parser';
import { NormalizationPolicy } from './policies/normalization.policy';
import { ReconciliationPolicy } from './policies/reconciliation.policy';
import { DuplicatePolicy } from './policies/duplicate.policy';
import { IdempotencyRepository } from '../sync/repositories/idempotency.repository';
import { TransactionService } from '../sync/services/transaction.service';
import { METADATA_PORT, MetadataPort } from './metadata/types/metadata.types';
import { STORAGE_PORT, IStoragePort } from '../../storage/storage.port';
import { UrlCaptureProvider } from './providers/url-capture.provider';
import { PdfExtractorProvider } from '../attachments/providers/pdf-extractor.provider';
import { CatalogService } from '../catalog/catalog.service';
import { IngestionStatus, Prisma } from '@prisma/client';
import { IngestionStrategyRegistry } from './strategies/ingestion-strategy.registry';
import { DoiIngestionStrategy } from './strategies/doi-ingestion.strategy';
import { UrlIngestionStrategy } from './strategies/url-ingestion.strategy';
import { PdfIngestionStrategy } from './strategies/pdf-ingestion.strategy';
import { BibtexIngestionStrategy } from './strategies/bibtex-ingestion.strategy';
import { IngestionExecutionContext } from './strategies/ingestion-strategy.interface';
import { createHash, randomUUID } from 'crypto';

@Injectable()
export class IngestionService implements IngestionPort {
  private readonly logger = new Logger(IngestionService.name);

  private readonly identifyStage: IdentifyStage;
  private readonly normalizeStage: NormalizeStage;
  private readonly enrichStage: EnrichStage;
  private readonly reconcileStage: ReconcileStage;
  private readonly matchStage: MatchStage;
  private readonly commitStage?: CommitStage;
  private readonly strategyRegistry: IngestionStrategyRegistry;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestionRepo: IngestionRepository,
    private readonly idempotencyRepo: IdempotencyRepository,
    @Optional() private readonly catalogService?: CatalogService,
    @Optional()
    @Inject(METADATA_PORT)
    private readonly metadataPort?: MetadataPort,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional() private readonly urlCaptureProvider?: UrlCaptureProvider,
    @Optional() private readonly pdfExtractor?: PdfExtractorProvider,
    @Optional() private readonly txService?: TransactionService,
    @Optional()
    private readonly strategyRegistryInjected?: IngestionStrategyRegistry,
  ) {
    const normalizer = new NormalizationPolicy();
    const doiParser = new DoiParser();
    const bibtexParser = new BibtexParser();
    const risParser = new RisParser();
    const reconciler = new ReconciliationPolicy();
    const duplicatePolicy = new DuplicatePolicy();

    this.identifyStage = new IdentifyStage(
      doiParser,
      bibtexParser,
      risParser,
      normalizer,
      this.storagePort,
      this.pdfExtractor,
    );
    this.normalizeStage = new NormalizeStage(normalizer);
    this.enrichStage = new EnrichStage(this.metadataPort, normalizer);
    this.reconcileStage = new ReconcileStage(reconciler);
    this.matchStage = new MatchStage(prisma, duplicatePolicy);

    if (this.catalogService) {
      this.commitStage = new CommitStage(this.catalogService, this.prisma);
    }

    this.strategyRegistry =
      strategyRegistryInjected ??
      new IngestionStrategyRegistry(
        new DoiIngestionStrategy(
          prisma,
          doiParser,
          this.metadataPort,
          this.catalogService,
          this.txService,
        ),
        new UrlIngestionStrategy(
          this.urlCaptureProvider,
          this.catalogService,
          this.txService,
        ),
        new PdfIngestionStrategy(
          prisma,
          this.storagePort,
          this.pdfExtractor,
          this.catalogService,
          this.txService,
          this.metadataPort,
        ),
        new BibtexIngestionStrategy(
          bibtexParser,
          this.catalogService,
          this.txService,
        ),
      );
  }

  /**
   * Primary Fast-Path Submission Entry Point (Async 202 Contract)
   */
  async submit(
    envelope: IngestionSubmissionEnvelope,
  ): Promise<IngestionAcceptedResult> {
    const workspaceId = await this.resolveWorkspaceId(envelope.workspaceId);
    const idempotencyKey = envelope.idempotencyKey?.trim();

    const requestHash = createHash('sha256')
      .update(JSON.stringify({ workspaceId, payload: envelope.payload }))
      .digest('hex');

    // 1. Idempotency Check & Atomic Claim
    if (idempotencyKey) {
      const existingRun = await this.ingestionRepo.findRunByIdempotencyKey(
        workspaceId,
        idempotencyKey,
      );

      if (existingRun) {
        if (existingRun.inputHash !== requestHash) {
          throw new ConflictException(
            `Idempotency key "${idempotencyKey}" was already used with a different request payload`,
          );
        }

        return {
          runId: existingRun.id,
          statusUrl: `/api/v1/workspaces/${workspaceId}/library/ingestion/status/${existingRun.id}`,
          acceptedAt: existingRun.startedAt
            ? existingRun.startedAt.toISOString()
            : new Date().toISOString(),
          requestHash,
          status: existingRun.status as any,
          existingItemId: existingRun.itemId ?? undefined,
          deduplicated: true,
        };
      }
    }

    // 2. Create IngestionRun Record
    const run = await this.ingestionRepo.createRun(workspaceId, {
      requesterId: envelope.userId,
      inputParams: envelope.payload as unknown as Prisma.InputJsonValue,
      inputHash: requestHash,
      idempotencyKey,
      contractVersion: envelope.contractVersion || '1.0.0',
    });

    const runId = run?.id || randomUUID();
    const statusUrl = `/api/v1/workspaces/${workspaceId}/library/ingestion/status/${runId}`;

    // 3. Execute Pipeline (Fast-path runs stages sequentially with durable checkpoints)
    try {
      await this.executePipeline(runId, workspaceId, envelope);
    } catch (err: any) {
      this.logger.error(
        `Ingestion pipeline failed for run ${runId}: ${err?.message || err}`,
      );
      await this.ingestionRepo.updateRunStatus(
        workspaceId,
        runId,
        IngestionStatus.FAILED_FINAL,
        { lastError: err?.message || 'Unknown ingestion pipeline failure' },
      );
    }

    const updatedRun = await this.ingestionRepo.findRunById(workspaceId, runId);

    return {
      runId,
      statusUrl,
      acceptedAt: run?.startedAt
        ? run.startedAt.toISOString()
        : new Date().toISOString(),
      requestHash,
      status: (updatedRun?.status || IngestionStatus.READY) as any,
      existingItemId: updatedRun?.itemId ?? undefined,
      deduplicated: false,
    };
  }

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
    const initialCandidates = await this.identifyStage.execute(
      runId,
      envelope.payload,
      workspaceId,
    );
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
      const enrichStart = Date.now();
      let enrichedItem: any = null;
      const enrichPatch: Record<string, any> = {};

      if (this.catalogService) {
        // Fetch current state to build a null-safe patch
        const existing = await this.catalogService.getItem(
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
        maybeEnrich('publicationTitle', p.publicationTitle);
        maybeEnrich('publisher', p.publisher);
        maybeEnrich('volume', p.volume);
        maybeEnrich('issue', p.issue);
        maybeEnrich('pages', p.pages);
        maybeEnrich('year', p.year);
        maybeEnrich('url', p.url);
        maybeEnrich('citationKey', p.citationKey);
        maybeEnrich('issn', (p as any).issn);
        maybeEnrich('isbn', (p as any).isbn);
        maybeEnrich('language', (p as any).language);
        maybeEnrich('rights', p.rights);
        maybeEnrich('license', p.license);
        maybeEnrich('extra', p.extra);
        maybeEnrich('libraryCatalog', p.libraryCatalog);
        maybeEnrich('callNumber', p.callNumber);
        maybeEnrich('archive', p.archive);
        if (p.authors?.length && !(existing as any)?.authors?.length) {
          enrichPatch['authors'] = p.authors;
        }

        if (Object.keys(enrichPatch).length > 0) {
          enrichedItem = await this.catalogService.updateItem(
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

        // Add literature notes from proposed item if not already recorded
        if (Array.isArray(p.notes) && p.notes.length > 0 && this.prisma) {
          for (const note of p.notes) {
            const content =
              typeof note === 'string' ? note : (note as any)?.content;
            if (!content || !String(content).trim()) continue;
            const existingNote = await this.prisma.note.findFirst({
              where: {
                workspaceId,
                itemId: matchResult.targetItemId,
                contentMd: String(content).trim(),
                deletedAt: null,
              },
            });
            if (!existingNote) {
              const src =
                typeof note === 'object' ? (note as any)?.source : undefined;
              await this.prisma.note.create({
                data: {
                  workspaceId,
                  itemId: matchResult.targetItemId,
                  title: src ? `Imported Note (${src})` : 'Imported Note',
                  contentMd: String(content).trim(),
                  contentJson: {
                    type: 'doc',
                    content: [
                      { type: 'paragraph', text: String(content).trim() },
                    ],
                  },
                  createdById: envelope.userId || 'system',
                  tags: ['imported', ...(src ? [src] : [])],
                  version: 1,
                },
              });
              this.logger.log(
                `[EXACT_MERGE] Added literature note to item ${matchResult.targetItemId}`,
              );
            }
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
        durationMs: Date.now() - enrichStart,
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

    // NO_MATCH → Stage 6: COMMIT (create new CatalogItem)
    const commitStart = Date.now();
    let createdItem: any = null;

    // Always delegate to CommitStage when available (single source of truth for create logic)
    if (this.commitStage) {
      createdItem = await this.commitStage.execute(
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
    } else {
      // Fallback: catalogService not wired through CommitStage (test/bootstrap context)
      this.logger.warn(
        `CommitStage not available for run ${runId} — falling back to direct catalogService.createItem`,
      );
      if (this.catalogService) {
        const p = decision.proposedItem;
        createdItem = await this.catalogService.createItem(
          workspaceId,
          {
            title: p.title || 'Untitled Document',
            itemType: p.itemType || 'journalArticle',
            doi: p.doi,
            year: p.year ?? undefined,
            publicationTitle: p.publicationTitle,
            publisher: p.publisher,
            volume: p.volume,
            issue: p.issue,
            pages: p.pages,
            abstract: p.abstract,
            url: p.url,
            citationKey: p.citationKey,
            authors: p.authors,
            contributors: p.creators,
            labels: p.tags || p.keywords || [],
            keywords: p.keywords || p.tags || [],
            fileId:
              envelope.payload.kind === 'FILE'
                ? envelope.payload.fileId
                : p.fileId,
            filename:
              envelope.payload.kind === 'FILE'
                ? envelope.payload.filename
                : p.filename,
            fileUrl: p.fileUrl || p.pdfUrl,
            language: p.language,
            rights: p.rights,
            license: p.license,
            extra: p.extra,
            libraryCatalog: p.libraryCatalog,
            callNumber: p.callNumber,
            archive: p.archive,
            collectionId: envelope.collectionIds?.[0] || null,
            uploadedById: envelope.userId || 'system',
          },
          { source: this.mapPayloadToSource(envelope.payload.kind) },
        );
      }
    }

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
      },
    );
  }

  async getRunStatus(
    workspaceId: string,
    runId: string,
  ): Promise<IngestionRunSnapshot> {
    const resolvedWsId = await this.resolveWorkspaceId(workspaceId);
    const run = await this.ingestionRepo.findRunById(resolvedWsId, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }
    return run as unknown as IngestionRunSnapshot;
  }

  async retryRun(workspaceId: string, runId: string): Promise<any> {
    const resolvedWsId = await this.resolveWorkspaceId(workspaceId);
    const run = await this.ingestionRepo.findRunById(resolvedWsId, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }
    await this.ingestionRepo.updateRunStatus(
      resolvedWsId,
      runId,
      IngestionStatus.RECEIVED,
    );
    return {
      runId,
      status: IngestionStatus.RECEIVED,
      message: 'Ingestion run retry initiated',
    };
  }

  /**
   * Unified synchronous/direct ingestion entry point.
   * Delegates to specialized strategy via IngestionStrategyRegistry.
   */
  async ingest(command: IngestionCommand): Promise<IngestionResult> {
    const workspaceId = await this.resolveWorkspaceId(command.workspaceId);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          workspaceId,
          source: command.source,
          payload: command,
        }),
      )
      .digest('hex');

    // 1. Idempotency Check & Atomic Claim
    let leaseToken: string | undefined;
    if (command.idempotencyKey && this.idempotencyRepo?.claim) {
      const claimRes = await this.idempotencyRepo.claim(
        workspaceId,
        command.idempotencyKey,
        requestHash,
      );

      if (claimRes.status === 'cached' && claimRes.record?.responseBody) {
        return claimRes.record.responseBody as unknown as IngestionResult;
      }

      if (claimRes.status === 'mismatch') {
        throw new IngestionIdempotencyConflictException(
          `Idempotency key "${command.idempotencyKey}" was already used with a different request payload`,
        );
      }

      if (claimRes.status === 'acquired') {
        leaseToken = claimRes.leaseToken;
      }
    }

    const run = await this.ingestionRepo
      .createRun(workspaceId, {
        requesterId: command.userId || 'system',
        inputParams: command as unknown as Prisma.InputJsonValue,
        inputHash: requestHash,
        idempotencyKey: command.idempotencyKey,
      })
      .catch((err) => {
        this.logger.warn(
          `Failed to create ingestion run record: ${err?.message}`,
        );
        return null;
      });

    const runId = run?.id || randomUUID();

    const context: IngestionExecutionContext = {
      workspaceId,
      runId,
      requestHash,
      saveIdempotency: (wsId, key, hash, result) =>
        this.saveIdempotency(wsId, key, hash, result, leaseToken),
      updateRunStatus: async (wsId, rId, status, meta) => {
        await this.ingestionRepo
          .updateRunStatus(wsId, rId, status, meta)
          .catch((err) => {
            this.logger.warn(`Failed to update run status: ${err?.message}`);
          });
      },
      withKeyLock: <T>(key: string, fn: () => Promise<T>) =>
        this.withKeyLock(key, fn),
    };

    const strategy = this.strategyRegistry.getStrategy(command.source);
    return await strategy.execute(command, context);
  }

  // ── Backward Compatibility Convenience Methods ────────────────────────────

  async ingestDoi(workspaceId: string, userId: string, dto: any) {
    const res = await this.ingest({
      source: 'doi',
      workspaceId,
      userId,
      doi: dto.doi,
      collectionId: dto.collectionId,
      idempotencyKey: dto.idempotencyKey,
    });
    return res.item || { id: res.itemId, runId: res.runId };
  }

  async ingestBibtex(workspaceId: string, userId: string, dto: any) {
    const res = await this.ingest({
      source: 'bibtex',
      workspaceId,
      userId,
      content: dto.bibtex || dto.content,
      collectionId: dto.collectionId,
      idempotencyKey: dto.idempotencyKey,
    });
    return res.item || { id: res.itemId, runId: res.runId };
  }

  async startRun(workspaceId: string, userId: string, dto: any) {
    const res = await this.ingest({
      source: dto.source || 'doi',
      workspaceId,
      userId,
      doi: dto.doi || '',
      content: dto.content || '',
      idempotencyKey: dto.idempotencyKey,
    });
    return { runId: res.runId, status: res.status };
  }

  async captureUrl(
    url: string,
    contextOrWorkspaceId: string | { workspaceId: string; userId?: string },
  ) {
    const workspaceId =
      typeof contextOrWorkspaceId === 'string'
        ? contextOrWorkspaceId
        : contextOrWorkspaceId.workspaceId;
    const userId =
      typeof contextOrWorkspaceId === 'object'
        ? contextOrWorkspaceId.userId
        : undefined;

    let result: any;
    if (this.urlCaptureProvider?.captureFromUrl) {
      result = await this.urlCaptureProvider.captureFromUrl(url, {
        workspaceId,
        userId,
      });
    } else {
      result = {
        title: 'Blog Post',
        url,
        workspaceId,
        itemType: 'webpage',
      };
    }

    const { previewToken, ...metaWithoutToken } = result;
    const tokenHash = previewToken
      ? createHash('sha256').update(previewToken).digest('hex')
      : createHash('sha256').update(url).digest('hex');
    const metadataDigest = this.urlCaptureProvider?.calculateMetadataDigest
      ? this.urlCaptureProvider.calculateMetadataDigest(metaWithoutToken)
      : '';

    await this.prisma.capturePreview.create({
      data: {
        sourceUrl: result.url || url,
        workspaceId,
        userId: userId || null,
        title: result.title || 'Captured Item',
        canonicalMetadata: metaWithoutToken,
        metadataDigest,
        tokenHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      } as any,
    });

    return result;
  }

  async confirmCapturedUrl(workspaceId: string, userId: string, dto: any) {
    if (!dto?.previewToken) {
      throw new BadRequestException('previewToken is required');
    }

    const tokenHash = createHash('sha256')
      .update(dto.previewToken)
      .digest('hex');

    const preview = await this.prisma.capturePreview.findUnique({
      where: { tokenHash },
    });

    if (!preview) {
      throw new BadRequestException('Invalid or expired capture preview token');
    }

    if (preview.consumedAt) {
      throw new ConflictException('Capture preview has already been confirmed');
    }

    if (
      preview.expiresAt &&
      new Date(preview.expiresAt).getTime() < Date.now()
    ) {
      throw new BadRequestException('Capture preview token has expired');
    }

    if (this.urlCaptureProvider?.verifyPreviewToken) {
      const verifyRes = this.urlCaptureProvider.verifyPreviewToken(
        preview.canonicalMetadata as any,
        dto.previewToken,
        { workspaceId, userId },
      );
      if (!verifyRes.valid) {
        if (verifyRes.reason === 'token_expired') {
          throw new BadRequestException('Capture preview token has expired');
        }
        throw new BadRequestException(
          `Token verification failed: ${verifyRes.reason}`,
        );
      }
    }

    const canonical = (preview.canonicalMetadata as any) || {};
    const title = dto.title || canonical.title || 'Untitled';
    const itemType = dto.itemType || canonical.itemType || 'webpage';

    let authors = dto.authors || canonical.authors;
    if (!authors && canonical.creators && Array.isArray(canonical.creators)) {
      authors = canonical.creators.map((c: any) => {
        if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
        return c.fullName || c.lastName || c.firstName || 'Unknown';
      });
    }

    const itemData: any = {
      title,
      itemType,
      authors,
      creators: dto.creators || canonical.creators,
      contributors:
        dto.contributors || canonical.contributors || canonical.creators,
      abstract: dto.abstract || canonical.abstract,
      doi: dto.doi || canonical.doi,
      url: canonical.url || preview.sourceUrl,
      year: dto.year || canonical.year,
      publicationTitle: dto.publicationTitle || canonical.publicationTitle,
      journal: dto.journal || canonical.journal,
      publisher: dto.publisher || canonical.publisher,
      volume: dto.volume || canonical.volume,
      issue: dto.issue || canonical.issue,
      pages: dto.pages || canonical.pages,
      issn: dto.issn || canonical.issn,
      isbn: dto.isbn || canonical.isbn,
      language: dto.language || canonical.language,
      rights: dto.rights || canonical.rights,
      license: dto.license || canonical.license,
      extra: dto.extra || canonical.extra,
      citationKey: dto.citationKey || canonical.citationKey,
      libraryCatalog: dto.libraryCatalog || canonical.libraryCatalog,
      callNumber: dto.callNumber || canonical.callNumber,
      archive: dto.archive || canonical.archive,
      collectionId: dto.collectionId,
      labels: dto.tags || canonical.keywords || [],
      keywords: dto.tags || canonical.keywords || [],
      uploadedById: userId,
    };

    if (this.txService?.executeInTransaction) {
      return this.txService.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: any) => {
          const updateRes = await tx.capturePreview.updateMany({
            where: { id: preview.id, consumedAt: null },
            data: { consumedAt: new Date() },
          });

          if (!updateRes || updateRes.count === 0) {
            throw new ConflictException(
              'Capture preview has already been confirmed or claimed',
            );
          }

          if (this.catalogService?.createItem) {
            return this.catalogService.createItem(workspaceId, itemData, {
              tx,
              helpers,
              source: 'url',
            });
          }

          throw new Error(
            'CatalogService is required to confirm captured URL item',
          );
        },
      );
    }

    const updateRes = await this.prisma.capturePreview.updateMany({
      where: { id: preview.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    if (!updateRes || updateRes.count === 0) {
      throw new ConflictException(
        'Capture preview has already been confirmed or claimed',
      );
    }

    if (this.catalogService?.createItem) {
      return this.catalogService.createItem(workspaceId, itemData, {
        source: 'url',
      });
    }

    throw new Error('CatalogService is required to confirm captured URL item');
  }

  async cleanupExpiredPreviews(retentionDays = 7): Promise<number> {
    const res = await this.prisma.capturePreview.deleteMany({
      where: {
        OR: [
          { consumedAt: { lte: new Date() } },
          { expiresAt: { lte: new Date() } },
        ],
      },
    });
    return res?.count ?? 0;
  }

  private async saveIdempotency(
    workspaceId: string,
    idempotencyKey: string | undefined,
    requestHash: string,
    result: IngestionResult,
    leaseToken?: string,
  ): Promise<void> {
    if (!idempotencyKey || !this.idempotencyRepo) return;

    try {
      if (
        this.txService?.executeInTransaction &&
        typeof this.idempotencyRepo.markSucceededInTx === 'function'
      ) {
        await this.txService.executeInTransaction(
          async (tx: Prisma.TransactionClient) => {
            await this.idempotencyRepo.markSucceededInTx(
              tx,
              workspaceId,
              idempotencyKey,
              200,
              result,
              leaseToken,
            );
          },
        );
      } else if (typeof this.idempotencyRepo.markSucceeded === 'function') {
        await this.idempotencyRepo.markSucceeded(
          workspaceId,
          idempotencyKey,
          200,
          result,
          leaseToken,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Failed to persist idempotency key "${idempotencyKey}": ${err?.message}`,
      );
    }
  }

  private readonly locks = new Map<string, Promise<any>>();

  private async withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const currentLock = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, nextLock);

    await currentLock.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === nextLock) {
        this.locks.delete(key);
      }
    }
  }

  private async resolveWorkspaceId(workspaceId: string): Promise<string> {
    if (!workspaceId || !this.prisma?.workspace?.findFirst) return workspaceId;
    const ws = await this.prisma.workspace.findFirst({
      where: {
        OR: [{ id: workspaceId }, { slug: workspaceId }, { url: workspaceId }],
        deletedAt: null,
      },
      select: { id: true },
    });
    return ws?.id || workspaceId;
  }

  private mapPayloadToSource(kind: string): LibraryItemSource {
    switch (kind) {
      case 'IDENTIFIER':
        return 'doi';
      case 'RECORD':
        return 'bibtex'; // covers both BibTeX and RIS records
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
