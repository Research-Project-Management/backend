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
import { CreateNoteDto, UpdateNoteDto } from '../dto/notes.dto';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import { NotesService } from '../services/notes.service';

@ApiTags('Library Notes')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/notes',
  'api/v1/projects/:projectId/library/notes',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
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
  ) {
    if (!isUUID(id)) {
      throw new BadRequestException(`Invalid note UUID: ${id}`);
    }
    return this.notesService.updateNote(currentUserId, id, dto);
  }

  @Delete(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a research note' })
  async deleteNote(
    @CurrentUser('id') currentUserId: string,
    @Param('id') id: string,
  ) {
    if (!isUUID(id)) {
      throw new BadRequestException(`Invalid note UUID: ${id}`);
    }
    return this.notesService.deleteNote(currentUserId, id);
  }

  @Post('items/:itemId/extract-annotations')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Extract and compile notes from PDF annotations for an item',
  })
  async extractNotes(
    @CurrentUser('id') currentUserId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    if (!isUUID(itemId)) {
      throw new BadRequestException(`Invalid item UUID: ${itemId}`);
    }
    const rawProjectId = paramProjectId || queryProjectId;
    const effectiveProjectId =
      rawProjectId &&
      rawProjectId !== 'me' &&
      rawProjectId !== 'user' &&
      rawProjectId !== 'undefined'
        ? rawProjectId
        : undefined;

    return this.notesService.extractNotesFromAnnotations(
      currentUserId,
      itemId,
      effectiveProjectId,
    );
  }
}
