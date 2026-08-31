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

@Controller([
  'api/v1/workspaces/:workspaceId/library/sync',
  'workspaces/:workspaceId/library/sync',
  'api/workspace/:workspaceId/library/sync',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get('pull')
  async pullDelta(
    @Param('workspaceId') workspaceId: string,
    @Query('sinceSeq') sinceSeq?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedSeq = sinceSeq !== undefined ? BigInt(sinceSeq) : BigInt(0);
    const parsedLimit = limit !== undefined ? parseInt(limit, 10) : 100;

    return this.syncService.pullDelta(
      workspaceId,
      parsedSeq,
      parsedLimit,
    );
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

    const applied = await this.syncService.pushMutations(
      workspaceId,
      body.mutations,
    );

    return { applied };
  }

  @Post('resync')
  async initiateFullResync(@Param('workspaceId') workspaceId: string) {
    const latestSeq = await this.syncService.getLatestSequence(workspaceId);
    return {
      requiresFullResync: true,
      latestSeq: latestSeq.toString(),
      timestamp: new Date().toISOString(),
    };
  }
}
