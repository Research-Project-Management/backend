import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../../modules/iam/authz/decorators/workspace-roles.decorator';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import { ReadingService } from './reading.service';
import { UpdateReadingDto, GetBatchReadingStatesDto } from './dto/reading.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/items/:itemId/state',
  'api/v1/workspace/:workspaceId/library/items/:itemId/state',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ReadingController {
  constructor(private readonly readingService: ReadingService) {}

  @Get()
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getState(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.readingService.getState(workspaceId, itemId, userId);
  }

  @Patch()
  @WorkspaceRoles('owner', 'admin', 'member')
  async updateState(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateReadingDto,
  ) {
    return this.readingService.updateState(workspaceId, itemId, userId, dto);
  }

  @Post('read')
  @WorkspaceRoles('owner', 'admin', 'member')
  async markAsRead(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.readingService.markAsRead(workspaceId, itemId, userId);
  }
}

/**
 * Dedicated batch controller — no :itemId in path.
 * POST /api/v1/workspaces/:workspaceId/library/items/state/batch
 */
@Controller([
  'api/v1/workspaces/:workspaceId/library/items/state',
  'api/v1/workspace/:workspaceId/library/items/state',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ReadingBatchController {
  constructor(private readonly readingService: ReadingService) {}

  @Post('batch')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getBatchStates(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() body: GetBatchReadingStatesDto,
  ) {
    return this.readingService.getBatchStates(
      workspaceId,
      body.itemIds || [],
      userId,
    );
  }
}
