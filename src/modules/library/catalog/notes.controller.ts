import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Headers,
  UseGuards,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';

import { CreateNoteDto, UpdateNoteDto } from './dto/notes.dto';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

// CQRS Use Cases
import { CreateNoteUseCase } from './core/use-cases/create-note.use-case';
import { UpdateNoteUseCase } from './core/use-cases/update-note.use-case';
import { DeleteNoteUseCase } from './core/use-cases/delete-note.use-case';
import { ExtractNotesFromAnnotationsUseCase } from './core/use-cases/extract-notes-from-annotations.use-case';
import { GetNoteUseCase } from './core/use-cases/get-note.use-case';
import { ListNotesUseCase } from './core/use-cases/list-notes.use-case';

@ApiTags('Library Notes')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/notes',
  'api/v1/projects/:projectId/library/notes',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class NoteController {
  constructor(
    private readonly createNoteUseCase: CreateNoteUseCase,
    private readonly getNoteUseCase: GetNoteUseCase,
    private readonly listNotesUseCase: ListNotesUseCase,
    private readonly updateNoteUseCase: UpdateNoteUseCase,
    private readonly deleteNoteUseCase: DeleteNoteUseCase,
    private readonly extractNotesUseCase: ExtractNotesFromAnnotationsUseCase,
  ) {}

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
      rawProjectId !== 'personal' &&
      isUUID(rawProjectId)
        ? rawProjectId
        : undefined;

    return this.listNotesUseCase.execute({
      userId: currentUserId,
      itemId,
      projectId: effectiveProjectId,
    });
  }

  @Get(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get a library note by ID' })
  async getNote(
    @CurrentUser('id') currentUserId: string,
    @Param('id') id: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    const note = await this.getNoteUseCase.execute({
      userId: currentUserId,
      id,
      projectId: effectiveProjectId,
    });
    if (!note) {
      throw new NotFoundException(`Note ${id} not found`);
    }

    return note;
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Create a note in user or project library' })
  async createNote(
    @CurrentUser('id') currentUserId: string,
    @Body() body: CreateNoteDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId =
      paramProjectId || queryProjectId || body.projectId;
    const createData = {
      ...body,
      projectId: effectiveProjectId || undefined,
      createdById: currentUserId,
    };

    return this.createNoteUseCase.execute({
      userId: currentUserId,
      data: createData,
      projectId: effectiveProjectId || undefined,
    });
  }

  @Get('items/:itemId')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List notes for an item' })
  async listNotesByItem(
    @CurrentUser('id') currentUserId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.listNotesUseCase.execute({
      userId: currentUserId,
      itemId,
      projectId: effectiveProjectId,
    });
  }

  @Post('items/:itemId/from-annotations')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Extract notes from annotations' })
  async extractNotesFromAnnotations(
    @CurrentUser('id') currentUserId: string,
    @Param('itemId') itemId: string,
    @Query('protocol') queryProtocol?: 'flux' | 'web' | 'zotero',
    @Body()
    body?: { protocol?: 'flux' | 'web' | 'zotero'; webBaseUrl?: string },
  ) {
    const protocol = body?.protocol || queryProtocol;
    const options = protocol
      ? { protocol, webBaseUrl: body?.webBaseUrl }
      : undefined;

    return this.extractNotesUseCase.execute({
      userId: currentUserId,
      itemId,
      options,
    });
  }

  @Patch(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a note' })
  async updateNote(
    @CurrentUser('id') currentUserId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateNoteDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    const expectedVersion =
      body.expectedVersion ??
      (ifMatch ? parseInt(ifMatch.replace(/["']/g, ''), 10) : undefined);
    if (expectedVersion === undefined || isNaN(expectedVersion)) {
      throw new BadRequestException(
        'Optimistic locking requirement: expectedVersion or If-Match header is required',
      );
    }

    const { expectedVersion: _, ...updateData } = body;

    return this.updateNoteUseCase.execute({
      userId: currentUserId,
      id,
      expectedVersion,
      data: updateData,
      projectId: effectiveProjectId,
    });
  }

  @Delete(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a note' })
  async deleteNote(
    @CurrentUser('id') currentUserId: string,
    @Param('id') id: string,
    @Query('expectedVersion') expectedVersionQuery?: string,
    @Headers('if-match') ifMatch?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    const expectedVersion =
      expectedVersionQuery !== undefined
        ? parseInt(expectedVersionQuery, 10)
        : ifMatch
          ? parseInt(ifMatch.replace(/["']/g, ''), 10)
          : undefined;

    const deleted = await this.deleteNoteUseCase.execute({
      userId: currentUserId,
      id,
      expectedVersion,
      projectId: effectiveProjectId,
    });

    if (!deleted) {
      throw new NotFoundException(`Note ${id} not found`);
    }

    return { deleted, id };
  }
}

export const NotesController = NoteController;
export type NotesController = NoteController;
