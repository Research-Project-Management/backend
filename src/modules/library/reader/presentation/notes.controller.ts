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
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { NotesService } from '../application/services/notes.service';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';

import { CreateNoteDto, UpdateNoteDto } from '../application/dtos/notes.dto';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

// CQRS Use Cases
import { CreateNoteUseCase } from '../application/commands/create-note.use-case';
import { UpdateNoteUseCase } from '../application/commands/update-note.use-case';
import { DeleteNoteUseCase } from '../application/commands/delete-note.use-case';
import { ExtractNotesFromAnnotationsUseCase } from '../application/commands/extract-notes-from-annotations.use-case';
import { GetNoteUseCase } from '../application/queries/get-note.use-case';
import { ListNotesUseCase } from '../application/queries/list-notes.use-case';

@ApiTags('Library Notes')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/notes',
  'api/v1/projects/:projectId/library/notes',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class NotesController {
  private notesServiceInstance?: NotesService;
  private createNoteUseCaseInstance?: CreateNoteUseCase;
  private getNoteUseCaseInstance?: GetNoteUseCase;
  private listNotesUseCaseInstance?: ListNotesUseCase;
  private updateNoteUseCaseInstance?: UpdateNoteUseCase;
  private deleteNoteUseCaseInstance?: DeleteNoteUseCase;
  private extractNotesUseCaseInstance?: ExtractNotesFromAnnotationsUseCase;

  constructor(notesService: NotesService);
  constructor(
    createNoteUseCase: CreateNoteUseCase,
    getNoteUseCase: GetNoteUseCase,
    listNotesUseCase: ListNotesUseCase,
    updateNoteUseCase: UpdateNoteUseCase,
    deleteNoteUseCase: DeleteNoteUseCase,
    extractNotesUseCase: ExtractNotesFromAnnotationsUseCase,
    notesService?: NotesService,
  );
  constructor(
    @Optional() private readonly createNoteUseCase?: any,
    @Optional() private readonly getNoteUseCase?: GetNoteUseCase,
    @Optional() private readonly listNotesUseCase?: ListNotesUseCase,
    @Optional() private readonly updateNoteUseCase?: UpdateNoteUseCase,
    @Optional() private readonly deleteNoteUseCase?: DeleteNoteUseCase,
    @Optional()
    private readonly extractNotesUseCase?: ExtractNotesFromAnnotationsUseCase,
    @Optional() private readonly notesService?: NotesService,
  ) {
    const isLegacyService =
      createNoteUseCase && !('execute' in (createNoteUseCase as any));

    if (isLegacyService) {
      this.notesServiceInstance = createNoteUseCase as any;
    } else {
      this.createNoteUseCaseInstance = createNoteUseCase;
      this.getNoteUseCaseInstance = getNoteUseCase;
      this.listNotesUseCaseInstance = listNotesUseCase;
      this.updateNoteUseCaseInstance = updateNoteUseCase;
      this.deleteNoteUseCaseInstance = deleteNoteUseCase;
      this.extractNotesUseCaseInstance = extractNotesUseCase;
      this.notesServiceInstance = notesService;
    }
  }

  private get effectiveNotesService(): NotesService {
    return (this.notesServiceInstance ?? this.notesService)!;
  }

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

    if (this.listNotesUseCaseInstance) {
      return this.listNotesUseCaseInstance.execute({
        userId: currentUserId,
        itemId,
        projectId: effectiveProjectId,
      });
    }

    return this.effectiveNotesService.listNotes(
      currentUserId,
      itemId,
      effectiveProjectId,
    );
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
    let note;
    if (this.getNoteUseCaseInstance) {
      note = await this.getNoteUseCaseInstance.execute({
        userId: currentUserId,
        id,
        projectId: effectiveProjectId,
      });
    } else {
      note = await this.effectiveNotesService.getNote(
        currentUserId,
        id,
        effectiveProjectId,
      );
    }
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
      createdById: currentUserId || 'system',
    };

    if (this.createNoteUseCaseInstance) {
      return this.createNoteUseCaseInstance.execute({
        userId: currentUserId,
        data: createData,
        projectId: effectiveProjectId || undefined,
      });
    }

    return this.effectiveNotesService.createNote(currentUserId, createData);
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
    if (this.listNotesUseCaseInstance) {
      return this.listNotesUseCaseInstance.execute({
        userId: currentUserId,
        itemId,
        projectId: effectiveProjectId,
      });
    }

    return this.effectiveNotesService.listNotes(
      currentUserId,
      itemId,
      effectiveProjectId,
    );
  }

  @Post('items/:itemId/from-annotations')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Extract notes from annotations' })
  async extractNotesFromAnnotations(
    @CurrentUser('id') currentUserId: string,
    @Param('itemId') itemId: string,
    @Query('protocol') queryProtocol?: 'flux' | 'web' | 'zotero',
    @Body() body?: { protocol?: 'flux' | 'web' | 'zotero'; webBaseUrl?: string },
  ) {
    const protocol = body?.protocol || queryProtocol;
    const options = protocol ? { protocol, webBaseUrl: body?.webBaseUrl } : undefined;

    if (this.extractNotesUseCaseInstance) {
      return this.extractNotesUseCaseInstance.execute({
        userId: currentUserId,
        itemId,
        options,
      });
    }

    return this.effectiveNotesService.extractNotesFromAnnotations(
      currentUserId,
      itemId,
      options,
    );
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

    if (this.updateNoteUseCaseInstance) {
      return this.updateNoteUseCaseInstance.execute({
        userId: currentUserId,
        id,
        expectedVersion,
        data: updateData,
        projectId: effectiveProjectId,
      });
    }

    return this.effectiveNotesService.updateNote(
      currentUserId,
      id,
      expectedVersion,
      updateData,
      effectiveProjectId,
    );
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

    let deleted: boolean;
    if (this.deleteNoteUseCaseInstance) {
      deleted = await this.deleteNoteUseCaseInstance.execute({
        userId: currentUserId,
        id,
        expectedVersion,
        projectId: effectiveProjectId,
      });
    } else {
      deleted = await this.effectiveNotesService.deleteNote(
        currentUserId,
        id,
        expectedVersion,
        effectiveProjectId,
      );
    }

    if (!deleted) {
      throw new NotFoundException(`Note ${id} not found`);
    }

    return { deleted, id };
  }
}
