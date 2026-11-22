import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  BadRequestException,
  NotFoundException,
  Put,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import { normalizeProjectSpaceId } from '@/modules/library/core';
import { SavedSearchesService } from '@/modules/library/catalog/services/saved-searches.service';
import {
  CreateSavedSearchDto,
  UpdateSavedSearchDto,
  PreviewSavedSearchDto,
  ExecuteSavedSearchQueryDto,
} from '@/modules/library/catalog/dto/saved-searches.dto';


@ApiTags('Library Saved Searches (Smart Collections)')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/saved-searches',
  'api/v1/spaces/:spaceId/library/saved-searches',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class SavedSearchesController {
  constructor(protected readonly savedSearchesService: SavedSearchesService) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List all saved searches' })
  async findAll(
    @CurrentUser('id') userId: string,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
    return this.savedSearchesService.findAll(userId, projectId);
  }

  @Post('preview')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Preview saved search condition results' })
  async preview(
    @CurrentUser('id') userId: string,
    @Body() dto: PreviewSavedSearchDto,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(
      paramProjectId || queryProjectId || dto?.spaceId,
    );
    return this.savedSearchesService.preview(userId, dto, projectId);
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Create a saved search' })
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateSavedSearchDto,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(
      paramProjectId || queryProjectId || dto?.spaceId,
    );
    return this.savedSearchesService.create(userId, dto, projectId);
  }

  @Get(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get saved search by ID' })
  async findById(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
    return this.savedSearchesService.findById(userId, id, projectId);
  }

  @Put(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a saved search' })
  async update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSavedSearchDto,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
    return this.savedSearchesService.update(userId, id, dto, projectId);
  }

  @Patch(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Patch a saved search' })
  async updatePatch(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSavedSearchDto,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    return this.update(userId, id, dto, queryProjectId, paramProjectId);
  }

  @Delete(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a saved search' })
  async delete(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
    return this.savedSearchesService.delete(userId, id, projectId);
  }

  @Get(':id/execute')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Execute saved search and return matching items' })
  async execute(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query?: ExecuteSavedSearchQueryDto,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const dto = query || {};
    const projectId = normalizeProjectSpaceId(
      paramProjectId || queryProjectId || dto?.spaceId,
    );
    return this.savedSearchesService.execute(userId, id, dto, projectId);
  }

  @Get([':id/items', ':id/results'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Execute saved search (items/results alias)' })
  async executeItems(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query?: ExecuteSavedSearchQueryDto,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    return this.execute(userId, id, query, queryProjectId, paramProjectId);
  }
}
