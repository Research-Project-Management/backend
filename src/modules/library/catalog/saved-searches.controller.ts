import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
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
import { SavedSearchesService } from './core/services/saved-searches.service';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  CreateSavedSearchDto,
  UpdateSavedSearchDto,
  PreviewSavedSearchDto,
  ExecuteSavedSearchQueryDto,
} from './dto/saved-search.dto';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

/**
 * Shared Base Adapter for Saved Searches / Smart Collections.
 */
export abstract class BaseSavedSearchesController {
  constructor(protected readonly service: SavedSearchesService) {}

  protected async executeFindAll(userId: string, projectId?: string) {
    return this.service.findAll(userId, projectId);
  }

  protected async executeCreate(
    userId: string,
    dto: CreateSavedSearchDto,
    projectId?: string,
  ) {
    return this.service.create(userId, dto, projectId);
  }

  protected async executePreview(
    userId: string,
    dto: PreviewSavedSearchDto,
    projectId?: string,
  ) {
    return this.service.preview(userId, dto, projectId);
  }

  protected async executeFindById(
    userId: string,
    id: string,
    projectId?: string,
  ) {
    return this.service.findById(userId, id, projectId);
  }

  protected async executeUpdate(
    userId: string,
    id: string,
    dto: UpdateSavedSearchDto,
    projectId?: string,
  ) {
    return this.service.update(userId, id, dto, projectId);
  }

  protected async executeDelete(
    userId: string,
    id: string,
    projectId?: string,
  ) {
    return this.service.delete(userId, id, projectId);
  }

  protected async executeSearch(
    userId: string,
    id: string,
    query: ExecuteSavedSearchQueryDto,
    projectId?: string,
  ) {
    return this.service.execute(userId, id, query, projectId);
  }
}

/**
 * Personal Saved Searches Controller (/api/v1/library/saved-searches).
 * Guarded purely by JwtAuthGuard — scoped to authenticated user.
 */
@ApiTags('Library Saved Searches - Personal')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/library/saved-searches')
@UseGuards(JwtAuthGuard)
export class SavedSearchesController extends BaseSavedSearchesController {
  constructor(service: SavedSearchesService) {
    super(service);
  }

  @Get()
  @ApiOperation({ summary: 'List personal saved searches (smart collections)' })
  async findAll(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeFindAll(userId, queryProjectId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a personal saved search' })
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateSavedSearchDto,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeCreate(userId, dto, queryProjectId);
  }

  @Post('preview')
  @ApiOperation({ summary: 'Preview personal saved search results' })
  async preview(
    @CurrentUser('id') userId: string,
    @Body() dto: PreviewSavedSearchDto,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executePreview(userId, dto, queryProjectId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a personal saved search by ID' })
  async findById(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeFindById(userId, id, queryProjectId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a personal saved search' })
  async update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSavedSearchDto,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeUpdate(userId, id, dto, queryProjectId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a personal saved search' })
  async delete(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeDelete(userId, id, queryProjectId);
  }

  @Get(':id/results')
  @ApiOperation({ summary: 'Execute a personal saved search' })
  async execute(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query: ExecuteSavedSearchQueryDto,
  ) {
    return this.executeSearch(userId, id, query, query.projectId);
  }
}

/**
 * Project Saved Searches Controller (/api/v1/projects/:projectId/library/saved-searches).
 * Strictly validates :projectId with ParseUUIDPipe and enforces project roles.
 */
@ApiTags('Library Saved Searches - Project')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/projects/:projectId/library/saved-searches')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ProjectSavedSearchesController extends BaseSavedSearchesController {
  constructor(service: SavedSearchesService) {
    super(service);
  }

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List project saved searches' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async findAll(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeFindAll(userId, projectId);
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Create a project saved search' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateSavedSearchDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeCreate(userId, dto, projectId);
  }

  @Post('preview')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Preview project saved search results' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async preview(
    @CurrentUser('id') userId: string,
    @Body() dto: PreviewSavedSearchDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executePreview(userId, dto, projectId);
  }

  @Get(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get a project saved search by ID' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async findById(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeFindById(userId, id, projectId);
  }

  @Patch(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a project saved search' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSavedSearchDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeUpdate(userId, id, dto, projectId);
  }

  @Delete(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a project saved search' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async delete(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeDelete(userId, id, projectId);
  }

  @Get(':id/results')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Execute a project saved search' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async execute(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query: ExecuteSavedSearchQueryDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeSearch(userId, id, query, projectId);
  }
}
