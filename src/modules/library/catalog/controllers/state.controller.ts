import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
  Post,
  Body,
  NotFoundException,
  Header,
  Put,
  Patch,
  HttpCode,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser, Public } from '@/modules/identity/auth';
import {
  ProjectRoleGuard,
  ProjectRoles,
  ProjectAccessGuard,
} from '@/modules/project/access';
import { normalizeProjectSpaceId, isUuid } from '@/modules/library/core';
import { CursorPaginationQueryDto } from '@/modules/library/catalog/dto/items.dto';
import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { LibraryBootstrapService } from '@/modules/library/catalog/services/bootstrap.service';
import { ReaderBootstrapService } from '@/modules/library/catalog/services/reader-bootstrap.service';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import { SchemaValidatorService } from '@/modules/library/catalog/services/schema-validator.service';
import { StateService } from '@/modules/library/catalog/services/state.service';
import {
  UpdateStateDto,
  GetBatchStatesDto,
} from '@/modules/library/catalog/dto/state.dto';


@ApiTags('Library Reading State')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/items/:itemId/state',
  'api/v1/spaces/:spaceId/library/items/:itemId/state',
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
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
    return this.stateService.getState(userId, itemId, projectId);
  }

  @Put()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Update user reading state for an item' })
  async updateState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateStateDto,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
    return this.stateService.updateState(userId, itemId, dto, projectId);
  }

  @Patch()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Patch user reading state for an item' })
  async patchState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateStateDto,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
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
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
    return this.stateService.markAsRead(userId, itemId, projectId);
  }
}

@ApiTags('Library Reading State')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/state',
  'api/v1/spaces/:spaceId/library/state',
  'api/v1/library/items/state',
  'api/v1/spaces/:spaceId/library/items/state',
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
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
    return this.stateService.getBatchStates(
      userId,
      dto?.itemIds || [],
      projectId,
    );
  }
}
