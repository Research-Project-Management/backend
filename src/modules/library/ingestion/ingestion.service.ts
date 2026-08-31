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
} from './types/ingestion.types';
import {
  IngestionValidationException,
  IngestionIdempotencyConflictException,
} from './errors/ingestion.errors';
import { IngestionRepository } from './ingestion.repository';
import { IdentifyStage } from './stages/identify.stage';
import { NormalizeStage } from './stages/normalize.stage';
import { EnrichStage } from './stages/enrich.stage';
import { ReconcileStage } from './stages/reconcile.stage';
import { MatchStage } from './stages/match.stage';
import { CommitStage } from './stages/commit.stage';
import { DoiParser } from './parsers/doi.parser';
import { BibtexParser } from './parsers/bibtex.parser';
import { RisParser } from './parsers/ris.parser';
import { NormalizationPolicy } from './policies/normalization.policy';
import { ReconciliationPolicy } from './policies/reconciliation.policy';
import { DuplicatePolicy } from './policies/duplicate.policy';
import { MetadataRoutingPolicy } from './metadata/policies/metadata.policy';
import { IdempotencyRepository } from '../sync/repositories/idempotency.repository';
import { TransactionService } from '../sync/services/transaction.service';
import { METADATA_PORT, MetadataPort } from './metadata/types/metadata.types';
import { STORAGE_PORT, IStoragePort } from '../../storage/storage.port';
import { UrlCaptureProvider } from './providers/url-capture.provider';
import { PdfExtractorProvider } from '../attachments/providers/pdf-extractor.provider';
import { CatalogService } from '../catalog/catalog.service';
import { IngestionStatus, Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { randomUUID, createHash } from 'crypto';

@Injectable()
export class IngestionService implements IngestionPort {
  private readonly logger = new Logger(IngestionService.name);
  private ingestionRepo: IngestionRepository;
  private idempotencyRepo: IdempotencyRepository;
  private identifyStage: IdentifyStage;
  private normalizeStage: NormalizeStage;
  private enrichStage: EnrichStage;
  private reconcileStage: ReconcileStage;
  private matchStage: MatchStage;
  private commitStage?: CommitStage;
  private catalogService?: CatalogService;
  private libraryTx?: TransactionService;
  private storagePort?: IStoragePort;
  private urlConnector?: any;
  private extractorService?: any;
  private metadataPort?: MetadataPort;
  private bibtexParserService: BibtexParser;
  private doiParserService: DoiParser;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(TransactionService)
    param2?: any,
    @Optional()
    @Inject(IdempotencyRepository)
    param3?: any,
    @Optional()
    @Inject(PdfExtractorProvider)
    param4?: any,
    @Optional()
    @Inject(BibtexParser)
    param5?: any,
    @Optional()
    @Inject(STORAGE_PORT)
    param6?: any,
    @Optional()
    @Inject(UrlCaptureProvider)
    param7?: any,
    @Optional()
    @Inject(METADATA_PORT)
    param8?: any,
    @Optional()
    @Inject(CatalogService)
    param9?: any,
    @Optional()
    @Inject(IngestionRepository)
    param10?: any,
  ) {
    const normalizer = new NormalizationPolicy();
    const doiParser = new DoiParser();
    const bibtexParser = new BibtexParser();
    const risParser = new RisParser();
    const reconciler = new ReconciliationPolicy();
    const duplicatePolicy = new DuplicatePolicy();

    this.doiParserService = doiParser;
    this.bibtexParserService = bibtexParser;
    this.ingestionRepo = new IngestionRepository(prisma);
    this.idempotencyRepo = new IdempotencyRepository(prisma);

    const injectedArgs = [
      param2,
      param3,
      param4,
      param5,
      param6,
      param7,
      param8,
      param9,
      param10,
    ].filter(Boolean);

    for (const arg of injectedArgs) {
      if (
        arg instanceof IngestionRepository ||
        (arg.createRun && arg.findRunById)
      ) {
        this.ingestionRepo = arg;
      } else if (
        arg instanceof IdempotencyRepository ||
        arg.markSucceededInTx
      ) {
        this.idempotencyRepo = arg;
      } else if (
        arg instanceof CatalogService ||
        (arg.createItem && !arg.executeInTransaction)
      ) {
        this.catalogService = arg;
      } else if (
        arg instanceof TransactionService ||
        arg.executeInTransaction
      ) {
        this.libraryTx = arg;
      } else if (
        arg instanceof UrlCaptureProvider ||
        arg.captureFromUrl ||
        arg.captureUrl
      ) {
        this.urlConnector = arg;
      } else if (arg.resolve) {
        this.metadataPort = arg;
      } else if (arg.readOwnedFile) {
        this.storagePort = arg;
      } else if (
        arg.extractDocumentFromBuffer ||
        arg.extractMetadataFromBuffer
      ) {
        this.extractorService = arg;
      } else if (arg instanceof BibtexParser) {
        this.bibtexParserService = arg;
      }
    }

    this.identifyStage = new IdentifyStage(
      doiParser,
      bibtexParser,
      risParser,
      normalizer,
    );
    this.normalizeStage = new NormalizeStage(normalizer);
    this.enrichStage = new EnrichStage(this.metadataPort, normalizer);
    this.reconcileStage = new ReconcileStage(reconciler);
    this.matchStage = new MatchStage(prisma, duplicatePolicy);
    if (this.catalogService) {
      this.commitStage = new CommitStage(this.catalogService);
    }
  }

  /**
   * Primary Fast-Path Submission Entry Point (Async 202 Contract)
   */
  async submit(
    envelope: IngestionSubmissionEnvelope,
  ): Promise<IngestionAcceptedResult> {
    const workspaceId = await this.resolveWorkspaceId(envelope.workspaceId);
    const idempotencyKey = envelope.idempotencyKey?.trim();

    const requestHash = crypto
      .createHash('sha256')
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

    // Decision Branching
    if (matchResult.matchType === 'EXACT' && matchResult.targetItemId) {
      await this.ingestionRepo.createDecision(runId, {
        decisionType: 'UPDATE',
        decisionReason: 'Exact DOI match found in workspace',
        proposedItem: decision.proposedItem as unknown as Prisma.InputJsonValue,
        duplicateMatch: matchResult as unknown as Prisma.InputJsonValue,
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
        {
          completedAt: new Date(),
        },
      );
      return;
    }

    // Stage 6: COMMIT (No match -> Create new CatalogItem)
    const commitStart = Date.now();
    let createdItem: any = null;

    if (this.commitStage) {
      createdItem = await this.commitStage.execute(
        workspaceId,
        decision.proposedItem,
        {
          collectionIds: envelope.collectionIds,
          tagIds: envelope.tagIds,
          userId: envelope.userId,
          source: this.mapPayloadToSource(envelope.payload.kind),
        },
      );
    } else if (this.catalogService) {
      createdItem = await this.catalogService.createItem(
        workspaceId,
        {
          title: decision.proposedItem.title || 'Untitled Document',
          itemType: decision.proposedItem.itemType || 'journalArticle',
          doi: decision.proposedItem.doi,
          year: decision.proposedItem.year ?? undefined,
          publicationTitle: decision.proposedItem.publicationTitle,
          publisher: decision.proposedItem.publisher,
          volume: decision.proposedItem.volume,
          issue: decision.proposedItem.issue,
          pages: decision.proposedItem.pages,
          abstract: decision.proposedItem.abstract,
          url: decision.proposedItem.url,
          citationKey: decision.proposedItem.citationKey,
          authors: decision.proposedItem.authors,
          contributors: decision.proposedItem.creators,
          labels: decision.proposedItem.tags,
          collectionId: envelope.collectionIds?.[0] || null,
          uploadedById: envelope.userId || 'system',
        },
        { source: 'manual' },
      );
    } else if (this.libraryTx) {
      createdItem = await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: any) => {
          if (this.catalogService) {
            return this.catalogService.createItem(
              workspaceId,
              {
                title: decision.proposedItem.title || 'Untitled Document',
                doi: decision.proposedItem.doi,
                year: decision.proposedItem.year ?? undefined,
                publicationTitle: decision.proposedItem.publicationTitle,
                uploadedById: envelope.userId || 'system',
              },
              { tx, helpers, source: 'manual' },
            );
          }
          throw new Error('CatalogService is required to commit ingestion item');
        },
      );
    }

    await this.ingestionRepo.createStage(runId, {
      stageName: 'COMMIT',
      durationMs: Date.now() - commitStart,
      success: true,
      outputSnapshot: { itemId: createdItem?.id },
    });

    await this.ingestionRepo.createDecision(runId, {
      decisionType: 'CREATE',
      decisionReason: 'New item created successfully in catalog',
      proposedItem: decision.proposedItem as unknown as Prisma.InputJsonValue,
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

  // ── Status & Retry Operations ─────────────────────────────────────────────

  async getRunStatus(workspaceId: string, runId: string): Promise<any> {
    const run = await this.ingestionRepo.findRunById(workspaceId, runId);
    if (!run) {
      throw new NotFoundException(
        `Ingestion run "${runId}" not found in workspace "${workspaceId}"`,
      );
    }

    return {
      id: run.id,
      runId: run.id,
      workspaceId: run.workspaceId,
      status: run.status,
      itemId: run.itemId,
      inputHash: run.inputHash,
      attempts: run.attempts,
      lastError: run.lastError,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      stages: run.stages,
      candidates: run.candidates,
      decisions: run.decisions,
      reviewCases: run.reviewCases,
    };
  }

  async retryRun(
    workspaceId: string,
    runId: string,
  ): Promise<IngestionAcceptedResult> {
    const run = await this.ingestionRepo.findRunById(workspaceId, runId);
    if (!run) {
      throw new NotFoundException(
        `Ingestion run "${runId}" not found in workspace`,
      );
    }

    if (run.status === IngestionStatus.READY) {
      throw new BadRequestException('Ingestion run is already completed');
    }

    await this.ingestionRepo.updateRunStatus(
      workspaceId,
      runId,
      IngestionStatus.RECEIVED,
      { lastError: undefined },
    );

    const envelope: IngestionSubmissionEnvelope = {
      workspaceId,
      userId: run.requesterId ?? undefined,
      payload: run.inputParams as any,
      contractVersion: run.contractVersion,
    };

    try {
      await this.executePipeline(run.id, workspaceId, envelope);
    } catch (err: any) {
      await this.ingestionRepo.updateRunStatus(
        workspaceId,
        run.id,
        IngestionStatus.FAILED_FINAL,
        { lastError: err?.message || 'Retry failed' },
      );
    }

    const updated = await this.ingestionRepo.findRunById(workspaceId, run.id);
    return {
      runId: run.id,
      statusUrl: `/api/v1/workspaces/${workspaceId}/library/ingestion/status/${run.id}`,
      acceptedAt: run.startedAt
        ? run.startedAt.toISOString()
        : new Date().toISOString(),
      requestHash: run.inputHash,
      status: (updated?.status || IngestionStatus.RECEIVED) as any,
      existingItemId: updated?.itemId ?? undefined,
      deduplicated: false,
    };
  }

  private async saveIdempotency(
    workspaceId: string,
    idempotencyKey?: string,
    requestHash?: string,
    result?: IngestionResult,
  ): Promise<void> {
    if (idempotencyKey && result && this.idempotencyRepo?.markSucceeded) {
      try {
        await this.idempotencyRepo.markSucceeded(
          workspaceId,
          idempotencyKey,
          200,
          result,
        );
      } catch (err: any) {
        this.logger.warn(
          `Failed to record idempotency success for ${idempotencyKey}: ${err?.message}`,
        );
      }
    }
  }

  private locks = new Map<string, Promise<void>>();

  private async withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }
    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((res) => {
      resolveLock = res;
    });
    this.locks.set(key, lockPromise);
    try {
      return await fn();
    } finally {
      this.locks.delete(key);
      resolveLock();
    }
  }

  // ── Backward Compatibility Adapter for IngestionPort ─────────────────────

  async ingest(command: IngestionCommand): Promise<IngestionResult> {
    const workspaceId = await this.resolveWorkspaceId(command.workspaceId);
    const runId = randomUUID();

    // 1. Idempotency handling
    let requestHash = '';
    if (command.idempotencyKey && this.idempotencyRepo?.claim) {
      requestHash = createHash('sha256')
        .update(
          JSON.stringify({
            source: command.source,
            workspaceId,
            doi: (command as any).doi,
            url: (command as any).url,
            content: (command as any).content,
            fileId: (command as any).fileId,
            filename: (command as any).filename,
            overrides: (command as any).overrides,
          }),
        )
        .digest('hex');

      const claimRes = await this.idempotencyRepo.claim(
        workspaceId,
        command.idempotencyKey,
        requestHash,
      );
      if (
        claimRes?.status === 'cached' &&
        (claimRes as any).record?.responseBody
      ) {
        return (claimRes as any).record.responseBody as IngestionResult;
      }
      if (claimRes?.status === 'mismatch') {
        throw new IngestionIdempotencyConflictException(
          'Idempotency key mismatch: payload does not match previously recorded request',
        );
      }
    }

    if (this.ingestionRepo?.createRun) {
      try {
        await this.ingestionRepo.createRun(workspaceId, {
          id: runId,
          requesterId: command.userId || 'system',
          inputParams: command as any,
          inputHash:
            requestHash ||
            createHash('sha256')
              .update(JSON.stringify(command))
              .digest('hex'),
          idempotencyKey: (command as any).idempotencyKey,
          contractVersion: '1.0.0',
          pipelineVersion: '1.0.0',
          status: IngestionStatus.RECEIVED,
        });
      } catch (err: any) {
        this.logger.warn(`Could not create ingestion run record: ${err?.message}`);
      }
    }

    // 2. Specific format handling via decoupled handlers
    switch (command.source) {
      case 'doi':
        return this.handleDoiIngestion(command, workspaceId, runId, requestHash);
      case 'url':
        return this.handleUrlIngestion(command, workspaceId, runId, requestHash);
      case 'bibtex':
        return this.handleBibtexIngestion(command, workspaceId, runId, requestHash);
      case 'pdf':
        return this.handlePdfIngestion(command, workspaceId, runId, requestHash);
      default:
        throw new BadRequestException(`Unsupported ingestion source: ${(command as any).source}`);
    }
  }

  // ── Handler: DOI Ingestion ────────────────────────────────────────────────

  private async handleDoiIngestion(
    command: IngestionCommand & { source: 'doi' },
    workspaceId: string,
    runId: string,
    requestHash: string,
  ): Promise<IngestionResult> {
    const cleanDoi = this.doiParserService.isValid(command.doi)
      ? this.doiParserService.normalize(command.doi)
      : command.doi.toLowerCase().trim();

    return await this.withKeyLock(`${workspaceId}:doi:${cleanDoi}`, async () => {
      // Check dedup claim or existing item
      const claim = await this.prisma.libraryDedupClaim.findUnique({
      where: {
        workspaceId_claimType_claimValue: {
          workspaceId,
          claimType: 'doi',
          claimValue: cleanDoi,
        },
      },
      include: {
        catalogItem: true,
      },
    });

    if (claim?.catalogItem) {
      if (claim.catalogItem.deletedAt) {
        const restored = await this.prisma.catalogItem.update({
          where: { id: claim.catalogItem.id },
          data: { deletedAt: null },
        });
        const result: IngestionResult = {
          runId,
          status: 'completed',
          itemId: restored.id,
          attachmentIds: [],
          deduplicated: true,
          item: restored,
        };
        await this.saveIdempotency(
          workspaceId,
          command.idempotencyKey,
          requestHash,
          result,
        );
        await this.ingestionRepo.updateRunStatus(
          workspaceId,
          runId,
          IngestionStatus.READY,
          { itemId: restored.id, completedAt: new Date() },
        ).catch(() => {});
        return result;
      }

      const result: IngestionResult = {
        runId,
        status: 'completed',
        itemId: claim.catalogItem.id,
        attachmentIds: [],
        deduplicated: true,
        item: claim.catalogItem,
      };
      await this.saveIdempotency(
        workspaceId,
        command.idempotencyKey,
        requestHash,
        result,
      );
      await this.ingestionRepo.updateRunStatus(
        workspaceId,
        runId,
        IngestionStatus.READY,
        { itemId: claim.catalogItem.id, completedAt: new Date() },
      ).catch(() => {});
      return result;
    }

    const existing = await this.prisma.catalogItem.findFirst({
      where: {
        workspaceId,
        doi: cleanDoi,
      },
    });

    if (existing) {
      if (existing.deletedAt) {
        const restored = await this.prisma.catalogItem.update({
          where: { id: existing.id },
          data: { deletedAt: null },
        });
        await this.prisma.libraryDedupClaim.upsert({
          where: {
            workspaceId_claimType_claimValue: {
              workspaceId,
              claimType: 'doi',
              claimValue: cleanDoi,
            },
          },
          update: { catalogItemId: restored.id },
          create: {
            workspaceId,
            claimType: 'doi',
            claimValue: cleanDoi,
            catalogItemId: restored.id,
          },
        }).catch(() => {});

        const result: IngestionResult = {
          runId,
          status: 'completed',
          itemId: restored.id,
          attachmentIds: [],
          deduplicated: true,
          item: restored,
        };
        await this.saveIdempotency(
          workspaceId,
          command.idempotencyKey,
          requestHash,
          result,
        );
        await this.ingestionRepo.updateRunStatus(
          workspaceId,
          runId,
          IngestionStatus.READY,
          { itemId: restored.id, completedAt: new Date() },
        ).catch(() => {});
        return result;
      }

      await this.prisma.libraryDedupClaim.upsert({
        where: {
          workspaceId_claimType_claimValue: {
            workspaceId,
            claimType: 'doi',
            claimValue: cleanDoi,
          },
        },
        update: { catalogItemId: existing.id },
        create: {
          workspaceId,
          claimType: 'doi',
          claimValue: cleanDoi,
          catalogItemId: existing.id,
        },
      }).catch(() => {});

      const result: IngestionResult = {
        runId,
        status: 'completed',
        itemId: existing.id,
        attachmentIds: [],
        deduplicated: true,
        item: existing,
      };
      await this.saveIdempotency(
        workspaceId,
        command.idempotencyKey,
        requestHash,
        result,
      );
      await this.ingestionRepo.updateRunStatus(
        workspaceId,
        runId,
        IngestionStatus.READY,
        { itemId: existing.id, completedAt: new Date() },
      ).catch(() => {});
      return result;
    }

    // Resolve via metadata service
    let resolvedMeta: any = null;
    if (this.metadataPort?.resolve) {
      resolvedMeta = await this.metadataPort.resolve({
        query: cleanDoi,
        workspaceId,
      });
    }

    const meta =
      resolvedMeta?.metadata ||
      resolvedMeta || { title: 'Imported DOI Document', doi: cleanDoi };

    let createdItem: any = null;
    let isDedup = false;
    const itemData: any = {
      title: meta.title || 'Untitled Document',
      doi: cleanDoi,
      year: meta.year,
      authors: meta.authors || [],
      abstract: meta.abstract,
      publicationTitle: meta.publicationTitle || meta.journal,
      journal: meta.journal,
      uploadedById: command.userId || 'system',
      collectionId: command.collectionId,
      itemType: meta.itemType || 'journalArticle',
    };

    if (this.libraryTx?.executeInTransaction) {
      createdItem = await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: any) => {
          // Check race condition inside tx
          const raceClaim = await tx.libraryDedupClaim.findUnique({
            where: {
              workspaceId_claimType_claimValue: {
                workspaceId,
                claimType: 'doi',
                claimValue: cleanDoi,
              },
            },
            include: { catalogItem: true },
          });
          if (raceClaim?.catalogItem) {
            isDedup = true;
            return raceClaim.catalogItem;
          }

          let item: any;
          if (this.catalogService?.createItem) {
            item = await this.catalogService.createItem(
              workspaceId,
              itemData,
              {
                tx,
                helpers,
                source: 'doi',
              },
            );
          } else {
            throw new Error('CatalogService is required to create DOI item');
          }

          try {
            await tx.libraryDedupClaim.create({
              data: {
                workspaceId,
                claimType: 'doi',
                claimValue: cleanDoi,
                catalogItemId: item.id,
              },
            });
          } catch {
            const winner = await tx.libraryDedupClaim.findUnique({
              where: {
                workspaceId_claimType_claimValue: {
                  workspaceId,
                  claimType: 'doi',
                  claimValue: cleanDoi,
                },
              },
              include: { catalogItem: true },
            });
            if (winner?.catalogItem) {
              isDedup = true;
              return winner.catalogItem;
            }
          }

          return item;
        },
      );
    } else if (this.catalogService?.createItem) {
      createdItem = await this.catalogService.createItem(
        workspaceId,
        itemData,
        {
          source: 'doi',
        },
      );
    }

    const result: IngestionResult = {
      runId,
      status: 'completed',
      itemId: createdItem?.id,
      attachmentIds: [],
      deduplicated: isDedup,
      item: createdItem,
    };

    await this.saveIdempotency(
      workspaceId,
      command.idempotencyKey,
      requestHash,
      result,
    );
    await this.ingestionRepo.updateRunStatus(
      workspaceId,
      runId,
      IngestionStatus.READY,
      { itemId: result.itemId, completedAt: new Date() },
    ).catch(() => {});

      return result;
    });
  }

  // ── Handler: URL Ingestion ────────────────────────────────────────────────

  private async handleUrlIngestion(
    command: IngestionCommand & { source: 'url' },
    workspaceId: string,
    runId: string,
    requestHash: string,
  ): Promise<IngestionResult> {
    try {
      MetadataRoutingPolicy.validateUrl(command.url);
    } catch (err: any) {
      throw new IngestionValidationException(
        `SSRF violation: ${err?.message || err}`,
      );
    }

    let captured: any = null;
    if (this.urlConnector?.captureFromUrl) {
      try {
        captured = await this.urlConnector.captureFromUrl(command.url, {
          workspaceId,
        });
      } catch {
        captured = {
          title: command.overrides?.title || 'Web Page',
          url: command.url,
          itemType: 'webpage',
        };
      }
    }

    let createdItem: any = null;
    const urlItemData: any = {
      title: command.overrides?.title || captured?.title || 'Web Page',
      abstract: command.overrides?.abstract || captured?.abstract,
      url: command.url,
      fileUrl: command.url,
      authors: captured?.authors || [],
      labels: command.overrides?.tags || [],
      keywords: command.overrides?.tags || [],
      uploadedById: command.userId || 'system',
      collectionId: command.collectionId,
      itemType: captured?.itemType || 'webpage',
    };

    if (this.libraryTx?.executeInTransaction) {
      createdItem = await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: any) => {
          if (this.catalogService?.createItem) {
            return await this.catalogService.createItem(
              workspaceId,
              urlItemData,
              {
                tx,
                helpers,
                source: 'url',
              },
            );
          }
          throw new Error('CatalogService is required to create URL item');
        },
      );
    } else if (this.catalogService?.createItem) {
      createdItem = await this.catalogService.createItem(
        workspaceId,
        urlItemData,
        {
          source: 'url',
        },
      );
    }

    const result: IngestionResult = {
      runId,
      status: 'completed',
      itemId: createdItem?.id,
      attachmentIds: [],
      deduplicated: false,
      item: createdItem,
    };
    await this.saveIdempotency(
      workspaceId,
      command.idempotencyKey,
      requestHash,
      result,
    );
    await this.ingestionRepo.updateRunStatus(
      workspaceId,
      runId,
      IngestionStatus.READY,
      { itemId: result.itemId, completedAt: new Date() },
    ).catch(() => {});

    return result;
  }

  // ── Handler: BibTeX Ingestion ─────────────────────────────────────────────

  private async handleBibtexIngestion(
    command: IngestionCommand & { source: 'bibtex' },
    workspaceId: string,
    runId: string,
    requestHash: string,
  ): Promise<IngestionResult> {
    if (command.content && command.content.length > 10 * 1024 * 1024) {
      throw new IngestionValidationException(
        'BibTeX payload exceeds 10MB limit',
      );
    }

    const entries = this.bibtexParserService.parse(command.content);
    const first = entries[0] || { title: 'BibTeX Item' };

    let createdItem: any = null;
    const bibItemData: any = {
      title: first.title,
      doi: first.doi,
      year: first.year,
      authors: first.authors || [],
      journal: first.journal,
      publicationTitle: first.journal || first.publisher,
      publisher: first.publisher,
      citationKey: first.citationKey,
      abstract: first.abstract,
      uploadedById: command.userId || 'system',
      collectionId: command.collectionId,
      itemType: first.itemType || 'journalArticle',
    };

    if (this.libraryTx?.executeInTransaction) {
      createdItem = await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: any) => {
          if (this.catalogService?.createItem) {
            return await this.catalogService.createItem(
              workspaceId,
              bibItemData,
              {
                tx,
                helpers,
                source: 'bibtex',
              },
            );
          }
          throw new Error('CatalogService is required to create BibTeX item');
        },
      );
    } else if (this.catalogService?.createItem) {
      createdItem = await this.catalogService.createItem(
        workspaceId,
        bibItemData,
        {
          source: 'bibtex',
        },
      );
    }

    const result: IngestionResult = {
      runId,
      status: 'completed',
      itemId: createdItem?.id,
      attachmentIds: [],
      deduplicated: false,
      item: createdItem,
    };
    await this.saveIdempotency(
      workspaceId,
      command.idempotencyKey,
      requestHash,
      result,
    );
    await this.ingestionRepo.updateRunStatus(
      workspaceId,
      runId,
      IngestionStatus.READY,
      { itemId: result.itemId, completedAt: new Date() },
    ).catch(() => {});

    return result;
  }

  // ── Handler: PDF Ingestion ────────────────────────────────────────────────

  private async handlePdfIngestion(
    command: IngestionCommand & { source: 'pdf' },
    workspaceId: string,
    runId: string,
    requestHash: string,
  ): Promise<IngestionResult> {
    let fileRecord: any;
    if (this.storagePort?.readOwnedFile) {
      try {
        fileRecord = await (this.storagePort as any).readOwnedFile(
          workspaceId,
          command.fileId,
        );
      } catch (err: any) {
        if (
          err?.status === 403 ||
          err?.message?.includes('Access denied') ||
          err?.name === 'ForbiddenException'
        ) {
          throw new IngestionValidationException(
            err.message ||
              'Access denied: file does not belong to workspace',
          );
        }
        try {
          fileRecord = await (this.storagePort as any).readOwnedFile({
            workspaceId,
            fileId: command.fileId,
          });
        } catch (innerErr: any) {
          if (innerErr instanceof IngestionValidationException) throw innerErr;
          if (
            innerErr?.status === 403 ||
            innerErr?.message?.includes('Access denied') ||
            innerErr?.name === 'ForbiddenException'
          ) {
            throw new IngestionValidationException(
              innerErr.message ||
                'Access denied: file does not belong to workspace',
            );
          }
          throw innerErr;
        }
      }
    }

    let hash = '';
    let extractedDoc: any = null;
    if (fileRecord?.buffer) {
      const magic = fileRecord.buffer.slice(0, 5).toString('ascii');
      if (!magic.startsWith('%PDF')) {
        throw new IngestionValidationException(
          'Missing %PDF magic bytes in uploaded file',
        );
      }

      hash = createHash('sha256')
        .update(fileRecord.buffer)
        .digest('hex');

      if (this.extractorService?.extractDocumentFromBuffer) {
        try {
          extractedDoc = await this.extractorService.extractDocumentFromBuffer(
            fileRecord.buffer,
          );
        } catch (err: any) {
          this.logger.warn(`PDF extraction failed: ${err?.message}`);
        }
      }
    }

    return await this.withKeyLock(`${workspaceId}:pdf:${hash || command.fileId}`, async () => {
      if (hash) {
        const claim = await this.prisma.libraryDedupClaim.findUnique({
        where: {
          workspaceId_claimType_claimValue: {
            workspaceId,
            claimType: 'pdf_sha256',
            claimValue: hash,
          },
        },
        include: {
          catalogItem: {
            include: { attachments: true },
          },
        },
      });

      if (claim?.catalogItem && !claim.catalogItem.deletedAt) {
        const it = claim.catalogItem;
        const result: IngestionResult = {
          runId,
          status: 'completed',
          itemId: it.id,
          attachmentIds: it.attachments?.map((a: any) => a.id) || [],
          deduplicated: true,
          item: it,
        };
        await this.saveIdempotency(
          workspaceId,
          command.idempotencyKey,
          requestHash,
          result,
        );
        await this.ingestionRepo.updateRunStatus(
          workspaceId,
          runId,
          IngestionStatus.READY,
          { itemId: it.id, completedAt: new Date() },
        ).catch(() => {});
        return result;
      }
    }

    // Also check if an attachment with same fileId or fileHash exists
    const existingAtt = await this.prisma.catalogAttachment.findFirst({
      where: {
        OR: [
          {
            fileId: command.fileId,
            catalogItem: { workspaceId, deletedAt: null },
          },
          ...(hash
            ? [
                {
                  fileHash: hash,
                  catalogItem: { workspaceId, deletedAt: null },
                },
              ]
            : []),
        ],
      },
      include: {
        catalogItem: {
          include: { attachments: true },
        },
      },
    });

    if (existingAtt?.catalogItem && !existingAtt.catalogItem.deletedAt) {
      const it = existingAtt.catalogItem;
      const result: IngestionResult = {
        runId,
        status: 'completed',
        itemId: it.id,
        attachmentIds: it.attachments?.map((a: any) => a.id) || [
          existingAtt.id,
        ],
        deduplicated: true,
        item: it,
      };
      await this.saveIdempotency(
        workspaceId,
        command.idempotencyKey,
        requestHash,
        result,
      );
      await this.ingestionRepo.updateRunStatus(
        workspaceId,
        runId,
        IngestionStatus.READY,
        { itemId: it.id, completedAt: new Date() },
      ).catch(() => {});
      return result;
    }

    let createdItem: any = null;
    let createdAttachment: any = null;
    let isDedup = false;

    const pdfItemData: any = {
      title:
        command.overrides?.title ||
        extractedDoc?.title ||
        command.filename ||
        'PDF Document',
      filename: command.filename || 'PDF Document',
      uploadedById: command.userId || 'system',
      collectionId: command.collectionId,
      authors: command.overrides?.authors || extractedDoc?.authors || [],
      abstract: command.overrides?.abstract || extractedDoc?.abstract,
      doi: command.overrides?.doi || extractedDoc?.doi,
      labels:
        command.overrides?.keywords ||
        command.overrides?.tags ||
        extractedDoc?.keywords ||
        [],
      keywords:
        command.overrides?.keywords ||
        command.overrides?.tags ||
        extractedDoc?.keywords ||
        [],
      itemType: 'journalArticle',
    };

    if (this.libraryTx?.executeInTransaction) {
      createdItem = await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: any) => {
          // Check race condition in tx
          if (hash) {
            const raceClaim = await tx.libraryDedupClaim.findUnique({
              where: {
                workspaceId_claimType_claimValue: {
                  workspaceId,
                  claimType: 'pdf_sha256',
                  claimValue: hash,
                },
              },
              include: { catalogItem: { include: { attachments: true } } },
            });
            if (raceClaim?.catalogItem) {
              isDedup = true;
              return raceClaim.catalogItem;
            }
          }

          let item: any;
          if (this.catalogService?.createItem) {
            item = await this.catalogService.createItem(
              workspaceId,
              pdfItemData,
              {
                tx,
                helpers,
                source: 'pdf',
              },
            );
          } else {
            throw new Error('CatalogService is required to create PDF item');
          }

          // Create attachment for PDF
          createdAttachment = await tx.catalogAttachment.create({
            data: {
              catalogItemId: item.id,
              fileId: command.fileId || null,
              filename: command.filename || 'document.pdf',
              url: command.fileId
                ? `/api/files/${command.fileId}`
                : `/api/files/temp`,
              fileHash: hash || null,
              size: fileRecord?.buffer?.length || 0,
              mimeType: 'application/pdf',
              attachmentType: 'primary_pdf',
              revisions: {
                create: {
                  revisionNumber: 1,
                  fileHash: hash || '',
                  sizeBytes: fileRecord?.buffer?.length || 0,
                  url: command.fileId
                    ? `/api/files/${command.fileId}`
                    : `/api/files/temp`,
                },
              },
            },
          });

          if (hash) {
            try {
              await tx.libraryDedupClaim.create({
                data: {
                  workspaceId,
                  claimType: 'pdf_sha256',
                  claimValue: hash,
                  catalogItemId: item.id,
                },
              });
            } catch {
              const winner = await tx.libraryDedupClaim.findUnique({
                where: {
                  workspaceId_claimType_claimValue: {
                    workspaceId,
                    claimType: 'pdf_sha256',
                    claimValue: hash,
                  },
                },
                include: { catalogItem: { include: { attachments: true } } },
              });
              if (winner?.catalogItem) {
                isDedup = true;
                return winner.catalogItem;
              }
            }
          }

          return item;
        },
      );
    } else if (this.catalogService?.createItem) {
      createdItem = await this.catalogService.createItem(
        workspaceId,
        pdfItemData,
        {
          source: 'pdf',
        },
      );
    }

    const result: IngestionResult = {
      runId,
      status: 'completed',
      itemId: createdItem?.id,
      attachmentIds: createdAttachment
        ? [createdAttachment.id]
        : createdItem?.attachments?.length
          ? createdItem.attachments.map((a: any) => a.id)
          : [],
      deduplicated: isDedup,
      item: createdItem,
    };
    await this.saveIdempotency(
      workspaceId,
      command.idempotencyKey,
      requestHash,
      result,
    );
    await this.ingestionRepo.updateRunStatus(
      workspaceId,
      runId,
      IngestionStatus.READY,
      { itemId: result.itemId, completedAt: new Date() },
    ).catch(() => {});

      return result;
    });
  }

  // Backward compatibility convenience methods
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
    if (this.urlConnector?.captureFromUrl) {
      result = await this.urlConnector.captureFromUrl(url, {
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
    const metadataDigest = this.urlConnector?.calculateMetadataDigest
      ? this.urlConnector.calculateMetadataDigest(metaWithoutToken)
      : '';

    await this.prisma.capturePreview.create({
      data: {
        sourceUrl: result.url || url,
        workspaceId,
        userId: userId || null,
        title: result.title || 'Captured Paper',
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

    if (this.urlConnector?.verifyPreviewToken) {
      const verifyRes = this.urlConnector.verifyPreviewToken(
        preview.canonicalMetadata,
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
      collectionId: dto.collectionId,
      tags: dto.tags,
      uploadedById: userId,
    };

    if (this.libraryTx?.executeInTransaction) {
      return this.libraryTx.executeInTransaction(
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

          throw new Error('CatalogService is required to confirm captured URL item');
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

  private mapPayloadToSource(
    kind: string,
  ): 'doi' | 'bibtex' | 'ris' | 'url' | 'pdf' | 'manual' {
    switch (kind) {
      case 'IDENTIFIER':
        return 'doi';
      case 'RECORD':
        return 'bibtex';
      case 'URL':
        return 'url';
      case 'FILE':
        return 'pdf';
      default:
        return 'manual';
    }
  }
}
