import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import {
  Prisma,
  IngestionRun,
  IngestionStatus,
  Item,
} from '@prisma/client';
import {
  IngestionStage,
  IngestionCandidate,
  IngestionDecision,
  IngestionReviewCase,
} from '../../domain/types/ingestion.types';
import { randomUUID } from 'crypto';
import { isUUID } from 'class-validator';

export interface CreateIngestionRunData {
  id?: string;
  userId?: string;
  projectId?: string | null;
  inputParams: Prisma.InputJsonValue;
  inputHash: string;
  idempotencyKey?: string;
  contractVersion?: string;
  pipelineVersion?: string;
  status?: IngestionStatus;
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
  | { userId?: string; projectId?: string | null }
  | string;

export function parseRunScope(
  scope?: IngestionScope,
  fallbackUserId?: string,
): { userId: string; projectId: string | null } {
  if (typeof scope === 'object' && scope !== null) {
    const rawProject = scope.projectId;
    return {
      userId: scope.userId || fallbackUserId || 'system',
      projectId: rawProject && isUUID(rawProject) ? rawProject : null,
    };
  }
  const str = typeof scope === 'string' ? scope : '';
  const isProject =
    str &&
    str !== 'user' &&
    str !== 'me' &&
    str !== 'personal' &&
    str !== fallbackUserId &&
    isUUID(str);
  return {
    userId: fallbackUserId || (!isProject && str ? str : 'system'),
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
        inputParams: data.inputParams,
        inputHash: data.inputHash,
        idempotencyKey: data.idempotencyKey,
        contractVersion: data.contractVersion || '1.0.0',
        pipelineVersion: data.pipelineVersion || '1.0.0',
        status: IngestionStatus.RECEIVED,
      },
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
    const log = (run.executionLog as any) || {};
    const stages: IngestionStage[] = Array.isArray(log.stages)
      ? log.stages.map((s: any) => ({
          id: s.id || randomUUID(),
          ingestionRunId: run.id,
          stageName: s.stageName,
          durationMs: s.durationMs || 0,
          success: s.success !== false,
          errorMessage: s.errorMessage || null,
          executedAt: s.executedAt ? new Date(s.executedAt) : new Date(),
        }))
      : [];
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
    const { userId, projectId } = parseRunScope(scope);
    return client.ingestionRun.findFirst({
      where: {
        idempotencyKey,
        ...(projectId ? { projectId } : userId && userId !== 'system' ? { userId } : {}),
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
    // Only increment attempts when retrying: transitioning from FAILED_RETRYABLE back to RECEIVED
    const isRetry =
      details?.previousStatus === IngestionStatus.FAILED_RETRYABLE &&
      status === IngestionStatus.RECEIVED;
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
      IngestionStatus.RECEIVED,
      IngestionStatus.DETECTED,
      IngestionStatus.EXTRACTED,
      IngestionStatus.RESOLVED,
      IngestionStatus.NORMALIZED,
      IngestionStatus.MERGED,
      IngestionStatus.ENRICHING,
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
        startedAt: { lt: olderThan },
        completedAt: null,
      },
      orderBy: { startedAt: 'asc' },
      take: options?.limit ?? 100,
    });
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
          in: [IngestionStatus.RECEIVED, IngestionStatus.FAILED_RETRYABLE],
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
        const log = (run.executionLog as any) || {};
        const stages = Array.isArray(log.stages) ? log.stages : [];
        stages.push({
          stageName: data.stageName,
          durationMs: data.durationMs,
          success: data.success,
          errorMessage: data.errorMessage,
        });
        await client.ingestionRun.update({
          where: { id: ingestionRunId },
          data: { executionLog: { ...log, stages } },
        });
      }
    } catch (err: any) {
      this.logger.debug(`Could not update executionLog for stage: ${err?.message}`);
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
    const log = (run?.executionLog as any) || {};
    return Array.isArray(log.stages) ? log.stages : [];
  }

  // ── Candidate Operations ──────────────────────────────────────────────────

  async createCandidate(
    ingestionRunId: string,
    data: CreateIngestionCandidateData,
    _tx?: Prisma.TransactionClient,
  ): Promise<IngestionCandidate> {
    return {
      id: randomUUID(),
      ingestionRunId,
      sourceProvider: data.sourceProvider,
      sourceRecordId: data.sourceRecordId ?? null,
      confidenceScore: data.confidenceScore ?? 1.0,
      metadataPayload: data.metadataPayload,
      rawEvidenceRef: data.rawEvidenceRef ?? null,
      fetchedAt: new Date(),
    };
  }

  async findCandidates(
    _ingestionRunId: string,
    _tx?: Prisma.TransactionClient,
  ): Promise<IngestionCandidate[]> {
    return [];
  }

  // ── Decision Operations ───────────────────────────────────────────────────

  async createDecision(
    ingestionRunId: string,
    data: CreateIngestionDecisionData,
    _tx?: Prisma.TransactionClient,
  ): Promise<IngestionDecision> {
    return {
      id: randomUUID(),
      ingestionRunId,
      decisionType: data.decisionType,
      decisionReason: data.decisionReason,
      proposedItem: data.proposedItem,
      fieldDecisions: data.fieldDecisions,
      duplicateMatch: data.duplicateMatch,
      decidedAt: new Date(),
    };
  }

  async findDecisions(
    _ingestionRunId: string,
    _tx?: Prisma.TransactionClient,
  ): Promise<IngestionDecision[]> {
    return [];
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
        status: IngestionStatus.NEEDS_REVIEW,
        reviewData: reviewCase as any,
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
        ...(projectId ? { projectId } : userId && userId !== 'system' ? { userId } : {}),
        status: IngestionStatus.NEEDS_REVIEW,
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
    const currentReview = (run?.reviewData as any) || {};
    const updatedReview: IngestionReviewCase = {
      ...currentReview,
      status,
      resolvedAt: new Date(),
    };
    await client.ingestionRun.update({
      where: { id },
      data: {
        reviewData: updatedReview as any,
        status: status === 'APPROVED' ? IngestionStatus.COMMITTED : IngestionStatus.FAILED_FINAL,
      },
    });
    return updatedReview;
  }

  // ── Capture Preview Operations ───────────────────────────────────────────
  async createCapturePreview(data: any, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return await (client as any).capturePreview.create({
      data,
    });
  }

  async findCapturePreviewByTokenHash(
    tokenHash: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return await (client as any).capturePreview.findUnique({
      where: { tokenHash },
    });
  }

  async claimCapturePreview(
    tokenHash: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = this.getClient(tx);
    const updateRes = await (client as any).capturePreview.updateMany({
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
    const res = await (client as any).capturePreview.deleteMany({
      where: {
        expiresAt: { lt: olderThan },
      },
    });
    return res.count;
  }

  // ── Local Metadata Identifier Lookup ────────────────────────────────────
  async findItemByIdentifier(
    type: string,
    cleanQuery: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    let whereClause: any = null;
    if (type === 'DOI') {
      whereClause = { doi: cleanQuery, deletedAt: null };
    } else if (type === 'ARXIV') {
      whereClause = { arxivId: cleanQuery, deletedAt: null };
    } else if (type === 'PMID') {
      whereClause = { pmid: cleanQuery, deletedAt: null };
    }
    if (!whereClause) return null;

    return client.item.findFirst({
      where: whereClause,
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
      },
    });
  }
}
