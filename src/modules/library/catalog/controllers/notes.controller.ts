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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import { normalizeProjectScopeId } from '@/modules/library/core';
import { NotesService } from '@/modules/library/catalog/services/notes.service';
import {
  CreateNoteDto,
  UpdateNoteDto,
  ExtractNotesFromAnnotationsDto,
} from '@/modules/library/catalog/dto/notes.dto';

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
