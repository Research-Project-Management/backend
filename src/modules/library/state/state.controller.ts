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
import { StateService } from './state.service';
import { UpdateStateDto, GetBatchStatesDto } from './dto/state.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/items/:itemId/state',
  'api/v1/workspace/:workspaceId/library/items/:itemId/state',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class StateController {
  constructor(private readonly stateService: StateService) {}

  @Get()
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getState(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.stateService.getState(workspaceId, itemId, userId);
  }

  @Patch()
  @WorkspaceRoles('owner', 'admin', 'member')
  async updateState(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateStateDto,
  ) {
    return this.stateService.updateState(workspaceId, itemId, userId, dto);
  }

  @Post('read')
  @WorkspaceRoles('owner', 'admin', 'member')
  async markAsRead(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.stateService.markAsRead(workspaceId, itemId, userId);
  }
}

export const ReadingController = StateController;
export type ReadingController = StateController;

/**
 * Dedicated batch controller — no :itemId in path.
 * POST /api/v1/workspaces/:workspaceId/library/items/state/batch
 */
@Controller([
  'api/v1/workspaces/:workspaceId/library/items/state',
  'api/v1/workspace/:workspaceId/library/items/state',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class StateBatchController {
  constructor(private readonly stateService: StateService) {}

  @Post('batch')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getBatchStates(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() body: GetBatchStatesDto,
  ) {
    return this.stateService.getBatchStates(
      workspaceId,
      body.itemIds || [],
      userId,
    );
  }
}

export const ReadingBatchController = StateBatchController;
export type ReadingBatchController = StateBatchController;
