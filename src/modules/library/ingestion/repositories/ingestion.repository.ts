import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@/core';
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
} from '@/modules/library/ingestion/types/ingestion.types';
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

function parseReviewCase(val: unknown): IngestionReviewCase | null {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return null;
  return val as IngestionReviewCase;
}

function toJsonValue<T>(val: T): Prisma.InputJsonValue {
  return val as unknown as Prisma.InputJsonValue;
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

  // Run Operations

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

  private buildRunIdWhere(
    scope: IngestionScope | undefined,
    runId: string,
  ): Prisma.IngestionRunWhereInput {
    if (!scope) return { id: runId };
    if (typeof scope === 'object') {
      if (scope.projectId && isUUID(scope.projectId)) {
        return { id: runId, projectId: scope.projectId };
      }
      if (scope.userId && scope.userId !== 'system' && isUUID(scope.userId)) {
        return { id: runId, userId: scope.userId };
      }
      return { id: runId };
    }
    const trimmed = scope.trim();
    if (
      !trimmed ||
      trimmed === 'system' ||
      trimmed === 'user' ||
      trimmed === 'me' ||
      !isUUID(trimmed)
    ) {
      return { id: runId };
    }
    return {
      id: runId,
      OR: [{ userId: trimmed }, { projectId: trimmed }],
    };
  }

  async findRunById(
    scope: { userId?: string; projectId?: string } | string,
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
      where: this.buildRunIdWhere(scope, runId),
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
    const parsedReview = parseReviewCase(run.reviewData);
    const reviewCases: IngestionReviewCase[] = parsedReview
      ? [parsedReview]
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
      status === IngestionStatus.PENDING;
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

  // Stage Operations

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

  // Review Case Operations

  async createReviewCase(
    scope: IngestionScope,
    ingestionRunId: string,
    data: CreateIngestionReviewCaseData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase> {
    const client = this.getClient(tx);
    let fallbackUserId = data.assignedToId || data.assignedToUserId;
    if (
      !fallbackUserId &&
      (!scope ||
        scope === 'user' ||
        scope === 'me' ||
        (typeof scope === 'object' && !scope.userId))
    ) {
      const existingRun = await client.ingestionRun
        .findUnique({
          where: { id: ingestionRunId },
          select: { userId: true },
        })
        .catch(() => null);
      if (existingRun?.userId) {
        fallbackUserId = existingRun.userId;
      }
    }
    const { userId, projectId } = parseRunScope(scope, fallbackUserId);
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
        reviewData: toJsonValue(reviewCase),
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
      .map((r) => parseReviewCase(r.reviewData))
      .filter((rc): rc is IngestionReviewCase => Boolean(rc));
  }

  async findReviewCaseById(
    scope: { userId?: string; projectId?: string } | string,
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase | null> {
    const client = this.getClient(tx);
    const run = await client.ingestionRun.findFirst({
      where: this.buildRunIdWhere(scope, id),
      select: { reviewData: true },
    });
    return parseReviewCase(run?.reviewData);
  }

  async updateReviewCaseStatus(
    scope: { userId?: string; projectId?: string } | string,
    id: string,
    status: 'APPROVED' | 'REJECTED' | 'DISMISSED',
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase> {
    const client = this.getClient(tx);
    const run = await client.ingestionRun.findFirst({
      where: this.buildRunIdWhere(scope, id),
      select: { reviewData: true },
    });
    const currentReview =
      parseReviewCase(run?.reviewData) || ({} as IngestionReviewCase);
    const updatedReview: IngestionReviewCase = {
      ...currentReview,
      status,
      resolvedAt: new Date(),
    };
    await client.ingestionRun.update({
      where: { id },
      data: {
        reviewData: toJsonValue(updatedReview),
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
            ? { userId, projectId: null }
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
      const rd = parseReviewCase(run.reviewData) as
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
      const rd = parseReviewCase(run.reviewData) || ({} as IngestionReviewCase);
      await client.ingestionRun.update({
        where: { id: run.id },
        data: {
          reviewData: toJsonValue({
            ...rd,
            status: 'RESOLVED',
            resolvedAt: new Date(),
          }),
        },
      });
    }
  }

  // Capture Preview Operations (Persistent Database Store)
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

  // Local Metadata Identifier Lookup
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
    let whereClause: Prisma.ItemWhereInput | null = null;
    if (type === 'DOI') {
      whereClause = {
        doi: { equals: cleanQuery, mode: 'insensitive' },
        deletedAt: null,
      };
    } else if (type === 'ARXIV') {
      whereClause = {
        metadata: { path: ['arxivId'], equals: cleanQuery },
        deletedAt: null,
      };
    } else if (type === 'PMID') {
      whereClause = {
        metadata: { path: ['pmid'], equals: cleanQuery },
        deletedAt: null,
      };
    }
    if (!whereClause) return null;

    if (scope.projectId) {
      whereClause.projectId = scope.projectId;
    } else {
      whereClause.userId = scope.userId;
      whereClause.projectId = null;
    }

    return client.item.findFirst({
      where: whereClause,
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
      },
    });
  }
}
