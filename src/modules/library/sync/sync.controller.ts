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
import { SyncService } from './sync.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';

interface SyncMutation {
  entityType: string;
  entityId: string;
  action: 'create' | 'update' | 'delete';
  version: number;
  data?: unknown;
}

interface PushMutationsBody {
  mutations: SyncMutation[];
}

@Controller('api/v1/workspaces/:workspaceId/library/sync')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get('pull')
  async pullDelta(
    @Param('workspaceId') workspaceId: string,
    @Query('sinceSeq') sinceSeq?: string,
    @Query('limit') limit?: string,
  ) {
    let parsedSeq: bigint;
    let parsedLimit: number;
    try {
      parsedSeq = sinceSeq !== undefined ? BigInt(sinceSeq) : BigInt(0);
      parsedLimit = limit !== undefined ? parseInt(limit, 10) : 100;
    } catch {
      throw new BadRequestException('Invalid sync cursor or limit');
    }

    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw new BadRequestException('Invalid sync limit');
    }

    return this.syncService.pullDelta(workspaceId, parsedSeq, parsedLimit);
  }

  @Post('push')
  async pushMutations(
    @Param('workspaceId') workspaceId: string,
    @Body() body: PushMutationsBody,
  ) {
    if (!body || !Array.isArray(body.mutations)) {
      throw new BadRequestException(
        'Invalid payload: mutations array is required',
      );
    }

    const applied = await this.syncService.pushMutations(
      workspaceId,
      body.mutations,
    );

    return { applied };
  }

  @Post('batch')
  async applyBatch(
    @Param('workspaceId') workspaceId: string,
    @Body() body: any,
  ) {
    if (!body || !Array.isArray(body.operations)) {
      throw new BadRequestException(
        'Invalid payload: operations array is required',
      );
    }

    return this.syncService.applyExternalSyncBatch({
      workspaceId,
      operations: body.operations,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Post('resync')
  async resync(@Param('workspaceId') workspaceId: string) {
    const latestSeq = await this.syncService.getLatestSequence(workspaceId);
    return {
      requiresFullResync: true,
      latestSeq: latestSeq.toString(),
      timestamp: new Date().toISOString(),
    };
  }
}
