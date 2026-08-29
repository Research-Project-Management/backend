import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ChangeLogRepository } from './change-log.repository';
import { LibraryTransactionService } from './library-transaction.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';

@Controller([
  'api/v1/workspaces/:workspaceId/library/sync',
  'workspaces/:workspaceId/library/sync',
  'api/workspace/:workspaceId/library/sync',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class SyncController {
  constructor(
    private readonly changeLogRepo: ChangeLogRepository,
    private readonly txService: LibraryTransactionService,
  ) {}

  @Get('pull')
  async pullDelta(
    @Param('workspaceId') workspaceId: string,
    @Query('sinceSeq') sinceSeq?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedSeq = sinceSeq !== undefined ? BigInt(sinceSeq) : BigInt(0);
    const parsedLimit = limit !== undefined ? parseInt(limit, 10) : 100;

    const changes = await this.changeLogRepo.getChangesSince(
      workspaceId,
      parsedSeq,
      parsedLimit,
    );
    const tombstones = await this.changeLogRepo.getTombstonesSince(
      workspaceId,
      parsedSeq,
      parsedLimit,
    );
    const latestSeq = await this.changeLogRepo.getLatestSequence(workspaceId);

    // Format BigInt values as strings for JSON serialization
    const serializedChanges = changes.map((c) => ({
      ...c,
      seq: c.seq.toString(),
    }));

    const serializedTombstones = tombstones.map((t) => ({
      ...t,
      seq: t.seq?.toString() ?? null,
    }));

    return {
      success: true,
      data: {
        changes: serializedChanges,
        tombstones: serializedTombstones,
        latestSeq: latestSeq.toString(),
        hasMore: changes.length === parsedLimit,
      },
    };
  }

  @Post('push')
  async pushMutations(
    @Param('workspaceId') workspaceId: string,
    @Body()
    body: {
      mutations: Array<{
        entityType: string;
        entityId: string;
        action: 'create' | 'update' | 'delete';
        version: number;
        data?: any;
      }>;
    },
  ) {
    if (!body || !Array.isArray(body.mutations)) {
      throw new BadRequestException(
        'Invalid payload: mutations array is required',
      );
    }

    const applied = await this.txService.executeInTransaction(
      async (_tx, helpers) => {
        const results = [];
        for (const mutation of body.mutations) {
          if (mutation.action === 'delete') {
            const tombstone = await helpers.recordTombstone(workspaceId, {
              entityType: mutation.entityType,
              entityId: mutation.entityId,
            });
            results.push({
              entityId: mutation.entityId,
              action: 'delete',
              seq: tombstone.seq?.toString(),
            });
          } else {
            const change = await helpers.appendChange(workspaceId, {
              entityType: mutation.entityType,
              entityId: mutation.entityId,
              action: mutation.action,
              version: mutation.version,
              data: mutation.data,
            });
            results.push({
              entityId: mutation.entityId,
              action: mutation.action,
              seq: change.seq.toString(),
            });
          }
        }
        return results;
      },
    );

    return {
      success: true,
      data: { applied },
    };
  }

  @Post('resync')
  async initiateFullResync(@Param('workspaceId') workspaceId: string) {
    const latestSeq = await this.changeLogRepo.getLatestSequence(workspaceId);
    return {
      success: true,
      data: {
        requiresFullResync: true,
        latestSeq: latestSeq.toString(),
        timestamp: new Date().toISOString(),
      },
    };
  }
}
