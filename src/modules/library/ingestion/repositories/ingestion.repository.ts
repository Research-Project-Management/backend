import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma, IngestionRun, IngestionStatus, IngestionStage as DbIngestionStage, Item } from '@prisma/client';
import { IngestionStage, IngestionReviewCase } from '@/modules/library/ingestion/types/ingestion.types';
import { uuidv7 } from '@/modules/library/core';
import { isUUID } from 'class-validator';
import {
  CreateIngestionRunData,
  CreateIngestionStageData,
  CreateIngestionReviewCaseData,
  IngestionScope,
  parseRunScope,
} from '@/modules/library/ingestion/domain/duplicate-merge.domain';
export type { CreateIngestionRunData, CreateIngestionStageData, CreateIngestionReviewCaseData, IngestionScope };
export { parseRunScope };

function parseReviewCase(val: unknown): IngestionReviewCase | null {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return null;
  const obj = val as Record<string, unknown>;
  if (typeof obj.reason !== 'string' && Array.isArray(obj.cases) && obj.cases.length > 0) {
    const first = obj.cases[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      return first as IngestionReviewCase;
    }
  }
  return val as IngestionReviewCase;
}

function parseReviewCases(val: unknown): IngestionReviewCase[] {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return [];
  const obj = val as Record<string, unknown>;
  if (Array.isArray(obj.cases) && obj.cases.length > 0) {
    return obj.cases.filter(
      (c): c is IngestionReviewCase => Boolean(c) && typeof c === 'object' && !Array.isArray(c),
    );
  }
  const single = parseReviewCase(val);
  return single && (single.id || single.reason || single.targetItemId !== undefined) ? [single] : [];
}

function toJsonValue<T>(val: T): Prisma.InputJsonValue {
  return val as unknown as Prisma.InputJsonValue;
}

@Injectable()
export class IngestionRepository {
  private readonly logger = new Logger(IngestionRepository.name);
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient): PrismaService | Prisma.TransactionClient {
    return tx || this.prisma;
  }

  async createRun(
    scope: IngestionScope,
    data: CreateIngestionRunData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun> {
    const client = this.getClient(tx);
    const { userId, projectId } = parseRunScope(scope, data.userId);

    return client.ingestionRun.create({
      data: {
        ...(data.id ? { id: data.id } : {}),
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
    return this.getClient(tx).ingestionRun.update({ where: { id: runId }, data: { currentStage: stage } });
  }

  private buildRunIdWhere(scope: IngestionScope | undefined, runId: string): Prisma.IngestionRunWhereInput {
    if (!scope) return { id: runId };
    if (typeof scope === 'object') {
      if (scope.projectId && isUUID(scope.projectId)) return { id: runId, projectId: scope.projectId };
      if (scope.userId && scope.userId !== 'system' && isUUID(scope.userId)) return { id: runId, userId: scope.userId };
      return { id: runId };
    }
    const trimmed = scope.trim();
    if (!trimmed || trimmed === 'system' || trimmed === 'user' || trimmed === 'me' || !isUUID(trimmed)) {
      return { id: runId };
    }
    return { id: runId, OR: [{ userId: trimmed }, { projectId: trimmed }] };
  }

  async findRunById(
    scope: { userId?: string; projectId?: string } | string,
    runId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<(IngestionRun & { stages: IngestionStage[]; reviews: IngestionReviewCase[]; item?: Item | null }) | null> {
    const client = this.getClient(tx);
    const run = await client.ingestionRun.findFirst({
      where: this.buildRunIdWhere(scope, runId),
      include: { item: true },
    });
    if (!run) return null;
    const log = run.executionLog && typeof run.executionLog === 'object' ? (run.executionLog as Record<string, unknown>) : {};
    const rawStages = Array.isArray(log.stages) ? log.stages : [];
    const stages: IngestionStage[] = rawStages.map((stage) => {
      const s = stage && typeof stage === 'object' ? (stage as Record<string, unknown>) : {};
      return {
        id: typeof s.id === 'string' ? s.id : uuidv7(),
        ingestionRunId: run.id,
        stageName: typeof s.stageName === 'string' ? s.stageName : '',
        durationMs: typeof s.durationMs === 'number' ? s.durationMs : 0,
        success: s.success !== false,
        errorMessage: typeof s.errorMessage === 'string' ? s.errorMessage : null,
        outputSnapshot: s.outputSnapshot,
        leaseToken: typeof s.leaseToken === 'string' ? s.leaseToken : null,
        leaseExpiresAt: s.leaseExpiresAt ? new Date(s.leaseExpiresAt as string | number | Date) : null,
        executedAt: s.executedAt ? new Date(s.executedAt as string | number | Date) : new Date(),
      };
    });
    const parsedReviews = parseReviewCases(run.reviewData);
    return { ...run, stages, reviews: parsedReviews };
  }

  async findRunByIdempotencyKey(
    scope: IngestionScope,
    idempotencyKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun | null> {
    const client = this.getClient(tx);
    const { userId, projectId } = parseRunScope(scope);
    return client.ingestionRun.findFirst({
      where: { userId, projectId: projectId ?? null, idempotencyKey },
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
      previousStatus?: IngestionStatus;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun> {
    const client = this.getClient(tx);
    const isRetry = details?.previousStatus === IngestionStatus.FAILED_RETRYABLE && status === IngestionStatus.PENDING;
    return client.ingestionRun.update({
      where: { id: runId },
      data: {
        status,
        ...(details?.itemId !== undefined ? { itemId: details.itemId } : {}),
        ...(details?.lastError !== undefined ? { lastError: details.lastError } : {}),
        ...(details?.completedAt !== undefined ? { completedAt: details.completedAt } : {}),
        ...(details?.executionLog !== undefined
          ? {
              executionLog: await (async () => {
                if (details.executionLog && typeof details.executionLog === 'object' && !Array.isArray(details.executionLog)) {
                  const existing = await client.ingestionRun.findUnique({ where: { id: runId }, select: { executionLog: true } });
                  const existingLog = existing?.executionLog && typeof existing.executionLog === 'object' && !Array.isArray(existing.executionLog)
                    ? (existing.executionLog as Record<string, unknown>) : {};
                  return { ...existingLog, ...(details.executionLog as Record<string, unknown>), stages: (details.executionLog as Record<string, unknown>).stages ?? existingLog.stages } as Prisma.InputJsonValue;
                }
                return details.executionLog;
              })(),
            }
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
    let mergedProgress = progress;
    if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
      const existing = await client.ingestionRun.findUnique({ where: { id: runId }, select: { executionLog: true } });
      const existingLog = existing?.executionLog && typeof existing.executionLog === 'object' && !Array.isArray(existing.executionLog)
        ? (existing.executionLog as Record<string, unknown>) : {};
      mergedProgress = { ...existingLog, ...(progress as Record<string, unknown>), stages: (progress as Record<string, unknown>).stages ?? existingLog.stages } as Prisma.InputJsonValue;
    }
    await client.ingestionRun.update({ where: { id: runId }, data: { executionLog: mergedProgress } });
  }

  async findOrphanedRuns(
    olderThan: Date,
    options?: { scopeId?: string; userId?: string; projectId?: string; limit?: number },
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun[]> {
    const client = this.getClient(tx);
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
        status: { in: [IngestionStatus.PENDING, IngestionStatus.RUNNING] },
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
    return this.getClient(tx).ingestionRun.findFirst({
      where: { userId, inputHash },
      orderBy: { startedAt: 'desc' },
    });
  }

  async purgeOldRuns(olderThanOrDays: Date | number = 7, tx?: Prisma.TransactionClient): Promise<number> {
    const olderThan = typeof olderThanOrDays === 'number'
      ? new Date(Date.now() - olderThanOrDays * 24 * 60 * 60 * 1000) : olderThanOrDays;
    const result = await this.getClient(tx).ingestionRun.deleteMany({
      where: {
        status: { in: [IngestionStatus.COMPLETED, IngestionStatus.FAILED_FINAL, IngestionStatus.CANCELLED] },
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
      id: uuidv7(),
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
      const run = await client.ingestionRun.findUnique({ where: { id: ingestionRunId }, select: { executionLog: true } });
      if (run) {
        const log = run.executionLog && typeof run.executionLog === 'object' && !Array.isArray(run.executionLog)
          ? (run.executionLog as Record<string, unknown>) : {};
        const stages = Array.isArray(log.stages) ? [...(log.stages as unknown[])] : [];
        stages.push({
          id: stage.id,
          stageName: data.stageName,
          durationMs: data.durationMs ?? 0,
          success: data.success ?? true,
          errorMessage: data.errorMessage ?? null,
          outputSnapshot: data.outputSnapshot,
          leaseToken: data.leaseToken ?? null,
          leaseExpiresAt: data.leaseExpiresAt ?? null,
          executedAt: stage.executedAt,
        });
        await client.ingestionRun.update({
          where: { id: ingestionRunId },
          data: { executionLog: { ...log, stages } as unknown as Prisma.InputJsonValue },
        });
      }
    } catch (err: unknown) {
      this.logger.debug(`Could not update executionLog for stage: ${err instanceof Error ? err.message : String(err)}`);
    }
    return stage;
  }

  async updateStageByRunAndName(
    ingestionRunId: string,
    stageName: string,
    data: Partial<CreateIngestionStageData>,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionStage | null> {
    const client = this.getClient(tx);
    const run = await client.ingestionRun.findUnique({ where: { id: ingestionRunId }, select: { executionLog: true } });
    if (!run) return null;
    const log = run.executionLog && typeof run.executionLog === 'object' && !Array.isArray(run.executionLog)
      ? (run.executionLog as Record<string, unknown>) : {};
    const stages = Array.isArray(log.stages) ? [...(log.stages as Array<Record<string, unknown>>)] : [];
    const idx = stages.findIndex((s) => s && s.stageName === stageName);
    const existing = idx >= 0 ? stages[idx] : null;
    const updatedStage: IngestionStage = {
      id: typeof existing?.id === 'string' ? existing.id : uuidv7(),
      ingestionRunId,
      stageName,
      durationMs: data.durationMs ?? (typeof existing?.durationMs === 'number' ? existing.durationMs : 0),
      success: data.success ?? (typeof existing?.success === 'boolean' ? existing.success : true),
      errorMessage: data.errorMessage !== undefined ? data.errorMessage : typeof existing?.errorMessage === 'string' ? existing.errorMessage : null,
      outputSnapshot: data.outputSnapshot !== undefined ? data.outputSnapshot : existing?.outputSnapshot,
      leaseToken: data.leaseToken !== undefined ? data.leaseToken : typeof existing?.leaseToken === 'string' ? existing.leaseToken : null,
      leaseExpiresAt: data.leaseExpiresAt !== undefined ? data.leaseExpiresAt : existing?.leaseExpiresAt ? new Date(existing.leaseExpiresAt as string | number | Date) : null,
      executedAt: existing?.executedAt ? new Date(existing.executedAt as string | number | Date) : new Date(),
    };
    const persistedStage = {
      id: updatedStage.id,
      stageName: updatedStage.stageName,
      durationMs: updatedStage.durationMs,
      success: updatedStage.success,
      errorMessage: updatedStage.errorMessage ?? null,
      outputSnapshot: updatedStage.outputSnapshot,
      leaseToken: updatedStage.leaseToken ?? null,
      leaseExpiresAt: updatedStage.leaseExpiresAt ?? null,
      executedAt: updatedStage.executedAt,
    };
    if (idx >= 0) stages[idx] = persistedStage;
    else stages.push(persistedStage);
    await client.ingestionRun.update({
      where: { id: ingestionRunId },
      data: { executionLog: { ...log, stages } as unknown as Prisma.InputJsonValue },
    });
    return updatedStage;
  }

  async findStages(ingestionRunId: string, tx?: Prisma.TransactionClient): Promise<IngestionStage[]> {
    const run = await this.getClient(tx).ingestionRun.findUnique({ where: { id: ingestionRunId }, select: { executionLog: true } });
    const log = run?.executionLog && typeof run.executionLog === 'object' && !Array.isArray(run.executionLog)
      ? (run.executionLog as Record<string, unknown>) : {};
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
    const existingRun = await client.ingestionRun
      .findUnique({ where: { id: ingestionRunId }, select: { userId: true, reviewData: true } })
      .catch(() => null);
    let fallbackUserId = data.assignedToId || data.assignedToUserId;
    if (!fallbackUserId && (!scope || scope === 'user' || scope === 'me' || (typeof scope === 'object' && !scope.userId))) {
      if (existingRun?.userId) fallbackUserId = existingRun.userId;
    }
    const { userId, projectId } = parseRunScope(scope, fallbackUserId);
    const existingCases = parseReviewCases(existingRun?.reviewData);
    const caseId =
      existingCases.length > 0
        ? `${ingestionRunId}:${existingCases.length + 1}`
        : ingestionRunId;
    const reviewCase: IngestionReviewCase = {
      id: caseId,
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
    const allCases = [...existingCases, reviewCase];
    const storedReviewData =
      allCases.length > 1 ? { ...reviewCase, id: ingestionRunId, cases: allCases } : { ...reviewCase, cases: allCases };
    await client.ingestionRun.update({
      where: { id: ingestionRunId },
      data: { reviewData: toJsonValue(storedReviewData) },
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
    const statusFilter = options?.status?.trim().toUpperCase();
    const runs = await client.ingestionRun.findMany({
      where: {
        ...(projectId ? { projectId } : userId && userId !== 'system' ? { userId } : {}),
        reviewData: statusFilter ? { path: ['status'], equals: statusFilter } : { not: Prisma.JsonNull },
      },
      take: options?.limit ?? 50,
      orderBy: { startedAt: 'desc' },
      select: { reviewData: true },
    });
    return runs
      .flatMap((r) => parseReviewCases(r.reviewData))
      .filter((rc): rc is IngestionReviewCase => Boolean(rc) && (!statusFilter || String(rc?.status || '').toUpperCase() === statusFilter));
  }

  private buildReviewCaseWhere(scope: IngestionScope | undefined, id: string): Prisma.IngestionRunWhereInput {
    const baseRunId = id.includes(':') ? id.split(':')[0] : id;
    const { id: _ignoredId, ...scopeFilters } = this.buildRunIdWhere(scope, baseRunId);
    return {
      ...scopeFilters,
      OR: [{ id }, { id: baseRunId }, { reviewData: { path: ['id'], equals: id } }],
    };
  }

  async findReviewCaseById(scope: IngestionScope, id: string, tx?: Prisma.TransactionClient): Promise<IngestionReviewCase | null> {
    const run = await this.getClient(tx).ingestionRun.findFirst({ where: this.buildReviewCaseWhere(scope, id), select: { reviewData: true } });
    const cases = parseReviewCases(run?.reviewData);
    return cases.find((c) => c.id === id || c.ingestionRunId === id) ?? parseReviewCase(run?.reviewData);
  }

  async updateReviewCaseStatus(
    scope: IngestionScope,
    id: string,
    status: 'OPEN' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'DISMISSED' | 'RESOLVED',
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase> {
    const client = this.getClient(tx);
    const run = await client.ingestionRun.findFirst({ where: this.buildReviewCaseWhere(scope, id), select: { id: true, reviewData: true } });
    const existingCases = parseReviewCases(run?.reviewData);
    const matchedCase = existingCases.find((c) => c.id === id) ?? existingCases[0] ?? parseReviewCase(run?.reviewData) ?? ({} as IngestionReviewCase);
    const isResolved = status === 'APPROVED' || status === 'REJECTED' || status === 'DISMISSED' || status === 'RESOLVED';
    const resolvedDate = isResolved ? new Date() : null;
    const updatedReview: IngestionReviewCase = { ...matchedCase, status, resolvedAt: resolvedDate };
    const updatedCases =
      existingCases.length > 0
        ? existingCases.map((c) =>
            c.id === id || (c.ingestionRunId === id && existingCases.length === 1)
              ? { ...c, status, resolvedAt: resolvedDate }
              : c,
          )
        : [updatedReview];
    const targetRunId = run?.id || updatedReview.ingestionRunId || (id.includes(':') ? id.split(':')[0] : id);
    const allResolved = updatedCases.every(
      (c) => c.status === 'APPROVED' || c.status === 'REJECTED' || c.status === 'DISMISSED' || c.status === 'RESOLVED',
    );
    const storedReviewData =
      existingCases.length > 0
        ? { ...updatedReview, status: allResolved ? status : 'PENDING', cases: updatedCases }
        : updatedReview;
    await client.ingestionRun.update({
      where: { id: targetRunId },
      data: {
        reviewData: toJsonValue(storedReviewData),
        ...(allResolved && (status === 'APPROVED' || status === 'RESOLVED') ? { status: IngestionStatus.COMPLETED }
          : allResolved && (status === 'REJECTED' || status === 'DISMISSED') ? { status: IngestionStatus.FAILED_FINAL } : {}),
      },
    });
    return updatedReview;
  }

  async findIngestionDuplicateSuspects(
    scope: IngestionScope,
    limit: number = 50,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ runId: string; createdItemId: string; targetItemId: string; confidence: number; matchReason: string }>> {
    const client = this.getClient(tx);
    const { userId, projectId } = parseRunScope(scope);
    const runs = await client.ingestionRun.findMany({
      where: {
        ...(projectId ? { projectId } : userId && userId !== 'system' ? { userId, projectId: null } : {}),
        itemId: { not: null },
        reviewData: { not: Prisma.JsonNull },
      },
      take: limit,
      orderBy: { startedAt: 'desc' },
      select: { id: true, itemId: true, reviewData: true },
    });
    const suspects: Array<{ runId: string; createdItemId: string; targetItemId: string; confidence: number; matchReason: string }> = [];
    for (const run of runs) {
      const cases = parseReviewCases(run.reviewData) as Array<IngestionReviewCase & { evidence?: { confidence?: number; matchReason?: string } }>;
      for (const rd of cases) {
        if (rd?.targetItemId && run.itemId && rd.status !== 'RESOLVED' && rd.status !== 'DISMISSED') {
          suspects.push({
            runId: run.id,
            createdItemId: run.itemId,
            targetItemId: rd.targetItemId,
            confidence: rd.evidence?.confidence ?? 0.85,
            matchReason: rd.evidence?.matchReason ?? 'PROBABLE_MATCH',
          });
        }
      }
    }
    return suspects;
  }

  async resolveReviewCasesForItems(itemIds: string[], tx?: Prisma.TransactionClient): Promise<void> {
    if (!itemIds || itemIds.length === 0) return;
    const client = this.getClient(tx);
    const resolvedAt = new Date().toISOString();
    if (typeof client.ingestionRun?.findMany === 'function') {
      const matchingRuns = await client.ingestionRun.findMany({
        where: {
          OR: [{ itemId: { in: itemIds } }, ...itemIds.map((itemId) => ({ reviewData: { path: ['targetItemId'], equals: itemId } }))],
          reviewData: { not: Prisma.JsonNull },
        },
        select: { id: true, reviewData: true },
      });
      for (const run of matchingRuns) {
        const existingReviewData = run.reviewData && typeof run.reviewData === 'object' && !Array.isArray(run.reviewData)
          ? (run.reviewData as Record<string, unknown>) : {};
        const currentStatus = String(existingReviewData.status || 'PENDING').toUpperCase();
        const existingCases = parseReviewCases(run.reviewData);
        const updatedCases = existingCases.map((c) =>
          !c.targetItemId || itemIds.includes(c.targetItemId)
            ? { ...c, status: 'RESOLVED' as const, resolvedAt: new Date(resolvedAt) }
            : c,
        );
        if (currentStatus === 'OPEN' || currentStatus === 'PENDING') {
          await client.ingestionRun.update({
            where: { id: run.id },
            data: {
              reviewData: toJsonValue({
                ...existingReviewData,
                status: 'RESOLVED',
                resolvedAt,
                ...(updatedCases.length > 0 ? { cases: updatedCases } : {}),
              }),
            },
          });
        }
      }
      return;
    }
    await client.ingestionRun.updateMany({
      where: { itemId: { in: itemIds }, reviewData: { not: Prisma.JsonNull } },
      data: { reviewData: toJsonValue({ status: 'RESOLVED', resolvedAt }) },
    });
  }

  // Capture Preview Operations (Persistent Database Store)
  async createCapturePreview(data: Prisma.CapturePreviewCreateInput, tx?: Prisma.TransactionClient) {
    return this.getClient(tx).capturePreview.create({ data });
  }

  async findCapturePreviewByTokenHash(tokenHash: string, tx?: Prisma.TransactionClient) {
    return this.getClient(tx).capturePreview.findUnique({ where: { tokenHash } });
  }

  async claimCapturePreview(tokenHash: string, tx?: Prisma.TransactionClient): Promise<number> {
    const res = await this.getClient(tx).capturePreview.updateMany({ where: { tokenHash, claimedAt: null }, data: { claimedAt: new Date() } });
    return res.count;
  }

  async releaseCapturePreview(tokenHash: string, tx?: Prisma.TransactionClient): Promise<number> {
    const res = await this.getClient(tx).capturePreview.updateMany({ where: { tokenHash }, data: { claimedAt: null } });
    return res.count;
  }

  async findExpiredCapturePreviews(olderThan: Date = new Date(), tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    if (!client.capturePreview?.findMany) return [];
    return client.capturePreview.findMany({
      where: { expiresAt: { lt: olderThan } },
      take: 200,
      select: { id: true, claimedAt: true, canonicalMetadata: true },
    });
  }

  async deleteExpiredCapturePreviews(olderThan: Date = new Date(), ids?: string[], tx?: Prisma.TransactionClient): Promise<number> {
    const res = await this.getClient(tx).capturePreview.deleteMany({
      where: { ...(Array.isArray(ids) && ids.length > 0 ? { id: { in: ids } } : {}), expiresAt: { lt: olderThan } },
    });
    return res.count;
  }

  /**
   * Scope-isolated lookup of an Item by external identifier.
   * Returns null (fail closed) when no userId is supplied.
   */
  async findItemByIdentifier(
    type: string,
    cleanQuery: string,
    scope: { userId: string; projectId?: string | null },
    tx?: Prisma.TransactionClient,
  ) {
    if (!scope?.userId) return null;
    const upperType = type.trim().toUpperCase();
    const cleanIsbn = cleanQuery.replace(/[-\s]/g, '').trim();
    const baseArxiv = cleanQuery.replace(/v\d+$/i, '').trim();
    const whereByType: Record<string, Prisma.ItemWhereInput> = {
      DOI: {
        deletedAt: null,
        OR: [
          { doi: { equals: cleanQuery, mode: 'insensitive' } },
          { metadata: { path: ['doi'], equals: cleanQuery } },
          { identifiers: { some: { type: 'doi', value: { equals: cleanQuery, mode: 'insensitive' } } } },
        ],
      },
      ARXIV: {
        deletedAt: null,
        OR: [
          { metadata: { path: ['arxivId'], equals: cleanQuery } },
          { metadata: { path: ['arxivId'], equals: baseArxiv } },
          { metadata: { path: ['arxiv'], equals: cleanQuery } },
          { identifiers: { some: { type: { in: ['arxiv', 'arxivId'] }, value: { in: [cleanQuery, baseArxiv] } } } },
        ],
      },
      PMID: {
        deletedAt: null,
        OR: [
          { metadata: { path: ['pmid'], equals: cleanQuery } },
          { identifiers: { some: { type: 'pmid', value: cleanQuery } } },
        ],
      },
      ISBN: {
        deletedAt: null,
        OR: [
          { metadata: { path: ['isbn'], equals: cleanIsbn } },
          { metadata: { path: ['isbn'], equals: cleanQuery } },
          { identifiers: { some: { type: 'isbn', value: { in: [cleanIsbn, cleanQuery] } } } },
        ],
      },
    };
    const whereClause = whereByType[upperType];
    if (!whereClause) return null;
    if (scope.projectId) {
      whereClause.projectId = scope.projectId;
    } else {
      whereClause.userId = scope.userId;
      whereClause.projectId = null;
    }
    return this.getClient(tx).item.findFirst({
      where: whereClause,
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        identifiers: true,
      },
    });
  }
}
