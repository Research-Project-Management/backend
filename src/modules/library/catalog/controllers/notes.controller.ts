import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, BadRequestException, NotFoundException, Put, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import { normalizeProjectScopeId } from '@/modules/library/core';
import { NotesService } from '@/modules/library/catalog/services/notes.service';
import { CreateNoteDto, UpdateNoteDto, ExtractNotesFromAnnotationsDto } from '@/modules/library/catalog/dto/collections.dto';
import { TagType } from '@prisma/client';
import { TagsService } from '@/modules/library/catalog/services/tags.service';
import { CreateTagDto, UpdateTagDto, SplitTagDto } from '@/modules/library/catalog/dto/collections.dto';
import { SavedSearchesService } from '@/modules/library/catalog/services/saved-searches.service';
import { CreateSavedSearchDto, UpdateSavedSearchDto, PreviewSavedSearchDto, ExecuteSavedSearchQueryDto } from '@/modules/library/catalog/types/catalog.types';

@ApiTags('Library Notes')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/notes',
  'api/v1/projects/:projectId/library/notes',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class NoteController {
  constructor(private readonly notesService: NotesService) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List library notes for user or project' })
  async listNotes(
    @CurrentUser('id') currentUserId: string,
    @Query('itemId') itemId?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId,
    );
    return this.notesService.listNotes(
      currentUserId,
      itemId,
      effectiveProjectId,
    );
  }

  @Get(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get a single note by ID' })
  async getNote(
    @CurrentUser('id') currentUserId: string,
    @Param('id') id: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    if (!isUUID(id)) {
      throw new BadRequestException(`Invalid note UUID: ${id}`);
    }
    const effectiveProjectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId,
    );
    const note = await this.notesService.getNote(
      currentUserId,
      id,
      effectiveProjectId,
    );
    if (!note) {
      throw new NotFoundException(`Note with ID ${id} not found`);
    }
    return note;
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Create a research literature note' })
  async createNote(
    @CurrentUser('id') currentUserId: string,
    @Body() dto: CreateNoteDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId || dto.projectId,
    );
    return this.notesService.createNote(currentUserId, {
      ...dto,
      createdById: currentUserId,
      projectId: effectiveProjectId,
    });
  }

  @Patch(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a research note' })
  async updateNote(
    @CurrentUser('id') currentUserId: string,
    @Param('id') id: string,
    @Body() dto: UpdateNoteDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    if (!isUUID(id)) {
      throw new BadRequestException(`Invalid note UUID: ${id}`);
    }
    const effectiveProjectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId,
    );
    return this.notesService.updateNote(
      currentUserId,
      id,
      dto,
      effectiveProjectId,
    );
  }

  @Delete(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a research note' })
  async deleteNote(
    @CurrentUser('id') currentUserId: string,
    @Param('id') id: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
    @Query('expectedVersion') rawExpectedVersion?: string | number,
  ) {
    if (!isUUID(id)) {
      throw new BadRequestException(`Invalid note UUID: ${id}`);
    }
    const effectiveProjectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId,
    );
    const parsedVersion =
      rawExpectedVersion !== undefined && rawExpectedVersion !== ''
        ? Number(rawExpectedVersion)
        : undefined;
    const expectedVersion =
      parsedVersion !== undefined && Number.isFinite(parsedVersion)
        ? parsedVersion
        : undefined;
    return this.notesService.deleteNote(
      currentUserId,
      id,
      expectedVersion,
      effectiveProjectId,
    );
  }

  @Post('items/:itemId/from-annotations')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Extract and compile notes from PDF annotations for an item',
  })
  async extractNotes(
    @CurrentUser('id') currentUserId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
    @Body() body?: ExtractNotesFromAnnotationsDto,
  ) {
    if (!isUUID(itemId)) {
      throw new BadRequestException(`Invalid item UUID: ${itemId}`);
    }
    const effectiveProjectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId || body?.projectId,
    );
    const hasOptions =
      body &&
      (body.noteId !== undefined ||
        body.attachmentId !== undefined ||
        body.annotationIds !== undefined ||
        body.tagColor !== undefined ||
        body.tagColorName !== undefined ||
        body.includeComments !== undefined ||
        body.protocol !== undefined ||
        body.webBaseUrl !== undefined);
    const options = hasOptions
      ? {
          noteId: body.noteId,
          attachmentId: body.attachmentId,
          annotationIds: body.annotationIds,
          tagColor: body.tagColor,
          tagColorName: body.tagColorName,
          includeComments: body.includeComments,
          protocol: body.protocol,
          webBaseUrl: body.webBaseUrl,
          projectId: effectiveProjectId,
        }
      : undefined;

    return this.notesService.extractNotesFromAnnotations(
      currentUserId,
      itemId,
      options,
      effectiveProjectId,
    );
  }
}

@ApiTags('Library Tags')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library/tags', 'api/v1/projects/:projectId/library/tags'])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class TagController {
  constructor(private readonly tagsService: TagsService) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List tags in personal or project scope' })
  async getTags(
    @CurrentUser('id') userId: string,
    @Query('includeInactive') includeInactive?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    const tags = await this.tagsService.getTags(userId, {
      includeInactive: includeInactive === 'true',
      projectId,
    });
    return { tags, total: tags.length };
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create or get a tag' })
  async createTag(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateTagDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId || dto?.projectId,
    );
    const tag = await this.tagsService.createOrGetTag(
      userId,
      dto.name,
      dto.color,
      dto.type,
      projectId,
      dto.shortcut,
    );
    return { tag };
  }

  @Put(':tagId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a tag' })
  async updateTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Body() dto: UpdateTagDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    const tag = await this.tagsService.updateTag(
      userId,
      tagId,
      {
        name: dto.name,
        color: dto.color,
        type: dto.type,
        shortcut: dto.shortcut,
        expectedVersion: dto.expectedVersion,
      },
      projectId,
    );
    return { tag };
  }

  @Patch(':tagId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Patch a tag' })
  async patchTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Body() dto: UpdateTagDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.updateTag(userId, tagId, dto, queryProjectId, paramProjectId);
  }

  @Post(':tagId/split')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Atomically split a tag into multiple tags while preserving all item associations',
  })
  async splitTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Body() dto: SplitTagDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId || dto?.projectId,
    );
    const res = await this.tagsService.splitTag(
      userId,
      tagId,
      dto?.parts || [],
      projectId,
    );
    return { success: true, ...res };
  }

  @Delete('automatic')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete all automatic tags' })
  async deleteAutomaticTags(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    const res = await this.tagsService.deleteAutomaticTags(userId, projectId);
    return { success: true, ...res };
  }

  @Delete(':tagId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a tag' })
  async deleteTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    await this.tagsService.deleteTag(userId, tagId, projectId);
    return { success: true };
  }

  @Post(':tagId/items/:itemId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign tag to item' })
  async assignTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    await this.tagsService.assignTag(userId, tagId, itemId, projectId);
    return { success: true };
  }

  @Delete(':tagId/items/:itemId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Remove tag from item' })
  async removeTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    await this.tagsService.removeTag(userId, tagId, itemId, projectId);
    return { success: true };
  }
}

@ApiTags('Library Saved Searches (Smart Collections)')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/saved-searches',
  'api/v1/projects/:projectId/library/saved-searches',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class SavedSearchesController {
  constructor(protected readonly savedSearchesService: SavedSearchesService) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List all saved searches' })
  async findAll(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.savedSearchesService.findAll(userId, projectId);
  }

  @Post('preview')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Preview saved search condition results' })
  async preview(
    @CurrentUser('id') userId: string,
    @Body() dto: PreviewSavedSearchDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId || dto?.projectId,
    );
    return this.savedSearchesService.preview(userId, dto, projectId);
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Create a saved search' })
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateSavedSearchDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId || dto?.projectId,
    );
    return this.savedSearchesService.create(userId, dto, projectId);
  }

  @Get(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get saved search by ID' })
  async findById(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.savedSearchesService.findById(userId, id, projectId);
  }

  @Put(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a saved search' })
  async update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSavedSearchDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.savedSearchesService.update(userId, id, dto, projectId);
  }

  @Patch(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Patch a saved search' })
  async updatePatch(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSavedSearchDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.update(userId, id, dto, queryProjectId, paramProjectId);
  }

  @Delete(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a saved search' })
  async delete(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.savedSearchesService.delete(userId, id, projectId);
  }

  @Get(':id/execute')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Execute saved search and return matching items' })
  async execute(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query?: ExecuteSavedSearchQueryDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const dto = query || {};
    const projectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId || dto?.projectId,
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
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.execute(userId, id, query, queryProjectId, paramProjectId);
  }
}
