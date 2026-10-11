import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
import {
  Prisma,
  IngestionRun,
  IngestionStatus,
  IngestionStage as DbIngestionStage,
  Item,
} from '@prisma/client';
import {
  IngestionStage,
  IngestionCandidate,
  IngestionDecision,
  IngestionReviewCase,
} from '../types/ingestion.types';
import { randomUUID } from 'crypto';
import { isUUID } from 'class-validator';

export interface CreateIngestionRunData {
  id?: string;
  userId?: string;
  projectId?: string | null;
  traceId?: string | null;
  inputParams: Prisma.InputJsonValue;
  inputHash: string;
  idempotencyKey?: string | null;
  contractVersion?: string;
  pipelineVersion?: string;
  status?: IngestionStatus;
  nextRetryAt?: Date | null;
}

export interface CreateIngestionStageData {
  stageName: string;
  durationMs?: number;
  success?: boolean;
  errorMessage?: string;
  outputSnapshot?: Prisma.InputJsonValue;
  leaseToken?: string;
  leaseExpiresAt?: Date;
}

export interface CreateIngestionCandidateData {
  sourceProvider: string;
  sourceRecordId?: string;
  confidenceScore?: number;
  metadataPayload: Prisma.InputJsonValue;
  rawEvidenceRef?: string;
}

export interface CreateIngestionDecisionData {
  decisionType: string; // CREATE, UPDATE, MERGE, REVIEW, REJECT
  decisionReason: string;
  proposedItem: Prisma.InputJsonValue;
  fieldDecisions?: Prisma.InputJsonValue;
  duplicateMatch?: Prisma.InputJsonValue;
}

export interface CreateIngestionReviewCaseData {
  targetItemId?: string;
  reason: string;
  evidence?: Prisma.InputJsonValue;
  options?: Prisma.InputJsonValue;
  status?: string; // PENDING, RESOLVED, DISMISSED
  resolution?: string;
  assignedToUserId?: string;
  assignedToId?: string;
}

export type IngestionScope =
  { userId?: string; projectId?: string | null } | string;

export function parseRunScope(
  scope?: IngestionScope,
  fallbackUserId?: string,
): { userId: string; projectId: string | null } {
  if (typeof scope === 'object' && scope !== null) {
    const rawProject = scope.projectId;
    const resolvedUserId = scope.userId || fallbackUserId;
    if (!resolvedUserId) {
      throw new BadRequestException(
        'User context (userId) is required for ingestion run operations',
      );
    }
    return {
      userId: resolvedUserId,
      projectId: rawProject && isUUID(rawProject) ? rawProject : null,
    };
  }
  const str = typeof scope === 'string' ? scope : '';
  const isProject =
    str &&
    str !== 'user' &&
    str !== 'me' &&
    str !== fallbackUserId &&
    isUUID(str);
  const resolvedUserId = fallbackUserId || (!isProject && str ? str : '');
  if (!resolvedUserId) {
    throw new BadRequestException(
      'User context (userId) is required for ingestion run operations',
    );
  }
  return {
    userId: resolvedUserId,
    projectId: isProject ? str : null,
  };
}

@Injectable()
export class IngestionRepository {
  private readonly logger = new Logger(IngestionRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  private getClient(
    tx?: Prisma.TransactionClient,
  ): PrismaService | Prisma.TransactionClient {
    return tx || this.prisma;
  }

  // ── Run Operations ────────────────────────────────────────────────────────

  async createRun(
    scope: IngestionScope,
    data: CreateIngestionRunData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun> {
    const client = this.getClient(tx);
    const { userId, projectId } = parseRunScope(scope, data.userId);

    return client.ingestionRun.create({
      data: {
        id: data.id || randomUUID(),
        userId,
        projectId,
        traceId: data.traceId ?? null,
        inputParams: data.inputParams,
        inputHash: data.inputHash,
        idempotencyKey: data.idempotencyKey ?? null,
        contractVersion: data.contractVersion || '1.0.0',
        pipelineVersion: data.pipelineVersion || '1.0.0',
        status: data.status || IngestionStatus.PENDING,
        nextRetryAt: data.nextRetryAt ?? null,
      },
    });
  }

  async updateRunStage(
    _scope: IngestionScope,
    runId: string,
    stage: DbIngestionStage,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun> {
    const client = this.getClient(tx);
    return client.ingestionRun.update({
      where: { id: runId },
      data: { currentStage: stage },
    });
  }

  async findRunById(
    _scope: { userId?: string; projectId?: string } | string,
    runId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<
    | (IngestionRun & {
        stages: IngestionStage[];
        candidates: IngestionCandidate[];
        decisions: IngestionDecision[];
        reviewCases: IngestionReviewCase[];
        item?: Item | null;
      })
    | null
  > {
    const client = this.getClient(tx);
    const run = await client.ingestionRun.findFirst({
      where: {
        id: runId,
      },
      include: {
        item: true,
      },
    });
    if (!run) return null;
    const log =
      run.executionLog && typeof run.executionLog === 'object'
        ? (run.executionLog as Record<string, unknown>)
        : {};
    const rawStages = Array.isArray(log.stages) ? log.stages : [];
    const stages: IngestionStage[] = rawStages.map((stage) => {
      const s =
        stage && typeof stage === 'object'
          ? (stage as Record<string, unknown>)
          : {};
      return {
        id: typeof s.id === 'string' ? s.id : randomUUID(),
        ingestionRunId: run.id,
        stageName: typeof s.stageName === 'string' ? s.stageName : '',
        durationMs: typeof s.durationMs === 'number' ? s.durationMs : 0,
        success: s.success !== false,
        errorMessage:
          typeof s.errorMessage === 'string' ? s.errorMessage : null,
        executedAt: s.executedAt
          ? new Date(s.executedAt as string | number | Date)
          : new Date(),
      };
    });
    const reviewCases: IngestionReviewCase[] = run.reviewData
      ? [run.reviewData as unknown as IngestionReviewCase]
      : [];
    return {
      ...run,
      stages,
      candidates: [],
      decisions: [],
      reviewCases,
    };
  }

  async findRunByIdempotencyKey(
    scope: IngestionScope,
    idempotencyKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun | null> {
    const client = this.getClient(tx);
    const { userId } = parseRunScope(scope);
    return client.ingestionRun.findFirst({
      where: {
        userId,
        idempotencyKey,
      },
    });
  }

  async updateRunStatus(
    _scope: IngestionScope,
    runId: string,
    status: IngestionStatus,
    details?: {
      itemId?: string;
      lastError?: string;
      completedAt?: Date;
      executionLog?: Prisma.InputJsonValue;
      /** Previous status — used to determine if this is a retry (only increment attempts on FAILED_RETRYABLE → RECEIVED transitions) */
      previousStatus?: IngestionStatus;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun> {
    const client = this.getClient(tx);
    // Only increment attempts when retrying: transitioning from FAILED_RETRYABLE back to PENDING
    const isRetry =
      details?.previousStatus === IngestionStatus.FAILED_RETRYABLE &&
      (status === IngestionStatus.PENDING ||
        (status as unknown as string) === 'RECEIVED');
    return client.ingestionRun.update({
      where: {
        id: runId,
      },
      data: {
        status,
        ...(details?.itemId !== undefined ? { itemId: details.itemId } : {}),
        ...(details?.lastError !== undefined
          ? { lastError: details.lastError }
          : {}),
        ...(details?.completedAt !== undefined
          ? { completedAt: details.completedAt }
          : {}),
        ...(details?.executionLog !== undefined
          ? { executionLog: details.executionLog }
          : {}),
        ...(isRetry ? { attempts: { increment: 1 } } : {}),
      },
    });
  }

  async updateRunProgress(
    _scope: IngestionScope,
    runId: string,
    progress: Prisma.InputJsonValue,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);
    await client.ingestionRun.update({
      where: {
        id: runId,
      },
      data: {
        executionLog: progress,
      },
    });
  }

  async findOrphanedRuns(
    olderThan: Date,
    options?: {
      scopeId?: string;
      userId?: string;
      projectId?: string;
      limit?: number;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun[]> {
    const client = this.getClient(tx);
    const nonTerminalStatuses: IngestionStatus[] = [
      IngestionStatus.PENDING,
      IngestionStatus.RUNNING,
    ];

    let projectId = options?.projectId;
    let userId = options?.userId;
    if (options?.scopeId && !projectId && !userId) {
      const parsed = parseRunScope(options.scopeId);
      projectId = parsed.projectId || undefined;
      userId = parsed.userId !== 'system' ? parsed.userId : undefined;
    }

    return client.ingestionRun.findMany({
      where: {
        ...(projectId ? { projectId } : userId ? { userId } : {}),
        status: { in: nonTerminalStatuses },
        updatedAt: { lt: olderThan },
        completedAt: null,
      },
      orderBy: { updatedAt: 'asc' },
      take: options?.limit ?? 100,
    });
  }

  async findLatestRunByInputHash(
    userId: string,
    inputHash: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun | null> {
    const client = this.getClient(tx);
    return client.ingestionRun.findFirst({
      where: {
        userId,
        inputHash,
      },
      orderBy: { startedAt: 'desc' },
    });
  }

  /**
   * Purge completed, failed, or cancelled runs older than a retention threshold.
   * Prevents long-term table and TOAST bloat.
   */
  async purgeOldRuns(
    olderThan: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = this.getClient(tx);
    const terminalStatuses: IngestionStatus[] = [
      IngestionStatus.COMPLETED,
      IngestionStatus.FAILED_FINAL,
      IngestionStatus.CANCELLED,
    ];

    const result = await client.ingestionRun.deleteMany({
      where: {
        status: { in: terminalStatuses },
        completedAt: { lt: olderThan },
      },
    });

    return result.count;
  }

  async findRecoverableRuns(
    since: Date,
    limit = 50,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun[]> {
    const client = this.getClient(tx);
    return client.ingestionRun.findMany({
      where: {
        status: {
          in: [IngestionStatus.PENDING, IngestionStatus.FAILED_RETRYABLE],
        },
        startedAt: { gte: since },
        completedAt: null,
      },
      orderBy: { startedAt: 'asc' },
      take: limit,
    });
  }

  async reconcileRun(
    _scope: { userId?: string; projectId?: string } | string,
    runId: string,
    data: {
      status: IngestionStatus;
      lastError: string;
      completedAt?: Date | null;
      attemptsIncrement?: boolean;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun> {
    const client = this.getClient(tx);
    return client.ingestionRun.update({
      where: { id: runId },
      data: {
        status: data.status,
        lastError: data.lastError,
        completedAt: data.completedAt,
        ...(data.attemptsIncrement ? { attempts: { increment: 1 } } : {}),
      },
    });
  }

  // ── Stage Operations ──────────────────────────────────────────────────────

  async createStage(
    ingestionRunId: string,
    data: CreateIngestionStageData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionStage> {
    const client = this.getClient(tx);
    const stage: IngestionStage = {
      id: randomUUID(),
      ingestionRunId,
      stageName: data.stageName,
      durationMs: data.durationMs ?? 0,
      success: data.success ?? true,
      errorMessage: data.errorMessage ?? null,
      outputSnapshot: data.outputSnapshot,
      leaseToken: data.leaseToken ?? null,
      leaseExpiresAt: data.leaseExpiresAt ?? null,
      executedAt: new Date(),
    };

    try {
      const run = await client.ingestionRun.findUnique({
        where: { id: ingestionRunId },
        select: { executionLog: true },
      });
      if (run) {
        const log =
          run.executionLog &&
          typeof run.executionLog === 'object' &&
          !Array.isArray(run.executionLog)
            ? (run.executionLog as Record<string, unknown>)
            : {};
        const stages = Array.isArray(log.stages)
          ? [...(log.stages as unknown[])]
          : [];
        stages.push({
          id: stage.id,
          stageName: data.stageName,
          durationMs: data.durationMs ?? 0,
          success: data.success ?? true,
          errorMessage: data.errorMessage,
          executedAt: stage.executedAt,
        });
        await client.ingestionRun.update({
          where: { id: ingestionRunId },
          data: {
            executionLog: {
              ...log,
              stages,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.debug(`Could not update executionLog for stage: ${message}`);
    }

    return stage;
  }

  async findStages(
    ingestionRunId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionStage[]> {
    const client = this.getClient(tx);
    const run = await client.ingestionRun.findUnique({
      where: { id: ingestionRunId },
      select: { executionLog: true },
    });
    const log =
      run?.executionLog &&
      typeof run.executionLog === 'object' &&
      !Array.isArray(run.executionLog)
        ? (run.executionLog as Record<string, unknown>)
        : {};
    return Array.isArray(log.stages) ? (log.stages as IngestionStage[]) : [];
  }

  // ── Candidate Operations ──────────────────────────────────────────────────

  createCandidate(
    ingestionRunId: string,
    data: CreateIngestionCandidateData,
    _tx?: Prisma.TransactionClient,
  ): Promise<IngestionCandidate> {
    return Promise.resolve({
      id: randomUUID(),
      ingestionRunId,
      sourceProvider: data.sourceProvider,
      sourceRecordId: data.sourceRecordId ?? null,
      confidenceScore: data.confidenceScore ?? 1.0,
      metadataPayload: data.metadataPayload,
      rawEvidenceRef: data.rawEvidenceRef ?? null,
      fetchedAt: new Date(),
    });
  }

  findCandidates(
    _ingestionRunId: string,
    _tx?: Prisma.TransactionClient,
  ): Promise<IngestionCandidate[]> {
    return Promise.resolve([]);
  }

  // ── Decision Operations ───────────────────────────────────────────────────

  createDecision(
    ingestionRunId: string,
    data: CreateIngestionDecisionData,
    _tx?: Prisma.TransactionClient,
  ): Promise<IngestionDecision> {
    return Promise.resolve({
      id: randomUUID(),
      ingestionRunId,
      decisionType: data.decisionType,
      decisionReason: data.decisionReason,
      proposedItem: data.proposedItem,
      fieldDecisions: data.fieldDecisions,
      duplicateMatch: data.duplicateMatch,
      decidedAt: new Date(),
    });
  }

  findDecisions(
    _ingestionRunId: string,
    _tx?: Prisma.TransactionClient,
  ): Promise<IngestionDecision[]> {
    return Promise.resolve([]);
  }

  // ── Review Case Operations ────────────────────────────────────────────────

  async createReviewCase(
    scope: IngestionScope,
    ingestionRunId: string,
    data: CreateIngestionReviewCaseData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase> {
    const client = this.getClient(tx);
    const { userId, projectId } = parseRunScope(scope, data.assignedToId);
    const reviewCase: IngestionReviewCase = {
      id: randomUUID(),
      userId: userId !== 'system' ? userId : null,
      projectId,
      ingestionRunId,
      targetItemId: data.targetItemId ?? null,
      reason: data.reason,
      evidence: data.evidence,
      options: data.options,
      assignedToId: data.assignedToId ?? null,
      status: 'PENDING',
      resolution: null,
      createdAt: new Date(),
      resolvedAt: null,
    };

    await client.ingestionRun.update({
      where: { id: ingestionRunId },
      data: {
        reviewData: reviewCase as unknown as Prisma.InputJsonValue,
      },
    });

    return reviewCase;
  }

  async findReviewCases(
    scope: IngestionScope,
    options?: { status?: string; limit?: number },
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase[]> {
    const client = this.getClient(tx);
    const { userId, projectId } = parseRunScope(scope);
    const runs = await client.ingestionRun.findMany({
      where: {
        ...(projectId
          ? { projectId }
          : userId && userId !== 'system'
            ? { userId }
            : {}),
        reviewData: { not: Prisma.JsonNull },
      },
      take: options?.limit ?? 50,
      orderBy: { startedAt: 'desc' },
      select: { reviewData: true },
    });
    return runs
      .map((r) => r.reviewData as unknown as IngestionReviewCase)
      .filter(Boolean);
  }

  async findReviewCaseById(
    _scope: { userId?: string; projectId?: string } | string,
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase | null> {
    const client = this.getClient(tx);
    const run = await client.ingestionRun.findFirst({
      where: { id },
      select: { reviewData: true },
    });
    return (run?.reviewData as unknown as IngestionReviewCase) ?? null;
  }

  async updateReviewCaseStatus(
    _scope: { userId?: string; projectId?: string } | string,
    id: string,
    status: 'APPROVED' | 'REJECTED' | 'DISMISSED',
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase> {
    const client = this.getClient(tx);
    const run = await client.ingestionRun.findFirst({
      where: { id },
      select: { reviewData: true },
    });
    const currentReview =
      (run?.reviewData as unknown as IngestionReviewCase) ||
      ({} as IngestionReviewCase);
    const updatedReview: IngestionReviewCase = {
      ...currentReview,
      status,
      resolvedAt: new Date(),
    };
    await client.ingestionRun.update({
      where: { id },
      data: {
        reviewData: updatedReview as unknown as Prisma.InputJsonValue,
        status:
          status === 'APPROVED'
            ? IngestionStatus.COMPLETED
            : IngestionStatus.FAILED_FINAL,
      },
    });
    return updatedReview;
  }

  async findIngestionDuplicateSuspects(
    scope: IngestionScope,
    limit: number = 50,
    tx?: Prisma.TransactionClient,
  ): Promise<
    Array<{
      runId: string;
      createdItemId: string;
      targetItemId: string;
      confidence: number;
      matchReason: string;
    }>
  > {
    const client = this.getClient(tx);
    const { userId, projectId } = parseRunScope(scope);
    const runs = await client.ingestionRun.findMany({
      where: {
        ...(projectId
          ? { projectId }
          : userId && userId !== 'system'
            ? { userId }
            : {}),
        itemId: { not: null },
        reviewData: { not: Prisma.JsonNull },
      },
      take: limit,
      orderBy: { startedAt: 'desc' },
      select: { id: true, itemId: true, reviewData: true },
    });

    const suspects: Array<{
      runId: string;
      createdItemId: string;
      targetItemId: string;
      confidence: number;
      matchReason: string;
    }> = [];

    for (const run of runs) {
      const rd = run.reviewData as unknown as
        | (IngestionReviewCase & {
            evidence?: { confidence?: number; matchReason?: string };
          })
        | null;
      if (
        rd &&
        rd.targetItemId &&
        run.itemId &&
        rd.status !== 'RESOLVED' &&
        rd.status !== 'DISMISSED'
      ) {
        suspects.push({
          runId: run.id,
          createdItemId: run.itemId,
          targetItemId: rd.targetItemId,
          confidence: rd.evidence?.confidence ?? 0.85,
          matchReason: rd.evidence?.matchReason ?? 'PROBABLE_MATCH',
        });
      }
    }
    return suspects;
  }

  async resolveReviewCasesForItems(
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!itemIds || itemIds.length === 0) return;
    const client = this.getClient(tx);
    const runs = await client.ingestionRun.findMany({
      where: {
        itemId: { in: itemIds },
        reviewData: { not: Prisma.JsonNull },
      },
      select: { id: true, reviewData: true },
    });

    for (const run of runs) {
      const rd =
        (run.reviewData as unknown as IngestionReviewCase) ||
        ({} as IngestionReviewCase);
      await client.ingestionRun.update({
        where: { id: run.id },
        data: {
          reviewData: {
            ...rd,
            status: 'RESOLVED',
            resolvedAt: new Date(),
          } as unknown as Prisma.InputJsonValue,
        },
      });
    }
  }

  // ── Capture Preview Operations (Persistent Database Store) ─────────────────
  async createCapturePreview(
    data: Prisma.CapturePreviewCreateInput,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return await client.capturePreview.create({ data });
  }

  async findCapturePreviewByTokenHash(
    tokenHash: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return await client.capturePreview.findUnique({
      where: { tokenHash },
    });
  }

  async claimCapturePreview(
    tokenHash: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = this.getClient(tx);
    const updateRes = await client.capturePreview.updateMany({
      where: {
        tokenHash,
        claimedAt: null,
      },
      data: {
        claimedAt: new Date(),
      },
    });
    return updateRes.count;
  }

  async deleteExpiredCapturePreviews(
    olderThan: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = this.getClient(tx);
    const res = await client.capturePreview.deleteMany({
      where: {
        expiresAt: { lt: olderThan },
      },
    });
    return res.count;
  }

  // ── Local Metadata Identifier Lookup ────────────────────────────────────
  /**
   * Tenant-scoped lookup of an Item by external identifier.
   * A scope is REQUIRED: items are user-owned and must never be resolved
   * across tenants. Returns null (fail closed) when no userId is supplied.
   */
  async findItemByIdentifier(
    type: string,
    cleanQuery: string,
    scope: { userId: string; projectId?: string | null },
    tx?: Prisma.TransactionClient,
  ) {
    if (!scope?.userId) return null;
    const client = this.getClient(tx);
    let whereClause: any = null;
    if (type === 'DOI') {
      whereClause = {
        doi: { equals: cleanQuery, mode: 'insensitive' },
        deletedAt: null,
      };
    } else if (type === 'ARXIV') {
      whereClause = { arxivId: cleanQuery, deletedAt: null };
    } else if (type === 'PMID') {
      whereClause = { pmid: cleanQuery, deletedAt: null };
    }
    if (!whereClause) return null;

    whereClause.userId = scope.userId;
    if (scope.projectId) whereClause.projectId = scope.projectId;

    return client.item.findFirst({
      where: whereClause,
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
      },
    });
  }
}
