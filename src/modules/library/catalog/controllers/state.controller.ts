import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { StateService } from '../services/state.service';
import { UpdateStateDto, GetBatchStatesDto } from '../dto/state.dto';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

/**
 * Shared Base Adapter for Item Reading State Operations.
 */
export abstract class BaseStateController {
  constructor(protected readonly stateService: StateService) {}

  protected async executeGetState(
    userId: string,
    itemId: string,
    projectId?: string,
  ) {
    return this.stateService.getState(userId, itemId, projectId);
  }

  protected async executeUpdateState(
    userId: string,
    itemId: string,
    dto: UpdateStateDto,
    projectId?: string,
  ) {
    return this.stateService.updateState(userId, itemId, dto, projectId);
  }

  protected async executeMarkAsRead(
    userId: string,
    itemId: string,
    projectId?: string,
  ) {
    return this.stateService.markAsRead(userId, itemId, projectId);
  }
}

/**
 * Personal Item State Controller (/api/v1/library/items/:itemId/state).
 * Guarded purely by JwtAuthGuard — scoped to authenticated user.
 */
@ApiTags('Library Items - Personal Reading State')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/library/items/:itemId/state')
@UseGuards(JwtAuthGuard)
export class StateController extends BaseStateController {
  constructor(stateService: StateService) {
    super(stateService);
  }

  @Get()
  @ApiOperation({ summary: 'Get personal reading state for an item' })
  async getState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    projectId?: string,
  ) {
    return this.executeGetState(userId, itemId, projectId);
  }

  @Patch()
  @ApiOperation({ summary: 'Update personal reading state for an item' })
  async updateState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateStateDto,
    projectId?: string,
  ) {
    return this.executeUpdateState(userId, itemId, dto, projectId);
  }

  @Post('read')
  @ApiOperation({ summary: 'Mark personal item as read' })
  async markAsRead(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    projectId?: string,
  ) {
    return this.executeMarkAsRead(userId, itemId, projectId);
  }
}

/**
 * Project Item State Controller (/api/v1/projects/:projectId/library/items/:itemId/state).
 * Strictly validates :projectId with ParseUUIDPipe and enforces project roles.
 */
@ApiTags('Library Items - Project Reading State')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/projects/:projectId/library/items/:itemId/state')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ProjectStateController extends BaseStateController {
  constructor(stateService: StateService) {
    super(stateService);
  }

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get project reading state for an item' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeGetState(userId, itemId, projectId);
  }

  @Patch()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Update project reading state for an item' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async updateState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateStateDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeUpdateState(userId, itemId, dto, projectId);
  }

  @Post('read')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Mark project item as read' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async markAsRead(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeMarkAsRead(userId, itemId, projectId);
  }
}

/**
 * Shared Base Adapter for Item Batch State Operations.
 */
export abstract class BaseStateBatchController {
  constructor(protected readonly stateService: StateService) {}

  protected async executeGetBatchStates(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ) {
    return this.stateService.getBatchStates(userId, itemIds, projectId);
  }
}

/**
 * Personal Item State Batch Controller (/api/v1/library/items/state).
 */
@ApiTags('Library Items - Personal Batch State')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/library/items/state')
@UseGuards(JwtAuthGuard)
export class StateBatchController extends BaseStateBatchController {
  constructor(stateService: StateService) {
    super(stateService);
  }

  @Post('batch')
  @ApiOperation({ summary: 'Get reading states for batch of personal items' })
  async getBatchStates(
    @CurrentUser('id') userId: string,
    @Body() body: GetBatchStatesDto,
    projectId?: string,
  ) {
    return this.executeGetBatchStates(userId, body.itemIds || [], projectId);
  }
}

/**
 * Project Item State Batch Controller (/api/v1/projects/:projectId/library/items/state).
 */
@ApiTags('Library Items - Project Batch State')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/projects/:projectId/library/items/state')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ProjectStateBatchController extends BaseStateBatchController {
  constructor(stateService: StateService) {
    super(stateService);
  }

  @Post('batch')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get reading states for batch of project items' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getBatchStates(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() body: GetBatchStatesDto,
  ) {
    return this.executeGetBatchStates(userId, body.itemIds || [], projectId);
  }
}
