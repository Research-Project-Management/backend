import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../iam/authn/guards/auth.guard';
import { ProjectRoleGuard } from '../../../iam/authz/guards/role.guard';
import { ProjectRoles } from '../../../iam/authz/decorators/role.decorator';
import { CurrentUser } from '../../../iam/authn/decorators/user.decorator';
import { StateService } from '../application/services/state.service';
import { UpdateStateDto, GetBatchStatesDto } from '../application/dtos/state.dto';
import { isUUID } from 'class-validator';

const toValidProjectId = (val?: string): string | undefined =>
  val && val !== 'me' && val !== 'user' && val !== 'personal' && isUUID(val)
    ? val
    : undefined;

@Controller([
  'api/v1/library/items/:itemId/state',
  'api/v1/projects/:projectId/library/items/:itemId/state',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class StateController {
  constructor(private readonly stateService: StateService) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = toValidProjectId(paramProjectId);
    return this.stateService.getState(userId, itemId, projectId);
  }

  @Patch()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async updateState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateStateDto,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = toValidProjectId(paramProjectId);
    return this.stateService.updateState(userId, itemId, dto, projectId);
  }

  @Post('read')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async markAsRead(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = toValidProjectId(paramProjectId);
    return this.stateService.markAsRead(userId, itemId, projectId);
  }
}

/**
 * Dedicated batch controller — no :itemId in path.
 * POST /api/v1/library/items/state/batch
 * POST /api/v1/projects/:projectId/library/items/state/batch
 */
@Controller([
  'api/v1/library/items/state',
  'api/v1/projects/:projectId/library/items/state',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class StateBatchController {
  constructor(private readonly stateService: StateService) {}

  @Post('batch')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getBatchStates(
    @CurrentUser('id') userId: string,
    @Body() body: GetBatchStatesDto,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = toValidProjectId(paramProjectId);
    return this.stateService.getBatchStates(
      userId,
      body.itemIds || [],
      projectId,
    );
  }
}
