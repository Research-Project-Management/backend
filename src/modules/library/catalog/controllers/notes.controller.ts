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
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  CreateNoteDto,
  UpdateNoteDto,
} from '@/modules/library/catalog/dto/notes.dto';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import { NotesService } from '@/modules/library/catalog/services/notes.service';

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
    const rawProjectId = paramProjectId || queryProjectId;
    const effectiveProjectId =
      rawProjectId &&
      rawProjectId !== 'me' &&
      rawProjectId !== 'user' &&
      rawProjectId !== 'undefined'
        ? rawProjectId
        : undefined;

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
    const rawProjectId = paramProjectId || queryProjectId;
    const effectiveProjectId =
      rawProjectId &&
      rawProjectId !== 'me' &&
      rawProjectId !== 'user' &&
      rawProjectId !== 'undefined'
        ? rawProjectId
        : undefined;

    if (!isUUID(id)) {
      throw new BadRequestException(`Invalid note UUID: ${id}`);
    }

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
    const rawProjectId = paramProjectId || queryProjectId || dto.projectId;
    const effectiveProjectId =
      rawProjectId &&
      rawProjectId !== 'me' &&
      rawProjectId !== 'user' &&
      rawProjectId !== 'undefined'
        ? rawProjectId
        : undefined;

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
    const rawProjectId = paramProjectId || queryProjectId;
    const effectiveProjectId =
      rawProjectId &&
      rawProjectId !== 'me' &&
      rawProjectId !== 'user' &&
      rawProjectId !== 'undefined'
        ? rawProjectId
        : undefined;
    return effectiveProjectId
      ? this.notesService.updateNote(currentUserId, id, dto, effectiveProjectId)
      : this.notesService.updateNote(currentUserId, id, dto);
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
    const rawProjectId = paramProjectId || queryProjectId;
    const effectiveProjectId =
      rawProjectId &&
      rawProjectId !== 'me' &&
      rawProjectId !== 'user' &&
      rawProjectId !== 'undefined'
        ? rawProjectId
        : undefined;
    const parsedVersion =
      rawExpectedVersion !== undefined && rawExpectedVersion !== ''
        ? Number(rawExpectedVersion)
        : undefined;
    const expectedVersion =
      parsedVersion !== undefined && Number.isFinite(parsedVersion)
        ? parsedVersion
        : undefined;
    return effectiveProjectId
      ? this.notesService.deleteNote(
          currentUserId,
          id,
          expectedVersion,
          effectiveProjectId,
        )
      : expectedVersion !== undefined
        ? this.notesService.deleteNote(currentUserId, id, expectedVersion)
        : this.notesService.deleteNote(currentUserId, id);
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
    @Body()
    body?: {
      noteId?: string;
      tagColor?: boolean;
      includeComments?: boolean;
      projectId?: string;
    },
  ) {
    if (!isUUID(itemId)) {
      throw new BadRequestException(`Invalid item UUID: ${itemId}`);
    }
    const rawProjectId = paramProjectId || queryProjectId || body?.projectId;
    const effectiveProjectId =
      rawProjectId &&
      rawProjectId !== 'me' &&
      rawProjectId !== 'user' &&
      rawProjectId !== 'undefined'
        ? rawProjectId
        : undefined;

    const options =
      body &&
      (body.noteId !== undefined ||
        body.tagColor !== undefined ||
        body.includeComments !== undefined)
        ? { ...body, projectId: effectiveProjectId }
        : effectiveProjectId;

    return this.notesService.extractNotesFromAnnotations(
      currentUserId,
      itemId,
      options,
    );
  }

  async extractNotesFromAnnotations(
    currentUserId: string,
    itemId: string,
    queryProjectId?: string,
    paramProjectId?: string,
  ) {
    return this.extractNotes(
      currentUserId,
      itemId,
      queryProjectId,
      paramProjectId,
    );
  }
}
