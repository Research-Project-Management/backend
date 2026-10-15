import {
  Injectable,
  Logger,
  Optional,
  Inject,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import {
  IngestionSubmissionEnvelope,
  IngestionAcceptedResult,
  SubmissionPayload,
} from '@/modules/library/ingestion/types/submission.types';
import {
  IngestionCommand,
  IngestionResult,
  IngestionPort,
  IngestionRunSnapshot,
} from '@/modules/library/ingestion/types/ingestion.types';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { IngestionStatus, IngestionRun, Prisma } from '@prisma/client';
import { PipelineService } from './pipeline.service';
import { QueueService } from './queue.service';
import { UrlCaptureService } from './url-capture.service';
import { ConfirmCapturedUrlDto } from '@/modules/library/ingestion/dto/capture-url.dto';
import { ItemDetail, UpdateItemData } from '@/modules/library/catalog';
import {
  CATALOG_GATEWAY_PORT,
  ICatalogGatewayPort,
} from '@/modules/library/ingestion/types/catalog-gateway.types';
import { createHash, randomUUID } from 'crypto';
import zlib from 'zlib';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import {
  METADATA_PORT,
  MetadataPort,
  QueryType,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizeIsbn,
} from '@/modules/library/shared-kernel/domain/identifier.domain';
import { parseCreatorString } from '@/modules/library/shared-kernel/domain/author.domain';
import {
  harmonizeZoteroFields,
  resolveCanonicalCreatorRole,
} from '@/modules/library/shared-kernel/domain/zotero-field-harmonizer.domain';

interface IngestionExecutionLog {
  item?: { id?: string; title?: string };
  items?: Array<{ itemId?: string; title?: string; status?: string }>;
  currentTitle?: string;
  total?: number;
  processed?: number;
  succeeded?: number;
  duplicates?: number;
  failed?: number;
  percentage?: number;
  [key: string]: unknown;
}

@Injectable()
export class IngestionService implements IngestionPort {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly repo: IngestionRepository,
    private readonly pipeline: PipelineService,
    private readonly queue: QueueService,
    private readonly urlCapture: UrlCaptureService,
    @Optional()
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway?: ICatalogGatewayPort,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    @Inject(METADATA_PORT)
    private readonly metadataService?: MetadataPort,
  ) {}

  /**
   * Primary Fast-Path Submission Entry Point (Async 202 Contract)
   */
  async submit(
    envelope: IngestionSubmissionEnvelope,
    options?: { enqueue?: boolean },
  ): Promise<IngestionAcceptedResult> {
    if (!envelope.userId) {
      throw new BadRequestException(
        'User context (userId) is required for ingestion submission',
      );
    }

    const projectId = envelope.projectId ?? '';
    const idempotencyKey = envelope.idempotencyKey?.trim();

    const requestHash = createHash('sha256')
      .update(JSON.stringify({ projectId, payload: envelope.payload }))
      .digest('hex');

    // 1. Idempotency Check & Atomic Claim
    if (idempotencyKey) {
      const existingRun = await this.repo.findRunByIdempotencyKey(
        { userId: envelope.userId, projectId: envelope.projectId },
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
          statusUrl: `/api/v1/library/ingestion/status/${existingRun.id}`,
          acceptedAt: existingRun.startedAt
            ? existingRun.startedAt.toISOString()
            : new Date().toISOString(),
          requestHash,
          status: existingRun.status,
          existingItemId: existingRun.itemId ?? undefined,
          deduplicated: true,
        };
      }
    }

    // Claim Check Pattern: If record payload exceeds 32KB, offload compressed payload to Storage
    let effectivePayload = envelope.payload;
    if (
      envelope.payload.kind === 'RECORD' &&
      envelope.payload.content &&
      envelope.payload.content.length > 32 * 1024 &&
      typeof this.storagePort?.uploadFile === 'function'
    ) {
      try {
        const rawBuffer = Buffer.from(envelope.payload.content, 'utf-8');
        const compressed = zlib.gzipSync(rawBuffer);
        const uploadResult = await this.storagePort.uploadFile({
          userId: envelope.userId,
          projectId: envelope.projectId || undefined,
          filename: `ingest_${envelope.payload.format.toLowerCase()}_${randomUUID().slice(0, 8)}.json.gz`,
          buffer: compressed,
          mimeType: 'application/gzip',
          source: 'ingestion.claim_check',
        });

        if (uploadResult?.fileId) {
          effectivePayload = {
            kind: 'RECORD',
            format: envelope.payload.format,
            isOffloaded: true,
            fileId: uploadResult.fileId,
            storageKey: uploadResult.path,
            byteSize: compressed.length,
            uncompressedSize: rawBuffer.length,
          };
          this.logger.log(
            `[ClaimCheck] Offloaded large ${envelope.payload.format} record payload (${rawBuffer.length}B -> ${compressed.length}B compressed) to storage fileId=${uploadResult.fileId}`,
          );
        }
      } catch (offloadErr: unknown) {
        const offloadMsg =
          offloadErr instanceof Error ? offloadErr.message : String(offloadErr);
        this.logger.warn(
          `[ClaimCheck] Failed to offload record payload to storage: ${offloadMsg}. Falling back to inline.`,
        );
      }
    }

    const envelopeToPersist: IngestionSubmissionEnvelope = {
      ...envelope,
      payload: effectivePayload,
    };

    // 2. Create IngestionRun Record with Race Condition Protection (P2002)
    let run: IngestionRun;
    try {
      run = await this.repo.createRun(
        { userId: envelope.userId, projectId },
        {
          inputParams: envelopeToPersist as unknown as Prisma.InputJsonValue,
          inputHash: requestHash,
          idempotencyKey,
          contractVersion: envelope.contractVersion || '1.0.0',
        },
      );
    } catch (err: unknown) {
      const errRecord =
        err && typeof err === 'object'
          ? (err as Record<string, unknown>)
          : null;
      const isP2002 =
        errRecord?.code === 'P2002' ||
        (err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002') ||
        (err instanceof Error && err.message.includes('Unique constraint'));

      // If a concurrent request inserted with the exact same (userId, idempotencyKey), Prisma throws P2002
      if (idempotencyKey && isP2002) {
        const raceRun = await this.repo.findRunByIdempotencyKey(
          { userId: envelope.userId, projectId: envelope.projectId },
          idempotencyKey,
        );
        if (raceRun) {
          if (raceRun.inputHash !== requestHash) {
            throw new ConflictException(
              `Idempotency key "${idempotencyKey}" was already used with a different request payload`,
            );
          }
          return {
            runId: raceRun.id,
            statusUrl: `/api/v1/library/ingestion/status/${raceRun.id}`,
            acceptedAt: raceRun.startedAt
              ? raceRun.startedAt.toISOString()
              : new Date().toISOString(),
            requestHash,
            status: raceRun.status,
            existingItemId: raceRun.itemId ?? undefined,
            deduplicated: true,
          };
        }
      }
      throw err;
    }

    const runId = run?.id || randomUUID();
    const statusUrl = `/api/v1/library/ingestion/status/${runId}`;

    // 3. Return the durable run immediately and dispatch to IngestionQueueService
    // for bounded concurrency and worker resilience (unless direct synchronous execution is requested).
    const shouldEnqueue = options?.enqueue ?? true;
    if (shouldEnqueue) {
      void this.queue.enqueue(runId, projectId, envelopeToPersist);
    }

    return {
      runId,
      statusUrl,
      acceptedAt: run?.startedAt
        ? run.startedAt.toISOString()
        : new Date().toISOString(),
      requestHash,
      status: run?.status || IngestionStatus.PENDING,
      existingItemId: run?.itemId ?? undefined,
      deduplicated: false,
    };
  }

  /**
   * Executes the multi-stage ingestion pipeline.
   * Delegated to PipelineService.
   */
  async executePipeline(
    runId: string,
    projectId: string,
    envelope: IngestionSubmissionEnvelope,
  ): Promise<void> {
    return this.pipeline.executePipeline(runId, projectId, envelope);
  }

  private parseExecutionLog(executionLog: unknown): IngestionExecutionLog {
    if (
      executionLog &&
      typeof executionLog === 'object' &&
      !Array.isArray(executionLog)
    ) {
      return executionLog as IngestionExecutionLog;
    }
    return {};
  }

  async getRunStatus(
    /** scopeId: may be userId (user library) or projectId — repo ignores it, kept for interface parity */
    scopeId: string,
    runId: string,
  ): Promise<IngestionRunSnapshot> {
    const run = await this.repo.findRunById(scopeId, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }

    const log = this.parseExecutionLog(run.executionLog);
    const logItem =
      log.item ||
      (Array.isArray(log.items) && log.items.length > 0
        ? { id: log.items[0].itemId || run.itemId, title: log.items[0].title }
        : null);
    const runItem = run.item as
      { id?: string; title?: string } | null | undefined;
    const resolvedItem = runItem || logItem || null;
    const title =
      runItem?.title ||
      log.currentTitle ||
      (Array.isArray(log.items) && log.items[0]?.title) ||
      log.item?.title ||
      null;
    const itemId =
      run.itemId ||
      resolvedItem?.id ||
      (Array.isArray(log.items) && log.items[0]?.itemId) ||
      null;

    return {
      ...run,
      itemId,
      item: resolvedItem
        ? { ...resolvedItem, title: resolvedItem.title || title }
        : null,
      title,
    } as unknown as IngestionRunSnapshot;
  }

  async getRunProgress(
    /** scopeId: may be userId (user library) or projectId — repo ignores it, kept for interface parity */
    scopeId: string,
    runId: string,
  ): Promise<{
    runId: string;
    projectId: string;
    status: string;
    currentStage?: string;
    total: number;
    processed: number;
    percentage: number;
    succeeded: number;
    duplicates: number;
    failed: number;
    currentTitle?: string;
    items: Array<{
      title: string;
      status: 'SUCCEEDED' | 'DUPLICATE' | 'FAILED';
      itemId?: string;
      error?: string;
    }>;
    startedAt: string;
    completedAt?: string;
  }> {
    const run = await this.repo.findRunById(scopeId, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }

    const log = this.parseExecutionLog(run.executionLog);
    const total = Number(log.total) || 1;
    const isCompleted = run.status === IngestionStatus.COMPLETED;
    const processed = Number(log.processed) || (isCompleted ? total : 0);
    const succeeded =
      Number(log.succeeded) || (isCompleted && !log.duplicates ? 1 : 0);
    const duplicates = Number(log.duplicates) || 0;
    const failed =
      Number(log.failed) ||
      (run.status === IngestionStatus.FAILED_FINAL ||
      run.status === IngestionStatus.FAILED_RETRYABLE
        ? 1
        : 0);
    const percentage =
      typeof log.percentage === 'number'
        ? log.percentage
        : isCompleted
          ? 100
          : Math.min(Math.round((processed / total) * 100), 99);

    const runItem = run.item as
      { id?: string; title?: string } | null | undefined;
    const title =
      runItem?.title ||
      log.currentTitle ||
      (Array.isArray(log.items) && log.items[0]?.title) ||
      log.item?.title ||
      undefined;

    const items: Array<{
      title: string;
      status: 'SUCCEEDED' | 'DUPLICATE' | 'FAILED';
      itemId?: string;
      error?: string;
    }> =
      Array.isArray(log.items) && log.items.length > 0
        ? log.items.map((it) => ({
            title: it.title || 'Untitled Document',
            status:
              it.status === 'DUPLICATE' || it.status === 'FAILED'
                ? it.status
                : 'SUCCEEDED',
            itemId: it.itemId,
          }))
        : title
          ? [
              {
                title,
                status: isCompleted ? 'SUCCEEDED' : 'FAILED',
                itemId: run.itemId || undefined,
              },
            ]
          : [];

    return {
      runId: run.id,
      projectId: scopeId,
      status: String(run.status),
      currentStage: run.currentStage || undefined,
      total,
      processed,
      percentage,
      succeeded,
      duplicates,
      failed,
      currentTitle: title,
      items,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString(),
    };
  }

  async retryRun(
    /** scopeId: may be userId (user library) or projectId — repo ignores it, kept for interface parity */
    scopeId: string,
    runId: string,
  ): Promise<{
    runId: string;
    status: IngestionStatus;
    message: string;
  }> {
    const run = await this.repo.findRunById(scopeId, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }

    await this.repo.updateRunStatus(scopeId, runId, IngestionStatus.PENDING);

    const envelope = run.inputParams as unknown as IngestionSubmissionEnvelope;
    if (envelope && typeof envelope === 'object') {
      void this.queue.enqueue(runId, scopeId, {
        ...envelope,
        projectId: scopeId,
      });
      this.logger.log(
        `Retry initiated and re-enqueued for run ${runId} (scope: ${scopeId})`,
      );
    } else {
      this.logger.warn(
        `Retry requested for run ${runId}, but inputParams is missing or invalid.`,
      );
    }

    return {
      runId,
      status: IngestionStatus.PENDING,
      message: 'Ingestion run retry initiated and enqueued',
    };
  }

  /**
   * Unified synchronous/direct ingestion entry point.
   * Delegates to modern IngestionPipelineRunner via mapped envelope.
   */
  async ingest(command: IngestionCommand): Promise<IngestionResult> {
    const projectId = command.projectId || command.userId || '';
    const envelope = this.mapCommandToEnvelope(projectId, command);

    const submissionRes = await this.submit(envelope, { enqueue: false });
    const runId = submissionRes.runId;

    if (submissionRes.deduplicated && submissionRes.existingItemId) {
      const item = this.catalogGateway
        ? await this.catalogGateway
            .getItem(
              envelope.userId!,
              submissionRes.existingItemId,
              projectId || undefined,
            )
            .catch(() => undefined)
        : undefined;

      return {
        runId,
        status: 'completed',
        itemId: submissionRes.existingItemId,
        attachmentIds: [],
        deduplicated: true,
        item,
      };
    }

    try {
      await this.pipeline.executePipeline(runId, projectId, envelope);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Ingestion pipeline failed for run ${runId}: ${errMsg}`,
      );
      await this.repo
        .updateRunStatus(projectId, runId, IngestionStatus.FAILED_FINAL, {
          lastError: errMsg,
        })
        .catch(() => {});

      return {
        runId,
        status: 'failed',
        attachmentIds: [],
        deduplicated: false,
        errorMessage: errMsg || 'Pipeline execution failed',
      };
    }

    const updatedRun = await this.repo.findRunById(projectId, runId);
    const itemId = updatedRun?.itemId ?? undefined;
    const item =
      itemId && this.catalogGateway
        ? await this.catalogGateway
            .getItem(envelope.userId!, itemId, projectId || undefined)
            .catch(() => undefined)
        : undefined;

    return {
      runId,
      status:
        updatedRun?.status === IngestionStatus.FAILED_FINAL
          ? 'failed'
          : 'completed',
      itemId,
      attachmentIds: [],
      deduplicated: false,
      item,
      errorMessage: updatedRun?.lastError ?? undefined,
    };
  }

  private mapCommandToEnvelope(
    projectId: string,
    command: IngestionCommand,
  ): IngestionSubmissionEnvelope {
    let payload: SubmissionPayload;
    switch (command.source) {
      case 'doi':
        payload = {
          kind: 'IDENTIFIER',
          identifierType: 'DOI',
          value: command.doi || '',
        };
        break;
      case 'arxiv':
        payload = {
          kind: 'IDENTIFIER',
          identifierType: 'ARXIV',
          value: ('arxivId' in command ? command.arxivId : '') || '',
        };
        break;
      case 'pmid':
        payload = {
          kind: 'IDENTIFIER',
          identifierType: 'PMID',
          value: ('pmid' in command ? command.pmid : '') || '',
        };
        break;
      case 'isbn':
        payload = {
          kind: 'IDENTIFIER',
          identifierType: 'ISBN',
          value: ('isbn' in command ? command.isbn : '') || '',
        };
        break;
      case 'url':
        payload = {
          kind: 'URL',
          url: command.url || '',
          previewToken:
            'previewToken' in command ? command.previewToken : undefined,
        };
        break;
      case 'bibtex':
        payload = {
          kind: 'RECORD',
          format: 'BIBTEX',
          content: command.content || '',
        };
        break;
      case 'ris':
        payload = {
          kind: 'RECORD',
          format: 'RIS',
          content: command.content || '',
        };
        break;
      case 'pdf':
        payload = {
          kind: 'FILE',
          fileId: command.fileId || '',
          filename: command.filename,
        };
        break;
      case 'zotero':
        payload = {
          kind: 'CONNECTOR',
          connectionId:
            ('connectionId' in command ? command.connectionId : '') || '',
          externalObjectId:
            ('externalItemKey' in command ? command.externalItemKey : '') || '',
          externalVersion: '1',
        };
        break;
      default:
        throw new BadRequestException(
          `Unsupported ingestion source: ${String((command as { source?: unknown }).source)}`,
        );
    }

    return {
      projectId,
      userId: command.userId,
      idempotencyKey: command.idempotencyKey,
      payload,
      collectionIds: command.collectionId ? [command.collectionId] : undefined,
      overrides: 'overrides' in command ? command.overrides : undefined,
    };
  }

  // ── Backward Compatibility Convenience Methods ────────────────────────────

  async ingestDoi(
    projectId: string,
    userId: string,
    dto: { doi: string; collectionId?: string; idempotencyKey?: string },
  ) {
    const res = await this.ingest({
      source: 'doi',
      projectId,
      userId,
      doi: dto.doi,
      collectionId: dto.collectionId,
      idempotencyKey: dto.idempotencyKey,
    });
    return res.item || { id: res.itemId, runId: res.runId };
  }

  async ingestBibtex(
    projectId: string,
    userId: string,
    dto: {
      bibtex?: string;
      content?: string;
      collectionId?: string;
      idempotencyKey?: string;
    },
  ) {
    const res = await this.ingest({
      source: 'bibtex',
      projectId,
      userId,
      content: dto.bibtex || dto.content || '',
      collectionId: dto.collectionId,
      idempotencyKey: dto.idempotencyKey,
    });
    return res.item || { id: res.itemId, runId: res.runId };
  }

  async startRun(
    projectId: string,
    userId: string,
    dto: {
      source?: 'doi' | 'url' | 'bibtex' | 'pdf' | string;
      doi?: string;
      content?: string;
      idempotencyKey?: string;
    },
  ) {
    const source = (dto.source || (dto.content ? 'bibtex' : 'doi')) as
      'doi' | 'bibtex';
    const res = await this.ingest(
      source === 'bibtex'
        ? {
            source: 'bibtex',
            projectId,
            userId,
            content: dto.content || '',
            idempotencyKey: dto.idempotencyKey,
          }
        : {
            source: 'doi',
            projectId,
            userId,
            doi: dto.doi || '',
            idempotencyKey: dto.idempotencyKey,
          },
    );
    return { runId: res.runId, status: res.status };
  }

  async captureUrl(
    url: string,
    contextOrProjectId:
      | string
      | {
          projectId?: string;
          userId?: string;
        },
  ) {
    return this.urlCapture.captureUrl(url, contextOrProjectId);
  }

  async confirmCapturedUrl(
    projectId: string,
    userId: string,
    dto: ConfirmCapturedUrlDto,
  ) {
    return this.urlCapture.confirmCapturedUrl(projectId, userId, dto);
  }

  async cleanupExpiredPreviews(retentionDays = 7): Promise<number> {
    return this.urlCapture.cleanupExpiredPreviews(retentionDays);
  }

  /**
   * Re-resolves bibliographic metadata for an existing library item on demand.
   * Queries Open Academic Mirrors (CrossRef, arXiv, PubMed, EuropePMC) and harmonizes fields.
   */
  async reResolveMetadata(
    userId: string,
    itemId: string,
    options?: {
      doi?: string;
      arxivId?: string;
      pmid?: string;
      isbn?: string;
      title?: string;
      forceRefresh?: boolean;
      aggressive?: boolean;
      fields?: string[];
      expectedVersion?: number;
    },
    projectId?: string,
  ): Promise<{
    success: boolean;
    message: string;
    itemId: string;
    item: ItemDetail | null;
    resolvedFrom?: {
      query: string;
      queryType: string;
      canonicalId?: string;
    };
    updatedFields: string[];
    warnings?: string[];
  }> {
    if (!this.catalogGateway) {
      throw new BadRequestException(
        'Catalog gateway is unavailable for metadata re-resolution',
      );
    }

    const existingItem = await this.catalogGateway.getItem(
      userId,
      itemId,
      projectId,
    );
    if (!existingItem) {
      throw new NotFoundException(`Item "${itemId}" not found in library`);
    }

    // Determine query & queryType
    let query: string | undefined;
    let queryType: QueryType | undefined;

    if (options?.doi) {
      query = normalizeDoi(options.doi) || options.doi.trim();
      queryType = 'DOI';
    } else if (options?.arxivId) {
      query = normalizeArxivId(options.arxivId) || options.arxivId.trim();
      queryType = 'ARXIV';
    } else if (options?.pmid) {
      query = normalizePmid(options.pmid) || options.pmid.trim();
      queryType = 'PMID';
    } else if (options?.isbn) {
      query = normalizeIsbn(options.isbn) || options.isbn.trim();
      queryType = 'ISBN';
    } else if (options?.title) {
      query = options.title.trim();
      queryType = 'TITLE';
    } else if (existingItem.doi) {
      query = normalizeDoi(existingItem.doi) || existingItem.doi;
      queryType = 'DOI';
    } else if (existingItem.extraFields?.arxivId || existingItem.arxivId) {
      const rawArxiv = String(
        existingItem.extraFields?.arxivId || existingItem.arxivId || '',
      );
      query = normalizeArxivId(rawArxiv) || rawArxiv;
      queryType = 'ARXIV';
    } else if (existingItem.extraFields?.pmid || existingItem.pmid) {
      const rawPmid = String(
        existingItem.extraFields?.pmid || existingItem.pmid || '',
      );
      query = normalizePmid(rawPmid) || rawPmid;
      queryType = 'PMID';
    } else if (existingItem.isbn) {
      query = normalizeIsbn(existingItem.isbn) || existingItem.isbn;
      queryType = 'ISBN';
    } else if (
      existingItem.title &&
      existingItem.title.trim().length >= 10 &&
      !/^(untitled|document|uploaded document|manuscript)$/i.test(
        existingItem.title.trim(),
      )
    ) {
      query = existingItem.title.trim();
      queryType = 'TITLE';
    }

    if (!query) {
      throw new BadRequestException(
        'Cannot re-resolve metadata: item has no existing identifier or credible title. Please specify a DOI, arXiv ID, or title in request body.',
      );
    }

    if (!this.metadataService) {
      throw new BadRequestException(
        'MetadataService is unavailable for metadata re-resolution',
      );
    }

    const resolved = await this.metadataService.resolve({
      query,
      queryType,
      forceRefresh: options?.forceRefresh ?? options?.aggressive ?? true,
      scopeId: projectId || 'user',
    });

    if (!resolved || !resolved.metadata) {
      return {
        success: false,
        message: `No authoritative bibliographic metadata found for query "${query}".`,
        itemId,
        item: existingItem,
        updatedFields: [],
      };
    }

    const effectiveItemType =
      resolved.metadata.itemType ||
      existingItem.itemType ||
      ((existingItem as Record<string, unknown>).type as string | undefined) ||
      'journalArticle';
    const m = harmonizeZoteroFields(
      {
        ...resolved.metadata,
        extraFields: { ...(resolved.metadata.extraFields || {}) },
      },
      { itemType: effectiveItemType, syncExtraFields: true },
    ) as typeof resolved.metadata;

    const updateData: Record<string, unknown> = {};
    const updatedFields: string[] = [];
    const allowedFieldSet =
      Array.isArray(options?.fields) && options.fields.length > 0
        ? new Set(options.fields)
        : null;

    const applyField = (fieldName: string, value: unknown) => {
      if (allowedFieldSet && !allowedFieldSet.has(fieldName)) {
        return;
      }
      if (value !== undefined && value !== null && value !== '') {
        updateData[fieldName] = value;
        if (!updatedFields.includes(fieldName)) {
          updatedFields.push(fieldName);
        }
      }
    };

    if (m.title && m.title !== existingItem.title) {
      applyField('title', m.title);
    }

    if (Array.isArray(m.creators) && m.creators.length > 0) {
      const creators = m.creators.map((c, index) => ({
        orderIndex: index,
        creatorType: resolveCanonicalCreatorRole(c.creatorType, {
          itemType: effectiveItemType,
        }),
        firstName: c.firstName || '',
        lastName: c.lastName || '',
        fullName:
          c.fullName ||
          c.name ||
          [c.firstName, c.lastName].filter(Boolean).join(' '),
        ...(c.fieldMode !== undefined ? { fieldMode: c.fieldMode } : {}),
      }));
      applyField('creators', creators);
    } else if (m.authors && m.authors.length > 0) {
      const creators = m.authors.map((authorStr: string, index: number) => {
        const parsed = parseCreatorString(authorStr, index, 'author');
        return {
          orderIndex: index,
          creatorType: 'author',
          firstName: parsed.firstName || '',
          lastName: parsed.lastName || '',
          fullName: parsed.fullName || authorStr,
          ...(parsed.fieldMode !== undefined
            ? { fieldMode: parsed.fieldMode }
            : {}),
        };
      });
      applyField('creators', creators);
    }

    if (m.publicationDate) {
      applyField('date', m.publicationDate);
      applyField('publicationDate', m.publicationDate);
    } else if (m.year) {
      applyField('date', String(m.year));
    }
    if (m.year) {
      applyField('year', m.year);
    }

    if (m.journal || m.publicationTitle) {
      applyField('publicationTitle', m.journal || m.publicationTitle);
    }

    if (m.abstract || m.abstractNote) {
      applyField('abstractNote', m.abstract || m.abstractNote);
      applyField('abstract', m.abstract || m.abstractNote);
    }

    const handledKeys = new Set([
      'title',
      'creators',
      'authors',
      'editors',
      'contributors',
      'publicationDate',
      'date',
      'year',
      'publicationTitle',
      'journal',
      'abstract',
      'abstractNote',
      'extraFields',
      'notes',
      'provenance',
    ]);

    const mRecord = m as Record<string, unknown>;
    for (const [key, val] of Object.entries(mRecord)) {
      if (handledKeys.has(key)) continue;
      if (val === undefined || val === null || val === '') continue;
      if (Array.isArray(val) && val.length === 0) continue;
      applyField(key, val);
    }

    if (
      m.extraFields &&
      typeof m.extraFields === 'object' &&
      Object.keys(m.extraFields).length > 0
    ) {
      const mergedExtraFields: Record<string, unknown> = {
        ...(existingItem.extraFields || {}),
      };
      for (const [efKey, efVal] of Object.entries(m.extraFields)) {
        if (efVal !== undefined && efVal !== null && efVal !== '') {
          mergedExtraFields[efKey] = efVal;
          applyField(efKey, efVal);
        }
      }
      updateData.extraFields = mergedExtraFields;
    }

    if (updatedFields.length === 0) {
      return {
        success: true,
        message:
          'Item metadata is already up to date with authoritative registry.',
        itemId,
        item: existingItem,
        resolvedFrom: {
          query,
          queryType: resolved.queryType,
          canonicalId: resolved.canonicalId,
        },
        updatedFields: [],
      };
    }

    const expectedVersion = options?.expectedVersion ?? existingItem.version;
    const updated = await this.catalogGateway.updateItem(
      userId,
      itemId,
      updateData,
      expectedVersion,
      projectId,
    );

    return {
      success: true,
      message: `Successfully re-resolved metadata from ${resolved.canonicalId || query}. Updated ${updatedFields.length} field(s): ${updatedFields.join(', ')}.`,
      itemId,
      item: updated || existingItem,
      resolvedFrom: {
        query,
        queryType: resolved.queryType,
        canonicalId: resolved.canonicalId,
      },
      updatedFields,
    };
  }
}
