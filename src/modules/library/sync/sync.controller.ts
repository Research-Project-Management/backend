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
import { WorkspaceRoles } from '../../../modules/iam/authz/decorators/workspace-roles.decorator';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import { PushMutationsDto, ApplyExternalSyncBatchDto } from './dto/sync.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/sync',
  'api/v1/workspace/:workspaceId/library/sync',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get('pull')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
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
  @WorkspaceRoles('owner', 'admin', 'member')
  async pushMutations(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() body: PushMutationsDto,
  ) {
    if (!body || !Array.isArray(body.mutations)) {
      throw new BadRequestException(
        'Invalid payload: mutations array is required',
      );
    }

    const applied = await this.syncService.pushMutations(
      workspaceId,
      body.mutations,
      userId,
    );

    return { applied };
  }

  @Post('batch')
  @WorkspaceRoles('owner', 'admin', 'member')
  async applyBatch(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() body: ApplyExternalSyncBatchDto,
  ) {
    if (!body || !Array.isArray(body.operations)) {
      throw new BadRequestException(
        'Invalid payload: operations array is required',
      );
    }

    return this.syncService.applyExternalSyncBatch(
      {
        workspaceId,
        operations: body.operations as any,
        idempotencyKey: body.idempotencyKey,
      },
      userId,
    );
  }

  @Post('resync')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async resync(@Param('workspaceId') workspaceId: string) {
    const latestSeq = await this.syncService.getLatestSequence(workspaceId);
    return {
      requiresFullResync: true,
      latestSeq: latestSeq.toString(),
      timestamp: new Date().toISOString(),
    };
  }
}
