import {
  Controller,
  Get,
  Put,
  Patch,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import { normalizeProjectScopeId } from '@/modules/library/core';
import { StateService } from '@/modules/library/catalog/services/state.service';
import {
  UpdateStateDto,
  GetBatchStatesDto,
} from '@/modules/library/catalog/dto/state.dto';

@ApiTags('Library Reading State')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/items/:itemId/state',
  'api/v1/projects/:projectId/library/items/:itemId/state',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class StateController {
  constructor(protected readonly stateService: StateService) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get user reading state for an item' })
  async getState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.stateService.getState(userId, itemId, projectId);
  }

  @Put()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Update user reading state for an item' })
  async updateState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateStateDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.stateService.updateState(userId, itemId, dto, projectId);
  }

  @Patch()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Patch user reading state for an item' })
  async patchState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateStateDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.updateState(
      userId,
      itemId,
      dto,
      queryProjectId,
      paramProjectId,
    );
  }

  @Post(['mark-read', 'read'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark item as read' })
  async markAsRead(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.stateService.markAsRead(userId, itemId, projectId);
  }
}

@ApiTags('Library Reading State')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/state',
  'api/v1/projects/:projectId/library/state',
  'api/v1/library/items/state',
  'api/v1/projects/:projectId/library/items/state',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class StateBatchController {
  constructor(protected readonly stateService: StateService) {}

  @Post('batch')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get batch reading states for items' })
  async getBatchStates(
    @CurrentUser('id') userId: string,
    @Body() dto?: GetBatchStatesDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.stateService.getBatchStates(
      userId,
      dto?.itemIds || [],
      projectId,
    );
  }
}
