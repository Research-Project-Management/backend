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
} from '@prisma/client';
import { randomUUID } from 'crypto';

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

  private getClient(tx?: Prisma.TransactionClient): PrismaService | Prisma.TransactionClient {
    return tx || this.prisma;
  }

  // ── Run Operations ────────────────────────────────────────────────────────

  async createRun(
    workspaceId: string,
    data: CreateIngestionRunData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun> {
    const client = this.getClient(tx);
    return client.ingestionRun.create({
      data: {
        id: data.id || randomUUID(),
        workspaceId,
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
    workspaceId: string,
    runId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<
    | (IngestionRun & {
        stages: IngestionStage[];
        candidates: IngestionCandidate[];
        decisions: IngestionDecision[];
        reviewCases: IngestionReviewCase[];
      })
    | null
  > {
    const client = this.getClient(tx);
    return client.ingestionRun.findFirst({
      where: {
        id: runId,
        workspaceId,
      },
      include: {
        stages: { orderBy: { executedAt: 'asc' } },
        candidates: { orderBy: { fetchedAt: 'asc' } },
        decisions: { orderBy: { decidedAt: 'desc' } },
        reviewCases: { orderBy: { createdAt: 'desc' } },
      },
    });
  }

  async findRunByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun | null> {
    const client = this.getClient(tx);
    return client.ingestionRun.findFirst({
      where: {
        workspaceId,
        idempotencyKey,
      },
    });
  }

  async updateRunStatus(
    workspaceId: string,
    runId: string,
    status: IngestionStatus,
    details?: {
      itemId?: string;
      lastError?: string;
      completedAt?: Date;
      executionLog?: Prisma.InputJsonValue;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun> {
    const client = this.getClient(tx);
    return client.ingestionRun.update({
      where: {
        id: runId,
        workspaceId,
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
        attempts: { increment: 1 },
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
    workspaceId: string,
    ingestionRunId: string,
    data: CreateIngestionReviewCaseData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase> {
    const client = this.getClient(tx);
    return client.ingestionReviewCase.create({
      data: {
        workspaceId,
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
    workspaceId: string,
    options?: { status?: string; limit?: number },
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase[]> {
    const client = this.getClient(tx);
    return client.ingestionReviewCase.findMany({
      where: {
        workspaceId,
        ...(options?.status ? { status: options.status } : {}),
      },
      take: options?.limit ?? 50,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findReviewCaseById(
    workspaceId: string,
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase | null> {
    const client = this.getClient(tx);
    return client.ingestionReviewCase.findFirst({
      where: {
        id,
        workspaceId,
      },
    });
  }

  async updateReviewCaseStatus(
    workspaceId: string,
    id: string,
    status: 'APPROVED' | 'REJECTED' | 'DISMISSED',
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase> {
    const client = this.getClient(tx);
    return client.ingestionReviewCase.update({
      where: {
        id,
        workspaceId,
      },
      data: {
        status,
        resolvedAt: new Date(),
      },
    });
  }
}
