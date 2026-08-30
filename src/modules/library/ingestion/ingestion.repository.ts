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
  requesterId?: string;
  inputParams: Prisma.InputJsonValue;
  inputHash: string;
  idempotencyKey?: string;
  contractVersion?: string;
  pipelineVersion?: string;
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
  evidence: Prisma.InputJsonValue;
  options?: Prisma.InputJsonValue;
  assignedToId?: string;
}

@Injectable()
export class IngestionRepository {
  private readonly logger = new Logger(IngestionRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Run Operations ────────────────────────────────────────────────────────

  async createRun(
    workspaceId: string,
    data: CreateIngestionRunData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun> {
    const client = (tx || this.prisma) as any;
    if (client.ingestionRun?.create) {
      return (await client.ingestionRun.create({
        data: {
          workspaceId,
          requesterId: data.requesterId,
          inputParams: data.inputParams,
          inputHash: data.inputHash,
          idempotencyKey: data.idempotencyKey,
          contractVersion: data.contractVersion || '1.0.0',
          pipelineVersion: data.pipelineVersion || '1.0.0',
          status: IngestionStatus.RECEIVED,
        },
      })) as IngestionRun;
    }
    return {
      id: randomUUID(),
      workspaceId,
      requesterId: data.requesterId ?? null,
      itemId: null,
      status: IngestionStatus.RECEIVED,
      idempotencyKey: data.idempotencyKey ?? null,
      inputParams: data.inputParams,
      inputHash: data.inputHash,
      contractVersion: data.contractVersion || '1.0.0',
      pipelineVersion: data.pipelineVersion || '1.0.0',
      attempts: 0,
      maxRetries: 3,
      lastError: null,
      executionLog: null,
      startedAt: new Date(),
      completedAt: null,
    } as IngestionRun;
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
    const client = (tx || this.prisma) as any;
    if (client.ingestionRun?.findFirst) {
      return (await client.ingestionRun.findFirst({
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
      })) as
        | (IngestionRun & {
            stages: IngestionStage[];
            candidates: IngestionCandidate[];
            decisions: IngestionDecision[];
            reviewCases: IngestionReviewCase[];
          })
        | null;
    }
    return null;
  }

  async findRunByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionRun | null> {
    const client = (tx || this.prisma) as any;
    if (client.ingestionRun?.findFirst) {
      return (await client.ingestionRun.findFirst({
        where: {
          workspaceId,
          idempotencyKey,
        },
      })) as IngestionRun | null;
    }
    return null;
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
    const client = (tx || this.prisma) as any;
    if (client.ingestionRun?.update) {
      return (await client.ingestionRun.update({
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
      })) as IngestionRun;
    }
    return {
      id: runId,
      workspaceId,
      status,
      itemId: details?.itemId ?? null,
      lastError: details?.lastError ?? null,
      completedAt: details?.completedAt ?? null,
    } as IngestionRun;
  }

  // ── Stage Operations ──────────────────────────────────────────────────────

  async createStage(
    ingestionRunId: string,
    data: CreateIngestionStageData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionStage> {
    const client = (tx || this.prisma) as any;
    if (client.ingestionStage?.create) {
      return (await client.ingestionStage.create({
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
      })) as IngestionStage;
    }
    return {
      id: randomUUID(),
      ingestionRunId,
      stageName: data.stageName,
      durationMs: data.durationMs ?? 0,
      success: data.success ?? true,
      errorMessage: data.errorMessage ?? null,
      outputSnapshot: data.outputSnapshot ?? null,
      leaseToken: data.leaseToken ?? null,
      leaseExpiresAt: data.leaseExpiresAt ?? null,
      executedAt: new Date(),
    } as IngestionStage;
  }

  async findStages(
    ingestionRunId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionStage[]> {
    const client = (tx || this.prisma) as any;
    if (client.ingestionStage?.findMany) {
      return (await client.ingestionStage.findMany({
        where: { ingestionRunId },
        orderBy: { executedAt: 'asc' },
      })) as IngestionStage[];
    }
    return [];
  }

  // ── Candidate Operations ──────────────────────────────────────────────────

  async createCandidate(
    ingestionRunId: string,
    data: CreateIngestionCandidateData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionCandidate> {
    const client = (tx || this.prisma) as any;
    if (client.ingestionCandidate?.create) {
      return (await client.ingestionCandidate.create({
        data: {
          ingestionRunId,
          sourceProvider: data.sourceProvider,
          sourceRecordId: data.sourceRecordId,
          confidenceScore: data.confidenceScore ?? 1.0,
          metadataPayload: data.metadataPayload,
          rawEvidenceRef: data.rawEvidenceRef,
        },
      })) as IngestionCandidate;
    }
    return {
      id: randomUUID(),
      ingestionRunId,
      sourceProvider: data.sourceProvider,
      sourceRecordId: data.sourceRecordId ?? null,
      confidenceScore: data.confidenceScore ?? 1.0,
      metadataPayload: data.metadataPayload,
      rawEvidenceRef: data.rawEvidenceRef ?? null,
      fetchedAt: new Date(),
    } as IngestionCandidate;
  }

  async findCandidates(
    ingestionRunId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionCandidate[]> {
    const client = (tx || this.prisma) as any;
    if (client.ingestionCandidate?.findMany) {
      return (await client.ingestionCandidate.findMany({
        where: { ingestionRunId },
        orderBy: { fetchedAt: 'asc' },
      })) as IngestionCandidate[];
    }
    return [];
  }

  // ── Decision Operations ───────────────────────────────────────────────────

  async createDecision(
    ingestionRunId: string,
    data: CreateIngestionDecisionData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionDecision> {
    const client = (tx || this.prisma) as any;
    if (client.ingestionDecision?.create) {
      return (await client.ingestionDecision.create({
        data: {
          ingestionRunId,
          decisionType: data.decisionType,
          decisionReason: data.decisionReason,
          proposedItem: data.proposedItem,
          fieldDecisions: data.fieldDecisions,
          duplicateMatch: data.duplicateMatch,
        },
      })) as IngestionDecision;
    }
    return {
      id: randomUUID(),
      ingestionRunId,
      decisionType: data.decisionType,
      decisionReason: data.decisionReason,
      proposedItem: data.proposedItem,
      fieldDecisions: data.fieldDecisions ?? null,
      duplicateMatch: data.duplicateMatch ?? null,
      decidedAt: new Date(),
    } as IngestionDecision;
  }

  async findDecisions(
    ingestionRunId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionDecision[]> {
    const client = (tx || this.prisma) as any;
    if (client.ingestionDecision?.findMany) {
      return (await client.ingestionDecision.findMany({
        where: { ingestionRunId },
        orderBy: { decidedAt: 'desc' },
      })) as IngestionDecision[];
    }
    return [];
  }

  // ── Review Case Operations ────────────────────────────────────────────────

  async createReviewCase(
    workspaceId: string,
    ingestionRunId: string,
    data: CreateIngestionReviewCaseData,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase> {
    const client = (tx || this.prisma) as any;
    if (client.ingestionReviewCase?.create) {
      return (await client.ingestionReviewCase.create({
        data: {
          workspaceId,
          ingestionRunId,
          targetItemId: data.targetItemId,
          reason: data.reason,
          evidence: data.evidence,
          options: data.options,
          assignedToId: data.assignedToId,
          status: 'PENDING',
        },
      })) as IngestionReviewCase;
    }
    return {
      id: randomUUID(),
      workspaceId,
      ingestionRunId,
      targetItemId: data.targetItemId ?? null,
      status: 'PENDING',
      reason: data.reason,
      evidence: data.evidence,
      options: data.options ?? null,
      assignedToId: data.assignedToId ?? null,
      resolvedAt: null,
      createdAt: new Date(),
    } as IngestionReviewCase;
  }

  async findReviewCases(
    workspaceId: string,
    options?: { status?: string; limit?: number },
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase[]> {
    const client = (tx || this.prisma) as any;
    if (client.ingestionReviewCase?.findMany) {
      return (await client.ingestionReviewCase.findMany({
        where: {
          workspaceId,
          ...(options?.status ? { status: options.status } : {}),
        },
        take: options?.limit ?? 50,
        orderBy: { createdAt: 'desc' },
      })) as IngestionReviewCase[];
    }
    return [];
  }

  async findReviewCaseById(
    workspaceId: string,
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase | null> {
    const client = (tx || this.prisma) as any;
    if (client.ingestionReviewCase?.findFirst) {
      return (await client.ingestionReviewCase.findFirst({
        where: {
          id,
          workspaceId,
        },
      })) as IngestionReviewCase | null;
    }
    return null;
  }

  async updateReviewCaseStatus(
    workspaceId: string,
    id: string,
    status: 'APPROVED' | 'REJECTED' | 'DISMISSED',
    tx?: Prisma.TransactionClient,
  ): Promise<IngestionReviewCase> {
    const client = (tx || this.prisma) as any;
    if (client.ingestionReviewCase?.update) {
      return (await client.ingestionReviewCase.update({
        where: {
          id,
          workspaceId,
        },
        data: {
          status,
          resolvedAt: new Date(),
        },
      })) as IngestionReviewCase;
    }
    return {
      id,
      workspaceId,
      status,
      resolvedAt: new Date(),
    } as IngestionReviewCase;
  }
}
