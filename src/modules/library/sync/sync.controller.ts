import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';
import { WorkspaceRole } from '@/modules/iam/authz/enums/workspace-role.enum';
import { SyncService } from './sync.service';
import { SyncPushMutation } from './types/sync.types';
import { wrapResponse } from './utils/sync.util';

@ApiTags('Library Sync')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
@Controller('workspaces/:workspaceId/library')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get('changes')
  @WorkspaceRoles(
    WorkspaceRole.VIEWER,
    WorkspaceRole.MEMBER,
    WorkspaceRole.ADMIN,
    WorkspaceRole.OWNER,
  )
  @ApiOperation({
    summary: 'Get incremental library change feed since a sequence number',
  })
  async getChanges(
    @Param('workspaceId') workspaceId: string,
    @Query('after', new DefaultValuePipe(0), ParseIntPipe) after: number,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ) {
    const result = await this.syncService.getChanges(workspaceId, after, limit);
    return wrapResponse(result);
  }

  @Post('sync/push')
  @WorkspaceRoles(
    WorkspaceRole.MEMBER,
    WorkspaceRole.ADMIN,
    WorkspaceRole.OWNER,
  )
  @ApiOperation({
    summary:
      'Push offline mutations with optimistic concurrency conflict detection',
  })
  async pushChanges(
    @Param('workspaceId') workspaceId: string,
    @Body('mutations') mutations: SyncPushMutation[],
  ) {
    const result = await this.syncService.pushChanges(
      workspaceId,
      mutations || [],
    );
    return wrapResponse(result);
  }
}
