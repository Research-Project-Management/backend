import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Controller, HttpException, HttpStatus, Get, Query, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles, RequireOperator } from '@/modules/project/access';
import { TransactionService, compactLibraryChanges } from '@/modules/library/sync/services/transaction.service';
import { ResilienceRegistryService } from '@/modules/library/core/resilience/resilience-registry.service';
import { OutboxWorker } from '@/modules/library/sync/services/outbox.worker';
import { OutboxMetrics } from '@/modules/library/sync/services/outbox-metrics.service';
import { SyncQueryDto } from '@/modules/library/sync/dto/sync.dto';
import { normalizeProjectScopeId } from '@/modules/library/core';

export { SyncQueryDto };

const PERSONAL_STATE_FIELDS_IN_ITEM_PAYLOAD = [
  'isStarred',
  'starred',
  'isRead',
  'readStatus',
  'rating',
  'currentPage',
  'lastReadPage',
  'scrollPosition',
  'lastOpenedAt',
  'lastReadAt',
  'isMyPublication',
] as const;

function stripCrossUserItemState(
  data: unknown,
  changeUserId: string | null | undefined,
  requestingUserId: string,
  entityType: string | null | undefined,
  projectId?: string,
): unknown {
  if (
    !projectId ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    entityType?.toLowerCase() !== 'item' ||
    (changeUserId && changeUserId === requestingUserId)
  ) {
    return data;
  }
  const clone = { ...(data as Record<string, unknown>) };
  for (const field of PERSONAL_STATE_FIELDS_IN_ITEM_PAYLOAD) {
    delete clone[field];
  }
  return clone;
}

function parseSafeBigInt(val?: string): bigint | undefined {
  if (!val) return undefined;
  const trimmed = val.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  try {
    return BigInt(trimmed);
  } catch {
    return undefined;
  }
}

@ApiTags('Library Sync')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library/sync', 'api/v1/projects/:projectId/library/sync'])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class SyncController {
  constructor(
    private readonly transactionService: TransactionService,
    private readonly resilienceRegistry: ResilienceRegistryService,
    private readonly outboxWorker: OutboxWorker,
    private readonly outboxMetrics: OutboxMetrics,
  ) {}

  private resolveProjectId(
    routeProjectId?: string,
    queryProjectId?: string,
  ): string | undefined {
    return normalizeProjectScopeId(routeProjectId ?? queryProjectId);
  }

  @Get('version')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get current sync sequence version of the library',
    description:
      'Returns the latest monotonic library version sequence for optimistic concurrency or sync checkpoints.',
  })
  async getSyncVersion(
    @CurrentUser('id') userId: string,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const projectId = this.resolveProjectId(routeProjectId, queryProjectId);
    const scope = projectId ? { projectId } : { userId };
    const latestSeq = await this.transactionService.getLatestSequence(scope);

    return {
      version: latestSeq.toString(),
      scope: projectId ? 'project' : 'user',
      scopeId: projectId ?? userId,
    };
  }

  @Get('changes')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get incremental library changes since a given sequence (CDC)',
    description:
      'Fetches changed entities (Item, Collection, Tag, Attachment, Note) since the specified sequence for client cache reconciliation.',
  })
  async getChanges(
    @CurrentUser('id') userId: string,
    @Query() query: SyncQueryDto,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const projectId = this.resolveProjectId(routeProjectId, queryProjectId);
    const scope = projectId ? { projectId, userId } : { userId };
    const sinceSeq = parseSafeBigInt(query.since) ?? 0n;
    const limit = query.limit ?? 100;

    const [minRetainedSeq, changes] = await Promise.all([
      sinceSeq > 0n
        ? (this.transactionService.getMinRetainedSequence?.(scope) ??
          Promise.resolve(undefined))
        : Promise.resolve(undefined),
      this.transactionService.getChangesSince(scope, sinceSeq, limit + 1),
    ]);

    if (minRetainedSeq && sinceSeq > 0n && sinceSeq < minRetainedSeq - 1n) {
      throw new HttpException(
        {
          statusCode: HttpStatus.GONE,
          error: 'Gone',
          code: 'SYNC_RESET_REQUIRED',
          message:
            'Client sync cursor is older than retention period. Full library re-seed required.',
          minRetainedSequence: minRetainedSeq.toString(),
        },
        HttpStatus.GONE,
      );
    }

    const visibleChanges = projectId
      ? changes.filter((c) => {
          const typeLower = c.entityType?.toLowerCase();
          if (typeLower === 'state' || typeLower === 'attachmentreadingstate') {
            return !c.userId || c.userId === userId;
          }
          return true;
        })
      : changes;
    const hasMore = visibleChanges.length > limit || changes.length > limit;
    const rawPaged = visibleChanges.slice(0, limit);
    const highWaterMarkSeq =
      rawPaged.length > 0
        ? rawPaged[rawPaged.length - 1].seq
        : changes.length > 0
          ? changes[Math.min(changes.length, limit) - 1].seq
          : sinceSeq;
    const pagedChanges =
      query.compact !== false
        ? compactLibraryChanges(rawPaged)
        : rawPaged;

    return {
      since: sinceSeq.toString(),
      count: pagedChanges.length,
      compacted: query.compact !== false,
      hasMore,
      nextCursor: hasMore ? highWaterMarkSeq.toString() : null,
      changes: pagedChanges.map((c) => ({
        id: c.id,
        seq: c.seq.toString(),
        userId: c.userId,
        projectId: c.projectId,
        entityType: c.entityType,
        entityId: c.entityId,
        action: c.action,
        version: c.version,
        data: stripCrossUserItemState(
          c.data,
          c.userId,
          userId,
          c.entityType,
          projectId,
        ),
        createdAt: c.createdAt,
      })),
    };
  }

  @Get('tombstones')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get deleted entity tombstones since a given sequence',
    description:
      'Fetches purged/deleted entity markers so offline-first clients can purge local cache.',
  })
  async getTombstones(
    @CurrentUser('id') userId: string,
    @Query() query: SyncQueryDto,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const projectId = this.resolveProjectId(routeProjectId, queryProjectId);
    const scope = projectId ? { projectId, userId } : { userId };
    const sinceSeq = parseSafeBigInt(query.since);
    const limit = query.limit ?? 100;

    const [minRetainedTombSeq, tombstones] = await Promise.all([
      sinceSeq !== undefined && sinceSeq > 0n
        ? (this.transactionService.getMinRetainedSequence?.(scope) ??
          Promise.resolve(undefined))
        : Promise.resolve(undefined),
      this.transactionService.getTombstonesSince(scope, sinceSeq, limit + 1),
    ]);

    if (
      minRetainedTombSeq &&
      sinceSeq !== undefined &&
      sinceSeq > 0n &&
      sinceSeq < minRetainedTombSeq - 1n
    ) {
      throw new HttpException(
        {
          statusCode: HttpStatus.GONE,
          error: 'Gone',
          code: 'SYNC_RESET_REQUIRED',
          message:
            'Client sync cursor is older than retention period. Full library re-seed required.',
          minRetainedSequence: minRetainedTombSeq.toString(),
        },
        HttpStatus.GONE,
      );
    }

    const hasMore = tombstones.length > limit;
    const pagedTombstones = hasMore ? tombstones.slice(0, limit) : tombstones;
    const highWaterMarkSeq =
      pagedTombstones.length > 0
        ? pagedTombstones[pagedTombstones.length - 1].seq
        : (sinceSeq ?? 0n);

    return {
      since: sinceSeq !== undefined ? sinceSeq.toString() : '0',
      count: pagedTombstones.length,
      hasMore,
      nextCursor: hasMore ? highWaterMarkSeq.toString() : null,
      tombstones: pagedTombstones.map((t) => ({
        id: t.id,
        seq: t.seq.toString(),
        userId: t.userId,
        projectId: t.projectId,
        entityType: t.entityType,
        entityId: t.entityId,
        deletedById: t.deletedById,
        deletedAt: t.deletedAt,
      })),
    };
  }

  @Get('diagnostics')
  @RequireOperator()
  @ApiOperation({
    summary: 'Library Subsystem Diagnostics & Observability',
    description:
      'Returns real-time telemetry including Circuit Breaker states, Outbox worker status, and metrics.',
  })
  getDiagnostics() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      resilience: this.resilienceRegistry?.getAllBreakerStatuses() ?? {},
      outbox: {
        workerId: this.outboxWorker?.getWorkerId() ?? 'disabled',
        metrics: {
          dispatches:
            this.outboxMetrics?.getCounter('outbox_dispatched_total') ?? 0,
        },
      },
    };
  }
}
