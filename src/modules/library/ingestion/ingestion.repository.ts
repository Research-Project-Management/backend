import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import {
  Prisma,
  IngestionRun,
  IngestionStage,
  IngestionCandidate,
  IngestionDecision,
  IngestionReviewCase,
  IngestionStatus,
  Item,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { isUUID } from 'class-validator';

export interface CreateIngestionRunData {
  id?: string;
  requesterId?: string;
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
    scope: { userId: string; projectId?: string } | string,
    data: CreateIngestionRunData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun> {
    const client = this.getClient(tx);
    const userId =
      typeof scope === 'object' ? scope.userId : data.requesterId || scope;
    const rawProjectId =
      typeof scope === 'object'
        ? scope.projectId
        : scope !== data.requesterId
          ? scope
          : undefined;
    const safeProjectId =
      rawProjectId && isUUID(rawProjectId) ? rawProjectId : null;

    return client.ingestionRun.create({
      data: {
        id: data.id || randomUUID(),
        userId,
        projectId: safeProjectId,
        requesterId: data.requesterId,
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
        stages: { orderBy: { executedAt: 'asc' } },
        candidates: { orderBy: { fetchedAt: 'asc' } },
        decisions: { orderBy: { decidedAt: 'desc' } },
        reviewCases: { orderBy: { createdAt: 'desc' } },
        item: true,
      },
    });
    return run;
  }

  async findRunByIdempotencyKey(
    _scope: { userId?: string; projectId?: string } | string,
    idempotencyKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun | null> {
    const client = this.getClient(tx);
    const userId =
      typeof _scope === 'object' ? _scope.userId : _scope || undefined;
    const projectId = typeof _scope === 'object' ? _scope.projectId : undefined;
    return client.ingestionRun.findFirst({
      where: {
        idempotencyKey,
        ...(projectId ? { projectId } : userId ? { userId } : {}),
      },
    });
  }

  async updateRunStatus(
    _scope: { userId?: string; projectId?: string } | string,
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
    _scope: { userId?: string; projectId?: string } | string,
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

    const projectId =
      options?.projectId ||
      (options?.scopeId && options.scopeId !== options.userId
        ? options.scopeId
        : undefined);
    const userId =
      options?.userId || (!projectId ? options?.scopeId : undefined);

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
    return client.ingestionStage.create({
      data: {
        ingestionRunId,
        stageName: data.stageName,
        durationMs: data.durationMs ?? 0,
        success: data.success ?? true,
        errorMessage: data.errorMessage,
        outputSnapshot: data.outputSnapshot,
        leaseToken: data.leaseToken,
        leaseExpiresAt: data.leaseExpiresAt,
      },
    });
  }

  async findStages(
    ingestionRunId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionStage[]> {
    const client = this.getClient(tx);
    return client.ingestionStage.findMany({
      where: { ingestionRunId },
      orderBy: { executedAt: 'asc' },
    });
  }

  // ── Candidate Operations ──────────────────────────────────────────────────

  async createCandidate(
    ingestionRunId: string,
    data: CreateIngestionCandidateData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionCandidate> {
    const client = this.getClient(tx);
    return client.ingestionCandidate.create({
      data: {
        ingestionRunId,
        sourceProvider: data.sourceProvider,
        sourceRecordId: data.sourceRecordId,
        confidenceScore: data.confidenceScore ?? 1.0,
        metadataPayload: data.metadataPayload,
        rawEvidenceRef: data.rawEvidenceRef,
      },
    });
  }

  async findCandidates(
    ingestionRunId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionCandidate[]> {
    const client = this.getClient(tx);
    return client.ingestionCandidate.findMany({
      where: { ingestionRunId },
      orderBy: { fetchedAt: 'asc' },
    });
  }

  // ── Decision Operations ───────────────────────────────────────────────────

  async createDecision(
    ingestionRunId: string,
    data: CreateIngestionDecisionData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionDecision> {
    const client = this.getClient(tx);
    return client.ingestionDecision.create({
      data: {
        ingestionRunId,
        decisionType: data.decisionType,
        decisionReason: data.decisionReason,
        proposedItem: data.proposedItem,
        fieldDecisions: data.fieldDecisions,
        duplicateMatch: data.duplicateMatch,
      },
    });
  }

  async findDecisions(
    ingestionRunId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionDecision[]> {
    const client = this.getClient(tx);
    return client.ingestionDecision.findMany({
      where: { ingestionRunId },
      orderBy: { decidedAt: 'desc' },
    });
  }

  // ── Review Case Operations ────────────────────────────────────────────────

  async createReviewCase(
    scope: { userId?: string; projectId?: string } | string,
    ingestionRunId: string,
    data: CreateIngestionReviewCaseData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase> {
    const client = this.getClient(tx);
    const userId =
      typeof scope === 'object' ? scope.userId : data.assignedToId || scope;
    const projectId = typeof scope === 'object' ? scope.projectId : undefined;

    return client.ingestionReviewCase.create({
      data: {
        userId: userId || null,
        projectId: projectId || null,
        ingestionRunId,
        targetItemId: data.targetItemId,
        reason: data.reason,
        evidence: data.evidence ?? Prisma.JsonNull,
        options: data.options ?? Prisma.JsonNull,
        assignedToId: data.assignedToId,
        status: 'PENDING',
      },
    });
  }

  async findReviewCases(
    _scope: { userId?: string; projectId?: string } | string,
    options?: { status?: string; limit?: number },
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase[]> {
    const client = this.getClient(tx);
    const userId =
      typeof _scope === 'object' ? _scope.userId : _scope || undefined;
    const projectId = typeof _scope === 'object' ? _scope.projectId : undefined;
    return client.ingestionReviewCase.findMany({
      where: {
        ...(projectId ? { projectId } : userId ? { userId } : {}),
        ...(options?.status ? { status: options.status } : {}),
      },
      take: options?.limit ?? 50,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findReviewCaseById(
    _scope: { userId?: string; projectId?: string } | string,
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase | null> {
    const client = this.getClient(tx);
    return client.ingestionReviewCase.findFirst({
      where: {
        id,
      },
    });
  }

  async updateReviewCaseStatus(
    _scope: { userId?: string; projectId?: string } | string,
    id: string,
    status: 'APPROVED' | 'REJECTED' | 'DISMISSED',
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase> {
    const client = this.getClient(tx);
    return client.ingestionReviewCase.update({
      where: {
        id,
      },
      data: {
        status,
        resolvedAt: new Date(),
      },
    });
  }
}
