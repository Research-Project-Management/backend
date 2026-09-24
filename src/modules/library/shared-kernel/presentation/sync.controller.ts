import {
  Controller,
  Get,
  Query,
  Param,
  UseGuards,
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import { TransactionService } from '../outbox/transaction.service';
import { ChangeLogRepository } from '../outbox/repositories/changelog.repository';
import { SyncQueryDto } from './dtos/sync-query.dto';

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
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class SyncController {
  constructor(
    private readonly transactionService: TransactionService,
    @Optional() private readonly changeLogRepo?: ChangeLogRepository,
  ) {}

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
    const projectId = routeProjectId ?? queryProjectId;
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
    const projectId = routeProjectId ?? queryProjectId;
    const scope = projectId ? { projectId } : { userId };
    const sinceSeq = parseSafeBigInt(query.since) ?? 0n;
    const limit = query.limit ?? 100;

    const changes = await this.transactionService.getChangesSince(
      scope,
      sinceSeq,
      limit,
    );

    return {
      since: sinceSeq.toString(),
      count: changes.length,
      hasMore: changes.length >= limit,
      changes: changes.map((c) => ({
        id: c.id,
        seq: c.seq.toString(),
        userId: c.userId,
        projectId: c.projectId,
        entityType: c.entityType,
        entityId: c.entityId,
        action: c.action,
        version: c.version,
        data: c.data,
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
    const projectId = routeProjectId ?? queryProjectId;
    const scope = projectId ? { projectId } : { userId };
    const sinceSeq = parseSafeBigInt(query.since);
    const limit = query.limit ?? 100;

    const tombstones = await this.transactionService.getTombstonesSince(
      scope,
      sinceSeq,
      limit,
    );

    return {
      since: sinceSeq !== undefined ? sinceSeq.toString() : '0',
      count: tombstones.length,
      hasMore: tombstones.length >= limit,
      tombstones: tombstones.map((t) => ({
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
}
